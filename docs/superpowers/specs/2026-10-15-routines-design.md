# Routines (scheduled agent runs that report to collab) — design

Date: 2026-10-15. Roadmap item 5 (see `2026-10-15-handsfree-roadmap.md`). Reuses the messaging service (`2026-10-15-messaging-design.md`) for posting.

## 1. Outcome

- A project can have routines: a cron schedule, a prompt, an agent command, and "post the result to the project's collab channel". The engine runs them unattended and records the last run.
- Two presets, one click to add: **Daily PR check** (weekdays 10:00, reports the repo's open PRs: awaiting review, stale, failing CI) and **Sentry check** (09:00 / 13:00 / 17:00, new or regressed Sentry issues since the last run, through the user's claude.ai Sentry connector in Claude Code).
- **Run now** from the UI; last result and next run visible per routine; a log per routine.
- Everything per project; a project with no messaging platform can still run routines (results stay in the app).

Out of scope: routines not tied to a project, result parsing beyond "the agent's final text", retries, overlapping runs of the same routine (a run that is still going when the next tick comes is skipped and logged).

## 2. Facts

- Claude Code headless: `claude -p <prompt> --output-format json --max-turns N --dangerously-skip-permissions` prints one JSON envelope `{ type: "result", is_error, result: "<final text>", … }`. The claude.ai connectors (Setmore, Sentry, GitHub, …) attached to the user's account are available in headless runs on this Mac (verified with `list_channels` on 2026-10-15). The Sentry connector shows "Needs authentication" in `claude mcp list`; the user authenticates it once with `/mcp` in an interactive `claude` session.
- `gh pr list --repo OWNER/REPO --state open --json number,title,url,isDraft,reviewDecision,statusCheckRollup,updatedAt,author` gives everything the PR check needs.

## 3. Data model (`engine/src/types.ts`)

```ts
export interface RoutineConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** 5-field cron in local time: "min hour dom month dow" with *, lists, ranges, steps. */
  schedule: string;
  /** Sent to the agent as {prompt}. Placeholders: {project} {repo} {repo_path} {channel} {last_run} {now}. */
  prompt: string;
  /** Command template; {prompt} is filled (shell-quoted). Empty = DEFAULT_ROUTINE_COMMAND. */
  agentCommand: string;
  postToChannel: boolean;
  timeoutMin: number;      // default 15, 1..120
}

export interface RoutineRun {
  startedAt: string;
  endedAt?: string;
  ok?: boolean;
  /** The agent's final text (or the error), trimmed to 4000 chars. */
  output?: string;
  posted?: boolean;
  postError?: string;
}

export interface RoutineState {
  nextRunAt?: string;
  running?: boolean;
  last?: RoutineRun;
}

// ProjectConfig addition
routines: RoutineConfig[];
// EngineState addition
routines: Record<string /* routine id */, RoutineState>;
// MessageKind addition
| "routine"

// Fix pass: no --dangerously-skip-permissions; the presets carry their own agentCommand with --allowedTools.
export const DEFAULT_ROUTINE_COMMAND = "claude -p {prompt} --output-format json --max-turns 25";

export const ROUTINE_PRESETS: Omit<RoutineConfig, "id">[] = [
  {
    name: "Daily PR check",
    enabled: true,
    schedule: "0 10 * * 1-5",
    prompt: [
      "You are preparing a short status report on the open pull requests of {repo} for the {project} team.",
      "Run: gh pr list --repo {repo} --state open --limit 50 --json number,title,url,isDraft,reviewDecision,statusCheckRollup,updatedAt,author",
      "Group the PRs: awaiting review (ready, no decision), changes requested, approved but not merged, failing CI, drafts, and stale (no update for 3+ days).",
      "Write the report as plain text for a chat message: a one-line headline with counts, then one line per PR (title — link — one-word state — author — age). Keep it under 30 lines. No markdown headers, no code fences.",
      "Print only the report.",
    ].join("\n"),
    agentCommand: "",
    postToChannel: true,
    timeoutMin: 15,
  },
  {
    name: "Sentry check",
    enabled: true,
    schedule: "0 9,13,17 * * *",
    prompt: [
      "Using the Sentry MCP tools, look at the Sentry project for {project} (ask the tools to list projects if you are unsure which one; prefer a project whose name matches {repo}).",
      "Find issues that are new or regressed since {last_run} (use now = {now}). For each: title, count of events, first/last seen, a link.",
      "Write a plain-text chat message: a one-line headline with the number of new/regressed issues (or 'Sentry: nothing new since {last_run}'), then one line per issue, most events first, max 15 lines. No markdown headers, no code fences.",
      "Print only the message.",
    ].join("\n"),
    agentCommand: "",
    postToChannel: true,
    timeoutMin: 15,
  },
];
```

