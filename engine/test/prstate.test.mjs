import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixPrompt, dedupeChecks, mergeNudgeDue, nextStatus, shouldAutoFix, summarizeChecks, toPrInfo, trimFailedLogs } from "../dist/test/prstate.js";

const run = (name, conclusion, status = "COMPLETED", runId = "555") => ({
  __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://github.com/acme/repo/actions/runs/${runId}/job/9`,
});
const ctx = (context, state) => ({ __typename: "StatusContext", context, state, targetUrl: "https://ci.example/1" });

test("summarizeChecks: empty or null rollup is none", () => {
  assert.equal(summarizeChecks(null).ci, "none");
  assert.equal(summarizeChecks([]).ci, "none");
});

test("summarizeChecks: all success is passing; NEUTRAL/SKIPPED/CANCELLED count as ok", () => {
  assert.equal(summarizeChecks([run("a", "SUCCESS"), run("b", "NEUTRAL"), run("c", "SKIPPED"), run("d", "CANCELLED")]).ci, "passing");
});

test("summarizeChecks: any in-progress run is pending", () => {
  assert.equal(summarizeChecks([run("a", "SUCCESS"), run("b", null, "IN_PROGRESS")]).ci, "pending");
  assert.equal(summarizeChecks([ctx("lint", "PENDING")]).ci, "pending");
});

test("summarizeChecks: a failure wins over pending and lists failed checks with run ids", () => {
  const s = summarizeChecks([run("test", "FAILURE"), run("b", null, "QUEUED"), ctx("ext", "ERROR")]);
  assert.equal(s.ci, "failing");
  assert.deepEqual(s.failed, [
    { name: "test", detailsUrl: "https://github.com/acme/repo/actions/runs/555/job/9", runId: "555" },
    { name: "ext", detailsUrl: "https://ci.example/1", runId: undefined },
  ]);
});

