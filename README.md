# HandsFree

A Mac app that picks up your tickets (Jira, GitHub Issues or Linear), works each one in its own git worktree with a chain of AI agents, and opens a draft PR. Nothing to watch until the PR exists.

```
Tracker query (Jira/acli · GitHub/gh · Linear/MCP) ─▶ .worktrees/<KEY> ─▶ Agent 1 ──fails / rate-limited──▶ Agent 2 … ─▶ commit
                                                                     ─▶ git push ─▶ gh pr create --draft ─▶ ticket comment with PR link
PR open ─▶ checked every few minutes: draft/ready, CI, reviews
   CI fails   ─▶ failing logs ─▶ agent chain again in the same worktree ─▶ push (up to N rounds)
   CI passes  ─▶ "ready for review" notification (once, published PRs only)
   approved   ─▶ "waiting to be merged" nudge after N minutes
   merged     ─▶ worktree removed ─▶ ticket moved to done (Jira "Done" · GitHub closed · Linear "Done") ─▶ comment with the PR link
   CI passes / approved too long ─▶ collab message to the project's channel (Setmore, once each)
```

## What's inside

| Path | What it is |
|---|---|
| `src-tauri/` | Mac shell (Tauri 2, Rust): window, menu bar icon, launch at login, notifications, starts the engine |
| `engine/src/` | The engine (Node/TypeScript): polling, worktrees, agent chain + fallback, PRs, tracker adapters (`engine/src/trackers/`), local API |
| `src/` | The UI (React): Dashboard, Projects, Settings |
| `engine/test/e2e.mjs` | End-to-end test with fake `acli`, `gh` and agents |

## One-time setup on your Mac

```bash
xcode-select --install                                   # if you haven't already
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust, for building the app
node -v                                                  # Node 20+ (the engine runs on it)
gh auth login                                            # PRs
acli jira auth login                                     # only for Jira projects: search, comments, done transition
claude --version; grok --version                         # your agents, logged in
# Setmore collab messages need an OAuth client id for HandsFree (public client, PKCE,
# redirect http://127.0.0.1:47831/oauth/callback) — ask the auth team, paste it in Settings → Accounts.
# The client must be allowed the scopes HandsFree requests, above all setmore.apis-internal.fullaccess
# (the MCP server refuses every tool call without it) and awapis.chat.streams.push (send_message).
# Linear projects: Settings → Accounts → Linear → Log in (HandsFree registers itself with Linear; no client id).
```

## Run it

```bash
cd ~/Documents/handsfree
npm install
npm run tauri dev        # develop: opens the app with hot reload
npm run tauri build      # build: src-tauri/target/release/bundle/macos/HandsFree.app (+ .dmg)
```

Drag `HandsFree.app` to Applications. It's unsigned, so the first time: right-click → Open.

Other commands: `npm run test:engine` (engine e2e test), `npm run engine` (engine only, headless; prints its API token).

## Using it

1. **Projects → New project.** Pick the repo, base branch, draft or ready PRs.
2. **Tracker.** Pick where tickets come from and press **Test query**. Each ticket is picked up once; *Forget* on the dashboard lets it be picked up again.
   - **Jira** (default): a JQL, run through `acli` with the login on your Mac. Keys look like `ABC-123`.
   - **GitHub Issues**: a `gh issue list --search` filter, e.g. `assignee:@me label:handsfree`, on the repo you set (empty = the project's remote, if it's on github.com). Keys look like `<repo-name>#12`; two projects on repos with the same name would share keys, so keep their filters apart.
   - **Linear**: an optional text filter plus an assignee (`me` by default), through Linear's MCP server (`https://mcp.linear.app/mcp`). Log in once in Settings → Accounts → Linear. Keys are Linear's identifiers (`ENG-123`).
   - **Status on merge**: when the PR merges, the ticket is moved there (Jira default "Done"; GitHub: any value closes the issue as completed; Linear default "Done"). Leave it empty to never move tickets. A failed move is logged and notified; the merge is still handled.