Migration: `normalizeProject` gives `routines: []` and `normalizeRoutine` fills defaults (`timeoutMin` clamped 1..120, invalid cron kept as text but flagged in the UI); `migrateState` gives `routines: {}`.

## 4. Components

### 4.1 `engine/src/routines/cron.ts` (pure)

- `parseCron(expr: string): CronSpec | Error` — 5 fields; `*`, `a`, `a-b`, `a,b,c`, `*/n`, `a-b/n`; dow 0–7 (7 = Sunday), 3-letter month/day names accepted (`mon`, `jan`). Returns an `Error` (not thrown) with a readable message for the UI.
- `nextRun(spec: CronSpec, after: Date): Date` — next matching minute strictly after `after`, local time, searching at most 366 days (then `Error`).
- `describeCron(spec)` — "every weekday at 10:00", "at 09:00, 13:00 and 17:00 every day", else the raw expression.

### 4.2 `engine/src/routines/service.ts` — `RoutineService`

```ts
constructor(deps: { config: () => Config; state: () => EngineState; persist: () => void; log: (file: string, chunk: string) => void; notify: (title: string, body: string) => void; messaging: Pick<MessagingService, "postToProject">; run?: typeof sh; now?: () => Date })
start()            // computes nextRunAt for every enabled routine, starts a 30 s tick
tick()             // runs every routine whose nextRunAt <= now and is not running; recomputes nextRunAt
runNow(routineId)  // ignores the schedule; refuses while running ("already running")
configChanged()    // recompute nextRunAt for added/edited routines, drop state for removed ones
shutdown()
readLog(routineId, max?)
```

