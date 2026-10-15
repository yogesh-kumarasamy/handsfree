import { fill, sh } from "./shell";
import { DEFAULT_JIRA_COMMENT, DEFAULT_JIRA_SEARCH, type FoundIssue, type ProjectConfig } from "./types";

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

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
      found.set(o.key, {
        key: o.key,
        summary: String(summary),
        description: d ? (typeof d === "string" ? d : adfToText(d)).trim() || undefined : undefined,
      });
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

export async function searchIssues(project: ProjectConfig): Promise<{ issues: FoundIssue[]; raw: string }> {
  const t = project.tracker;
  if (!t.query.trim()) throw new Error("No JQL set for this project.");
  const cmd = fill(t.searchCommand.trim() || DEFAULT_JIRA_SEARCH, { jql: t.query });
  const r = await sh(cmd, { timeoutMs: 90_000, cwd: project.repoPath || undefined });
  if (r.timedOut) throw new Error("The Jira search command timed out after 90s.");
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().slice(0, 600);
    throw new Error(
      r.code === 127 || /command not found/.test(msg)
        ? `Jira CLI not found. Install acli and run \`acli jira auth login\`, or change the search command.\n${msg}`
        : `Jira search failed (exit ${r.code}): ${msg}`,
    );
  }
  return { issues: parseIssues(r.stdout), raw: r.stdout.slice(0, 4000) };
}

export async function commentOnIssue(project: ProjectConfig, key: string, body: string) {
  const tpl = project.tracker.commentCommand.trim();
  if (tpl === "-") return { skipped: true as const };
  const r = await sh(fill(tpl || DEFAULT_JIRA_COMMENT, { issue_key: key, body }), { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 400) || `exit ${r.code}`);
  return { skipped: false as const };
}
