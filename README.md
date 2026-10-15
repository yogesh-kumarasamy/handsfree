# HandsFree

A Mac app that picks up your Jira tickets, works each one in its own git worktree with a chain of AI agents, and opens a draft PR. Nothing to watch until the PR exists.

```
Jira (acli, your JQL) ─▶ .worktrees/<KEY> ─▶ Agent 1 ──fails / rate-limited──▶ Agent 2 … ─▶ commit
                                                                     ─▶ git push ─▶ gh pr create --draft ─▶ Jira comment with PR link
PR open ─▶ checked every few minutes: draft/ready, CI, reviews
   CI fails   ─▶ failing logs ─▶ agent chain again in the same worktree ─▶ push (up to N rounds)
   CI passes  ─▶ "ready for review" notification (once, published PRs only)
   approved   ─▶ "waiting to be merged" nudge after N minutes
   merged     ─▶ worktree removed ─▶ Jira comment with the PR link
```

## What's inside

| Path | What it is |
|---|---|
| `src-tauri/` | Mac shell (Tauri 2, Rust): window, menu bar icon, launch at login, notifications, starts the engine |
| `engine/src/` | The engine (Node/TypeScript): polling, worktrees, agent chain + fallback, PRs, Jira comment, local API |
| `src/` | The UI (React): Dashboard, Projects, Settings |
| `engine/test/e2e.mjs` | End-to-end test with fake `acli`, `gh` and agents |

## One-time setup on your Mac

```bash
xcode-select --install                                   # if you haven't already
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust, for building the app
node -v                                                  # Node 20+ (the engine runs on it)
gh auth login                                            # PRs
acli jira auth login                                     # Jira search + comments
claude --version; grok --version                         # your agents, logged in
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
2. **Jira.** Write the JQL and press **Test JQL**. Each ticket is picked up once; *Forget* on the dashboard lets it be picked up again.
3. **MCP servers.** Paste the project's `mcp.json`. It's written to `.handsfree/mcp.json` in every worktree and passed to agents as `{mcp_file}`.
4. **Agent chain.** Up to 4, top to bottom. The next agent takes over in the same worktree when one exits non-zero, matches a token-exhaustion pattern in its last output, times out, or finishes without changes.
5. **Save & activate.** It starts on the next check (Settings → *Check Jira every*), or press **Check Jira now**.
6. **After the PR.** The dashboard groups tickets into *In progress*, *Pull requests*, *Approved, not merged* and *Merged*. **Publish** marks a draft ready (`gh pr ready`); publishing in the GitHub UI is picked up on the next check (Settings → *Check PRs every*, default 3 min). When CI fails, HandsFree fetches the failing step logs (`gh run view --log-failed`) and runs the agent chain again in the same worktree, up to the project's *Max automatic fix rounds*; **Fix CI** starts a round by hand. Approved PRs that wait longer than the project's limit raise a nudge. Merged PRs get their worktree removed and a comment on the ticket.

Agents are told to commit but not push. HandsFree commits anything left uncommitted, pushes `handsfree/<KEY>`, opens the PR with `gh`, and comments the link on the ticket. Jira status is never changed.

### Watch or step in (any agent)

Every ticket has one **Open** button:

- **Running → 👀 Open live.** Terminal shows the agent's live output. Close the window to stop watching; the agent keeps going. Press **Enter** to take over: HandsFree stops the agent and continues its session right there, so you can talk to it.
- **Failed / stopped → Take over.** Continues the last agent's session in its worktree.
- **When you're done**, the ticket shows **With you**. Choose **Open PR with my changes** (commit, push, draft PR, Jira comment) or **Hand back to agents** (re-run the chain; agents are told you changed things).

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
| `{issue_key}` `{body}` | Jira comment command only |

Agents also get `HANDSFREE=1`, `HANDSFREE_ISSUE=<KEY>` and `CI=1` in their environment.

### Check before first real run

- **Grok** preset is `grok --prompt {prompt}`. Confirm your Grok CLI's headless flag.
- **Antigravity** ships without a command. Add its headless command to enable it. If it only reads MCP config from a fixed path, use e.g. `cp {mcp_file} <its path> && <command>`.
- **acli** flags (`--fields`, `--limit`, `--json`) vary by version. **Test JQL** shows the exact error if they don't match; edit under *Advanced: CLI commands*.
- Claude's preset uses `--dangerously-skip-permissions` so it can run unattended. That's the point of the app, but it means the agent can run any command in the worktree.

## Where things live

- Config, state and per-ticket logs: `~/Library/Application Support/HandsFree/`
- Engine log: `~/Library/Logs/HandsFree/engine.log`
- Worktrees: `<repo>/.worktrees/<KEY>`. `.worktrees/` and `.handsfree/` are added to the repo's `.git/info/exclude`, so your checkout stays clean.

The engine listens on `127.0.0.1` with a random port and a per-launch token. Only the app can talk to it.
