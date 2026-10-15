# PR Lifecycle Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HandsFree tracks each ticket's PR from "opened" to "merged": draft/ready sync and publish, CI-failure auto-fix in the same worktree, approved-not-merged nudges, merged cleanup with a tracker comment, dashboard sections for each stage, plus live-ticking relative times and a sidebar Refresh.

**Architecture:** The Node engine (`engine/src/`) gets a second poll timer that runs `gh pr view --json` per open PR, feeds the result through pure functions in a new `prstate.ts` (CI summary, status table, fix prompt), and stores the result under `Ticket.pr`. A CI fix is an ordinary ticket run with `Ticket.fix` set, so slots, logs, take-over and restart recovery are reused. Once-only side effects (review ready, merge nudge, merged, fix rounds exhausted) go through a tiny internal `PrEvents` emitter whose only subscriber today is a desktop notification plus a log line. The React UI (`src/`) groups tickets into four sections and adds Publish / Fix CI actions.

**Tech Stack:** Node 20 + TypeScript (esbuild bundle, `node --test` for unit tests, the existing `engine/test/e2e.mjs` with fake `gh`/`acli`/agents), React 18 + Vite, Tauri 2 shell (untouched), `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-10-15-pr-lifecycle-design.md` (roadmap: `docs/superpowers/specs/2026-10-15-handsfree-roadmap.md`)

## Global Constraints

- Node 20+ (engine bundle target `node20`); no new runtime dependencies.
- Types shared between engine and UI live in `engine/src/types.ts`; the UI imports them from `../engine/src/types`.
- All side effects (gh calls, Jira comments, worktree removal) happen in the engine, never in the UI.
- Per-project settings: `ciAutoFix` (default `true`), `ciFixMaxRounds` (default `2`, range 0..5), `mergeNudgeAfterMin` (default `30`, range 5..1440). App setting: `prPollIntervalMin` (default `3`, range 1..60).
- `pr_open` status is removed; existing state files are migrated on load.
- The "review ready" event fires only for non-draft PRs, once per PR. The merge nudge fires once per PR.
- Logs fed to the fix prompt: last 150 lines per run, 20 000 characters total.
- `npm run typecheck` (both tsconfigs) and `npm run test:engine` must pass after every task.
- Commit after every task; message style of the repo is a short imperative title (see `git log`).

## Review Focus

1. **Worktree already cleaned up when CI fails** — the fix must recreate the worktree from the remote branch `origin/handsfree/KEY`, not from the base branch, or the fix would push a branch that drops the original work. Pinned by the e2e step "cleanup then fix" in Task 5.
2. **Several failed jobs in the same GitHub Actions run** — `gh run view --log-failed` must run once per run id, not once per job, so logs are not duplicated past the cap. Pinned by the `dedupeChecks` unit test in Task 3.
3. **`statusCheckRollup` is `null`, empty, or contains an entry with neither `conclusion` nor `state`** — must yield `ci: "none"` / `"pending"` without throwing. Pinned by `summarizeChecks` unit tests in Task 3.
4. **Approval withdrawn (APPROVED → CHANGES_REQUESTED)** — the ticket must return to `pr_ready`, `approvedAt` cleared, and no nudge sent later for the stale approval. Pinned by `toPrInfo` / `nextStatus` unit tests in Task 3.
5. **Engine paused while CI fails** — no fix is queued, the status shows `pr_ci_failed`, and the next check after resume queues the fix (the "already fixed this SHA" marker must not be set while paused). Pinned by the e2e "paused" step in Task 5.

---

### Task 1: Live relative times and a sidebar Refresh (quick fixes)

**Files:**
- Modify: `src/ui.tsx` (add `useTick`)
- Modify: `src/App.tsx` (tick + Refresh button + resubscribe)
- Modify: `src/views/Dashboard.tsx` (tick)
- Modify: `src/styles.css` (spinner class)

**Interfaces:**
- Produces: `useTick(ms?: number): void` in `src/ui.tsx` — re-renders the calling component every `ms` (default 15 000).

- [ ] **Step 1: Add `useTick` to `src/ui.tsx`**

At the top of `src/ui.tsx` change the import line and add the hook after the imports:

```tsx
import { useEffect, useState } from "react";
import type { TicketStatus } from "../engine/src/types";

/** Re-render the caller every `ms`, so relative times ("in 11 min", "3 min ago") stay current. */
export function useTick(ms = 15_000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}
```

- [ ] **Step 2: Tick the sidebar and add Refresh in `src/App.tsx`**

Replace the import of `./ui` and the first `useEffect` with the versions below, and add a `refreshing` state. The subscription effect now depends on `gen`, so bumping `gen` tears down the old `EventSource`, refetches config and state, and resubscribes.

```tsx
import { Icon, Logo, until, useTick } from "./ui";
```

Inside `App()` right after the `useState` lines:

```tsx
  const [gen, setGen] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  useTick();

  useEffect(() => {
    let unsub = () => {};
    let alive = true;
    setRefreshing(true);
    getApi()
      .then(async (a) => {
        setApi(a);
        const [c, s] = await Promise.all([a.getConfig(), a.getState()]);
        if (!alive) return;
        setConfig(c);
        setState(s);
        setError(undefined);
        unsub = a.subscribe((e) => {
          if (e.type === "state") setState(e.state);
          if (e.type === "config") setConfig(e.config);
          if (e.type === "notify") void notifyIfEnabled(e.title, e.body);
        });
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setRefreshing(false));
    return () => {
      alive = false;
      unsub();
    };
  }, [gen]);
```

Delete the old `useEffect(() => { let unsub = ...; getApi()... }, []);` block it replaces.

In the sidebar foot, replace the single Pause button row with:

```tsx
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={togglePause}>
              {paused ? Icon.play : Icon.pause} {paused ? "Resume" : "Pause"}
            </button>
            <button className="btn sm ghost" onClick={() => setGen((g) => g + 1)} disabled={refreshing} title="Reload config and state from the engine">
              <span className={refreshing ? "spin" : ""}>{Icon.refresh}</span> Refresh
            </button>
          </div>
```

- [ ] **Step 3: Tick the dashboard**

In `src/views/Dashboard.tsx` change the `../ui` import to include `useTick` and call it as the first line of `Dashboard()`:

```tsx
import { ago, duration, Icon, Logo, StatusBadge, until, useTick } from "../ui";
```

```tsx
export function Dashboard({ ... }) {
  useTick();
  const [selected, setSelected] = useState<string | undefined>(initialTicket);
```

- [ ] **Step 4: Spinner CSS**

Append to `src/styles.css`:

```css
.spin { display: inline-flex; animation: hf-spin 0.9s linear infinite; }
@keyframes hf-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 5: Typecheck and eyeball**

Run: `npm run typecheck`
Expected: no output (exit 0).

Run: `npm run dev` and open the printed URL (browser demo uses mock data). Confirm the sidebar "Next check in N min" counts down over a minute, the Dashboard "Updated" column changes, and the Refresh button spins briefly then returns.

- [ ] **Step 6: Commit**

```bash
git add src/ui.tsx src/App.tsx src/views/Dashboard.tsx src/styles.css
git commit -m "Dashboard: relative times tick live; sidebar Refresh re-syncs with the engine"
```

---

### Task 2: Types, defaults, state migration, unit-test harness

**Files:**
- Modify: `engine/src/types.ts`
- Modify: `engine/src/store.ts`
- Modify: `engine/src/orchestrator.ts` (only `loadState(this.config)` and the `"pr_open"` string literals so it still compiles)
- Modify: `src/ui.tsx` (status labels), `src/views/Dashboard.tsx` (`ORDER`, `pr_open` references), `src/mock.ts` (statuses, settings), `engine/test/e2e.mjs` (config settings only)
- Modify: `package.json` (scripts)
- Create: `engine/test/store.test.mjs`

**Interfaces:**
- Produces (in `engine/src/types.ts`): `TicketStatus` union, `PR_STATUSES`, `CiStatus`, `FailedCheck`, `PrInfo`, `FixContext`, `PrEventKind`, `PrEvent`, new fields on `Ticket`, `ProjectConfig`, `Settings`, `EngineState`.
- Produces (in `engine/src/store.ts`): `migrateState(raw: Partial<EngineState> | undefined, cfg: Config): EngineState`, `loadState(cfg: Config): EngineState`.
- Produces: `npm run test:unit` builds `engine/src/{prstate,store}.ts` to `engine/dist/test/*.js` and runs `engine/test/*.test.mjs`.

- [ ] **Step 1: Write the failing migration test**

Create `engine/test/store.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateState } from "../dist/test/store.js";

const cfg = (draftPr) => ({ version: 1, settings: {}, projects: [{ id: "p1", draftPr }] });
const ticket = (status, projectId = "p1") => ({ key: "X-1", projectId, status, branch: "", worktree: "", agentIndex: 0, attempts: [], createdAt: "", updatedAt: "" });

test("pr_open becomes pr_draft for draft projects", () => {
  const s = migrateState({ tickets: { "X-1": ticket("pr_open") } }, cfg(true));
  assert.equal(s.tickets["X-1"].status, "pr_draft");
});

test("pr_open becomes pr_ready for ready-PR projects", () => {
  const s = migrateState({ tickets: { "X-1": ticket("pr_open") } }, cfg(false));
  assert.equal(s.tickets["X-1"].status, "pr_ready");
});

test("pr_open with an unknown project defaults to pr_draft", () => {
  const s = migrateState({ tickets: { "X-1": ticket("pr_open", "gone") } }, cfg(false));
  assert.equal(s.tickets["X-1"].status, "pr_draft");
});

test("other statuses, poll timestamps and error maps are kept; missing maps are created", () => {
  const s = migrateState({ tickets: { "X-1": ticket("running") }, lastPollAt: "a", nextPollAt: "b" }, cfg(true));
  assert.equal(s.tickets["X-1"].status, "running");
  assert.equal(s.lastPollAt, "a");
  assert.equal(s.nextPollAt, "b");
  assert.deepEqual(s.pollErrors, {});
  assert.deepEqual(s.prCheckErrors, {});
});

test("empty file gives an empty state", () => {
  assert.deepEqual(migrateState(undefined, cfg(true)).tickets, {});
});
```

- [ ] **Step 2: Add the unit-test scripts to `package.json`**

Replace the `scripts` block with:

```json
  "scripts": {
    "dev": "vite",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "build:engine": "esbuild engine/src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=engine/dist/handsfree-engine.mjs",
    "build:test": "esbuild engine/src/prstate.ts engine/src/store.ts --bundle --platform=node --format=esm --target=node20 --outdir=engine/dist/test",
    "engine": "npm run build:engine && node engine/dist/handsfree-engine.mjs",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p engine/tsconfig.json --noEmit",
    "test:unit": "npm run build:test && node --test engine/test/*.test.mjs",
    "test:e2e": "npm run build:engine && node engine/test/e2e.mjs",
    "test:engine": "npm run test:unit && npm run test:e2e",
    "tauri": "tauri"
  },
```

`engine/src/prstate.ts` does not exist yet; create it as an empty module for now so the build works:

```ts
// Pure helpers for PR state. Filled in by the next task.
export {};
```

- [ ] **Step 3: Run the test to see it fail**

Run: `npm run test:unit`
Expected: build succeeds, then `store.test.mjs` fails with `migrateState is not a function` (or a SyntaxError about the missing export).

- [ ] **Step 4: Extend `engine/src/types.ts`**

Replace the `ProjectConfig`, `Settings`, `TicketStatus`, `Ticket`, and `EngineState` definitions with the versions below (keep everything else as is):

```ts
export interface ProjectConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** Absolute path to the git repo. */
  repoPath: string;
  baseBranch: string;
  remote: string;
  jql: string;
  /** Placeholders: {jql}. Must print JSON (or text containing issue keys). */
  jiraSearchCommand: string;
  /** Placeholders: {issue_key} {body}. Leave empty to skip the Jira comment. */
  jiraCommentCommand: string;
  /** Project-level MCP servers, e.g. {"mcpServers": {...}}. Written to {mcp_file} in each worktree. */
  mcpJson: string;
  agents: AgentConfig[];
  /** Extra instructions appended to every prompt for this project. */
  promptExtra: string;
  draftPr: boolean;
  /** When CI fails on the PR, run the agent chain in the same worktree with the failing logs. */
  ciAutoFix: boolean;
  /** Automatic CI fix rounds per PR before the ticket needs you (0..5). Manual "Fix CI" ignores this. */
  ciFixMaxRounds: number;
  /** Minutes an approved PR may wait before HandsFree raises a merge nudge (5..1440). */
  mergeNudgeAfterMin: number;
}

