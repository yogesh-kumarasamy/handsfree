import fs from "node:fs";
import path from "node:path";
import { exec } from "./shell";
import type { ProjectConfig, Ticket } from "./types";

async function git(cwd: string, args: string[], timeoutMs = 120_000) {
  const r = await exec("git", args, { cwd, timeoutMs });
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout.trim();
}

const tryGit = (cwd: string, args: string[]) => git(cwd, args).catch(() => undefined);

export async function repoInfo(repoPath: string) {
  if (!repoPath || !fs.existsSync(repoPath)) return { ok: false, error: "Folder not found." };
  const toplevel = await tryGit(repoPath, ["rev-parse", "--show-toplevel"]);
  if (!toplevel) return { ok: false, error: "This folder isn't a git repository." };
  const remotes = ((await tryGit(toplevel, ["remote"])) || "").split("\n").filter(Boolean);
  const head = await tryGit(toplevel, ["symbolic-ref", "--short", `refs/remotes/${remotes.includes("origin") ? "origin" : remotes[0] || "origin"}/HEAD`]);
  const defaultBranch = head ? head.replace(/^[^/]+\//, "") : (await tryGit(toplevel, ["branch", "--show-current"])) || "main";
  return { ok: true, toplevel, defaultBranch, remotes };
}

async function ensureExcluded(repo: string) {
  const common = path.resolve(repo, await git(repo, ["rev-parse", "--git-common-dir"]));
  const file = path.join(common, "info", "exclude");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const add = [".worktrees/", ".handsfree/"].filter((l) => !cur.split("\n").includes(l));
  if (add.length) fs.appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}# HandsFree\n${add.join("\n")}\n`);
}

export function worktreePath(project: ProjectConfig, key: string) {
  return path.join(project.repoPath, ".worktrees", key);
}

/** Create (or reuse) the ticket's worktree. Returns a log line. */
export async function ensureWorktree(project: ProjectConfig, t: Ticket): Promise<string> {
  const repo = project.repoPath;
  await git(repo, ["rev-parse", "--show-toplevel"]);
  await ensureExcluded(repo);
  const fetched = await exec("git", ["fetch", project.remote, project.baseBranch], { cwd: repo, timeoutMs: 180_000 });
  const remoteRef = `${project.remote}/${project.baseBranch}`;
  const hasRemote = (await tryGit(repo, ["rev-parse", "--verify", "--quiet", remoteRef])) !== undefined;
  const baseRef = hasRemote ? remoteRef : project.baseBranch;
  if (fs.existsSync(t.worktree) && (await tryGit(t.worktree, ["rev-parse", "--is-inside-work-tree"])) === "true") {
    // A retry keeps the agent's partial work. A fresh pick-up (e.g. after Forget) must not inherit a forgotten
    // run's commits or its old branch name, so it starts the ticket's branch again from base.
    if (!t.prUrl && t.attempts.length === 0) {
      await git(t.worktree, ["reset", "-q", "--hard"]);
      await git(t.worktree, ["clean", "-fdq"]);
      await git(t.worktree, ["checkout", "-q", "-B", t.branch, baseRef]);
      t.baseRef = baseRef;
      return `reusing worktree ${t.worktree}, reset to ${baseRef}`;
    }
    return `reusing worktree ${t.worktree}`;
  }
  // A ticket with a PR continues its pushed branch (e.g. the worktree was cleaned up and CI now fails).
  // A ticket without one is fresh work and starts from base, even if an old branch of the same name is still on the remote.
  // Trust the remote-tracking ref only when the fetch succeeds: a stale ref outlives a deleted remote branch.
  const remoteBranch = `${project.remote}/${t.branch}`;
  let pushed = false;
  if (t.prUrl) {
    const fetchedBranch = await exec("git", ["fetch", project.remote, t.branch], { cwd: repo, timeoutMs: 180_000 });
    if (fetchedBranch.code === 0) pushed = (await tryGit(repo, ["rev-parse", "--verify", "--quiet", remoteBranch])) !== undefined;
    else if (!(await branchGone(repo, project, t))) {
      throw new Error(`couldn't fetch ${remoteBranch}, which this PR is built on: ${(fetchedBranch.stderr || fetchedBranch.stdout).trim().slice(0, 300)}`);
    }
  }
  await tryGit(repo, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(t.worktree), { recursive: true });
  // Something else (a person's git, an editor) may hold .git/config.lock for a moment; one short retry covers it.
  const add = () => git(repo, ["worktree", "add", "-B", t.branch, t.worktree, pushed ? remoteBranch : baseRef]);
  await add().catch(async (e: Error) => {
    if (!/could not lock config file/.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, 500));
    // The failed add may have left a half-made worktree behind; clear it so the retry starts clean.
    await tryGit(repo, ["worktree", "remove", "--force", t.worktree]);
    await tryGit(repo, ["worktree", "prune"]);
    await add();
  });
  t.baseRef = baseRef;
  return pushed
    ? `recreated worktree from ${remoteBranch}`
    : `created worktree from ${baseRef}${fetched.code !== 0 ? " (fetch failed, using local ref)" : ""}`;
}

