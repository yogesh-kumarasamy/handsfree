// GitHub Issues through the GitHub CLI (`gh`), using the login already on the Mac.
import { issueTypeOf, labelNames } from "../naming";
import { fill } from "../shell";
import { DEFAULT_GITHUB_CLOSE, DEFAULT_GITHUB_COMMENT, DEFAULT_GITHUB_SEARCH, TRACKER_NOUN, type FoundIssue } from "../types";
import { defaultRun, failure, type Run, type TicketRef, type TrackerAdapter, type TrackerProject } from "./adapter";

/** owner/name of a github.com remote (ssh, scp-like or https), else undefined. */
export function parseRepoFromRemote(url: string): string | undefined {
  const m = /(?:^|[@/])github\.com[:/]([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** `gh issue list --json number,title,body,url` output (or plain "#12 Title" lines) → issues keyed `<repo-name>#<number>`. */
export function parseGithubIssues(output: string, repoName: string): FoundIssue[] {
  const out: FoundIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }
  if (parsed !== undefined) {
    const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { issues?: unknown[] })?.issues) ? (parsed as { issues: unknown[] }).issues : [];
    for (const raw of list) {
      const i = raw as { number?: number | string; title?: string; body?: string; url?: string; labels?: unknown[] };
      if (i?.number === undefined || !/^\d+$/.test(String(i.number))) continue;
      const n = String(i.number);
      const issue: FoundIssue = { key: `${repoName}#${n}`, summary: String(i.title ?? ""), id: n };
      if (i.body?.trim()) issue.description = i.body;
      if (i.url) issue.url = i.url;
      const labels = labelNames(i.labels);
      if (labels.length) issue.type = issueTypeOf(labels);
      out.push(issue);
    }
    return out;
  }
  for (const line of output.split("\n")) {
    const m = /^#?(\d+)[\t ]+(.+)$/.exec(line.trim());
    if (!m) continue;
    // gh's plain table is "12<TAB>OPEN<TAB>Title<TAB>labels…"; "#12  Title" lines have just the title.
    const fields = m[2].split("\t").map((f) => f.trim()).filter(Boolean);
    const title = /^(OPEN|CLOSED)$/.test(fields[0] || "") ? fields[1] || "" : fields[0] || "";
    out.push({ key: `${repoName}#${m[1]}`, summary: title, id: m[1] });
  }
  return out;
}

export class GithubTracker implements TrackerAdapter {
  readonly kind = "github" as const;
  readonly noun = TRACKER_NOUN.github;
  private resolved?: string;

  constructor(
    private p: TrackerProject,
    private run: Run = defaultRun,
  ) {}

  /** OWNER/REPO from the Tracker step, or from the project's remote. */
  async repo(): Promise<string> {
    if (this.resolved) return this.resolved;
    const set = this.p.tracker.repo.trim();
    if (set) return (this.resolved = set);
    let remoteUrl = "";
    if (this.p.repoPath) {
      const r = await this.run(fill("git -C {path} remote get-url {remote}", { path: this.p.repoPath, remote: this.p.remote || "origin" }), { timeoutMs: 15_000 });
      if (r.code === 0) remoteUrl = r.stdout.trim();
    }
    const fromRemote = parseRepoFromRemote(remoteUrl);
    if (!fromRemote) throw new Error(`Set the GitHub repo (owner/name) in the Tracker step${remoteUrl ? ` — the remote ${remoteUrl} isn't on github.com` : ""}.`);
    return (this.resolved = fromRemote);
  }

  private async gh(cmd: string, what: string) {
    const r = await this.run(cmd, { timeoutMs: 90_000, cwd: this.p.repoPath || undefined });
    if (r.timedOut) throw new Error(`The GitHub ${what} command timed out.`);
    if (r.code !== 0) {
      const msg = failure(r);
      throw new Error(
        r.code === 127 || /command not found/.test(msg)
          ? `GitHub CLI not found. Install gh and run \`gh auth login\`, or change the ${what} command.\n${msg}`
          : `GitHub ${what} failed (exit ${r.code}): ${msg}`,
      );
    }
    return r.stdout;
  }

  private number(t: TicketRef) {
    const n = t.trackerId || /#(\d+)$/.exec(t.key)?.[1];
    if (!n) throw new Error(`Can't tell the issue number of ${t.key}.`);
    return n;
  }

  async search(): Promise<FoundIssue[]> {
    const t = this.p.tracker;
    // An empty filter would pick up every open issue in the repo.
    if (!t.query.trim()) throw new Error("No GitHub issue filter set for this project (e.g. assignee:@me label:handsfree).");
    const repo = await this.repo();
    const out = await this.gh(fill(t.searchCommand.trim() || DEFAULT_GITHUB_SEARCH, { repo, query: t.query }), "search");
    return parseGithubIssues(out, repo.split("/").pop() || repo);
  }

  async comment(t: TicketRef, body: string) {
    const tpl = this.p.tracker.commentCommand.trim();
    if (tpl === "-") return { skipped: true };
    const repo = await this.repo();
    await this.gh(fill(tpl || DEFAULT_GITHUB_COMMENT, { number: this.number(t), repo, body, issue_key: t.key }), "comment");
    return { skipped: false };
  }

  async transition(t: TicketRef, status: string) {
    if (!status.trim()) return { skipped: true };
    const repo = await this.repo();
    await this.gh(fill(this.p.tracker.transitionCommand.trim() || DEFAULT_GITHUB_CLOSE, { number: this.number(t), repo, status, issue_key: t.key }), "close");
    return { skipped: false };
  }
}