export interface Settings {
  pollIntervalMin: number;
  /** How often open PRs are checked on GitHub (1..60 min). */
  prPollIntervalMin: number;
  maxParallel: number;
  agentTimeoutMin: number;
  /** Flag a running agent as slow (and notify) after this many minutes. */
  slowAfterMin: number;
  paused: boolean;
  notifications: boolean;
  launchAtLogin: boolean;
}
```

```ts
/**
 * Work phase: queued → running → (manual | failed | stopped).
 * PR phase: pr_draft | pr_ready | pr_ci_failed | pr_approved → merged | done.
 * "manual" = you took over. "done" = PR closed without merge (and legacy tickets).
 * A CI fix in progress is "running" with `ticket.fix` set.
 */
export type TicketStatus =
  | "queued"
  | "running"
  | "manual"
  | "failed"
  | "stopped"
  | "pr_draft"
  | "pr_ready"
  | "pr_ci_failed"
  | "pr_approved"
  | "merged"
  | "done";

/** Statuses with an open PR that the PR check keeps polling. */
export const PR_STATUSES: readonly TicketStatus[] = ["pr_draft", "pr_ready", "pr_ci_failed", "pr_approved"];

export type CiStatus = "none" | "pending" | "passing" | "failing";

export interface FailedCheck {
  name: string;
  detailsUrl?: string;
  /** GitHub Actions run id parsed from detailsUrl, when it is an Actions job. */
  runId?: string;
}

export interface PrInfo {
  url: string;
  number: number;
  draft: boolean;
  state: "open" | "merged" | "closed";
  headSha: string;
  ci: CiStatus;
  failedChecks: FailedCheck[];
  reviewDecision: "" | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  /** Newest approving review's submittedAt from GitHub. Cleared if the decision changes. */
  approvedAt?: string;
  mergedAt?: string;
  /** Set when the review_ready event fired. Once per PR. */
  reviewRequestedAt?: string;
  /** Set when the merge_nudge event fired. Once per PR. */
  mergeNudgedAt?: string;
  /** Completed CI-fix rounds on this PR. */
  fixRounds: number;
  /** Head SHA the last fix round was started for; prevents re-fixing the same failure. */
  lastFixSha?: string;
  checkedAt: string;
}

export interface FixContext {
  /** 1-based. */
  round: number;
  /** The failing commit. */
  headSha: string;
  failedChecks: FailedCheck[];
  /** Trimmed failing-step logs. */
  logs: string;
  requestedAt: string;
}

export type PrEventKind = "review_ready" | "merge_nudge" | "merged" | "ci_fix_exhausted";

