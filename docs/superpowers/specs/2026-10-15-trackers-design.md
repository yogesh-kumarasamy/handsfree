# Trackers (Jira, GitHub Issues, Linear) — design

Date: 2026-10-15. Roadmap item 4 (see `2026-10-15-handsfree-roadmap.md`). Builds on the PR lifecycle (`2026-10-15-pr-lifecycle-design.md`) and reuses the OAuth helper and MCP client from messaging (`2026-10-15-messaging-design.md`).

## 1. Outcome

- A project chooses its tracker: **Jira** (default, via `acli`), **GitHub Issues** (via `gh`), or **Linear** (via Linear's MCP server, signed in once from Settings → Accounts). The query, comment and "done" behaviour follow the tracker.
- On merge, the ticket is moved to the project's configured done status (Jira "Done", GitHub closed as completed, Linear "Done") and gets the two-line comment with the PR link. The "PR opened" comment keeps working for every tracker.
- Prompts, logs and UI copy stop saying "Jira" unless the project uses Jira.
- Existing projects keep working unchanged: their Jira settings migrate into the tracker config with `doneStatus: "Done"`.

Out of scope: creating tickets, reading comments, two-way status sync other than the merge transition, routines (item 5).

## 2. Facts established on 2026-10-15

- `acli jira workitem transition --key KEY --status "Done" --yes` transitions a Jira work item (also `--json`).
- `gh issue list --repo OWNER/REPO --search "<filter>" --state open --limit 50 --json number,title,body,url`; `gh issue comment N --repo OWNER/REPO -b "<text>"`; `gh issue close N --repo OWNER/REPO -r completed -c "<text>"`.
- Linear MCP: `https://mcp.linear.app/mcp`, streamable HTTP, OAuth with **dynamic client registration** (`https://mcp.linear.app/register`), PKCE S256, scopes `read write`. Tools (per Linear's MCP documentation): `list_issues` (filters: `assignee` ("me" allowed), `state`, `team`, `query`, `limit`), `list_my_issues`, `get_issue` (`id`), `create_comment` (`issueId`, `body`), `update_issue` (`id`, `state`, …), `list_issue_statuses` (`team`). Exact argument names are confirmed at runtime from `tools/list` (`inputSchema.properties`); the adapter maps by name and tolerates `issueId`/`id`/`issue`.

## 3. Data model (`engine/src/types.ts`)

```ts
export type TrackerKind = "jira" | "github" | "linear";

export interface TrackerConfig {
  kind: TrackerKind;
  /** Jira: JQL. GitHub: `gh issue list --search` filter (e.g. "assignee:@me label:handsfree"). Linear: free text passed as the `query` filter plus assignee=me unless `linearAssignee` says otherwise. */
  query: string;
  /** Jira/GitHub only. Placeholders Jira: {jql}. GitHub: {repo} {query}. Empty = default. */
  searchCommand: string;
  /** Jira/GitHub only. Placeholders: {issue_key} {number} {repo} {body}. Empty = default; "-" = never comment. */
  commentCommand: string;
  /** Jira/GitHub only. Placeholders: {issue_key} {number} {repo} {status}. Empty = default. */
  transitionCommand: string;
  /** Status to move the ticket to on merge. Empty = don't transition. Jira default "Done"; GitHub: any non-empty value closes the issue as completed; Linear default "Done". */
  doneStatus: string;
  /** GitHub only: OWNER/REPO. Empty = derived from the project's remote URL. */
  repo: string;
  /** Linear only: "me" (default) or a user name/email, or "" for no assignee filter. */
  linearAssignee: string;
}

// ProjectConfig: `jql`, `jiraSearchCommand`, `jiraCommentCommand` are REMOVED and replaced by
tracker: TrackerConfig;

// FoundIssue additions
export interface FoundIssue {
  key: string;
  summary: string;
  description?: string;
  /** Tracker-internal id when it differs from the key (Linear issue id, GitHub number). */
  id?: string;
  url?: string;
}

// Ticket additions
/** Tracker-internal id (Linear issue id, GitHub number) for comments/transitions. */
trackerId?: string;
issueUrl?: string;
/** Set when the done transition succeeded. */
trackerDone?: boolean;

// Settings.accounts addition
accounts: { setmore: SetmoreAccountSettings; linear: LinearAccountSettings };
export interface LinearAccountSettings {
  mcpUrl: string;      // default https://mcp.linear.app/mcp
  issuer: string;      // default https://mcp.linear.app
  redirectPort: number; // default 47832
  scopes: string;      // default "read write"
}

// EngineState.accounts addition
accounts: { setmore: AccountStatus; linear: AccountStatus };

// EngineEvent account event
| { type: "account"; name: "setmore" | "linear"; status: AccountStatus }

export const DEFAULT_JIRA_TRANSITION = "acli jira workitem transition --key {issue_key} --status {status} --yes";
export const DEFAULT_GITHUB_SEARCH = "gh issue list --repo {repo} --search {query} --state open --limit 50 --json number,title,body,url";
export const DEFAULT_GITHUB_COMMENT = "gh issue comment {number} --repo {repo} --body {body}";
export const DEFAULT_GITHUB_CLOSE = "gh issue close {number} --repo {repo} --reason completed";
export const TRACKER_NOUN: Record<TrackerKind, string> = { jira: "Jira ticket", github: "GitHub issue", linear: "Linear issue" };
```

`jiraCommented` on `Ticket` stays as the field name (persisted state) but the UI labels it "Commented on the ticket".

**Migration** (`normalizeProject`): when `tracker` is missing, build `{ kind: "jira", query: p.jql || "", searchCommand: p.jiraSearchCommand ?? "", commentCommand: p.jiraCommentCommand ?? "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me" }`. The three old fields are dropped on the next save.

**Ticket keys** per tracker: Jira `ABC-123` (unchanged); GitHub `<repo-name>#<number>` (e.g. `chatsupport-web#12`, repo name = last path segment of `repo`); Linear `identifier` (e.g. `ENG-123`). Branch `handsfree/<key>`, worktree `.worktrees/<key>` (git accepts `#` in refs and paths; `logFile` already sanitises).

**Linear tokens**: `DATA_DIR/auth/linear.json` (same `TokenStore`); the registered client is stored next to it in `DATA_DIR/auth/linear-client.json` (`client_id`, optional `client_secret`, registered redirect URI) and reused until the redirect port changes.

## 4. Components

### 4.1 `engine/src/trackers/adapter.ts`

```ts
export interface TrackerAdapter {
  readonly kind: TrackerKind;
  /** "Jira ticket" / "GitHub issue" / "Linear issue" — for prompts and logs. */
  readonly noun: string;
  search(): Promise<FoundIssue[]>;
  comment(t: Pick<Ticket, "key" | "trackerId">, body: string): Promise<{ skipped: boolean }>;
  /** Move to `status`; `skipped` when the project has no done status or the tracker can't. */
  transition(t: Pick<Ticket, "key" | "trackerId">, status: string): Promise<{ skipped: boolean }>;
}
export function trackerFor(p: ProjectConfig, deps: TrackerDeps): TrackerAdapter;
export interface TrackerDeps { linearTokens: TokenStore; linearClient: ClientStore; settings: Settings; onLinearStatus: (s: AccountStatus) => void; linear?: LinearAdapter; fetchImpl?: typeof fetch }
```

### 4.2 `engine/src/trackers/jira.ts`

Moves the current `engine/src/jira.ts` logic behind the interface (`parseIssues` stays exported for tests). `transition` runs `transitionCommand || DEFAULT_JIRA_TRANSITION` with `{issue_key}` `{status}`; `{status}` is shell-quoted by `fill`. Empty `doneStatus` → `{ skipped: true }`. `commentCommand === "-"` → skipped.

### 4.3 `engine/src/trackers/github.ts`

- `repo` resolution: `tracker.repo` or, from `git remote get-url <remote>` in `repoPath`, the `owner/name` of a `github.com` URL (ssh or https); error "Set the GitHub repo (owner/name) in the Tracker step" when neither works.
- `search`: `searchCommand || DEFAULT_GITHUB_SEARCH` with `{repo}` `{query}`; parses the JSON array into `FoundIssue { key: "<name>#<number>", summary: title, description: body, id: String(number), url }`. A non-JSON output falls back to lines like `#12 Title`.
- `comment`: `commentCommand || DEFAULT_GITHUB_COMMENT` with `{number}` (from `trackerId`, or the digits after `#` in the key) `{repo}` `{body}` `{issue_key}`.
- `transition`: non-empty `doneStatus` → `transitionCommand || DEFAULT_GITHUB_CLOSE` (closes as completed). Empty → skipped.

### 4.4 `engine/src/trackers/linear.ts`

- `LinearAdapter(settings.accounts.linear, tokens, client, onStatus, fetchImpl)` built on `McpClient` (from `../messaging/mcpclient`) with the same refresh/401 behaviour as the Setmore adapter (shared helper, see 4.5).
- On first use, `tools/list` is called once per process and cached: `{ name → inputSchema }`. Argument names are picked from the schema: for `list_issues` use `assignee` when present (value from `linearAssignee`, default `"me"`), `query` when `tracker.query` is non-empty, `limit: 50`; for `create_comment` the first of `issueId | id | issue`; for `update_issue` `id` plus the first of `state | stateId | status` set to `doneStatus`.
- `search`: `list_issues` (falls back to `list_my_issues` when `list_issues` is absent). Result parsing: `toolJson` → array, or `{ issues | nodes | data }`; each item → `FoundIssue { key: identifier, summary: title, description, id, url }`. Items without `identifier` are skipped.
- `comment`: `create_comment`; `transition`: `update_issue` with the done status; both `skipped: true` when the tool is absent (logged once).
- Not logged in → `AuthError("Not logged in to Linear. Settings → Accounts → Log in.")`.

### 4.5 Shared OAuth login: `engine/src/oauthlogin.ts`

The loopback login currently inside `MessagingService` (`loginUrl`, `onCallback`, `finishLogin`, `logout`) is extracted into a reusable class so Linear can use it:

```ts
export class LoopbackLogin {
  constructor(o: { name: "setmore" | "linear"; issuer: () => string; resource: () => string; scopes: () => string; redirectPort: () => number; clientId: () => Promise<string>; tokens: TokenStore; onStatus: (s: AccountStatus) => void; status: (error?: string) => AccountStatus; fetchImpl?: typeof fetch });
  loginUrl(): Promise<string>;   // same behaviour as today: single pending, state check, one-time exchange, busy-port error, 5-min timeout
  logout(): Promise<void>;       // revoke + clear
  shutdown(): void;
  get pending(): boolean;
}
```

`MessagingService` keeps its public API (`loginUrl`, `logout`, `status`, `shutdown`) and delegates. For Linear, `clientId()` performs dynamic registration when `linear-client.json` is missing: `POST <registration_endpoint>` (from discovery; `https://mcp.linear.app/register`) with `{ client_name: "HandsFree", redirect_uris: [redirectUri], grant_types: ["authorization_code","refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }`, stores the response. `discover` gains `registrationEndpoint?`. The token request uses `client_secret` (as `client_secret_post`) only if the registration returned one.

A `TrackerService` (`engine/src/trackers/service.ts`) owns the Linear login + status (`init`, `status`, `loginUrl`, `logout`, `settingsChanged`, `shutdown`) and `trackerFor(p)` with the per-process Linear adapter cache, mirroring `MessagingService`.

### 4.6 Orchestrator changes

- `poll()`: `trackerFor(p).search()` instead of `searchIssues(p)`; new tickets get `trackerId`, `issueUrl`. Pick-up log line: `picked up by <noun> query for “<project>”`.
- PR-opened comment: `tracker.comment(t, "HandsFree opened a … PR for this <noun>: <url>")` → log `✓ Commented the PR link on the <noun>`.
- `onMerged`: after the worktree removal: `transition(t, p.tracker.doneStatus)` → log `✓ Moved the <noun> to “Done”` / `! Transition failed: …`, `trackerDone: true` on success; then the existing merge comment through the adapter.
- `buildPrompt`: `You are working unattended on ${noun} ${t.key}: …`; the "no description" hint becomes `(No description was fetched. Read the full ${noun} with the tracker's CLI or MCP server before starting.)`.
- `doctor()`: `acli` is listed only when some project uses Jira; `gh` always.

### 4.7 Routes / API

- `POST /api/test-jira` is replaced by `POST /api/test-tracker` `{ project }` → `{ issues, error? }` (`Api.testTracker`; `testJira` removed).
- `GET /api/accounts/linear`, `POST /api/accounts/linear/login`, `POST /api/accounts/linear/logout` (`Api.linearStatus/linearLogin/linearLogout`), same shapes as Setmore.

### 4.8 UI

- Projects step 2 renamed **Tracker**: kind select (Jira / GitHub Issues / Linear); query textarea with per-kind label and hint (JQL; `gh issue list --search` filter; Linear text filter + assignee field); **Test query** button; GitHub: repo field (prefilled from the remote when empty); done status field (default per kind, "leave empty to never transition"); Advanced: search/comment/transition command templates (Jira/GitHub only, with placeholder hints). Validation: query required for Jira and GitHub; Linear requires a Linear login (warning, not blocking).
- Project card shows `<kind> · <query>`; Review step shows tracker kind, query, done status.
- Settings → Accounts: a Linear card (no client id; Log in / Log out, status, advanced URLs/port) next to the Setmore card.
- Dashboard: "Check Jira now" → "Check tickets now"; header "Jira checked" → "Tickets checked"; sidebar "Watching Jira" → "Watching tickets"; ticket detail "Jira" row → "Tracker" with `issueUrl` link when present and "Moved to Done ✓" after the transition.
- README: tracker section.

## 5. Behaviour and edge cases

- Transition failure never blocks the merge handling: logged, `trackerDone` stays unset, the ticket is still `merged`; a notification `KEY: couldn't move the <noun> to Done`.
- `doneStatus` empty → no transition, no error.
- GitHub keys never collide within a project; across projects on repos with the same name they would — accepted and documented.
- Linear not logged in → poll error for that project (`pollErrors[p.id]`), shown on the dashboard like a Jira CLI failure today.
- Linear registration/login failure → `AccountStatus.error`, shown in Settings.
- `KEY_RE` (Jira-only) is removed from the generic path; each adapter parses its own keys.

## 6. Testing

- **Unit**: `trackers/github` parsing (JSON and text fallback, key format, repo derivation from ssh/https remotes), `trackers/jira` transition command fill (quoting of a status with spaces), `trackers/linear` against a fake Linear MCP server (generic fake with configurable tools: `tools/list` schema → argument mapping; `list_issues` → keys/ids; `create_comment`; `update_issue`; missing tool → skipped), `oauthlogin` dynamic registration against the fake auth server extended with `/register`, and the extracted `LoopbackLogin` (state check, duplicate callback, busy port — moved from the service tests).
- **E2E**: existing Jira flow asserts the merge transition (`fake acli transition … --status Done`). A second project of kind `github` on the same repo: fake `gh issue list` returns one issue → ticket `repo#5` picked up, worktree + PR, comment via `gh issue comment`, merge → `gh issue close … --reason completed`. Linear: fake Linear MCP + fake auth with registration; `POST /api/accounts/linear/login` flow; a Linear project picks up `ENG-7`, comments on PR open, `update_issue` on merge.
- `npm run test:engine` stays the single command.

## 7. Files

- New: `engine/src/trackers/{adapter,jira,github,linear,service}.ts`, `engine/src/oauthlogin.ts`, `engine/test/{trackers-github,trackers-jira,trackers-linear,oauthlogin}.test.mjs`, `engine/test/fakes/linear-mcp.mjs` (or a `tools` option on `mcp-server.mjs`).
- Modified: `engine/src/{types,store,orchestrator,server}.ts`, `engine/src/messaging/{service,oauth}.ts` (login extraction, `registrationEndpoint`), `engine/src/jira.ts` (removed; logic moves), `engine/test/{e2e.mjs,service.test.mjs,fakes/auth-server.mjs}`, `package.json` (`build:test` list), `src/{api,mock}.ts`, `src/views/{Projects,Settings,Dashboard}.tsx`, `src/App.tsx`, `README.md`.