- Run: build the prompt with `fillTemplate` (`{project}` name, `{repo}` owner/name from the project's remote (same helper as the tracker/github code when present; else the remote URL), `{repo_path}`, `{channel}` = `messaging.channelName`, `{last_run}` = last successful `startedAt` or "the beginning", `{now}` ISO); command = `fill(agentCommand || DEFAULT_ROUTINE_COMMAND, { prompt })`; `sh(cmd, { cwd: repoPath, timeoutMs, env: { HANDSFREE: "1", HANDSFREE_ROUTINE: id } })`; stdout/stderr appended to `logs/routine-<id>.log` (same `logFile`-style sanitising, under `LOG_DIR`); the envelope's `result` (via `lastJson` from `messaging/agent.ts`) is the output; `is_error` or non-zero exit → `ok: false` with the last 400 chars as output.
- Post: when `postToChannel` and the project's `messaging.platform !== "none"` and the run succeeded: `messaging.postToProject(p, output, "routine", idempotencyKey = routine:<id>:<startedAt>)`; `posted`/`postError` recorded; a post failure is a notification, not a run failure.
- State is persisted after start and end; `running` is cleared on engine start (a run killed with the engine is recorded as `ok: false, output: "HandsFree was quit"`).
- One run at a time per routine; different routines may run concurrently (cap 2 at once across all projects; others wait for the next tick).

### 4.3 `engine/src/messaging/service.ts` addition (append only)

```ts
/** Post free text to the project's channel without a ticket (routines). Returns the platform message id. */
async postToProject(p: ProjectConfig, text: string, kind: MessageKind, idempotencyKey: string): Promise<{ id?: string }>
```

Resolves the adapter like `sendTest`, sends, logs to the engine log (no ticket), throws on failure. `MessageKind` gains `"routine"`.

### 4.4 Orchestrator (append only)

- Field `routines = new RoutineService({...})` after `messaging`; `start()` calls `this.routines.start()` after `this.messaging.init()`; `updateConfig()` calls `this.routines.configChanged()` after `this.messaging.settingsChanged()`; `shutdown()` calls `this.routines.shutdown()`.
- Engine log lines for routine runs go to the routine's own log file, not a ticket log.

### 4.5 Routes / API

- `POST /api/routines/:id/run` → `{}` or 400 `{error}`; `GET /api/routines/:id/log` → `{ log }`.
- `Api.runRoutine(id)`, `Api.getRoutineLog(id)`; mock implementations.

### 4.6 UI

- Projects: new step **Routines** inserted before **Review** (so Review becomes the last index; `src/demo.tsx` `editorStep` for the Review demo is updated). List of routines with name, schedule (+ `describeCron` text, red when invalid), enabled toggle, Run now, last run (ago, ok/failed, first line of output), next run. Edit inline: name, schedule, prompt (textarea), agent command (advanced), post toggle, timeout. "+ Add routine" menu: the two presets and "Custom". Delete with confirm.
- Dashboard: a **Routines** card after the sections (only when any project has an enabled routine): one row per routine — project, name, next run, last run status, Run now, "Log" (opens a detail pane reusing the log view styling).
- Settings: nothing new.
- README: routines section, the Sentry connector login note (`claude` → `/mcp` → authenticate Sentry once).

## 5. Behaviour and edge cases

- Invalid cron: routine stays disabled at runtime (`nextRunAt` undefined), UI shows the parse error.
- DST (fix pass): `nextRun` walks minutes/hours on the epoch, so the repeated hour at a fall-back is followed in real time and the result is always strictly after `after`. A local time that does not exist at a spring-forward (e.g. 02:30) is skipped that day.
- Project Off (fix pass): a project with `enabled: false` pauses its routines (no `nextRunAt`, tick skips, Run now → "This project is paused"); the global Pause does not.
- Engine asleep (Mac closed) past a scheduled time: on wake the tick runs any routine whose `nextRunAt` is in the past **once**, then schedules forward (no catch-up storms).
- Timeout: the agent is killed (`sh` timeout), run recorded `ok: false, output: "Timed out after N min"`.
- Posting without a channel: run recorded ok, `posted: false, postError: "no channel configured"`; no notification spam (one log line).
- Deleting a routine while running: the run finishes and its state is dropped afterwards.
- Prompt injection: the prompt is user-authored; tool results (Sentry titles, PR titles) are data the agent reads — same trust model as the coding agents. The run uses `--dangerously-skip-permissions` like the agent presets; documented.

## 6. Testing

- **Unit**: `cron` (parse errors, each syntax form, `nextRun` across day/month/year boundaries and DST-free assumptions, dow 7, names; `describeCron` for the two presets); `routines/service` with a fake runner: due/not due, overlap skip, run-now while running refused, timeout recorded, post called with the output and kind `routine`, post failure recorded without failing the run, config change recomputes/drops state, engine-start cleanup of `running`.
- **E2E**: project gets a routine with `schedule: "* * * * *"`, `agentCommand: "fakeroutine {prompt}"` (prints the Claude envelope with a known report and records the prompt), `postToChannel: true`; `POST /api/routines/<id>/run` → state `last.ok`, output matches, fake MCP `received` gets the report with the routine idempotency key; log route returns the agent output; a second `run` while running → 400. Tick-driven run: wait up to 70 s for a scheduled run (or set `nextRunAt` in the past via config change and tick) — the plan picks the deterministic variant: the service exposes `tick()` through a test-only route guarded by `HF_TEST=1`.
- `npm run test:engine` stays the single command.

## 7. Files

- New: `engine/src/routines/{cron,service}.ts`, `engine/test/{cron,routines}.test.mjs`.
- Modified (append-only where shared with item 4): `engine/src/{types,store,orchestrator,server}.ts`, `engine/src/messaging/service.ts` (one method), `engine/test/e2e.mjs`, `package.json` (`build:test` list), `src/{api,mock,demo}.ts(x)`, `src/views/{Projects,Dashboard}.tsx`, `src/styles.css`, `README.md`.