export interface PrEvent {
  kind: PrEventKind;
  key: string;
  prUrl: string;
  projectId: string;
  at: string;
}
```

```ts
export interface Ticket {
  key: string;
  projectId: string;
  summary: string;
  description?: string;
  status: TicketStatus;
  branch: string;
  worktree: string;
  baseRef?: string;
  /** Index into the project's enabled agent chain the next run starts from. */
  agentIndex: number;
  currentAgent?: string;
  attempts: Attempt[];
  prUrl?: string;
  /** What GitHub last told us about the PR. Absent until the first PR check. */
  pr?: PrInfo;
  /** Present while a CI fix is queued or running. */
  fix?: FixContext;
  /** Set while the current agent has run longer than settings.slowAfterMin. */
  slow?: boolean;
  jiraCommented?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EngineState {
  tickets: Record<string, Ticket>;
  lastPollAt?: string;
  nextPollAt?: string;
  pollErrors: Record<string, string>;
  lastPrCheckAt?: string;
  nextPrCheckAt?: string;
  /** Per ticket key: the last `gh` error from the PR check. */
  prCheckErrors: Record<string, string>;
}
```

- [ ] **Step 5: Defaults and migration in `engine/src/store.ts`**

Change `DEFAULT_SETTINGS`:

```ts
export const DEFAULT_SETTINGS: Settings = {
  pollIntervalMin: 15,
  prPollIntervalMin: 3,
  maxParallel: 2,
  agentTimeoutMin: 90,
  slowAfterMin: 30,
  paused: false,
  notifications: true,
  launchAtLogin: false,
};
```

In `normalizeProject`, after `draftPr: p.draftPr ?? true,` add:

```ts
    ciAutoFix: p.ciAutoFix ?? true,
    ciFixMaxRounds: clamp(p.ciFixMaxRounds, 0, 5, 2),
    mergeNudgeAfterMin: clamp(p.mergeNudgeAfterMin, 5, 1440, 30),
```

and add the helper near `cryptoId`:

```ts
function clamp(v: unknown, min: number, max: number, dflt: number) {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== undefined && v !== "" ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}
```

Replace `loadState` with:

```ts
/** Upgrade a state file from an older HandsFree. Exported for tests. */
export function migrateState(raw: Partial<EngineState> | undefined, cfg: Config): EngineState {
  const tickets = raw?.tickets || {};
  for (const t of Object.values(tickets)) {
    // 0.1 had a single "pr_open"; the first PR check will set the exact status.
    if ((t.status as string) === "pr_open") {
      const p = cfg.projects.find((x) => x.id === t.projectId);
      t.status = p && p.draftPr === false ? "pr_ready" : "pr_draft";
    }
  }
  return {
    tickets,
    pollErrors: raw?.pollErrors || {},
    prCheckErrors: raw?.prCheckErrors || {},
    lastPollAt: raw?.lastPollAt,
    nextPollAt: raw?.nextPollAt,
    lastPrCheckAt: raw?.lastPrCheckAt,
    nextPrCheckAt: raw?.nextPrCheckAt,
  };
}

export function loadState(cfg: Config): EngineState {
  return migrateState(readJson<Partial<EngineState>>(STATE_FILE), cfg);
}
```

- [ ] **Step 6: Keep the engine and UI compiling**

`engine/src/orchestrator.ts`:
- `state: EngineState = loadState();` → `state: EngineState = loadState(this.config);` (the `config` field is declared first, so it is initialised first).
- In `checkMergedPrs`: `.filter((x) => x.status === "pr_open" && x.prUrl)` → `.filter((x) => PR_STATUSES.includes(x.status) && x.prUrl)`; add `PR_STATUSES` to the `./types` import (it is a value, so import it without `type`).
- In `runTicket` after `openPr`: `status: "pr_open"` → `status: p.draftPr ? "pr_draft" : "pr_ready"`.
- In `open()`: `if (t.status === "pr_open" || t.status === "done")` → `if (PR_STATUSES.includes(t.status) || t.status === "merged" || t.status === "done")`.

`src/ui.tsx` `LABEL`:

```ts
const LABEL: Record<TicketStatus, string> = {
  queued: "Queued",
  running: "Running",
  manual: "With you",
  failed: "Failed",
  stopped: "Stopped",
  pr_draft: "Draft PR",
  pr_ready: "Ready for review",
  pr_ci_failed: "CI failing",
  pr_approved: "Approved",
  merged: "Merged",
  done: "Closed",
};
```

`src/views/Dashboard.tsx`:
- `const ORDER: TicketStatus[] = ["running", "manual", "failed", "stopped", "queued", "pr_ci_failed", "pr_draft", "pr_ready", "pr_approved", "merged", "done"];`
- `.filter((t) => showDone || t.status !== "done")` → `.filter((t) => showDone || (t.status !== "done" && t.status !== "merged"))`
- Stat card: `{n("pr_open")}` → `{n("pr_draft") + n("pr_ready") + n("pr_ci_failed")}`
- `openLabel` / `openHint`: replace both `ticket.status === "pr_open"` with `PR_STATUSES.includes(ticket.status)` and import `PR_STATUSES` from `../../engine/src/types` (value import).

`src/mock.ts`:
- settings: add `prPollIntervalMin: 3,`
- both projects: add `ciAutoFix: true, ciFixMaxRounds: 2, mergeNudgeAfterMin: 30,`
- the two `status: "pr_open"` tickets → `status: "pr_draft"`
- `demoState` returns: add `prCheckErrors: {}` next to `pollErrors: {}` (both the empty and busy branches)
- `open:` mock: `t.status !== "pr_open" && t.status !== "done"` → `!PR_STATUSES.includes(t.status) && t.status !== "merged" && t.status !== "done"` (import `PR_STATUSES`).

`engine/test/e2e.mjs`:
- In the config written to `config.json` add `prPollIntervalMin: 60` to `settings` (the test drives PR checks explicitly in later tasks).
- Replace every `"pr_open"` expectation with `"pr_draft"` (three places: `DEMO-1 pr_open`, "opening a PR'd ticket doesn't take it over", `DEMO-2 pr_open`, and the hand-back wait `t.status === "pr_open"`).

- [ ] **Step 7: Run tests and typecheck**

Run: `npm run test:unit`
Expected: 5 passing tests in `store.test.mjs`.

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm run test:e2e`
Expected: `✅ e2e passed` (the merged-PR step still passes because the fake `gh pr view` prints `MERGED` and `checkMergedPrs` is unchanged).

- [ ] **Step 8: Commit**

```bash
git add engine/src/types.ts engine/src/store.ts engine/src/prstate.ts engine/src/orchestrator.ts engine/test/store.test.mjs engine/test/e2e.mjs src/ui.tsx src/views/Dashboard.tsx src/mock.ts package.json
git commit -m "PR lifecycle types, per-project CI/nudge settings, pr_open migration, unit test harness"
```

---

### Task 3: Pure PR state helpers (`prstate.ts`)

**Files:**
- Modify: `engine/src/prstate.ts`
- Create: `engine/test/prstate.test.mjs`

**Interfaces:**
- Produces (all in `engine/src/prstate.ts`):
  - `interface RawCheck { __typename?: string; name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }`
  - `interface RawPr { number: number; url: string; state: "OPEN" | "MERGED" | "CLOSED"; isDraft: boolean; headRefOid: string; mergedAt: string | null; reviewDecision: string; latestReviews: { state: string; submittedAt: string }[]; statusCheckRollup: RawCheck[] | null }`
  - `summarizeChecks(rollup: RawCheck[] | null | undefined): { ci: CiStatus; failed: FailedCheck[] }`
  - `toPrInfo(raw: RawPr, prev?: PrInfo, at?: string): PrInfo`
  - `nextStatus(pr: PrInfo): TicketStatus`
  - `shouldAutoFix(pr: PrInfo, p: Pick<ProjectConfig, "ciAutoFix" | "ciFixMaxRounds">): boolean`
  - `mergeNudgeDue(pr: PrInfo, p: Pick<ProjectConfig, "mergeNudgeAfterMin">, nowMs: number): boolean`
  - `dedupeChecks(checks: FailedCheck[]): FailedCheck[]`
  - `trimFailedLogs(parts: { name: string; detailsUrl?: string; log?: string; error?: string }[], maxLines?: number, maxChars?: number): string`
  - `buildFixPrompt(p: ProjectConfig, t: Ticket, fix: FixContext): string`

- [ ] **Step 1: Write the failing tests**

Create `engine/test/prstate.test.mjs`:

```js
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npm run test:unit`
Expected: `prstate.test.mjs` fails on import (`summarizeChecks` is not exported).

- [ ] **Step 3: Implement `engine/src/prstate.ts`**

```ts
// Pure helpers for the PR lifecycle: no I/O, so they are unit-tested without `gh`.
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

export function summarizeChecks(rollup: RawCheck[] | null | undefined): { ci: CiStatus; failed: FailedCheck[] } {
  const failed: FailedCheck[] = [];
  let pending = false;
  let ok = 0;
  for (const c of rollup || []) {
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

export function buildFixPrompt(p: Pick<ProjectConfig, "baseBranch" | "promptExtra">, t: Pick<Ticket, "key" | "summary" | "branch" | "baseRef" | "prUrl" | "description" | "attempts">, fix: FixContext) {
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
    `- Commit with clear messages starting with "${t.key}: fix CI —". Do NOT push and do NOT touch the pull request — HandsFree pushes after you finish.`,
    "- Nobody is watching. Don't ask questions or wait for input; make reasonable assumptions and list them at the end.",
    "- Ignore the `.handsfree/` folder.",
    "- Finish with a short summary: what was failing, what you changed, and how you verified it.",
    ...(prev.length
      ? ["", "## Earlier attempts at this fix", ...prev.map((a) => `- ${a.agentName}: ${a.outcome || "failed"}${a.note ? ` (${a.note})` : ""}`), "Another agent already tried in this worktree. Start with `git status` and `git log`."]
      : []),
    ...(p.promptExtra.trim() ? ["", "## Project notes", p.promptExtra.trim()] : []),
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:unit`
Expected: all tests in `prstate.test.mjs` and `store.test.mjs` pass.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add engine/src/prstate.ts engine/test/prstate.test.mjs
git commit -m "prstate: pure CI summary, status table, nudge/fix rules and fix prompt"
```

---

### Task 4: GitHub PR check loop, merged/closed handling, PR events

**Files:**
- Modify: `engine/src/github.ts` (`fetchPr`, `publishPr`, `failedCheckLogs`; remove `prState`)
- Modify: `engine/src/git.ts` (`headSha`; `ensureWorktree` recreates from the remote branch when it exists)
- Create: `engine/src/prevents.ts`
- Modify: `engine/src/orchestrator.ts` (PR timer, `checkPrs`, `checkPr`, `onMerged`, default event subscriber, `cleanup` keeps PR status, `takeOver` allows `pr_ci_failed`)
- Modify: `engine/src/server.ts` (`POST /api/check-prs-now`)
- Modify: `engine/test/e2e.mjs` (JSON fake `gh pr view`, merged flow)

**Interfaces:**
- Consumes: `toPrInfo`, `nextStatus`, `mergeNudgeDue`, `dedupeChecks`, `trimFailedLogs`, `PR_JSON_FIELDS`, `RawPr` from `./prstate`.
- Produces:
  - `github.fetchPr(repoPath: string, url: string): Promise<RawPr>`, `github.publishPr(repoPath: string, url: string): Promise<void>`, `github.failedCheckLogs(repoPath: string, checks: FailedCheck[]): Promise<string>`
  - `git.headSha(wt: string): Promise<string>`
  - `class PrEvents { on(fn: (e: PrEvent) => void): () => void; emit(e: PrEvent): void }`
  - Orchestrator: `prEvents: PrEvents`, `schedulePrCheck(delayMs?)`, `checkPrs()`, `private checkPr(t: Ticket): Promise<void>`, `private onMerged(p, t)`. Task 5 adds `queueFix` inside `checkPr` at the marked spot.
  - Route: `POST /api/check-prs-now`.

- [ ] **Step 1: Update the e2e fake `gh` and the merged assertions (failing test first)**

In `engine/test/e2e.mjs` replace the `script("gh", ...)` block with:

```js
// pr-<n>.json (written by the test) drives `gh pr view`; default = open draft, no checks.
script("gh", `
case "$1 $2" in
  "pr list") echo "" ;;
  "pr create") n=$(cat "${root}/prn" 2>/dev/null || echo 100); n=$((n+1)); echo $n > "${root}/prn"; echo "$@" >> "${root}/prs.log"; echo "https://github.com/acme/repo/pull/$n" ;;
  "pr view") n="\${3##*/}"; cat "${root}/pr-$n.json" 2>/dev/null || echo "{\\"number\\":$n,\\"url\\":\\"https://github.com/acme/repo/pull/$n\\",\\"state\\":\\"OPEN\\",\\"isDraft\\":true,\\"headRefOid\\":\\"aaa111\\",\\"mergedAt\\":null,\\"reviewDecision\\":\\"\\",\\"latestReviews\\":[],\\"statusCheckRollup\\":[]}" ;;
  "pr ready") echo "$@" >> "${root}/ready.log" ;;
  "run view") echo "$@" >> "${root}/runs.log"; echo "Run $3 ▸ job test"; echo "FAIL tests/greeting.test.js: expected hi, got hello" ;;
  "auth status") echo "Logged in to github.com as tester"; exit 0 ;;
esac`);
```

Add a helper after `waitFor`:

```js
const prJson = (n, over = {}) =>
  fs.writeFileSync(
    path.join(root, `pr-${n}.json`),
    JSON.stringify({ number: n, url: `https://github.com/acme/repo/pull/${n}`, state: "OPEN", isDraft: true, headRefOid: "aaa111", mergedAt: null, reviewDecision: "", latestReviews: [], statusCheckRollup: [], ...over }),
  );
const checkPrs = () => api("/api/check-prs-now", "POST");
const ticket = async (k) => (await api("/api/state")).tickets[k];
```

Replace the block that starts with `// merge → next poll removes worktree` with:

```js
  // ---- PR check: draft PR gets its PrInfo; merge → worktree removed, Jira told, status merged
  await checkPrs();
  const checked = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.pr?.headSha === "aaa111" && t;
  }, "DEMO-1 PrInfo after first check");
  assert.equal(checked.status, "pr_draft");
  assert.equal(checked.pr.ci, "none");

  prJson(101, { state: "MERGED", isDraft: false, mergedAt: "2026-10-15T10:00:00Z" });
  await checkPrs();
  const mergedT = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "merged" && t;
  }, "DEMO-1 merged");
  assert.ok(!fs.existsSync(wt), "worktree removed after merge");
  assert.equal(mergedT.pr.mergedAt, "2026-10-15T10:00:00Z");
  assert.match(fs.readFileSync(path.join(root, "comments.log"), "utf8"), /DEMO-1 .*Merged.*pull\/101/, "merge commented on Jira");
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /🔔 Merged/);
```

Also delete the now-unused `fs.writeFileSync(path.join(root, "prstate"), "MERGED");` line if it still exists.

Run: `npm run test:e2e`
Expected: FAIL at "DEMO-1 PrInfo after first check" (no `check-prs-now` route yet, `t.pr` never set).

- [ ] **Step 2: `engine/src/github.ts`**

Replace the file's `prState` function with these, and add the imports:

```ts
import { dedupeChecks, PR_JSON_FIELDS, trimFailedLogs, type RawPr } from "./prstate";
import type { FailedCheck, ProjectConfig, Ticket } from "./types";
```

```ts
/** Everything the PR check needs, in one `gh` call. Throws when gh fails (not found, not logged in, deleted PR). */
export async function fetchPr(repoPath: string, url: string): Promise<RawPr> {
  const out = await gh(repoPath, ["pr", "view", url, "--json", PR_JSON_FIELDS]);
  return JSON.parse(out) as RawPr;
}

/** Mark a draft PR ready for review. */
export async function publishPr(repoPath: string, url: string) {
  await gh(repoPath, ["pr", "ready", url]);
}

/**
 * Failing-step logs for the fix prompt: `gh run view --log-failed` once per Actions run,
 * a link line for checks without a run. Never throws; fetch errors become text.
 */
export async function failedCheckLogs(repoPath: string, checks: FailedCheck[]): Promise<string> {
  const parts = await Promise.all(
    dedupeChecks(checks).map(async (c) => {
      if (!c.runId) return { name: c.name, detailsUrl: c.detailsUrl };
      const r = await exec("gh", ["run", "view", c.runId, "--log-failed"], { cwd: repoPath, timeoutMs: 120_000 });
      return r.code === 0
        ? { name: c.name, detailsUrl: c.detailsUrl, log: r.stdout }
        : { name: c.name, detailsUrl: c.detailsUrl, error: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}` };
    }),
  );
  return trimFailedLogs(parts);
}
```

- [ ] **Step 3: `engine/src/git.ts`: `headSha` and recreate-from-remote**

Add:

```ts
export async function headSha(wt: string) {
  return git(wt, ["rev-parse", "HEAD"]);
}
```

In `ensureWorktree`, replace the lines from `const fetched = ...` to the `return` with:

```ts
  const fetched = await exec("git", ["fetch", project.remote, project.baseBranch], { cwd: repo, timeoutMs: 180_000 });
  const remoteRef = `${project.remote}/${project.baseBranch}`;
  const hasRemote = (await tryGit(repo, ["rev-parse", "--verify", "--quiet", remoteRef])) !== undefined;
  const baseRef = hasRemote ? remoteRef : project.baseBranch;
  // The branch may already be pushed (e.g. the worktree was cleaned up and CI now fails): continue it, don't restart from base.
  await exec("git", ["fetch", project.remote, t.branch], { cwd: repo, timeoutMs: 180_000 });
  const remoteBranch = `${project.remote}/${t.branch}`;
  const pushed = (await tryGit(repo, ["rev-parse", "--verify", "--quiet", remoteBranch])) !== undefined;
  await tryGit(repo, ["worktree", "prune"]);
  fs.mkdirSync(path.dirname(t.worktree), { recursive: true });
  await git(repo, ["worktree", "add", "-B", t.branch, t.worktree, pushed ? remoteBranch : baseRef]);
  t.baseRef = baseRef;
  return pushed
    ? `recreated worktree from ${remoteBranch}`
    : `created worktree from ${baseRef}${fetched.code !== 0 ? " (fetch failed, using local ref)" : ""}`;
