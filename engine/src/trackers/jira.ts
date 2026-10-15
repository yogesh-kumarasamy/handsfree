// Jira through the Atlassian CLI (`acli`), using the login already on the Mac.
import { issueTypeOf } from "../naming";
import { fill } from "../shell";
import { DEFAULT_JIRA_COMMENT, DEFAULT_JIRA_SEARCH, DEFAULT_JIRA_TRANSITION, TRACKER_NOUN, type FoundIssue } from "../types";
import { defaultRun, failure, type Run, type TicketRef, type TrackerAdapter, type TrackerProject } from "./adapter";

/** A `key` field in the JSON. One-letter project keys are accepted here; the text fallback below stays stricter. */
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

/** Atlassian Document Format → plain text. */
function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text") return n.text || "";
  const inner = (n.content || []).map(adfToText).join("");
  return ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(n.type || "") ? `${inner}\n` : inner;
}

export function parseIssues(output: string): FoundIssue[] {
  const found = new Map<string, FoundIssue>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, any>;
    if (typeof o.key === "string" && KEY_RE.test(o.key)) {
      const f = o.fields || {};
      const summary = f.summary ?? o.summary ?? "";
      const d = f.description ?? o.description;
      const issue: FoundIssue = {
        key: o.key,
        summary: String(summary),
        description: d ? (typeof d === "string" ? d : adfToText(d)).trim() || undefined : undefined,
      };
      const typeName = f.issuetype?.name ?? o.issuetype?.name;
      if (typeof typeName === "string" && typeName.trim()) issue.type = issueTypeOf(typeName);
      found.set(o.key, issue);
      return;
    }
    Object.values(o).forEach(visit);
  };
  try {
    visit(JSON.parse(output));
  } catch {
    // Not JSON: fall back to scanning for issue keys at line starts ("ABC-123  Summary text").
    for (const line of output.split("\n")) {
      const m = /\b([A-Z][A-Z0-9_]+-\d+)\b\s*[|:\-–]?\s*(.*)$/.exec(line.trim());
      if (m && !found.has(m[1])) found.set(m[1], { key: m[1], summary: m[2].trim() });
    }
  }
  return [...found.values()];
}

export class JiraTracker implements TrackerAdapter {
  readonly kind = "jira" as const;
  readonly noun = TRACKER_NOUN.jira;

  constructor(
    private p: TrackerProject,
    private run: Run = defaultRun,
  ) {}

  async search(): Promise<FoundIssue[]> {
    const t = this.p.tracker;
    if (!t.query.trim()) throw new Error("No JQL set for this project.");
    const cmd = fill(t.searchCommand.trim() || DEFAULT_JIRA_SEARCH, { jql: t.query });
    const r = await this.run(cmd, { timeoutMs: 90_000, cwd: this.p.repoPath || undefined });
    if (r.timedOut) throw new Error("The Jira search command timed out after 90s.");
    if (r.code !== 0) {
      const msg = failure(r);
      throw new Error(
        r.code === 127 || /command not found/.test(msg)
          ? `Jira CLI not found. Install acli and run \`acli jira auth login\`, or change the search command.\n${msg}`
          : `Jira search failed (exit ${r.code}): ${msg}`,
      );
    }
    return parseIssues(r.stdout);
  }

  async comment(t: TicketRef, body: string) {
    const tpl = this.p.tracker.commentCommand.trim();
    if (tpl === "-") return { skipped: true };
    const r = await this.run(fill(tpl || DEFAULT_JIRA_COMMENT, { issue_key: t.key, body }), { timeoutMs: 60_000, cwd: this.p.repoPath || undefined });
    if (r.code !== 0) throw new Error(failure(r).slice(0, 400));
    return { skipped: false };
  }

  async transition(t: TicketRef, status: string) {
    if (!status.trim()) return { skipped: true };
    const tpl = this.p.tracker.transitionCommand.trim() || DEFAULT_JIRA_TRANSITION;
    const r = await this.run(fill(tpl, { issue_key: t.key, status }), { timeoutMs: 60_000, cwd: this.p.repoPath || undefined });
    if (r.code !== 0) throw new Error(failure(r).slice(0, 400));
    return { skipped: false };
  }
}