export async function headSha(wt: string) {
  return git(wt, ["rev-parse", "HEAD"]);
}

export async function hasUncommitted(wt: string) {
  return ((await git(wt, ["status", "--porcelain"])) || "").length > 0;
}

/** Files changed vs the base, committed or not, plus new untracked files (for the progress heartbeat). */
export async function changedFiles(wt: string, baseRef?: string) {
  const tracked = baseRef ? (await tryGit(wt, ["diff", "--name-only", baseRef])) || "" : "";
  const untracked = (await tryGit(wt, ["ls-files", "--others", "--exclude-standard"])) || "";
  return new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean)).size;
}

export async function commitAll(wt: string, message: string) {
  await git(wt, ["add", "-A"]);
  const r = await exec("git", ["commit", "-m", message], { cwd: wt, timeoutMs: 300_000 });
  if (r.code !== 0) await git(wt, ["commit", "--no-verify", "-m", message]);
}

/**
 * Rewrite the subject line of every commit in `range` (e.g. "origin/main..HEAD") for which `conform` returns a
 * different subject. Bodies and trailers are kept. Returns how many commits changed. Nothing runs when none would.
 */
export async function rewordCommits(wt: string, range: string, conform: (subject: string) => string): Promise<number> {
  const list = (await tryGit(wt, ["log", "--reverse", "--format=%H%x00%s", range])) || "";
  const map: Record<string, string> = {};
  for (const line of list.split("\n").filter(Boolean)) {
    const [sha, subject] = line.split("\0");
    const next = conform(subject);
    if (next !== subject) map[sha] = next;
  }
  const n = Object.keys(map).length;
  if (!n) return 0;
  const dir = path.join(wt, ".handsfree");
  fs.mkdirSync(dir, { recursive: true });
  const mapFile = path.join(dir, "reword.json");
  const script = path.join(dir, "reword.mjs");
  fs.writeFileSync(mapFile, JSON.stringify(map));
  // filter-branch feeds each message on stdin with GIT_COMMIT set; swap the first line when this commit is in the map.
  fs.writeFileSync(
    script,
    [
      'import fs from "node:fs";',
      "const map = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
      "const msg = fs.readFileSync(0, 'utf8');",
      "const next = map[process.env.GIT_COMMIT];",
      "process.stdout.write(next === undefined ? msg : next + msg.slice(msg.indexOf('\\n') === -1 ? msg.length : msg.indexOf('\\n')));",
    ].join("\n"),
  );
  const filter = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${JSON.stringify(mapFile)}`;
  const r = await exec("git", ["filter-branch", "-f", "--msg-filter", filter, range], {
    cwd: wt,
    timeoutMs: 300_000,
    env: { FILTER_BRANCH_SQUELCH_WARNING: "1" },
  });
  if (r.code !== 0) throw new Error(`git filter-branch: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  // filter-branch keeps backups under refs/original/; drop them so they don't confuse later worktree operations.
  await tryGit(wt, ["for-each-ref", "--format=%(refname)", "refs/original/"]).then(async (refs) => {
    for (const ref of (refs || "").split("\n").filter(Boolean)) await tryGit(wt, ["update-ref", "-d", ref]);
  });
  return n;
}