```

- [ ] **Step 4: `engine/src/prevents.ts`**

```ts
import type { PrEvent } from "./types";

/** Internal, once-per-PR lifecycle events (review ready, merge nudge, merged, fix rounds exhausted). Not on the SSE stream. */
export class PrEvents {
  private subs = new Set<(e: PrEvent) => void>();
  on(fn: (e: PrEvent) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(e: PrEvent) {
    for (const s of this.subs) {
      try {
        s(e);
      } catch {
        /* a subscriber must never break the check loop */
      }
    }
  }
}
```

- [ ] **Step 5: Orchestrator: PR timer, check loop, merged/closed, default subscriber**

In `engine/src/orchestrator.ts`:

Imports: replace `import { openPr, prState } from "./github";` with `import { fetchPr, openPr } from "./github";`, add `import { PrEvents } from "./prevents";`, `import { mergeNudgeDue, nextStatus, toPrInfo, type RawPr } from "./prstate";`, and add `PrEvent`, `PrInfo` to the `./types` type imports. (Task 5 adds `failedCheckLogs`, `publishPr`, `headSha`, `buildFixPrompt`, `shouldAutoFix`.)

Fields (after `private stateTimer?`):

```ts
  /** Once-per-PR lifecycle events. Default subscriber: notification + log. Messaging (roadmap item 3) subscribes here too. */
  prEvents = new PrEvents();
  private prTimer?: NodeJS.Timeout;
  private checkingPrs = false;
```

`start()`: after `this.persist();` add:

```ts
    this.prEvents.on((e) => this.onPrEvent(e));
    this.schedulePrCheck(5000);
```

(`schedulePoll(3000)` stays.)

Add the default subscriber next to `notify`:

```ts
  private onPrEvent(e: PrEvent) {
    const t = this.state.tickets[e.key];
    const text: Record<PrEvent["kind"], [string, string]> = {
      review_ready: ["Ready for review", "CI passed on the published PR — time to ask the team to review"],
      merge_nudge: ["Waiting to be merged", "Approved, but still not merged"],
      merged: ["Merged", "PR merged — worktree removed"],
      ci_fix_exhausted: ["CI still failing", "Automatic fix rounds used up — needs you"],
    };
    const [title, body] = text[e.kind];
    this.log(e.key, `\n🔔 ${title} · ${body}\n`);
    this.notify(`${e.key}: ${title}`, `${body}${t ? ` · ${t.summary}` : ""}`, "pr");
  }
```

Replace `checkMergedPrs` (and its call in `poll()`: delete the `await this.checkMergedPrs();` line) with:

```ts
  // ---------- PR check (its own timer) ----------
  schedulePrCheck(delayMs?: number) {
    clearTimeout(this.prTimer);
    const ms = delayMs ?? this.config.settings.prPollIntervalMin * 60_000;
    this.state.nextPrCheckAt = new Date(Date.now() + ms).toISOString();
    this.persist();
    this.prTimer = setTimeout(() => void this.checkPrs(), ms);
  }

  async checkPrs() {
    if (this.checkingPrs) return;
    this.checkingPrs = true;
    try {
      for (const t of Object.values(this.state.tickets)) {
        if (!t.prUrl || !PR_STATUSES.includes(t.status) || this.running.has(t.key)) continue;
        await this.checkPr(t);
      }
      for (const key of Object.keys(this.state.prCheckErrors)) if (!this.state.tickets[key]) delete this.state.prCheckErrors[key];
      this.state.lastPrCheckAt = now();
    } finally {
      this.checkingPrs = false;
      this.schedulePrCheck();
      this.pump();
    }
  }

  /** Fetch one PR and apply the status table; once-only side effects are guarded by fields on `t.pr`. */
  private async checkPr(t: Ticket) {
    const p = this.project(t.projectId);
    if (!p) return;
    let raw: RawPr;
    try {
      raw = await fetchPr(p.repoPath, t.prUrl!);
      delete this.state.prCheckErrors[t.key];
    } catch (e) {
      this.state.prCheckErrors[t.key] = (e as Error).message;
      this.persist();
      return;
    }
    const pr = toPrInfo(raw, t.pr);
    t.pr = pr;
    const status = nextStatus(pr);
    const ev = (kind: PrEvent["kind"]): PrEvent => ({ kind, key: t.key, prUrl: pr.url, projectId: p.id, at: now() });

    if (status === "merged") return this.onMerged(p, t);
    if (status === "done") {
      await removeWorktree(p, t).catch((e) => this.log(t.key, `\n! PR closed but worktree removal failed: ${(e as Error).message}\n`));
      this.log(t.key, "\n✓ PR closed without merge — worktree removed\n");
      return this.touch(t, { status: "done", fix: undefined });
    }
    // TASK 5 INSERTS THE CI-FIX BRANCH HERE
    if (pr.ci === "passing" && !pr.draft && !pr.reviewRequestedAt) {
      pr.reviewRequestedAt = now();
      this.prEvents.emit(ev("review_ready"));
    }
    if (status === "pr_approved" && mergeNudgeDue(pr, p, Date.now())) {
      pr.mergeNudgedAt = now();
      this.prEvents.emit(ev("merge_nudge"));
    }
    if (status !== t.status) this.log(t.key, `\n◆ ${describeStatus(status, pr)}\n`);
    this.touch(t, { status });
  }

  private async onMerged(p: ProjectConfig, t: Ticket) {
    try {
      await removeWorktree(p, t);
      this.log(t.key, "\n✓ PR merged — worktree removed\n");
    } catch (e) {
      this.log(t.key, `\n! PR merged but worktree removal failed: ${(e as Error).message}\n`);
    }
    this.touch(t, { status: "merged", fix: undefined, error: undefined });
    try {
      const r = await commentOnIssue(p, t.key, `Merged: ${t.prUrl}\n${t.summary} — shipped by HandsFree.`);
      if (!r.skipped) this.log(t.key, "✓ Commented the merge on Jira\n");
    } catch (e) {
      this.log(t.key, `! Jira merge comment failed: ${(e as Error).message}\n`);
    }
    this.prEvents.emit({ kind: "merged", key: t.key, prUrl: t.prUrl!, projectId: p.id, at: now() });
  }

