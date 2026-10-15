# PR lifecycle core — design

Date: 2026-10-15. Roadmap item 2 (plus the item 1 quick fixes). See `2026-10-15-handsfree-roadmap.md` for the agreed decomposition and shared decisions.

## 1. Outcome

After this work, a ticket's PR is tracked by HandsFree from "opened" to "merged":

- The dashboard shows PRs in three sections: **Pull requests** (draft and ready, with CI and review status), **Approved, not merged**, and **Merged**.
- A draft PR can be published from the dashboard. If it is published (or reverted to draft) in the GitHub UI, HandsFree picks that up on its next PR check.
- When CI fails, HandsFree reads the failing check logs, runs the project's agent chain in the same worktree with that context, and pushes the fix. Capped per project; after the cap the ticket needs attention.
- When a PR is approved, it moves to "Approved, not merged" with the approval time. When it has waited longer than the project's nudge delay, HandsFree raises a `merge_nudge` event (desktop notification now; collab message in roadmap item 3).
- When CI passes on a published PR, HandsFree raises a `review_ready` event once (desktop notification now; collab message in item 3).
- When the PR merges, the worktree is removed, the ticket moves to **Merged**, and a short comment with the PR link goes to the tracker (Jira today). The status transition arrives with item 4.
- Relative times ("next check in 11 min", "3 min ago") update live. A sidebar Refresh button re-syncs the UI.

Out of scope here: sending messages anywhere other than macOS notifications, multi-select, tracker transitions, routines.

## 2. Data model

All types live in `engine/src/types.ts` (shared with the UI).

### 2.1 Ticket status

```ts
export type TicketStatus =
  | "queued" | "running" | "manual" | "failed" | "stopped"   // work phase (unchanged)
  | "pr_draft"      // PR open, isDraft
  | "pr_ready"      // PR open, not draft, CI none/pending/passing, not approved
  | "pr_ci_failed"  // PR open (draft or ready), CI failing, no fix running
  | "pr_approved"   // PR open, reviewDecision APPROVED
  | "merged"        // PR merged, worktree removed
  | "done";         // PR closed without merge (and legacy tickets), worktree removed
```

`pr_open` is removed. `loadState` migrates: `pr_open` → `pr_draft` when the project has `draftPr`, else `pr_ready`; the first PR check corrects it.

A CI fix in progress is `status: "running"` with `ticket.fix` set (see 2.3). This reuses the parallel-slot accounting, the live log, take-over, and restart recovery without new code paths.

### 2.2 PR info

```ts
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
  /** Latest approving review's submittedAt from GitHub (not our poll time). Cleared if the decision changes. */
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
```

`Ticket.prUrl` stays (the UI and Jira comment use it) and is kept equal to `pr.url`.

### 2.3 Fix context

```ts
export interface FixContext {
  round: number;          // 1-based
  headSha: string;        // the failing commit
  failedChecks: FailedCheck[];
  /** Trimmed failing-step logs, built by github.failedCheckLogs(). */
  logs: string;
  requestedAt: string;
}
```

`Ticket.fix?: FixContext` is set when a fix is queued and cleared when the fix run ends (success or failure).

### 2.4 Config

```ts
// ProjectConfig additions
ciAutoFix: boolean;          // default true
ciFixMaxRounds: number;      // default 2, 0..5
mergeNudgeAfterMin: number;  // default 30, 5..1440

// Settings additions
prPollIntervalMin: number;   // default 3, 1..60
```

`normalizeProject` and `DEFAULT_SETTINGS` fill defaults for existing config files.

### 2.5 Engine state

```ts
// EngineState additions
lastPrCheckAt?: string;
nextPrCheckAt?: string;
prCheckErrors: Record<string /* ticket key */, string>;
```

### 2.6 PR events

```ts
export type PrEventKind = "review_ready" | "merge_nudge" | "merged" | "ci_fix_exhausted";
export interface PrEvent { kind: PrEventKind; key: string; prUrl: string; projectId: string; at: string }
```

Not an `EngineEvent` on the SSE stream. The orchestrator calls `this.prEvents.emit(event)` (a small typed emitter in `engine/src/prevents.ts`). In this item the only subscriber turns each event into a `notify` and a log line. Item 3 adds the messaging subscriber. Keeping it internal avoids the UI re-sending anything on reconnect.