export async function commitsAhead(wt: string, baseRef: string) {
  return Number((await tryGit(wt, ["rev-list", "--count", `${baseRef}..HEAD`])) || 0);
}

/** True when the remote has no such branch any more (exit 2 from ls-remote). Network errors count as "not gone". */
async function branchGone(cwd: string, project: ProjectConfig, t: Ticket) {
  const ls = await exec("git", ["ls-remote", "--exit-code", "--heads", project.remote, t.branch], { cwd, timeoutMs: 60_000 });
  return ls.code === 2;
}

/**
 * Before building on a branch that already has a PR: bring the worktree level with what is on the remote
 * (someone may have pushed — "Update branch", a reviewer's suggestion, another machine). Fast-forwards when
 * the worktree is behind; refuses when the two diverged. Returns the remote head to lease the push on
 * (null when the remote branch is gone).
 */
export async function syncWithRemote(project: ProjectConfig, t: Ticket): Promise<{ remoteSha: string | null; fastForwarded: boolean }> {
  const f = await exec("git", ["fetch", project.remote, t.branch], { cwd: t.worktree, timeoutMs: 180_000 });
  if (f.code !== 0) {
    if (await branchGone(t.worktree, project, t)) return { remoteSha: null, fastForwarded: false };
    throw new Error(`couldn't fetch ${project.remote}/${t.branch}: ${(f.stderr || f.stdout).trim().slice(0, 300)}`);
  }
  const remoteSha = await git(t.worktree, ["rev-parse", "FETCH_HEAD"]);
  const local = await git(t.worktree, ["rev-parse", "HEAD"]);
  if (remoteSha === local) return { remoteSha, fastForwarded: false };
  const isAncestor = async (a: string, b: string) => (await exec("git", ["merge-base", "--is-ancestor", a, b], { cwd: t.worktree, timeoutMs: 60_000 })).code === 0;
  if (await isAncestor(local, remoteSha)) {
    await git(t.worktree, ["merge", "--ff-only", remoteSha]);
    return { remoteSha, fastForwarded: true };
  }
  if (await isAncestor(remoteSha, local)) return { remoteSha, fastForwarded: false }; // local is ahead: commits not pushed yet
  throw new Error(
    `${project.remote}/${t.branch} and this worktree have diverged (someone rewrote the branch). Open it in Terminal, merge or rebase onto ${project.remote}/${t.branch}, then press Fix CI again.`,
  );
}

/**
 * Push the branch. `leaseSha` (from syncWithRemote) pins --force-with-lease to the exact remote head the work was
 * built on, so a push never overwrites commits that landed meanwhile. `null` = the remote branch is gone.
 */
export async function push(project: ProjectConfig, t: Ticket, leaseSha?: string | null) {
  // A remote-tracking ref can outlive its branch (GitHub deletes merged branches). --force-with-lease would then
  // refuse with "stale info", so drop the stale ref — but only when the branch is really gone, to keep the lease honest.
  if (leaseSha === null || (leaseSha === undefined && (await branchGone(t.worktree, project, t)))) {
    await tryGit(t.worktree, ["update-ref", "-d", `refs/remotes/${project.remote}/${t.branch}`]);
  }
  const lease = leaseSha ? `--force-with-lease=refs/heads/${t.branch}:${leaseSha}` : "--force-with-lease";
  await git(t.worktree, ["push", "-u", lease, project.remote, `HEAD:refs/heads/${t.branch}`], 300_000);
}

export async function removeWorktree(project: ProjectConfig, t: Ticket) {
  if (fs.existsSync(t.worktree)) await git(project.repoPath, ["worktree", "remove", "--force", t.worktree]);
  await tryGit(project.repoPath, ["worktree", "prune"]);
  await tryGit(project.repoPath, ["branch", "-D", t.branch]);
}