  checkPrsNow() {
    void this.checkPrs();
  }
```

Add at module level (next to `describe`):

```ts
function describeStatus(s: Ticket["status"], pr: PrInfo) {
  switch (s) {
    case "pr_draft": return `Draft PR · CI ${pr.ci}`;
    case "pr_ready": return `Ready for review · CI ${pr.ci}${pr.reviewDecision ? ` · ${pr.reviewDecision.toLowerCase().replace("_", " ")}` : ""}`;
    case "pr_ci_failed": return `CI failing: ${pr.failedChecks.map((c) => c.name).join(", ") || "unknown check"}`;
    case "pr_approved": return `Approved${pr.approvedAt ? ` at ${pr.approvedAt}` : ""} · waiting to be merged`;
    default: return s;
  }
}
```

Other orchestrator edits:
- `updateConfig`: after the `if (prevInterval !== ...) this.schedulePoll(1000);` line add
  `if (prevPr !== this.config.settings.prPollIntervalMin) this.schedulePrCheck(1000);` and declare `const prevPr = this.config.settings.prPollIntervalMin;` at the top of the method.
- `runTicket`, after `const url = await openPr(p, t, body);`: keep the status line from Task 2 and add `this.schedulePrCheck(3000);` right after `this.notify(\`Draft PR ready · ${t.key}\`, ...)` so the new PR gets its `PrInfo` quickly. Change the notification title to ``this.notify(`${p.draftPr ? "Draft PR" : "PR"} ready · ${t.key}`, t.summary, "pr")``.
- `cleanup(key)`: the PR is still open for PR statuses, so keep tracking it: replace `this.touch(t, { status: "done" });` with `this.touch(t, PR_STATUSES.includes(t.status) ? {} : { status: "done" });`.
- `takeOver`: allow `"pr_ci_failed"` in the status list: `["running", "failed", "stopped", "manual", "queued", "pr_ci_failed"]`.
- `shutdown()`: add `clearTimeout(this.prTimer);`.

- [ ] **Step 6: Route**

In `engine/src/server.ts` add to the `switch`:

```ts
        case "POST /api/check-prs-now":
          o.checkPrsNow();
          return send(200, {});
```

- [ ] **Step 7: Run everything**

Run: `npm run typecheck` → exit 0.
Run: `npm run test:engine` → unit tests pass and `✅ e2e passed`.

If the e2e hangs at "DEMO-1 PrInfo after first check", check the fake `gh` prints valid JSON: `bash -c 'cd <root>/bin && ./gh pr view https://x/pull/101'` from the temp dir printed at the start of the test.

- [ ] **Step 8: Commit**

```bash
git add engine/src/github.ts engine/src/git.ts engine/src/prevents.ts engine/src/orchestrator.ts engine/src/server.ts engine/test/e2e.mjs
git commit -m "PR check loop: PrInfo from gh, merged/closed handling, once-only PR events"
```

---

### Task 5: CI failure auto-fix, Publish, Fix CI

**Files:**
- Modify: `engine/src/orchestrator.ts` (`queueFix`, fix branch in `checkPr`, `runTicket` fix handling, `fail`, `publish`, `fixCi`, `retry`)
- Modify: `engine/src/server.ts` (`publish`, `fix-ci` routes)
- Modify: `src/api.ts` (`publish`, `fixCi`, `checkPrsNow`)
- Modify: `src/mock.ts` (same three methods)
- Modify: `engine/test/e2e.mjs` (fix scenarios)

**Interfaces:**
- Consumes: `buildFixPrompt`, `shouldAutoFix`, `failedCheckLogs`, `publishPr`, `headSha`, `FixContext`.
- Produces: Orchestrator `publish(key): Promise<void>`, `fixCi(key): Promise<void>`; routes `POST /api/tickets/:key/publish`, `POST /api/tickets/:key/fix-ci`; `Api.publish(key)`, `Api.fixCi(key)`, `Api.checkPrsNow()`.

- [ ] **Step 1: Extend the e2e (failing first)**

In `engine/test/e2e.mjs`, make the Claude fake prove it saw the CI logs: in `script("fakeclaude", ...)` change the first line to

```
test -f "$2" || exit 9; grep -q "Previous attempts" "$2" && echo "saw previous attempt"; grep -q "expected hi, got hello" "$2" && echo "saw ci logs"; test -f "$4" || exit 8; echo "hi" >> README.md; git add -A; git commit -qm "$HANDSFREE_ISSUE: greeting"
```

Then insert the following block **before** the `prJson(101, { state: "MERGED" ...` line added in Task 4 (so the merge happens last), and after `await waitFor(... "DEMO-2 pr_draft")` so the single slot is free:

```js
  const failing = (sha, runId) => ({
    isDraft: false, headRefOid: sha,
    statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `https://github.com/acme/repo/actions/runs/${runId}/job/9` }],
  });
  const commitsOnRemote = () => sh(`git rev-list --count main..handsfree/DEMO-1`, remote);

  // ---- Publish: gh pr ready + immediate re-check
  prJson(101, { isDraft: false });
  await api("/api/tickets/DEMO-1/publish", "POST", {});
  assert.match(fs.readFileSync(path.join(root, "ready.log"), "utf8"), /pull\/101/);
  assert.equal((await ticket("DEMO-1")).status, "pr_ready");

  // ---- Paused: CI failure is recorded, no fix queued, and nothing marks the SHA as handled
  await api("/api/pause", "POST");
  prJson(101, failing("aaa111", 555));
  await checkPrs();
  const pausedT = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ci_failed" && t;
  }, "pr_ci_failed while paused");
  assert.equal(pausedT.fix, undefined);
  assert.equal(pausedT.pr.lastFixSha, undefined);
  await api("/api/resume", "POST");

  // ---- Fix round 1: logs fetched, agent chain runs in the same worktree, fix pushed
  await checkPrs();
  const fixed1 = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ready" && t.pr?.fixRounds === 1 && t;
  }, "fix round 1 pushed", 60000);
  assert.equal(fixed1.fix, undefined);
  assert.equal(fixed1.pr.lastFixSha, "aaa111");
  assert.equal(fixed1.pr.ci, "pending");
  assert.match(fs.readFileSync(path.join(root, "runs.log"), "utf8"), /run view 555 --log-failed/);
  const fixLog = (await api("/api/tickets/DEMO-1/log")).log;
  assert.match(fixLog, /queuing fix round 1\/2/);
  assert.match(fixLog, /saw ci logs/);
  assert.match(fixLog, /⇡ Pushed fix round 1/);
  assert.equal(commitsOnRemote(), "2", "fix commit pushed on top of the feature commit");
  assert.equal(fs.readFileSync(path.join(wt, ".handsfree", "prompt.md"), "utf8").includes("CI failed on https://github.com/acme/repo/pull/101"), true);

  // ---- GitHub still reports the old failing SHA → shown as failing, but not fixed twice
  await checkPrs();
  const stale = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ci_failed" && t;
  }, "stale failure shown");
  assert.equal(stale.pr.fixRounds, 1, "same SHA not fixed twice");
  assert.equal(stale.fix, undefined);
  // ---- GitHub sees the pushed fix: new head, checks pending → back to ready
  prJson(101, { isDraft: false, headRefOid: "fix1", statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }] });
  await checkPrs();
  await waitFor(async () => (await ticket("DEMO-1")).status === "pr_ready", "pending CI on the fixed head");

  // ---- Worktree cleaned up, then CI fails on the new head → worktree recreated from the remote branch
  await api("/api/tickets/DEMO-1/cleanup", "POST");
  assert.ok(!fs.existsSync(wt), "worktree removed by cleanup");
  assert.equal((await ticket("DEMO-1")).status, "pr_ready", "cleanup keeps tracking an open PR");
  prJson(101, failing("bbb222", 556));
  await checkPrs();
  const fixed2 = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.pr?.fixRounds === 2 && t.status === "pr_ready" && t;
  }, "fix round 2 pushed", 60000);
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /recreated worktree from origin\/handsfree\/DEMO-1/);
  assert.equal(commitsOnRemote(), "3", "round 2 continues the pushed branch instead of restarting from main");

  // ---- Rounds exhausted (max 2) → pr_ci_failed + one "needs you" event; manual Fix CI still works
  prJson(101, failing("ccc333", 557));
  await checkPrs();
  const exhausted = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ci_failed" && t;
  }, "rounds exhausted");
  assert.equal(exhausted.fix, undefined);
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /🔔 CI still failing/);
  await api("/api/tickets/DEMO-1/fix-ci", "POST", {});
  await waitFor(async () => (await ticket("DEMO-1")).pr?.fixRounds === 3, "manual fix round 3", 60000);

  // ---- CI passes on a published PR → review_ready once
  prJson(101, { isDraft: false, headRefOid: "ddd444", statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] });
  await checkPrs();
  const ready = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.pr?.reviewRequestedAt && t;
  }, "review_ready");
  assert.equal(ready.status, "pr_ready");
  await checkPrs();
  await sleep(800);
  assert.equal(((await api("/api/tickets/DEMO-1/log")).log.match(/🔔 Ready for review/g) || []).length, 1, "review_ready fired once");

  // ---- Approved 2 h ago → pr_approved and a merge nudge, once
  prJson(101, { isDraft: false, headRefOid: "ddd444", reviewDecision: "APPROVED", latestReviews: [{ state: "APPROVED", submittedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }], statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] });
  await checkPrs();
  const approved = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_approved" && t.pr.mergeNudgedAt && t;
  }, "approved + nudge");
  assert.ok(approved.pr.approvedAt);
  await checkPrs();
  await sleep(800);
  assert.equal(((await api("/api/tickets/DEMO-1/log")).log.match(/🔔 Waiting to be merged/g) || []).length, 1, "nudge fired once");
```

Also change the Task 4 merged block's `prJson(101, { state: "MERGED", isDraft: false, mergedAt: ... })` to include `headRefOid: "ddd444"` (cosmetic; keeps the fake consistent).

Run: `npm run test:e2e`
Expected: fails at the publish step (`/api/tickets/DEMO-1/publish` is 404 → `status` stays `pr_draft`).

- [ ] **Step 2: Orchestrator: queue and run fixes**

Imports: extend `./github` to `import { failedCheckLogs, fetchPr, openPr, publishPr } from "./github";`, add `headSha` to the `./git` import list, and extend `./prstate` to `import { buildFixPrompt, mergeNudgeDue, nextStatus, shouldAutoFix, toPrInfo, type RawPr } from "./prstate";`.

In `checkPr`, replace the `// TASK 5 INSERTS THE CI-FIX BRANCH HERE` comment with:

```ts
    if (pr.ci === "failing" && pr.headSha !== pr.lastFixSha) {
      if (shouldAutoFix(pr, p) && !this.config.settings.paused) return this.queueFix(p, t, pr);
      if (!this.config.settings.paused && pr.fixRounds >= p.ciFixMaxRounds && t.status !== "pr_ci_failed") this.prEvents.emit(ev("ci_fix_exhausted"));
    }
```

Add after `onMerged`:

```ts
  /** Put the ticket back in the queue with the failing logs; `runTicket` sees `t.fix` and runs the fix prompt. */
  private async queueFix(p: ProjectConfig, t: Ticket, pr: PrInfo, manual = false) {
    const round = pr.fixRounds + 1;
    const max = manual ? Math.max(round, p.ciFixMaxRounds) : p.ciFixMaxRounds;
    const names = pr.failedChecks.map((c) => c.name).join(", ") || "unknown check";
    this.log(t.key, `\n✗ CI failed on ${pr.headSha.slice(0, 7)} (${names}) — queuing fix round ${round}/${max}${manual ? " (requested by you)" : ""}\n`);
    const logs = await failedCheckLogs(p.repoPath, pr.failedChecks);
    pr.lastFixSha = pr.headSha;
    this.touch(t, {
      status: "queued",
      error: undefined,
      agentIndex: 0,
      fix: { round, headSha: pr.headSha, failedChecks: pr.failedChecks, logs, requestedAt: now() },
    });
    this.pump();
  }

  // ---------- PR actions ----------
  async publish(key: string) {
    const t = this.state.tickets[key];
    const p = t && this.project(t.projectId);
    if (!t?.prUrl || !p) throw new Error("This ticket has no PR yet.");
    await publishPr(p.repoPath, t.prUrl);
    this.log(key, "\n⇡ Published — marked ready for review\n");
    await this.checkPr(t);
    this.persist();
  }

  /** Start a fix round now, regardless of the auto-fix setting and the round cap. */
  async fixCi(key: string) {
    const t = this.state.tickets[key];
    const p = t && this.project(t.projectId);
    if (!t?.prUrl || !p) throw new Error("This ticket has no PR yet.");
    if (this.running.has(key) || t.fix) throw new Error("A fix is already queued or running.");
    if (!t.pr || t.pr.ci !== "failing") throw new Error("CI isn't failing on this PR right now (press Check PRs now first).");
    await this.queueFix(p, t, t.pr, true);
  }
```

`retry(key)`: make a retry on a CI-failed ticket a manual fix:

```ts
  retry(key: string) {
    const t = this.state.tickets[key];
    if (!t || this.running.has(key)) return;
    if (t.status === "pr_ci_failed") return void this.fixCi(key).catch((e) => this.log(key, `! ${(e as Error).message}\n`));
    this.log(key, `\n↻ Retry requested at ${now()}\n`);
    this.touch(t, { status: "queued", error: undefined, agentIndex: 0 });
    this.pump();
  }
```

`fail(t, error, notifyUser)`: a failed fix round goes back to `pr_ci_failed`, and the round counts so a broken chain cannot loop:

```ts
  private fail(t: Ticket, error: string, notifyUser = true) {
    this.log(t.key, `\n✖ ${error}\n`);
    if (t.fix) {
      if (t.pr) t.pr.fixRounds = t.fix.round;
      this.touch(t, { status: "pr_ci_failed", error, fix: undefined, currentAgent: undefined, agentIndex: 0, slow: undefined });
    } else {
      this.touch(t, { status: "failed", error, currentAgent: undefined, agentIndex: 0, slow: undefined });
    }
    if (notifyUser) this.notify(`${t.key} failed`, error, "failed");
  }
```

`runTicket`:
- Replace `const alreadyDone = t.attempts.some((a) => a.outcome === "success") && !t.prUrl;` with
  ```ts
  // Skip the agents when the last attempt already succeeded (push/PR failed, or you handed back with your changes). A fix always runs them.
  const alreadyDone = !t.fix && t.attempts[t.attempts.length - 1]?.outcome === "success";
  ```
- In the `outcome === "stopped"` branch: `return this.touch(t, { status: t.fix ? "pr_ci_failed" : "stopped", fix: undefined, currentAgent: undefined, slow: undefined });` (a stop does not count a round).
- Replace the `// ---- push, PR, Jira ----` try block body with:

```ts
      this.touch(t, { currentAgent: undefined, slow: undefined });
      this.log(t.key, `\n⇡ Pushing ${t.branch}\n`);
      await push(p, t);
      const lastOk = [...t.attempts].reverse().find((a) => a.outcome === "success");
      const body = prBody(t, lastOk?.agentName || winner?.name || "agent", this.readLog(t.key, 20_000));
      // A ticket that already has a PR (CI fix, hand-back after cleanup) pushes to it; never open a second one.
      const url = t.prUrl || (await openPr(p, t, body));
      const sha = await headSha(t.worktree);
      if (t.fix) {
        const pr: PrInfo = { ...t.pr!, headSha: sha, ci: "pending", failedChecks: [], fixRounds: t.fix.round };
        this.log(t.key, `⇡ Pushed fix round ${t.fix.round} · ${sha.slice(0, 7)}\n`);
        this.touch(t, { prUrl: url, pr, status: nextStatus(pr), agentIndex: 0, fix: undefined });
        this.notify(`Fix pushed · ${t.key}`, `Round ${pr.fixRounds} · waiting for CI`, "pr");
      } else {
        // A hand-back on an existing PR keeps its PrInfo; a brand-new PR gets it on the next check.
        const pr = t.pr ? { ...t.pr, headSha: sha, ci: "pending" as const, failedChecks: [] } : undefined;
        const status = pr ? nextStatus(pr) : p.draftPr ? "pr_draft" : "pr_ready";
        this.log(t.key, `✓ ${p.draftPr ? "Draft PR" : "PR"} ${url}\n`);
        this.touch(t, { prUrl: url, pr, status, agentIndex: 0 });
        this.notify(`${p.draftPr ? "Draft PR" : "PR"} ready · ${t.key}`, t.summary, "pr");
      }
      this.schedulePrCheck(3000);
```

- Wrap the Jira "opened a PR" comment: `if (!t.jiraCommented) { try { ... } catch { ... } }` so fix rounds don't re-comment.
- In `runAgent`, replace `const prompt = buildPrompt(p, t, i > 0 || t.attempts.length > 1);` with
  `const prompt = t.fix ? buildFixPrompt(p, t, t.fix) : buildPrompt(p, t, i > 0 || t.attempts.length > 1);`.
- In `start()`, the re-queue loop already keeps `t.fix` (it only touches `status`/attempts); add to the log line: ``this.log(t.key, `\n↺ HandsFree restarted — re-queued${t.fix ? ` (CI fix round ${t.fix.round})` : ""}\n`)``.

- [ ] **Step 3: Routes and API client**

`engine/src/server.ts`: extend the ticket regex to `(retry|stop|cleanup|forget|log|open|takeover|handback|publish|fix-ci)` and inside the `if (m)` block, before `if (m[2] === "retry")`, add:

```ts
        if (m[2] === "publish" || m[2] === "fix-ci") {
          try {
            if (m[2] === "publish") await o.publish(key);
            else await o.fixCi(key);
            return send(200, {});
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        }
```

`src/api.ts`: in `interface Api` add

```ts
  /** `gh pr ready` on the ticket's draft PR, then re-check it. */
  publish(key: string): Promise<void>;
  /** Run a CI fix round now (ignores the auto-fix setting and the round cap). */
  fixCi(key: string): Promise<void>;
  checkPrsNow(): Promise<void>;
```

and in `createHttpApi` (next to `open`/`handBack`, which use the `action` helper that surfaces `{error}` messages):

```ts
    publish: (k) => action(`/api/tickets/${encodeURIComponent(k)}/publish`, {}),
    fixCi: (k) => action(`/api/tickets/${encodeURIComponent(k)}/fix-ci`, {}),
    checkPrsNow: () => call("/api/check-prs-now", "POST"),
```

`src/mock.ts`: add to the returned object

```ts
    publish: async (k) => {
      const t = state.tickets[k];
      if (t?.pr) {
        state = { ...state, tickets: { ...state.tickets, [k]: { ...t, status: "pr_ready", pr: { ...t.pr, draft: false } } } };
        emit({ type: "state", state });
      }
    },
    fixCi: ok,
    checkPrsNow: ok,
```

- [ ] **Step 4: Run everything**

Run: `npm run typecheck` → exit 0.
Run: `npm run test:engine` → `✅ e2e passed`.

Common failures: "fix round 1 pushed" times out → check the ticket log printed by the test for `✖`; the fake Claude must find `expected hi, got hello` in `prompt.md` (it is the second argument, `$2`, of the fake command).

- [ ] **Step 5: Commit**

```bash
git add engine/src/orchestrator.ts engine/src/server.ts src/api.ts src/mock.ts engine/test/e2e.mjs
git commit -m "CI auto-fix rounds in the same worktree, Publish and Fix CI actions"
```

---

### Task 6: Dashboard sections, PR details, demo data

**Files:**
- Modify: `src/views/Dashboard.tsx`
- Modify: `src/ui.tsx` (`StatusBadge` label override, `CiPill`, `ReviewPill`)
- Modify: `src/styles.css`
- Modify: `src/mock.ts` (tickets for every section)

**Interfaces:**
- Consumes: `Api.publish`, `Api.fixCi`, `Api.checkPrsNow`, `Ticket.pr`, `Ticket.fix`, `EngineState.nextPrCheckAt`, `EngineState.prCheckErrors`.
- Produces: `StatusBadge({ status, label? })`, `CiPill({ ci })`, `ReviewPill({ decision })` in `src/ui.tsx`.

- [ ] **Step 1: Pills and badge override in `src/ui.tsx`**

Replace `StatusBadge` with:

```tsx
export function StatusBadge({ status, label }: { status: TicketStatus; label?: string }) {
  return (
    <span className={`badge ${status}`}>
      <span className={`dot ${status === "running" ? "pulse" : ""}`} />
      {label || LABEL[status]}
    </span>
  );
}

export function CiPill({ ci }: { ci?: CiStatus }) {
  if (!ci || ci === "none") return <span className="pill faint">no CI</span>;
  const cls = ci === "passing" ? "ok" : ci === "failing" ? "bad" : "wait";
  const text = ci === "passing" ? "CI ✓" : ci === "failing" ? "CI ✕" : "CI …";
  return <span className={`pill ${cls}`}>{text}</span>;
}

export function ReviewPill({ decision }: { decision?: PrInfo["reviewDecision"] }) {
  if (!decision) return <span className="pill faint">no review</span>;
  const cls = decision === "APPROVED" ? "ok" : decision === "CHANGES_REQUESTED" ? "bad" : "wait";
  const text = decision === "APPROVED" ? "Approved" : decision === "CHANGES_REQUESTED" ? "Changes requested" : "Review needed";
  return <span className={`pill ${cls}`}>{text}</span>;
}
```

and change the type import to `import type { CiStatus, PrInfo, TicketStatus } from "../engine/src/types";`.

- [ ] **Step 2: CSS**

In `src/styles.css` replace `.badge.pr_open {...}` and `.badge.done {...}` with:

```css
.badge.pr_draft { background: var(--violet-soft); color: var(--violet); }
.badge.pr_ready { background: var(--blue-soft); color: var(--blue); }
.badge.pr_ci_failed { background: var(--red-soft); color: var(--red); }
.badge.pr_approved { background: var(--accent-soft); color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.badge.merged { background: var(--accent-soft); color: var(--accent); }
.badge.done { background: rgba(127, 140, 130, 0.14); color: var(--muted); }
.pill { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 6px; font-size: 11px; font-weight: 550; white-space: nowrap; }
.pill.ok { background: var(--accent-soft); color: var(--accent); }
.pill.bad { background: var(--red-soft); color: var(--red); }
.pill.wait { background: var(--amber-soft); color: var(--amber); }
.pill.faint { background: rgba(127, 140, 130, 0.14); color: var(--faint); }
.section-card { margin-bottom: 14px; }
.section-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px 4px; }
.section-head .count { font-size: 12px; color: var(--faint); font-weight: 500; }
.overdue { color: var(--amber); font-weight: 600; }
.err-line { color: var(--amber); font-size: 11.5px; }
```

Check `.stats` already becomes two columns on narrow widths (`@media` rule near line 246); the fifth card wraps, which is fine.

- [ ] **Step 3: Rewrite the list half of `src/views/Dashboard.tsx`**

Replace everything from `const ORDER` down to the end of the `Dashboard` function with:

```tsx
const WORK: TicketStatus[] = ["running", "manual", "failed", "stopped", "queued"];
const ORDER: TicketStatus[] = [...WORK, "pr_ci_failed", "pr_draft", "pr_ready", "pr_approved", "merged", "done"];

type Section = "work" | "prs" | "approved" | "merged";
function sectionOf(t: Ticket): Section {
  if (t.status === "pr_approved") return "approved";
  if (t.status === "merged" || t.status === "done") return "merged";
  if (PR_STATUSES.includes(t.status) || (t.fix && (t.status === "running" || t.status === "queued"))) return "prs";
  return "work";
}

export function Dashboard({
  api,
  config,
  state,
  initialTicket,
  onNewProject,
}: {
  api: Api;
  config: Config;
  state: EngineState;
  initialTicket?: string;
  onNewProject: () => void;
}) {
  useTick();
  const [selected, setSelected] = useState<string | undefined>(initialTicket);
  const [showClosed, setShowClosed] = useState(false);
  const [showAllMerged, setShowAllMerged] = useState(false);
  const projects = useMemo(() => Object.fromEntries(config.projects.map((p) => [p.id, p])), [config]);

  const sorted = useMemo(
    () => Object.values(state.tickets).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)),
    [state],
  );
  const by = (s: Section) => sorted.filter((t) => sectionOf(t) === s);
  const work = by("work");
  const prs = by("prs");
  const approved = by("approved");
  const mergedAll = by("merged").filter((t) => showClosed || t.status !== "done");
  const merged = showAllMerged ? mergedAll : mergedAll.slice(0, 20);
  const n = (s: TicketStatus) => sorted.filter((t) => t.status === s).length;
  const exhausted = sorted.filter((t) => t.status === "pr_ci_failed" && (t.pr?.fixRounds ?? 0) >= (projects[t.projectId]?.ciFixMaxRounds ?? 0)).length;

  if (config.projects.length === 0) return <FirstRun onNewProject={onNewProject} />;

  const sel = selected ? state.tickets[selected] : undefined;
  const pollErrors = Object.entries(state.pollErrors || {});
  const toggle = (t: Ticket) => setSelected(t.key === selected ? undefined : t.key);
  const rowCls = (t: Ticket) => (t.key === selected ? "selected" : "");
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const inState = (t: Ticket) => {
    if (t.status === "pr_approved" && t.pr?.approvedAt) return duration(t.pr.approvedAt);
    if (t.status === "running" && t.attempts.length) return duration(t.attempts[t.attempts.length - 1].startedAt);
    return ago(t.updatedAt);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">
            Jira checked {ago(state.lastPollAt)} · {config.settings.paused ? "paused" : `next ${until(state.nextPollAt)}`}
            {" · "}PRs checked {ago(state.lastPrCheckAt)} · next {until(state.nextPrCheckAt)}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => api.checkPrsNow()}>{Icon.refresh} Check PRs now</button>
          <button className="btn" onClick={() => api.pollNow()} disabled={config.settings.paused}>
            {Icon.refresh} Check Jira now
          </button>
        </div>
      </div>

      {pollErrors.map(([pid, err]) => (
        <div key={pid} className="callout err" style={{ marginBottom: 12 }}>
          <b>{projects[pid]?.name || pid}:</b> <span className="t">{err}</span>
        </div>
      ))}

      <div className="stats">
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--blue)" }} /> Running</div>
          <div className="stat-value">{n("running")} <small>/ {config.settings.maxParallel} slots</small></div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--faint)" }} /> Queued</div>
          <div className="stat-value">{n("queued")}</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--violet)" }} /> PRs open</div>
          <div className="stat-value">{prs.length}</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--accent)" }} /> Approved, waiting</div>
          <div className="stat-value">{approved.length}</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--red)" }} /> Needs attention</div>
          <div className="stat-value">{n("failed") + n("stopped") + exhausted}</div>
        </div>
      </div>

      <div className={`dash-grid ${sel ? "with-detail" : ""}`}>
        <div style={{ minWidth: 0 }}>
          {/* In progress */}
          <div className="card section-card" style={{ overflow: "hidden" }}>
            <div className="section-head"><div className="card-title" style={{ margin: 0 }}>In progress</div><span className="count">{work.length}</span></div>
            {work.length === 0 ? (
              <div className="empty" style={{ padding: "28px 20px" }}>
                <p style={{ marginBottom: 0 }}>Nothing running. HandsFree checks your JQL every {config.settings.pollIntervalMin} min.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className={`tickets ${sel ? "compact" : ""}`}>
                  <thead><tr><th>Ticket</th><th>Status</th><th>Agent chain</th><th>Updated</th></tr></thead>
                  <tbody>
                    {work.map((t) => (
                      <tr key={t.key} className={rowCls(t)} onClick={() => toggle(t)}>
                        <td><div className="key">{t.key}</div><div className="summary small muted">{t.summary}</div></td>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <StatusBadge status={t.status} />
                            {t.slow && t.status === "running" && <span className="badge stopped" title="Running longer than your “slow” setting">⏱ slow</span>}
                          </div>
                        </td>
                        <td><Chain ticket={t} project={projects[t.projectId]} /></td>
                        <td className="small muted">{inState(t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Pull requests */}
          {prs.length > 0 && (
            <div className="card section-card" style={{ overflow: "hidden" }}>
              <div className="section-head"><div className="card-title" style={{ margin: 0 }}>Pull requests</div><span className="count">{prs.length}</span></div>
              <div className="table-wrap">
                <table className={`tickets ${sel ? "compact" : ""}`}>
                  <thead><tr><th>Ticket</th><th>Status</th><th>CI</th><th>Review</th><th>Updated</th><th /></tr></thead>
                  <tbody>
                    {prs.map((t) => {
                      const p = projects[t.projectId];
                      const fixing = !!t.fix && (t.status === "running" || t.status === "queued");
                      const err = state.prCheckErrors?.[t.key];
                      return (
                        <tr key={t.key} className={rowCls(t)} onClick={() => toggle(t)}>
                          <td>
                            <div className="key">{t.key}</div>
                            <div className="summary small muted">{t.summary}</div>
                            {err && <div className="err-line" title={err}>PR check failed: {err.slice(0, 80)}</div>}
                          </td>
                          <td>
                            <StatusBadge
                              status={t.status}
                              label={fixing ? `${t.status === "queued" ? "Fix queued" : "Fixing CI"} ${t.fix!.round}/${Math.max(t.fix!.round, p?.ciFixMaxRounds ?? 0)}` : undefined}
                            />
                          </td>
                          <td><CiPill ci={t.pr?.ci} /></td>
                          <td><ReviewPill decision={t.pr?.reviewDecision} /></td>
                          <td className="small muted">{inState(t)}</td>
                          <td onClick={stop}>
                            <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                              {t.status === "pr_draft" && <button className="btn sm primary" onClick={() => api.publish(t.key)}>Publish</button>}
                              {t.status === "pr_ci_failed" && <button className="btn sm primary" onClick={() => api.fixCi(t.key)}>Fix CI</button>}
                              {t.prUrl && <button className="btn sm ghost" onClick={() => openExternal(t.prUrl!)}>PR ↗</button>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Approved, not merged */}
          {approved.length > 0 && (
            <div className="card section-card" style={{ overflow: "hidden" }}>
              <div className="section-head"><div className="card-title" style={{ margin: 0 }}>Approved, not merged</div><span className="count">{approved.length}</span></div>
              <div className="table-wrap">
                <table className={`tickets ${sel ? "compact" : ""}`}>
                  <thead><tr><th>Ticket</th><th>Approved</th><th>Waiting</th><th /></tr></thead>
                  <tbody>
                    {approved.map((t) => {
                      const limit = projects[t.projectId]?.mergeNudgeAfterMin ?? 30;
                      const waitedMin = t.pr?.approvedAt ? (Date.now() - new Date(t.pr.approvedAt).getTime()) / 60_000 : 0;
                      return (
                        <tr key={t.key} className={rowCls(t)} onClick={() => toggle(t)}>
                          <td><div className="key">{t.key}</div><div className="summary small muted">{t.summary}</div></td>
                          <td className="small muted">{ago(t.pr?.approvedAt)}</td>
                          <td className={`small ${waitedMin >= limit ? "overdue" : "muted"}`}>{t.pr?.approvedAt ? duration(t.pr.approvedAt) : "—"}{t.pr?.mergeNudgedAt ? " · nudged" : ""}</td>
                          <td onClick={stop}><div className="row" style={{ justifyContent: "flex-end" }}>{t.prUrl && <button className="btn sm ghost" onClick={() => openExternal(t.prUrl!)}>PR ↗</button>}</div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Merged */}
          {mergedAll.length > 0 && (
            <div className="card section-card" style={{ overflow: "hidden" }}>
              <div className="section-head">
                <div className="card-title" style={{ margin: 0 }}>Merged</div><span className="count">{mergedAll.length}</span>
                <div className="spacer" />
                <label className="row small muted" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed
                </label>
              </div>
              <div className="table-wrap">
                <table className={`tickets ${sel ? "compact" : ""}`}>
                  <thead><tr><th>Ticket</th><th>Status</th><th>Merged</th><th /></tr></thead>
                  <tbody>
                    {merged.map((t) => (
                      <tr key={t.key} className={rowCls(t)} onClick={() => toggle(t)}>
                        <td><div className="key">{t.key}</div><div className="summary small muted">{t.summary}</div></td>
                        <td><StatusBadge status={t.status} /></td>
                        <td className="small muted">{ago(t.pr?.mergedAt || t.updatedAt)}</td>
                        <td onClick={stop}><div className="row" style={{ justifyContent: "flex-end" }}>{t.prUrl && <button className="btn sm ghost" onClick={() => openExternal(t.prUrl!)}>PR ↗</button>}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mergedAll.length > 20 && !showAllMerged && (
                <div style={{ padding: "8px 14px 12px" }}><button className="btn sm ghost" onClick={() => setShowAllMerged(true)}>Show all {mergedAll.length}</button></div>
              )}
            </div>
          )}
        </div>

        {sel && <TicketDetail api={api} ticket={sel} project={projects[sel.projectId]} prError={state.prCheckErrors?.[sel.key]} onClose={() => setSelected(undefined)} />}
      </div>
    </div>
  );
}
```

Update the imports at the top of the file:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { PR_STATUSES, type Config, type EngineState, type ProjectConfig, type Ticket, type TicketStatus } from "../../engine/src/types";
import { openExternal, type Api } from "../api";
import { ago, CiPill, duration, Icon, Logo, ReviewPill, StatusBadge, until, useTick } from "../ui";
```

- [ ] **Step 4: PR block and actions in `TicketDetail`**

Change the signature to `function TicketDetail({ api, ticket, project, prError, onClose }: { api: Api; ticket: Ticket; project?: ProjectConfig; prError?: string; onClose: () => void })`.

Replace the `openLabel` / `openHint` definitions with:

```tsx
  const isPr = PR_STATUSES.includes(ticket.status);
  const fixing = !!ticket.fix && (ticket.status === "running" || ticket.status === "queued");
  const openLabel =
    ticket.status === "running" ? "👀 Open live" : ticket.status === "manual" ? "⌨ Reopen session" : isPr || ticket.status === "merged" ? "⌨ Open in Terminal" : "⌨ Take over";
  const openHint =
    ticket.status === "running"
      ? "See the agent working in Terminal. Press Enter there to take over and talk to it."
      : isPr || ticket.status === "merged"
        ? "Open the worktree and the last agent session in Terminal"
        : "Continue the last agent's session in Terminal, in this ticket's worktree";
