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
  if (fs.existsSync(t.worktree) && (await tryGit(t.worktree, ["rev-parse", "--is-inside-work-tree"])) === "true") {
    return `reusing worktree ${t.worktree}`;
  }
  const fetched = await exec("git", ["fetch", project.remote, project.baseBranch], { cwd: repo, timeoutMs: 180_000 });
  const remoteRef = `${project.remote}/${project.baseBranch}`;
  const hasRemote = (await tryGit(repo, ["rev-parse", "--verify", "--quiet", remoteRef])) !== undefined;
  const baseRef = hasRemote ? remoteRef : project.baseBranch;
  // The branch may already be pushed (e.g. the worktree was cleaned up and CI now fails): continue it, don't restart from base.
  // Trust the remote-tracking ref only when the fetch succeeds: a stale ref outlives a deleted remote branch.
  const fetchedBranch = await exec("git", ["fetch", project.remote, t.branch], { cwd: repo, timeoutMs: 180_000 });
  const remoteBranch = `${project.remote}/${t.branch}`;
  const pushed = fetchedBranch.code === 0 && (await tryGit(repo, ["rev-parse", "--verify", "--quiet", remoteBranch])) !== undefined;
  await tryGit(repo, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(t.worktree), { recursive: true });
  await git(repo, ["worktree", "add", "-B", t.branch, t.worktree, pushed ? remoteBranch : baseRef]);
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

export async function commitsAhead(wt: string, baseRef: string) {
  return Number((await tryGit(wt, ["rev-list", "--count", `${baseRef}..HEAD`])) || 0);
}

export async function push(project: ProjectConfig, t: Ticket) {
  // A remote-tracking ref can outlive its branch (GitHub deletes merged branches). --force-with-lease would then
  // refuse with "stale info", so drop the stale ref — but only when the branch is really gone, to keep the lease honest.
  const ls = await exec("git", ["ls-remote", "--exit-code", "--heads", project.remote, t.branch], { cwd: t.worktree, timeoutMs: 60_000 });
  if (ls.code === 2) await tryGit(t.worktree, ["update-ref", "-d", `refs/remotes/${project.remote}/${t.branch}`]);
  await git(t.worktree, ["push", "-u", "--force-with-lease", project.remote, `HEAD:refs/heads/${t.branch}`], 300_000);
}

export async function removeWorktree(project: ProjectConfig, t: Ticket) {
  if (fs.existsSync(t.worktree)) await git(project.repoPath, ["worktree", "remove", "--force", t.worktree]);
  await tryGit(project.repoPath, ["worktree", "prune"]);
  await tryGit(project.repoPath, ["branch", "-D", t.branch]);
}