test("summarizeChecks: TIMED_OUT, ACTION_REQUIRED and STARTUP_FAILURE are failures", () => {
  for (const c of ["TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) assert.equal(summarizeChecks([run("x", c)]).ci, "failing", c);
});

test("summarizeChecks: an entry with neither conclusion nor state is pending, not a crash", () => {
  assert.equal(summarizeChecks([{ name: "weird" }]).ci, "pending");
});

const raw = (over = {}) => ({
  number: 7, url: "https://github.com/acme/repo/pull/7", state: "OPEN", isDraft: false, headRefOid: "abc", mergedAt: null,
  reviewDecision: "", latestReviews: [], statusCheckRollup: [run("t", "SUCCESS")], ...over,
});

test("toPrInfo: maps fields and starts counters at zero", () => {
  const pr = toPrInfo(raw({ isDraft: true }), undefined, "2026-10-15T10:00:00Z");
  assert.equal(pr.draft, true);
  assert.equal(pr.state, "open");
  assert.equal(pr.ci, "passing");
  assert.equal(pr.fixRounds, 0);
  assert.equal(pr.checkedAt, "2026-10-15T10:00:00Z");
  assert.equal(pr.approvedAt, undefined);
});

test("toPrInfo: carries over once-only fields and fix counters", () => {
  const prev = { ...toPrInfo(raw()), reviewRequestedAt: "r", mergeNudgedAt: "m", fixRounds: 2, lastFixSha: "old" };
  const pr = toPrInfo(raw(), prev);
  assert.equal(pr.reviewRequestedAt, "r");
  assert.equal(pr.mergeNudgedAt, "m");
  assert.equal(pr.fixRounds, 2);
  assert.equal(pr.lastFixSha, "old");
});

test("toPrInfo: approvedAt is the newest approving review, kept stable while still approved, cleared when withdrawn", () => {
  const approved = raw({ reviewDecision: "APPROVED", latestReviews: [{ state: "APPROVED", submittedAt: "2026-10-15T08:00:00Z" }, { state: "APPROVED", submittedAt: "2026-10-15T09:00:00Z" }, { state: "COMMENTED", submittedAt: "2026-10-15T09:30:00Z" }] });
  const a = toPrInfo(approved);
  assert.equal(a.approvedAt, "2026-10-15T09:00:00Z");
  const b = toPrInfo(raw({ reviewDecision: "APPROVED", latestReviews: [{ state: "APPROVED", submittedAt: "2026-10-15T11:00:00Z" }] }), a);
  assert.equal(b.approvedAt, "2026-10-15T09:00:00Z", "first approval time is kept");
  const c = toPrInfo(raw({ reviewDecision: "CHANGES_REQUESTED" }), b);
  assert.equal(c.approvedAt, undefined);
});

test("toPrInfo: approved with no review timestamps falls back to the check time", () => {
  const pr = toPrInfo(raw({ reviewDecision: "APPROVED", latestReviews: [] }), undefined, "2026-10-15T10:00:00Z");
  assert.equal(pr.approvedAt, "2026-10-15T10:00:00Z");
});

test("nextStatus: the status table", () => {
  const base = toPrInfo(raw());
  assert.equal(nextStatus({ ...base, state: "merged" }), "merged");
  assert.equal(nextStatus({ ...base, state: "closed" }), "done");
  assert.equal(nextStatus({ ...base, ci: "failing" }), "pr_ci_failed");
  assert.equal(nextStatus({ ...base, ci: "failing", draft: true }), "pr_ci_failed");
  assert.equal(nextStatus({ ...base, reviewDecision: "APPROVED" }), "pr_approved");
  assert.equal(nextStatus({ ...base, reviewDecision: "APPROVED", draft: true }), "pr_draft", "a draft is never 'approved'");
  assert.equal(nextStatus({ ...base, draft: true }), "pr_draft");
  assert.equal(nextStatus({ ...base, ci: "pending" }), "pr_ready");
  assert.equal(nextStatus({ ...base, reviewDecision: "CHANGES_REQUESTED" }), "pr_ready");
});

test("shouldAutoFix: needs failing CI, a new head, the project flag and rounds left", () => {
  const pr = { ...toPrInfo(raw()), ci: "failing", headSha: "new", lastFixSha: "old", fixRounds: 1 };
  assert.equal(shouldAutoFix(pr, { ciAutoFix: true, ciFixMaxRounds: 2 }), true);
  assert.equal(shouldAutoFix({ ...pr, lastFixSha: "new" }, { ciAutoFix: true, ciFixMaxRounds: 2 }), false, "same head already fixed");
  assert.equal(shouldAutoFix({ ...pr, fixRounds: 2 }, { ciAutoFix: true, ciFixMaxRounds: 2 }), false, "rounds used");
  assert.equal(shouldAutoFix(pr, { ciAutoFix: false, ciFixMaxRounds: 2 }), false);
  assert.equal(shouldAutoFix({ ...pr, ci: "passing" }, { ciAutoFix: true, ciFixMaxRounds: 2 }), false);
});

test("mergeNudgeDue: once, after the delay, only while approved", () => {
  const t0 = Date.parse("2026-10-15T10:00:00Z");
  const pr = { ...toPrInfo(raw()), approvedAt: "2026-10-15T10:00:00Z" };
  assert.equal(mergeNudgeDue(pr, { mergeNudgeAfterMin: 30 }, t0 + 29 * 60_000), false);
  assert.equal(mergeNudgeDue(pr, { mergeNudgeAfterMin: 30 }, t0 + 30 * 60_000), true);
  assert.equal(mergeNudgeDue({ ...pr, mergeNudgedAt: "x" }, { mergeNudgeAfterMin: 30 }, t0 + 60 * 60_000), false);
  assert.equal(mergeNudgeDue({ ...pr, approvedAt: undefined }, { mergeNudgeAfterMin: 30 }, t0 + 60 * 60_000), false);
});

test("dedupeChecks: one entry per Actions run, checks without a run id are kept", () => {
  const d = dedupeChecks([
    { name: "unit", runId: "1", detailsUrl: "u1" },
    { name: "lint", runId: "1", detailsUrl: "u2" },
    { name: "ext", detailsUrl: "x" },
    { name: "e2e", runId: "2", detailsUrl: "u3" },
  ]);
  assert.deepEqual(d.map((c) => c.name), ["unit", "ext", "e2e"]);
});

test("trimFailedLogs: keeps the last N lines per run and caps the total", () => {
  const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const out = trimFailedLogs([{ name: "unit", detailsUrl: "u", log: long }, { name: "ext", detailsUrl: "https://ci.example/1" }, { name: "lint", error: "gh: not found" }], 150, 20_000);
  assert.match(out, /### unit/);
  assert.doesNotMatch(out, /\bline 149\b/, "older lines dropped");
  assert.match(out, /line 150\n/);
  assert.match(out, /line 299/);
  assert.match(out, /### ext\n.*https:\/\/ci\.example\/1/);
  assert.match(out, /### lint\n.*gh: not found/);
  const huge = trimFailedLogs([{ name: "a", log: "x".repeat(50_000) }], 150, 20_000);
  assert.ok(huge.length <= 20_100, `total capped, got ${huge.length}`);
});

test("buildFixPrompt: names the PR, the checks, the round, includes the logs and the commit rule", () => {
  const p = { baseBranch: "main", promptExtra: "Use pnpm." };
  const t = { key: "DEMO-1", summary: "Add greeting", branch: "handsfree/DEMO-1", baseRef: "origin/main", prUrl: "https://github.com/acme/repo/pull/7", description: "Say hi", attempts: [] };
  const fix = { round: 2, headSha: "abcdef0123", failedChecks: [{ name: "unit" }, { name: "lint" }], logs: "FAIL greeting.test.js", requestedAt: "" };
  const s = buildFixPrompt(p, t, fix);
  assert.match(s, /CI failed on https:\/\/github\.com\/acme\/repo\/pull\/7/);
  assert.match(s, /DEMO-1: Add greeting/);
  assert.match(s, /Fix round 2/);
  assert.match(s, /- unit\n- lint/);
  assert.match(s, /```\nFAIL greeting\.test\.js\n```/);
  assert.match(s, /"DEMO-1: fix CI/);
  assert.match(s, /Do NOT push/);
  assert.match(s, /## Project notes\nUse pnpm\./);
});

test("summarizeChecks: a re-run job supersedes its earlier failure (latest run per workflow+name wins)", () => {
  const old = { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-15T10:00:00Z", detailsUrl: "https://example.com/actions/runs/1/job/1" };
  const fresh = { __typename: "CheckRun", name: "test", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-15T10:30:00Z", detailsUrl: "https://example.com/actions/runs/2/job/1" };
  assert.equal(summarizeChecks([old, fresh]).ci, "passing");
  assert.equal(summarizeChecks([fresh, old]).ci, "passing", "order independent");
  const other = { ...old, workflowName: "Nightly" };
  assert.equal(summarizeChecks([other, fresh]).ci, "failing", "same name in another workflow is a different check");
  assert.equal(summarizeChecks([{ ...old, startedAt: undefined }, { ...fresh, startedAt: undefined }]).ci, "passing", "without timestamps the later entry wins");
});