```

In the action button row:
- `Open draft PR ↗` → `{ticket.prUrl && <button className="btn sm primary" onClick={() => openExternal(ticket.prUrl!)}>Open PR ↗</button>}`
- add after it:
  ```tsx
          {ticket.status === "pr_draft" && <button className="btn sm" onClick={() => run(() => api.publish(ticket.key))} title="gh pr ready — marks the PR ready for review">Publish</button>}
          {ticket.status === "pr_ci_failed" && <button className="btn sm primary" onClick={() => run(() => api.fixCi(ticket.key))} title="Run the agent chain on the failing checks now">Fix CI</button>}
  ```
- the "Open in Terminal" button condition `ticket.status !== "done"` → `ticket.status !== "done" && ticket.status !== "merged"`.
- `Retry chain` condition stays `failed || stopped`.
- `Clean up worktree` condition: `ticket.status !== "running" && ticket.status !== "done" && ticket.status !== "merged" && ticket.status !== "manual" && !fixing`.

In the `<dl className="kv">` block, after the Jira row add:

```tsx
          {ticket.pr && (
            <>
              <dt>PR</dt>
              <dd className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                #{ticket.pr.number} · {ticket.pr.draft ? "draft" : "ready"} <CiPill ci={ticket.pr.ci} /> <ReviewPill decision={ticket.pr.reviewDecision} />
                <span className="small faint">checked {ago(ticket.pr.checkedAt)}</span>
              </dd>
              {ticket.pr.failedChecks.length > 0 && (
                <>
                  <dt>Failing</dt>
                  <dd>
                    {ticket.pr.failedChecks.map((c) => (
                      <span key={c.name + (c.detailsUrl || "")} style={{ marginRight: 8 }}>
                        {c.detailsUrl ? <a href="#" onClick={(e) => { e.preventDefault(); openExternal(c.detailsUrl!); }}>{c.name} ↗</a> : c.name}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              <dt>Fix rounds</dt>
              <dd>{ticket.pr.fixRounds} / {project?.ciFixMaxRounds ?? "—"}{project && !project.ciAutoFix ? " (auto-fix off)" : ""}</dd>
              {ticket.pr.approvedAt && (<><dt>Approved</dt><dd>{ago(ticket.pr.approvedAt)}{ticket.pr.mergeNudgedAt ? " · nudge sent" : ""}</dd></>)}
              {ticket.pr.mergedAt && (<><dt>Merged</dt><dd>{ago(ticket.pr.mergedAt)}</dd></>)}
            </>
          )}
```

After the `{ticket.error && ...}` callout add:

```tsx
        {prError && <div className="callout err"><span className="t">PR check failed: {prError}</span></div>}
        {fixing && ticket.fix && (
          <div className="callout info">
            <span className="t">🔧 CI fix round {ticket.fix.round} on {ticket.fix.headSha.slice(0, 7)} · {ticket.fix.failedChecks.map((c) => c.name).join(", ")}</span>
          </div>
        )}
```

- [ ] **Step 5: Demo data in `src/mock.ts`**

Add a helper after `t(...)`:

```ts
const pr = (number: number, repo: string, over: Partial<PrInfo> = {}): PrInfo => ({
  url: `https://github.com/anywhere/${repo}/pull/${number}`,
  number,
  draft: false,
  state: "open",
  headSha: "9f3c2a1b7e",
  ci: "passing",
  failedChecks: [],
  reviewDecision: "",
  fixRounds: 0,
  checkedAt: ago(2),
  ...over,
});
```

(import `type PrInfo` from `../engine/src/types`.) Then adjust tickets:
- `CSW-1398` → `status: "pr_draft", pr: pr(2211, "chatsupport-web", { draft: true, ci: "pending" })`
- `SET-975` → `status: "pr_ci_failed", pr: pr(877, "setmore-api", { ci: "failing", fixRounds: 2, lastFixSha: "9f3c2a1b7e", failedChecks: [{ name: "unit tests", detailsUrl: "https://github.com/anywhere/setmore-api/actions/runs/771/job/1", runId: "771" }] }), error: "Every agent in the chain failed. Check the log, then Retry."`
- add
  ```ts
    t({ key: "CSW-1411", projectId: "p1", summary: "Rate-limit the public widget endpoint", status: "running", currentAgent: "Claude Code",
      prUrl: "https://github.com/anywhere/chatsupport-web/pull/2204", jiraCommented: true,
      pr: pr(2204, "chatsupport-web", { ci: "failing", lastFixSha: "9f3c2a1b7e", failedChecks: [{ name: "lint", runId: "802" }] }),
      fix: { round: 1, headSha: "9f3c2a1b7e", failedChecks: [{ name: "lint", runId: "802" }], logs: "", requestedAt: ago(6) },
      attempts: [{ agentName: "Claude Code", startedAt: ago(130), endedAt: ago(100), exitCode: 0, outcome: "success" }, { agentName: "Claude Code", startedAt: ago(5) }],
      createdAt: ago(131) }),
    t({ key: "CSW-1385", projectId: "p1", summary: "Export conversations as CSV", status: "pr_approved",
      prUrl: "https://github.com/anywhere/chatsupport-web/pull/2199", jiraCommented: true,
      pr: pr(2199, "chatsupport-web", { reviewDecision: "APPROVED", approvedAt: ago(48), mergeNudgedAt: ago(18) }),
      attempts: [{ agentName: "Claude Code", startedAt: ago(400), endedAt: ago(360), exitCode: 0, outcome: "success" }], createdAt: ago(401), updatedAt: ago(48) }),
  ```
- `CSW-1377` → `status: "merged", pr: pr(2190, "chatsupport-web", { state: "merged", mergedAt: ago(400), reviewDecision: "APPROVED", approvedAt: ago(460) })`
- Also set `prUrl` on the two new tickets (shown above) and `lastPrCheckAt: ago(2), nextPrCheckAt: new Date(Date.now() + 60_000).toISOString()` in the busy `demoState` return.

- [ ] **Step 6: Typecheck and eyeball the demo**

Run: `npm run typecheck` → exit 0.
Run: `npm run dev`, open the URL. Expect four sections: In progress (4 rows), Pull requests (3 rows: a draft with Publish, a CI-failed with Fix CI, a "Fixing CI 1/2" row), Approved not merged (1 row, "nudged", amber waiting), Merged (1 row). Click a PR row: the detail shows the PR block with pills, failing check links and fix rounds. Click Publish on the draft: it becomes "Ready for review" (mock).

- [ ] **Step 7: Commit**

```bash
git add src/views/Dashboard.tsx src/ui.tsx src/styles.css src/mock.ts
git commit -m "Dashboard: PR, approved and merged sections with CI/review pills, Publish and Fix CI"
```

---

### Task 7: Project and app settings, README

**Files:**
- Modify: `src/views/Projects.tsx` (CI auto-fix, max rounds, nudge delay in the Repository step and the Review step; `blankProject` defaults)
- Modify: `src/views/Settings.tsx` ("Check PRs every")
- Modify: `README.md`

**Interfaces:**
- Consumes: `ProjectConfig.ciAutoFix | ciFixMaxRounds | mergeNudgeAfterMin`, `Settings.prPollIntervalMin`.

- [ ] **Step 1: `blankProject` defaults**

In `src/views/Projects.tsx` `blankProject()` add after `draftPr: true,`:

```ts
    ciAutoFix: true,
    ciFixMaxRounds: 2,
    mergeNudgeAfterMin: 30,
```

- [ ] **Step 2: Fields in the Repository step**

After the `<div className="grid3">` block in `step === 0`, add:

```tsx
            <h3 className="card-title" style={{ marginTop: 22 }}>After the PR opens</h3>
            <p className="card-sub">HandsFree keeps checking the PR on GitHub (Settings → <i>Check PRs every</i>).</p>
            <div className="grid3">
              <div className="field">
                <label>CI fails</label>
                <div className="row" style={{ height: 34 }}>
                  <Toggle on={p.ciAutoFix} onChange={(v) => set({ ciAutoFix: v })} />
                  <span>{p.ciAutoFix ? "Agents fix it in the same worktree" : "Just show it as failing"}</span>
                </div>
              </div>
              <div className="field">
                <label>Max automatic fix rounds</label>
                <input className="input num-input" type="number" min={0} max={5} value={p.ciFixMaxRounds} onChange={(e) => set({ ciFixMaxRounds: Math.min(5, Math.max(0, Number(e.target.value) || 0)) })} />
                <span className="hint">Per PR. “Fix CI” on the dashboard always works.</span>
              </div>
              <div className="field">
                <label>Approved but not merged after</label>
                <div className="row">
                  <input className="input num-input" type="number" min={5} max={1440} value={p.mergeNudgeAfterMin} onChange={(e) => set({ mergeNudgeAfterMin: Math.min(1440, Math.max(5, Number(e.target.value) || 30)) })} />
                  <span className="muted">min</span>
                </div>
                <span className="hint">Then HandsFree nudges you (and, later, the team).</span>
              </div>
            </div>
```

In the Review step (`step === 4`) replace the `<dt>Cleanup</dt>` row with:

```tsx
              <dt>After the PR</dt>
              <dd>
                {p.ciAutoFix ? `CI failures fixed automatically, up to ${p.ciFixMaxRounds} round${p.ciFixMaxRounds === 1 ? "" : "s"}` : "CI failures only shown"} · nudge after {p.mergeNudgeAfterMin} min approved · worktree removed on merge, merge commented on the ticket
              </dd>
```

- [ ] **Step 3: App setting**

In `src/views/Settings.tsx` widen the `num` helper's key type to `"pollIntervalMin" | "prPollIntervalMin" | "maxParallel" | "agentTimeoutMin" | "slowAfterMin"` (add `slowAfterMin` only if the file already renders it; otherwise just add `prPollIntervalMin`) and add after the "Check Jira every" row:

```tsx
        <div className="setting-row">
          <div className="txt"><b>Check PRs every</b><span>How often open PRs are checked on GitHub for CI, reviews and merges.</span></div>
          {num("prPollIntervalMin", 1, 60)}<span className="muted">min</span>
        </div>
```

- [ ] **Step 4: README**

In `README.md`:
- Replace the pipeline diagram with:

```
Jira (acli, your JQL) ─▶ .worktrees/<KEY> ─▶ Agent 1 ──fails / rate-limited──▶ Agent 2 … ─▶ commit
                                                                     ─▶ git push ─▶ gh pr create --draft ─▶ Jira comment with PR link
PR open ─▶ checked every few minutes: draft/ready, CI, reviews
   CI fails   ─▶ failing logs ─▶ agent chain again in the same worktree ─▶ push (up to N rounds)
   CI passes  ─▶ "ready for review" notification (once, published PRs only)
   approved   ─▶ "waiting to be merged" nudge after N minutes
   merged     ─▶ worktree removed ─▶ Jira comment with the PR link
```

- Under "Using it", add a step 6:

```
6. **After the PR.** The dashboard groups tickets into *In progress*, *Pull requests*, *Approved, not merged* and *Merged*. **Publish** marks a draft ready (`gh pr ready`); publishing in the GitHub UI is picked up on the next check. When CI fails, HandsFree fetches the failing step logs (`gh run view --log-failed`) and runs the agent chain again in the same worktree, up to the project's *Max automatic fix rounds*; **Fix CI** starts a round by hand. Approved PRs that wait longer than the project's limit raise a nudge. Merged PRs get their worktree removed and a comment on the ticket.
```

- In the "Where things live" / settings area mention `Settings → Check PRs every` (default 3 min).

- [ ] **Step 5: Verify**

Run: `npm run typecheck` → exit 0.
Run: `npm run test:engine` → unit + `✅ e2e passed`.
Run: `npm run dev`, Projects → New project → Repository step shows the three new fields; Review step shows the "After the PR" line; Settings shows "Check PRs every".

- [ ] **Step 6: Commit**

```bash
git add src/views/Projects.tsx src/views/Settings.tsx README.md
git commit -m "Project settings for CI auto-fix and merge nudges, PR check interval, README"
```

---

## Self-review notes

- Spec coverage: §2.1 statuses/migration → Task 2; §2.2–2.6 types → Task 2; §3.1 github → Task 4; §3.2 prstate → Task 3 (`nextStatus` takes only `pr`, the ticket wasn't needed); §3.3 orchestrator → Tasks 4–5 (`handBack("pr")` goes through `runTicket`'s non-fix branch, which now derives the status from `t.pr` when present); §3.4 routes/api → Tasks 4–5; §3.5 UI → Tasks 1, 6, 7; §4.1–4.4 → Tasks 4–5; §4.5 quick fixes → Task 1 (plus `nextPrCheckAt` persisted in Task 2's `migrateState`); §5 errors → `prCheckErrors` in Task 4, shown in Task 6; §6 tests → Tasks 2–5; §7 migration → Task 2.
- Review Focus 1 → Task 4 Step 3 (`ensureWorktree`) + Task 5 e2e "cleanup then fix". 2 → Task 3 `dedupeChecks` test, used in Task 4 `failedCheckLogs`. 3 → Task 3 `summarizeChecks` tests. 4 → Task 3 `toPrInfo`/`nextStatus` tests. 5 → Task 5 e2e "paused" step.