3. **MCP servers.** Paste the project's `mcp.json`. It's written to `.handsfree/mcp.json` in every worktree and passed to agents as `{mcp_file}`.
4. **Agent chain.** Up to 4, top to bottom. The next agent takes over in the same worktree when one exits non-zero, matches a token-exhaustion pattern in its last output, times out, or finishes without changes.
5. **Save & activate.** It starts on the next check (Settings → *Check tickets every*), or press **Check tickets now**.
6. **After the PR.** The dashboard groups tickets into *In progress*, *Pull requests*, *Approved, not merged* and *Merged*. **Publish** marks a draft ready (`gh pr ready`); publishing in the GitHub UI is picked up on the next check (Settings → *Check PRs every*, default 3 min). When CI fails, HandsFree fetches the failing step logs (`gh run view --log-failed`) and runs the agent chain again in the same worktree, up to the project's *Max automatic fix rounds*; **Fix CI** starts a round by hand. Approved PRs that wait longer than the project's limit raise a nudge. Merged PRs get their worktree removed, the ticket moved to the project's done status, and a comment on the ticket.
7. **Messaging.** Settings → *Accounts*: paste the Setmore `client_id` from the auth team and press **Log in** (browser sign-in; tokens stay on this Mac). In each project's *Messaging* step pick the platform (Setmore collab, or an agent run with your own MCP connectors), load and pick the channel, and edit the four templates. HandsFree then posts "please review" when CI passes on a published PR and "waiting to be merged" when an approved PR sits past the project's delay — once each. **Send to collab** on a PR (or a selection of PRs) sends the prefilled, editable text; every send is listed in the ticket detail.

Agents are told to commit but not push. HandsFree commits anything left uncommitted, pushes the ticket's branch, opens the PR with `gh`, and comments the link on the ticket. The only status change HandsFree makes is the move to the done status on merge.

### Naming conventions

