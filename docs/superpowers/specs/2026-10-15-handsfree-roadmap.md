# HandsFree roadmap: from "draft PR exists" to "merged and reported"

Date: 2026-10-15. Status: agreed decomposition and order. Each numbered item gets its own spec and implementation plan; this document records the shared decisions so later specs do not re-litigate them.

## Goal

Today HandsFree stops at "draft PR opened, link commented on Jira". The goal is for HandsFree to own the rest of the ticket's life: publish, CI, review hand-off to the team, merge nudges, merge cleanup, tracker close-out, and scheduled project routines. Everything is configured per project, because a second project may use a different tracker (Linear, GitHub Issues) and a different messaging platform.

## Decomposition and order

1. **Quick fixes** (bounded, folded into the first plan): relative times on the dashboard and sidebar tick in real time; a Refresh button in the sidebar re-syncs the UI with the engine.
2. **PR lifecycle core** — spec: `2026-10-15-pr-lifecycle-design.md`. PR states tracked from GitHub, publish/sync of draft status, CI failure auto-fix in the same worktree, approved-but-not-merged tracking with a nudge deadline, merged section with cleanup and a tracker comment. Dashboard sections for each. No messaging platform yet; the engine raises typed PR events that item 3 consumes.
3. **Messaging** — engine becomes an MCP client (streamable HTTP + OAuth 2.1). First adapter: Setmore collab (`https://mcp.setmore.com/mcp`, auth server `https://auth.setmore.com/o`), sending as the signed-in user. Per-project channel and message templates. Consumes the PR events from item 2: "CI passed, please review" (once per PR, only when the PR is not a draft), "waiting to be merged" nudge (once, after the project's merge-nudge delay). Manual "Send to collab" on one PR and on a multi-selection.
4. **Trackers** — `TrackerAdapter` interface (`search`, `comment`, `transition`). Jira via `acli` stays the default. GitHub Issues via `gh`. Linear via its MCP server through the client built in item 3. On merge, the ticket is transitioned to the project's configured "done" status. Prompts stop saying "Jira ticket".
5. **Routines** — a routine is a cron expression, a prompt, an agent, and a destination channel. The agent runs with the project's MCP config and its result is posted to the channel. Two presets: daily 10:00 PR check (open PRs for the project: stale, awaiting review, failing CI) and a Sentry check three times a day (new or regressed issues since the last run).

## Shared decisions

- **Per project, always.** Tracker, messaging platform, channel, templates, CI auto-fix policy, nudge delay, routines all live on `ProjectConfig`. App-wide settings only hold polling cadence and machine-level toggles.
- **The engine owns side effects.** Messages, transitions and PR mutations happen in the Node engine, never in the React UI, so they work with the window closed.
- **Deterministic transport over agent-driven transport.** Sending a message or transitioning a ticket calls the API/CLI/MCP tool directly. Agents are only used where judgement is needed (writing code, summarising CI logs, routine reports).
- **Poll, don't webhook.** No inbound server. GitHub and tracker state are polled on separate timers (`gh` for PRs, the tracker adapter for tickets).
- **Status is a single enum on the ticket.** Dashboard sections are derived from `Ticket.status`; PR details live under `Ticket.pr`.

## Assumptions confirmed on 2026-10-15

- The "please review" message fires only after the PR is published (not a draft).
- CI auto-fix is capped at 2 rounds per PR by default; after that the ticket needs attention.
- "Approved" means GitHub `reviewDecision == APPROVED` on an open PR. The merge nudge is sent once per PR.
- The daily PR check reports open PRs of the project repo; the Sentry check reports new or regressed issues since the last run.
- The tracker "done" transition name is configurable per project; default "Done".
