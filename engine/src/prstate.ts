// Pure helpers for the PR lifecycle: no I/O, so they are unit-tested without `gh`.
import { commitRule } from "./naming";
import type { CiStatus, FailedCheck, FixContext, PrInfo, ProjectConfig, Ticket, TicketStatus } from "./types";

/** One entry of `gh pr view --json statusCheckRollup`: a CheckRun (Actions) or a StatusContext (external CI). */
export interface RawCheck {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
  startedAt?: string;
}

/** The fields we ask `gh pr view --json` for. */
export interface RawPr {
  number: number;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headRefOid: string;
  mergedAt: string | null;
  reviewDecision: string;
  latestReviews: { state: string; submittedAt: string }[];
  statusCheckRollup: RawCheck[] | null;
}

export const PR_JSON_FIELDS = "number,url,state,isDraft,headRefOid,mergedAt,reviewDecision,latestReviews,statusCheckRollup";

const FAILING_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILING_STATES = new Set(["FAILURE", "ERROR"]);
const OK_STATES = new Set(["SUCCESS"]);

function failedCheck(name: string, url?: string): FailedCheck {
  const runId = /\/actions\/runs\/(\d+)/.exec(url || "")?.[1];
  return { name, detailsUrl: url, runId };
}

/**
 * GitHub keeps the old run next to the re-run in statusCheckRollup. Keep only the latest run per
 * workflow + job name (by startedAt, else by position), like `gh pr checks` does.
 */
function latestRuns(rollup: RawCheck[]): RawCheck[] {
  // Map keeps first-seen order; replacing a value keeps its slot, so the output order matches the input.
  const byKey = new Map<string, RawCheck>();
  rollup.forEach((c, i) => {
    const isRun = c.__typename === "CheckRun" || c.status !== undefined || c.conclusion !== undefined;
    const key = isRun ? `run:${c.workflowName || ""}/${c.name || c.context || ""}` : `ctx:${i}`;
    const prev = byKey.get(key);
    // Both timestamped: the later start wins. Otherwise the later entry in the list wins.
    const newer = !prev || (c.startedAt && prev.startedAt ? c.startedAt >= prev.startedAt : true);
    if (newer) byKey.set(key, c);
  });
  return [...byKey.values()];
}

export function summarizeChecks(rollup: RawCheck[] | null | undefined): { ci: CiStatus; failed: FailedCheck[] } {
  const failed: FailedCheck[] = [];
  let pending = false;
  let ok = 0;
  for (const c of latestRuns(rollup || [])) {
    const name = c.name || c.context || "check";
    const url = c.detailsUrl || c.targetUrl;
    const isContext = c.__typename === "StatusContext" || (c.state !== undefined && c.status === undefined && c.conclusion === undefined);
    if (isContext) {
      const st = (c.state || "").toUpperCase();
      if (FAILING_STATES.has(st)) failed.push(failedCheck(name, url));
      else if (OK_STATES.has(st)) ok++;
      else pending = true;
      continue;
    }
    const status = (c.status || "").toUpperCase();
    const conclusion = (c.conclusion || "").toUpperCase();
    if (status !== "COMPLETED" && !conclusion) {
      pending = true;
      continue;
    }
    if (FAILING_CONCLUSIONS.has(conclusion)) failed.push(failedCheck(name, url));
    else ok++;
  }
  const ci: CiStatus = failed.length ? "failing" : pending ? "pending" : ok ? "passing" : "none";
  return { ci, failed };
}

export function toPrInfo(raw: RawPr, prev?: PrInfo, at = new Date().toISOString()): PrInfo {
  const { ci, failed } = summarizeChecks(raw.statusCheckRollup);
  const decision = (raw.reviewDecision || "") as PrInfo["reviewDecision"];
  let approvedAt: string | undefined;
  if (decision === "APPROVED") {
    if (prev?.approvedAt && prev.reviewDecision === "APPROVED") approvedAt = prev.approvedAt;
    else {
      const times = (raw.latestReviews || []).filter((r) => r.state === "APPROVED").map((r) => r.submittedAt).filter(Boolean).sort();
      approvedAt = times[times.length - 1] || at;
    }
  }
  return {
    url: raw.url,
    number: raw.number,
    draft: !!raw.isDraft,
    state: raw.state === "MERGED" ? "merged" : raw.state === "CLOSED" ? "closed" : "open",
    headSha: raw.headRefOid,
    ci,
    failedChecks: failed,
    reviewDecision: decision,
    approvedAt,
    mergedAt: raw.mergedAt || prev?.mergedAt,
    reviewRequestedAt: prev?.reviewRequestedAt,
    mergeNudgedAt: prev?.mergeNudgedAt,
    fixRounds: prev?.fixRounds || 0,
    lastFixSha: prev?.lastFixSha,
    checkedAt: at,
  };
}