## 3. Components

### 3.1 `engine/src/github.ts` (extended)

- `fetchPr(repoPath, url): Promise<RawPr>` runs
  `gh pr view <url> --json number,url,state,isDraft,headRefOid,mergedAt,reviewDecision,latestReviews,statusCheckRollup`.
- `openPr` unchanged. Add `publishPr(repoPath, url)` = `gh pr ready <url>`.
- `failedCheckLogs(repoPath, checks: FailedCheck[]): Promise<string>`: for each check with a `runId`, `gh run view <runId> --log-failed`; keep the last 150 lines per run; total capped at 20 000 characters; checks without a run id contribute `name — detailsUrl`. Errors from `gh run view` are included as a line rather than thrown, so one missing log never blocks a fix.
- `prState` is removed; `fetchPr` replaces it.

### 3.2 `engine/src/prstate.ts` (new, pure)

- `summarizeChecks(rollup): { ci: CiStatus; failed: FailedCheck[] }`.
  Rules on `statusCheckRollup` entries: CheckRun with `status != "COMPLETED"` → pending; conclusion `FAILURE | TIMED_OUT | ACTION_REQUIRED | STARTUP_FAILURE` → failing; `SUCCESS | NEUTRAL | SKIPPED | CANCELLED` → ok. StatusContext `state`: `PENDING | EXPECTED` → pending, `FAILURE | ERROR` → failing, `SUCCESS` → ok. Any failing → `failing`; else any pending → `pending`; else at least one ok → `passing`; empty → `none`. `runId` parsed with `/\/actions\/runs\/(\d+)/` from `detailsUrl`.
- `toPrInfo(raw, prev?: PrInfo): PrInfo` builds the new info, carrying over the once-only timestamps and fix counters from `prev`, and setting `approvedAt` from the newest `latestReviews` entry with `state == "APPROVED"` when `reviewDecision == "APPROVED"`.
- `nextStatus(t: Ticket, pr: PrInfo): TicketStatus` — the state table in section 4.1.
- `buildFixPrompt(project, ticket, fix): string` — section 4.3.

Pure, so it gets unit tests without `gh`.

### 3.3 `engine/src/orchestrator.ts` (extended)

- Second timer: `schedulePrCheck()` / `checkPrs()`, independent of the Jira poll. `checkMergedPrs` is replaced by `checkPrs`.
- `publish(key)`, `fixCi(key)` (manual trigger, allowed even when rounds are exhausted; it starts one more round), `checkPrsNow()`.
- `runTicket` learns about `t.fix`: a different prompt, agent chain from index 0, and after a successful push the ticket returns to its PR status (section 4.3). The "open PR" step already reuses an existing PR; the Jira "PR opened" comment is skipped when `jiraCommented` is set.
- `handBack(key, "pr")` sets the PR status via `nextStatus` after fetching the PR, instead of `pr_open`.
- Restart recovery: a `running` ticket with `fix` set is re-queued with its `fix` kept, as today for normal runs.

### 3.4 `engine/src/server.ts` and `src/api.ts`

New routes: `POST /api/tickets/:key/publish`, `POST /api/tickets/:key/fix-ci`, `POST /api/check-prs-now`. `Api` gains `publish`, `fixCi`, `checkPrsNow`.

### 3.5 UI

- `src/ui.tsx`: `useTick(ms)` hook (re-renders on an interval; default 15 s). `StatusBadge` labels for the new statuses. New small `CiPill` and `ReviewPill`.
- `src/App.tsx`: calls `useTick()` so "Next check in …" ticks. Sidebar foot gains a **Refresh** button: refetches config and state, and re-subscribes to events (tears down the current `EventSource` and opens a new one). The engine line shows both "Next Jira check" and "Next PR check" when there are open PRs.
- `src/views/Dashboard.tsx`: calls `useTick()`. The single table becomes four sections, each a card with its own table, rendered only when non-empty (the first one always):
  1. **In progress**: queued, running (without `fix`), manual, failed, stopped. Columns as today.
  2. **Pull requests**: pr_draft, pr_ready, pr_ci_failed, running with `fix`. Columns: Ticket, Status (Draft / Ready / CI failing / Fixing CI round n/N), CI, Review, In state for, Actions (Publish on drafts, Fix CI on ci_failed, Open PR).
  3. **Approved, not merged**: pr_approved. Columns: Ticket, Approved (relative), Waiting (duration since approvedAt, amber past the nudge delay), Actions (Open PR).
  4. **Merged**: merged, newest first, capped at 20 with "Show all". "Show closed" checkbox also lists `done`.
  Stat cards become: Running, Queued, PRs open, Approved waiting, Needs attention (failed + stopped + pr_ci_failed with rounds exhausted).