Each project (Repository step → *Naming conventions*) has a **template** and an optional **pattern** (regex) for the branch, the commit subject and the PR title. Templates know `{key}`, `{summary}`, `{slug}` (kebab-cased summary), `{type}` (from the ticket's issue type or labels: `bug`, `feature`, `spike`, `improvement`, `hotfix`, `refactor`, `config`) and `{type_cc}` (its conventional-commit twin: `fix`, `feat`, …). Defaults are HandsFree's classic `handsfree/{key}` and `{key}: {summary}` with no patterns.

- The branch is rendered at pick-up and checked before the worktree is created; the PR title is checked at the same time. A name that fails its pattern stops the ticket with the reason, so a GitHub naming check never sees it. Fix the rules and press **Retry**.
- HandsFree's own commits use the commit template. The agent is told the pattern with a rendered example; any of its commit subjects that still don't match are reworded to the template before the push (bodies and trailers are kept; already-pushed commits are left alone).
- **Use Anywhere rules** fills in the branch and commit regexes that Anywhere's `conventionsbot` GitHub check enforces, with `{key}/{type}/{slug}` and `{type_cc}: {key} {summary}`.

### Routines

A routine is a scheduled agent run for a project: a cron schedule (5 fields, local time), a prompt and an agent command. HandsFree runs it unattended in the project's repo and posts the agent's final text to the project's collab channel (Messaging step). Without a messaging platform the result stays in HandsFree.

- **Projects → Routines** step: **+ Add routine** gives two presets or a custom one.
  - **Daily PR check** (`0 10 * * 1-5`, weekdays 10:00): open PRs of the repo from `gh pr list`, grouped into awaiting review, changes requested, approved not merged, failing CI, drafts and stale.
  - **Sentry check** (`0 9,13,17 * * *`): new or regressed Sentry issues since the last successful run. It uses your claude.ai **Sentry connector** in Claude Code. Authenticate it once: run `claude`, type `/mcp`, pick Sentry and log in.
- Prompt placeholders: `{project}` `{repo}` (owner/name from the remote) `{repo_path}` `{channel}` `{now}` and `{last_run}` (ISO times; `{last_run}` is the start of the last successful run, or "the beginning"), `{last_run_human}` (the same in local time, for sentences).
- Permissions: the presets pre-approve only what they need with `--allowedTools` (`Bash(gh pr list:*)` for the PR check, `mcp__claude_ai_Sentry__*` for Sentry). A custom routine with an empty command runs `claude -p {prompt} --output-format json --max-turns 25` with no tools pre-approved: add `--allowedTools` for what its prompt needs, or opt into `--dangerously-skip-permissions` yourself. A custom command must print Claude's JSON result envelope. The presets tell the agent that tool output (PR titles, issue titles) is data, not instructions.
- **Run now** on the routine (project step or the dashboard's *Routines* card) ignores the schedule. The card shows the next run, the last result and the routine's **Log**.
- Switching a project **Off** pauses its routines (not scheduled, hidden from the dashboard card, Run now refused). The global Pause only stops Jira pick-up.
- Schedules are local time. On a DST fall-back night the repeated hour is followed in real time; on a spring-forward night a time that doesn't exist (e.g. 02:30) is skipped that day.
- Quitting HandsFree stops running routine agents; the run is recorded as "HandsFree was quit".
- One run at a time per routine (a slot that comes while the previous run is still going is skipped) and at most two routines at once. A Mac that slept through a slot runs it once on wake. Timeout per routine (default 15 min). A failed run or post sends a notification.

### Watch or step in (any agent)

Every ticket has one **Open** button:

- **Running → 👀 Open live.** Terminal shows the agent's live output. Close the window to stop watching; the agent keeps going. Press **Enter** to take over: HandsFree stops the agent and continues its session right there, so you can talk to it.
- **Running → message box under the live log.** Type a note (“also update the README”) and press Enter: the agent reads it as soon as its current tool call finishes and keeps going, no take-over needed. Works for agents whose command has `--input-format stream-json` (the Claude Code preset does; its prompt goes in on stdin, so there is no `{prompt}` argument). The run still ends on Claude's first result, so this is for steering mid-run; afterwards use Open / Take over.
- **Failed / stopped → Take over.** Continues the last agent's session in its worktree.
- **When you're done**, the ticket shows **With you**. Choose **Open PR with my changes** (commit, push, draft PR, ticket comment) or **Hand back to agents** (re-run the chain; agents are told you changed things).

Long runs get a **⏱ slow** flag and a notification after *Settings → Flag as slow after* (default 30 min).

Resuming uses each agent's **Resume command** (Projects → agent → *Take over*). Claude's is built in (`claude --resume {session_id} --mcp-config {mcp_file}`). For other tools, add their resume command and a **Session ID pattern** that finds the session ID in their output. Without one, you get a shell in the worktree with the agent's changes.

### Command placeholders

HandsFree shell-quotes these, so don't wrap them in quotes:

| Placeholder | Value |
|---|---|
| `{prompt}` | The full prompt text |
| `{prompt_file}` | Path to `.handsfree/prompt.md` |
| `{mcp_file}` | Path to `.handsfree/mcp.json` |
| `{issue_key}` `{worktree}` `{branch}` | Ticket key, worktree path, branch |
| `{jql}` | Jira search command only |
| `{repo}` `{query}` | GitHub search command only |
| `{issue_key}` `{number}` `{repo}` `{body}` | Tracker comment command (`-` = never comment) |
| `{issue_key}` `{number}` `{repo}` `{status}` | Jira transition / GitHub close command |

Agents also get `HANDSFREE=1`, `HANDSFREE_ISSUE=<KEY>` and `CI=1` in their environment.

### Check before first real run

- **Grok** preset is `grok --prompt {prompt}`. Confirm your Grok CLI's headless flag.
- **Antigravity** ships without a command. Add its headless command to enable it. If it only reads MCP config from a fixed path, use e.g. `cp {mcp_file} <its path> && <command>`.
- **acli** flags (`--fields`, `--limit`, `--json`) vary by version. **Test query** shows the exact error if they don't match; edit under *Advanced: CLI commands*.
- Claude's preset uses `--dangerously-skip-permissions` so it can run unattended. That's the point of the app, but it means the agent can run any command in the worktree.

## Where things live

- Config, state and per-ticket logs: `~/Library/Application Support/HandsFree/`
- Engine log: `~/Library/Logs/HandsFree/engine.log`
- Routine logs: `~/Library/Application Support/HandsFree/logs/routine-<id>.log`
- Worktrees: `<repo>/.worktrees/<KEY>` (characters outside `A-Z a-z 0-9 . _ -` become `-`, so GitHub's `repo#12` lives in `repo-12`: a `#` in the path breaks Vite/esbuild builds). `.worktrees/` and `.handsfree/` are added to the repo's `.git/info/exclude`, so your checkout stays clean.
- Setmore login: `~/Library/Application Support/HandsFree/auth/setmore.json` (mode 600; never sent anywhere but Setmore).

The engine listens on `127.0.0.1` with a random port and a per-launch token. Only the app can talk to it.