/** The status table from the spec (section 4.1). The orchestrator overrides pr_ci_failed with "queued" when it queues a fix. */
export function nextStatus(pr: PrInfo): TicketStatus {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "done";
  if (pr.ci === "failing") return "pr_ci_failed";
  if (!pr.draft && pr.reviewDecision === "APPROVED") return "pr_approved";
  return pr.draft ? "pr_draft" : "pr_ready";
}

export function shouldAutoFix(pr: PrInfo, p: Pick<ProjectConfig, "ciAutoFix" | "ciFixMaxRounds">) {
  return pr.ci === "failing" && pr.headSha !== pr.lastFixSha && p.ciAutoFix && pr.fixRounds < p.ciFixMaxRounds;
}

export function mergeNudgeDue(pr: PrInfo, p: Pick<ProjectConfig, "mergeNudgeAfterMin">, nowMs: number) {
  if (!pr.approvedAt || pr.mergeNudgedAt) return false;
  return nowMs - Date.parse(pr.approvedAt) >= p.mergeNudgeAfterMin * 60_000;
}

/** One log fetch per Actions run: several failed jobs usually share one run. */
export function dedupeChecks(checks: FailedCheck[]) {
  const seen = new Set<string>();
  return checks.filter((c) => {
    if (!c.runId) return true;
    if (seen.has(c.runId)) return false;
    seen.add(c.runId);
    return true;
  });
}

export function trimFailedLogs(parts: { name: string; detailsUrl?: string; log?: string; error?: string }[], maxLines = 150, maxChars = 20_000) {
  const sections = parts.map((p) => {
    if (p.log !== undefined) {
      const lines = p.log.replace(/\r/g, "").trimEnd().split("\n");
      const tail = lines.slice(-maxLines).join("\n");
      return `### ${p.name}\n${lines.length > maxLines ? `(last ${maxLines} of ${lines.length} lines)\n` : ""}${tail}`;
    }
    if (p.error) return `### ${p.name}\n(could not fetch the log: ${p.error})${p.detailsUrl ? `\n${p.detailsUrl}` : ""}`;
    return `### ${p.name}\n(no Actions log available)${p.detailsUrl ? ` ${p.detailsUrl}` : ""}`;
  });
  let out = sections.join("\n\n");
  if (out.length > maxChars) out = `(trimmed to the last ${maxChars} characters)\n` + out.slice(-maxChars);
  return out;
}

export function buildFixPrompt(
  p: Pick<ProjectConfig, "baseBranch" | "promptExtra" | "naming">,
  t: Pick<Ticket, "key" | "summary" | "type" | "branch" | "baseRef" | "prUrl" | "description" | "attempts">,
  fix: FixContext,
) {
  const prev = t.attempts.filter((a) => a.endedAt && Date.parse(a.startedAt) >= Date.parse(fix.requestedAt || "0"));
  return [
    `CI failed on ${t.prUrl} for ticket ${t.key}: ${t.summary}`,
    "",
    `Fix round ${fix.round}. Failing commit: ${fix.headSha.slice(0, 10)}.`,
    "",
    "## Failed checks",
    ...fix.failedChecks.map((c) => `- ${c.name}${c.detailsUrl ? ` (${c.detailsUrl})` : ""}`),
    "",
    "## Failing logs",
    "```",
    fix.logs.trim() || "(no logs captured; open the check links above or run the project's tests locally)",
    "```",
    "",
    "## Ticket",
    t.description?.trim() || "(No description was fetched.)",
    "",
    "## How to work",
    `- You are in a git worktree on branch \`${t.branch}\`, based on \`${t.baseRef || p.baseBranch}\`. The PR for this branch is already open. Only change files here.`,
    "- Fix the failing checks. Reproduce the failure locally where possible, then run the project's tests and linters and make them pass.",
    "- Do not revert or rewrite unrelated work on this branch; the earlier commits are the feature. Build on them.",
    `- ${commitRule(p.naming.commit, { key: t.key, summary: t.summary, type: t.type }, `Commit with clear messages starting with "${t.key}: fix CI —".`)} Do NOT push and do NOT touch the pull request — HandsFree pushes after you finish.`,
    "- Nobody is watching. Don't ask questions or wait for input; make reasonable assumptions and list them at the end.",
    "- Ignore the `.handsfree/` folder.",
    "- Finish with a short summary: what was failing, what you changed, and how you verified it.",
    ...(prev.length
      ? [
          "",
          "## Earlier attempts at this fix",
          ...prev.map((a) => `- ${a.agentName}: ${a.outcome || "failed"}${a.note ? ` (${a.note})` : ""}`),
          "Another agent already tried in this worktree. Start with `git status` and `git log`.",
        ]
      : []),
    ...(p.promptExtra.trim() ? ["", "## Project notes", p.promptExtra.trim()] : []),
  ].join("\n");
}