- `TicketDetail`: shows the PR block (draft/ready, CI with failed check names linking to `detailsUrl`, review decision, fix rounds, approved/merged times) and the same action buttons.
- `src/views/Projects.tsx`: Repository step gains "CI auto-fix" toggle, "Max fix rounds", "Nudge when approved but not merged after N min". Settings gains "Check PRs every N min".
- `src/mock.ts`: demo data for each new status so the demo scenario shows every section.

## 4. Behaviour

### 4.1 PR check (every `prPollIntervalMin`)

For every ticket with `prUrl` and status in `pr_draft | pr_ready | pr_ci_failed | pr_approved`:

1. `fetchPr`. On error: record in `prCheckErrors[key]`, keep the previous status, continue. On success clear the error.
2. `pr = toPrInfo(raw, t.pr)`; `t.pr = pr`.
3. `status = nextStatus(t, pr)`:

| GitHub state | isDraft | reviewDecision | ci | → status |
|---|---|---|---|---|
| merged | – | – | – | `merged` |
| closed | – | – | – | `done` |
| open | – | – | failing | `pr_ci_failed` (the orchestrator overrides this with `queued` when it queues a fix, see 4.2) |
| open | false | APPROVED | not failing | `pr_approved` |
| open | true | – | not failing | `pr_draft` |
| open | false | other | not failing | `pr_ready` |

4. Side effects, in this order, each guarded by its once-only field:
   - `merged`: `removeWorktree`, log, `pr.mergedAt`, tracker comment "Merged: <pr url>. <summary>" via the existing comment command (failure logged, not fatal), `prEvents.emit(merged)`.
   - `done` (closed): `removeWorktree`, log. No event.
   - `ci == "failing"` and `pr.headSha != pr.lastFixSha`: see 4.2.
   - `ci == "passing"`, `!pr.draft`, `!pr.reviewRequestedAt`: set `reviewRequestedAt`, emit `review_ready`.
   - `status == "pr_approved"`, `!pr.mergeNudgedAt`, `now - approvedAt >= mergeNudgeAfterMin`: set `mergeNudgedAt`, emit `merge_nudge`.
5. `touch(t, { status })`, with a log line whenever the status changed.

Tickets in `running` (including fixes) and `manual` are not checked; the next check after they finish catches up (including a merge that happened meanwhile).

### 4.2 CI failure → fix

When the check sees `ci == "failing"` on a new head (`pr.headSha != pr.lastFixSha`):

- If `project.ciAutoFix` and `pr.fixRounds < project.ciFixMaxRounds` and the engine is not paused: build `FixContext` (`logs` via `failedCheckLogs`), set `t.fix`, `pr.lastFixSha = pr.headSha`, status `queued`, log `✗ CI failed on <sha> (<n> checks) — queuing fix round r/N`. `pump()` picks it up under `maxParallel`.
- Otherwise: status `pr_ci_failed`; if rounds are exhausted and this is the first time for this head, emit `ci_fix_exhausted` and notify "CI failed on KEY, N fix rounds used — needs you".

Manual **Fix CI** behaves like the auto path but ignores `ciAutoFix` and the round cap.

### 4.3 Fix run

`runTicket` with `t.fix` set:

- Worktree is reused (`ensureWorktree` already does). HandsFree does not reset the worktree to `fix.headSha`: normally HEAD already is that commit, and if the user took over and left local changes, those are kept and the prompt mentions them (`git status` is non-empty).
- Prompt (`buildFixPrompt`): header "CI failed on PR <url> for ticket KEY: summary", the ticket description, the failed check names, the trimmed logs in a fenced block, then the standard "How to work" rules plus: "Fix the failing checks. Reproduce locally where possible. Do not revert unrelated work. Commit with a message starting with `KEY: fix CI —`." Previous attempts of this fix round are listed as today.
- Agent chain from index 0 with the usual fallback rules.
- Success: push (`--force-with-lease`, as today), `pr.fixRounds += 1`, clear `t.fix`, status from `nextStatus` using the last known `pr` with `ci` reset to `pending` (so it shows Draft/Ready pending until the next check), log `⇡ pushed fix round r`, notify "Fix pushed for KEY".
- Every agent fails: clear `t.fix`, status `pr_ci_failed`, `error` set, notify as a failure. The round still counts (`fixRounds += 1`) so a broken chain cannot loop.
- Stopped by the user: clear `t.fix`, status `pr_ci_failed`, no round counted.
- `retry(key)` on a `pr_ci_failed` ticket is the same as **Fix CI**.

### 4.4 Publish

`publish(key)`: `gh pr ready <url>`, then an immediate `fetchPr` for that ticket so the status flips to `pr_ready` without waiting for the timer. Errors are returned to the UI as today for `openTerminal`.

### 4.5 Quick fixes

- `useTick(15_000)` in `App` and `Dashboard`. `ago`, `until`, `duration` are unchanged; they re-run on each tick.
- Sidebar **Refresh**: `api.getConfig()`, `api.getState()`, and resubscribe. The button shows a spinner for the duration and an inline error if the engine does not answer.
- `nextPollAt` and `nextPrCheckAt` are persisted so the sidebar shows a sensible value during the first seconds after an engine restart.

## 5. Error handling

- `gh` failures during the PR check are per ticket (`prCheckErrors`), shown as an amber line in the ticket row and detail, never fatal to the check loop.
- `gh run view` failures appear inside the fix logs as text.
- A PR deleted on GitHub (`gh pr view` 404) leaves the ticket where it is with the error shown; **Forget** or **Clean up** remain available.
- A fix queued while the engine is paused waits in `queued` like any other ticket.
- Engine restart during a fix: the attempt is closed as "stopped", the ticket is re-queued with `fix` intact.

## 6. Testing

- **Unit** (`engine/test/prstate.test.mjs`, run with `node --test` against an esbuild bundle of `prstate.ts`): `summarizeChecks` for each conclusion/state combination and mixed sets; `toPrInfo` carry-over of once-only fields and `approvedAt` selection; `nextStatus` for every row of the table in 4.1; `buildFixPrompt` includes checks, logs cap, and round number.
- **E2E** (`engine/test/e2e.mjs`, extended): the fake `gh` reads a JSON file for `pr view` so the test can drive: draft → publish (`gh pr ready` recorded) → CI failing with a fake `gh run view --log-failed` → fix agent runs with the logs in its prompt and a second push happens → CI passing (`review_ready` notify observed on the SSE stream) → approved with an old `submittedAt` (`merge_nudge` notify observed) → merged (worktree removed, Jira comment recorded, status `merged`). Also: rounds exhausted → `pr_ci_failed` and `ci_fix_exhausted` notify; `pr_open` migration in `loadState`.
- `npm run test:engine` runs the unit tests then the e2e. `npm run typecheck` covers both tsconfigs.

## 7. Migration and compatibility

- Config files without the new fields get defaults from `normalizeProject` / `DEFAULT_SETTINGS`.
- State files: `pr_open` migrated as in 2.1; tickets without `pr` get it on the first check.
- `prState` callers (only `checkMergedPrs`) are replaced; `e2e.mjs`'s fake `gh pr view` changes from a bare word to JSON.

## 8. Files touched

- `engine/src/types.ts`, `store.ts`, `github.ts`, `orchestrator.ts`, `server.ts`, new `prstate.ts`, new `prevents.ts`
- `engine/test/e2e.mjs`, new `engine/test/prstate.test.mjs`, `package.json` scripts
- `src/api.ts`, `src/ui.tsx`, `src/App.tsx`, `src/views/Dashboard.tsx`, `src/views/Projects.tsx`, `src/views/Settings.tsx`, `src/mock.ts`, `src/styles.css`
- `README.md` (lifecycle diagram and the new settings)
