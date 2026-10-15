# Messaging (Setmore collab) — design

Date: 2026-10-15. Roadmap item 3 (see `2026-10-15-handsfree-roadmap.md`). Builds on the PR lifecycle (`2026-10-15-pr-lifecycle-design.md`), which already raises once-only `PrEvents`.

## 1. Outcome

- When CI passes on a published PR, HandsFree posts "please review" to the project's collab channel. When an approved PR has waited longer than the project's nudge delay, it posts "waiting to be merged". Both as the signed-in user, once per PR, text from per-project templates.
- From the dashboard, a PR row has **Send to collab** (template prefilled, editable before sending). Several PRs can be selected and sent as one combined message.
- Setmore is the first platform, talked to directly over its MCP server with the user's own OAuth login (no agent in the loop). A second adapter runs an agent with the user's MCP connectors instead, for platforms without a direct adapter and as a fallback.
- Everything is per project: platform, channel, templates. The Setmore login is per Mac user (Settings → Accounts).
- Every send is recorded on the ticket (when, where, ok/failed, error) and visible in the ticket detail; a failed send is a notification plus a badge, never a silent retry.

Out of scope: reading messages, replying, threads, Slack/Teams adapters (the seam is there), routines (item 5), tracker transitions (item 4).

## 2. Facts about Setmore established on 2026-10-15

- MCP server: `https://mcp.setmore.com/mcp`, streamable HTTP. Tools used: `list_channels({ query?, limit? }) → { channels: [{ channelId, name, isMember, memberCount }] }` and `send_message({ conversationType: "channel", conversationId, text, confirmationToken?, idempotencyKey? })`. `send_message` is a two-call flow: the first call (no token) returns a preview that carries a `confirmationToken`; the second call with the same arguments plus the token sends.
- Protected-resource metadata: `https://mcp.setmore.com/.well-known/oauth-protected-resource/mcp` → `authorization_servers: ["https://auth.setmore.com/o"]`, scopes `setmore.apis-internal.fullaccess awapis.streams.read awapis.users.read awapis.chat.users.push awapis.chat.streams.push awapis.fullaccess`.
- Authorization server metadata at `https://auth.setmore.com/o/.well-known/openid-configuration` (the `oauth-authorization-server` path 404s): `authorization_endpoint /oauth2/auth`, `token_endpoint /oauth2/v2/token`, `revocation_endpoint /oauth2/revoke`, grants `authorization_code` + `refresh_token`, PKCE `S256`, `token_endpoint_auth_methods_supported: client_secret_post, none`, scopes `openid offline_access`. **No dynamic client registration**, so a pre-registered public `client_id` is required (requested from the auth team; redirect `http://127.0.0.1:47831/oauth/callback`).
- Claude Code CLI on this Mac has the claude.ai `Setmore` connector connected; a headless `claude -p … --allowedTools mcp__claude_ai_Setmore__list_channels` call works (12 s, ~$0.76). This is the agent adapter's path.

## 3. Data model (`engine/src/types.ts`)

```ts
export type MessagingPlatform = "none" | "setmore" | "agent";

export interface MessagingConfig {
  platform: MessagingPlatform;
  /** Channel id on the platform (Setmore channelId). */
  channelId: string;
  /** Display name, cached from the channel picker. */
  channelName: string;
  templates: {
    reviewReady: string;   // default "Hey team, please review the PR for {key} — {summary}: {pr_url}"
    mergeNudge: string;    // default "Hi team, this PR is approved and has been waiting {approved_ago} to be merged: {pr_url}"
    manual: string;        // default "{key} — {summary}: {pr_url}"
    bulk: string;          // default "Hi team, these PRs need eyes:\n{list}"
  };
  /** platform "agent" only: command template; {prompt} is filled. Default: claude -p with the Setmore connector tools allowed. */
  agentCommand: string;
}

export interface SetmoreAccountSettings {
  clientId: string;
  /** Loopback port for the OAuth redirect; must match the registered redirect URI. Default 47831. */
  redirectPort: number;
  /** Overridable for tests. Defaults: https://mcp.setmore.com/mcp and https://auth.setmore.com/o. */
  mcpUrl: string;
  issuer: string;
  scopes: string;        // default "openid offline_access awapis.chat.streams.push awapis.streams.read awapis.users.read"
}

// Settings additions
accounts: { setmore: SetmoreAccountSettings };

// ProjectConfig addition
messaging: MessagingConfig;

export type MessageKind = "review_ready" | "merge_nudge" | "manual" | "bulk" | "test";

export interface MessageRecord {
  kind: MessageKind;
  at: string;
  platform: MessagingPlatform;
  channelId: string;
  channelName: string;
  text: string;
  ok: boolean;
  /** Platform message id when known. */
  id?: string;
  error?: string;
}

// Ticket addition
messages?: MessageRecord[];

// EngineState addition
accounts: { setmore: AccountStatus };
export interface AccountStatus {
  loggedIn: boolean;
  /** Display name / email from the token's id claims when present. */
  user?: string;
  scope?: string;
  expiresAt?: string;
  /** Set when the last refresh or call failed with an auth error; cleared on login. */
  error?: string;
  /** True while a login is in progress (loopback server listening). */
  loginPending?: boolean;
}

// EngineEvent addition
| { type: "account"; name: "setmore"; status: AccountStatus }
```

Template placeholders: `{key} {summary} {pr_url} {pr_number} {project} {branch} {approved_ago} {list}`. `{list}` is only meaningful in `bulk` and is "- {key} — {summary}: {pr_url}" per line. Unknown placeholders are left as-is. Templates are plain text, not shell-quoted (the `fill` helper in `shell.ts` quotes; messaging uses its own `fillTemplate`).

Token storage: `DATA_DIR/auth/setmore.json`, file mode `0600`:

```ts
interface StoredTokens { accessToken: string; refreshToken?: string; expiresAt: string; scope?: string; idClaims?: { name?: string; email?: string } }
```

Never in `config.json` or `state.json`, never on the SSE stream.

## 4. Components

### 4.1 `engine/src/messaging/templates.ts` (pure)

- `fillTemplate(tpl: string, vars: Record<string, string>): string` — `{name}` replacement, no quoting.
- `ticketVars(p: ProjectConfig, t: Ticket, now?: number): Record<string, string>` — builds the placeholder map; `approved_ago` is a humanised duration from `t.pr.approvedAt` ("47 min", "3 h 10 min"), empty when unknown.
- `bulkList(items: { p: ProjectConfig; t: Ticket }[]): string`.

### 4.2 `engine/src/messaging/oauth.ts`

- `pkce(): { verifier, challenge }` (RFC 7636, S256, base64url), `randomState()`.
- `discover(issuer, mcpUrl, fetchImpl?)` — tries `<issuer>/.well-known/openid-configuration`, then `<issuer>/.well-known/oauth-authorization-server`, returns `{ authorizationEndpoint, tokenEndpoint, revocationEndpoint? }`. Cached per process.
- `buildAuthorizeUrl(meta, { clientId, redirectUri, scope, state, challenge, resource })` — includes `code_challenge_method=S256` and RFC 8707 `resource=<mcpUrl>`.
- `exchangeCode(meta, { clientId, code, redirectUri, verifier, resource })` and `refresh(meta, { clientId, refreshToken, resource })` — `application/x-www-form-urlencoded` POST, public client (no secret). Errors carry the server's `error`/`error_description` text.
- `decodeIdClaims(idToken?)` — base64url JSON of the payload, no signature check (display only).
- `TokenStore` — `load/save/clear` of `DATA_DIR/auth/<name>.json` with mode 0600; `save` writes atomically like `store.ts`.

### 4.3 `engine/src/messaging/mcpclient.ts`

Minimal streamable-HTTP MCP client, no SDK dependency:

- `class McpClient { constructor(url, getToken: () => Promise<string>, opts?) }`
- `initialize()` — `POST` JSON-RPC `initialize` with `protocolVersion: "2025-06-18"`, `clientInfo { name: "HandsFree", version }`; stores `Mcp-Session-Id` from the response headers; sends `notifications/initialized`.
- `callTool(name, args)` — `tools/call`; lazily initialises. Headers: `Authorization: Bearer`, `Accept: application/json, text/event-stream`, `Content-Type: application/json`, `MCP-Protocol-Version`, `Mcp-Session-Id` when known.
- Response handling: `application/json` → parse; `text/event-stream` → read the body, take the last `data:` JSON-RPC message whose `id` matches. JSON-RPC `error` → throw `McpError(code, message)`. Tool `isError: true` → throw with the text content.
- `401` → call `onUnauthorized()` once (the adapter refreshes the token) and retry the request once; a second 401 throws `AuthError`. `404` with a session id → drop the session, re-initialise once, retry.
- `toolText(result)` → concatenated `content[].text`; `toolJson(result)` → `structuredContent` if present, else the first `JSON.parse`-able text block, else `undefined`.

### 4.4 `engine/src/messaging/adapter.ts` and adapters

```ts
export interface MessagingAdapter {
  readonly platform: MessagingPlatform;
  listChannels(query?: string): Promise<{ id: string; name: string }[]>;
  send(channelId: string, text: string, idempotencyKey: string): Promise<{ id?: string }>;
}
```

- `setmore.ts` — `SetmoreAdapter(settings, tokens: TokenStore, onStatus)`. `getToken()` loads tokens, refreshes when `expiresAt` is within 60 s (single in-flight refresh), persists, and reports `AccountStatus` changes through `onStatus`. `listChannels` → `list_channels` and maps `channelId/name`. `send` → `send_message` without a token, finds `confirmationToken` in `toolJson` (searched recursively by key) or in the text (`/confirmationToken["']?\s*[:=]\s*["']?([\w-]+)/`), then calls again with it and the same `idempotencyKey`. Message id from `toolJson` keys `messageId | id` when present. If the first call already reports `sent: true` (server may skip the preview for trusted clients), returns immediately. No token → `AuthError("Not logged in to Setmore")`.
- `agent.ts` — `AgentAdapter(cmdTemplate, cwd)`. Builds the prompt: the exact text (fenced), the channel id and name, "You have the user's explicit consent: call send_message once to get the confirmationToken, then call it again with that token. Do not change the text. Finish by printing only `{"sent": true, "id": "<message id or empty>"}` or `{"sent": false, "error": "<why>"}`." Runs `fill(cmdTemplate, { prompt })` with `sh`, 3 min timeout; parses the last JSON object in stdout (for `--output-format json` it is Claude's envelope: use its `result` field). `listChannels` uses the same mechanism with `list_channels` and expects a JSON array of `{ id, name }`.
- `index.ts` — `adapterFor(project, settings, deps): MessagingAdapter | undefined` (`none` → undefined).

### 4.5 `engine/src/messaging/service.ts` — `MessagingService`

Owned by the orchestrator (constructed in `start()` with `config`, `state`, `prEvents`, `log`, `notify`, `persist`):

- `onPrEvent(e)` — `review_ready` → `sendForTicket(t, "review_ready", template)`, `merge_nudge` → likewise. Other kinds ignored. Skips silently (one log line) when the project's platform is `none` or the template is empty.
- `sendForTicket(t, kind, text)` — resolves adapter + channel, `idempotencyKey = ${t.key}:${kind}:${t.pr?.headSha ?? ""}:${date}`, pushes a `MessageRecord` (ok or failed, truncated error), logs `💬 sent to #channel` or `! send failed: …`, notifies on failure (`kind: "failed"`), persists. Returns the record.
- `sendManual(key, text?)` — `manual` template filled unless `text` given.
- `sendBulk(keys, text?)` — groups by project; one message per project with the `bulk` template (`{list}`), or `text` with `{list}` filled if provided; records a `bulk` entry on every ticket in the group.
- `sendTest(projectLike)` — "HandsFree test message from <project> at <time>" to the configured channel, no ticket; returns `{ ok, error? }`.
- `listChannels(projectLike, query)`.
- Setmore account: `loginUrl()` starts the loopback server (port from settings; `EADDRINUSE` → error "port in use"), stores `state`/`verifier`, returns the authorize URL; the callback handler validates `state`, exchanges the code, saves tokens, decodes id claims, emits `{ type: "account" }`, serves a tiny "Signed in — you can close this tab" HTML, and closes the server. Timeout 5 min → server closed, `loginPending` cleared. `logout()` best-effort revokes the refresh token and clears the file. `status()`.

The service reads `config` through a getter so project/template edits apply immediately.

### 4.6 Routes (`engine/src/server.ts`) and `src/api.ts`

| Route | Body | Returns |
|---|---|---|
| `POST /api/tickets/:key/message` | `{ text?: string }` | `MessageRecord` (400 with `{error}` on failure) |
| `POST /api/messages/bulk` | `{ keys: string[]; text?: string }` | `{ sent: MessageRecord[]; failed: { key; error }[] }` |
| `POST /api/messaging/test` | `{ project: ProjectConfig }` | `{ ok: boolean; error?: string }` |
| `POST /api/messaging/channels` | `{ project: ProjectConfig; query?: string }` | `{ channels: { id; name }[]; error?: string }` |
| `GET /api/accounts/setmore` | – | `AccountStatus` |
| `POST /api/accounts/setmore/login` | – | `{ url: string }` |
| `POST /api/accounts/setmore/logout` | – | `{}` |

`Api` gains `sendMessage`, `sendBulk`, `testMessage`, `listChannels`, `setmoreStatus`, `setmoreLogin`, `setmoreLogout`. The mock implements them (login flips to logged in after 1 s, sends append records).

### 4.7 UI

- **Settings → Accounts** card: Setmore `client_id` input, redirect port (read-only text showing the full redirect URI to register), status line (logged in as …, or error), **Log in** (calls login, opens the URL with `openExternal`, shows "Finish signing in in your browser…" until the `account` event arrives) and **Log out**. Advanced disclosure: MCP URL, issuer, scopes.
- **Project editor** → new step **Messaging** between "Agent chain" and "Review": platform select (`None`, `Setmore collab`, `Agent (any MCP platform)`), channel picker (text filter + "Load channels" → list; picking sets `channelId/channelName`; manual id entry allowed), four template textareas with a placeholder legend, agent command field (agent platform only), **Send test message** with result callout. Review step shows platform + channel. Validation: platform ≠ none requires a channel id.
- **Dashboard**: checkbox column in *Pull requests* and *Approved, not merged*; a sticky bar "N selected · Send to collab" opens a small dialog with the combined text (bulk template filled) editable, Send/Cancel; a per-row **Send** button and a **Send to collab** button in the ticket detail open the same dialog with the manual template. Rows show a `💬` pill with the last send (ok/failed) and the detail lists `messages` newest first.
- Sidebar: nothing new.

## 5. Behaviour and edge cases

- `review_ready` fires once per PR (lifecycle design); so does the message. A fix push after the message does not resend. The manual button exists for that.
- Merge nudge: once, after the delay; the manual/bulk send covers repeats ("I need a manual send even after sending if it does not work").
- Not logged in / token revoked: automatic sends fail fast with `AuthError`, recorded on the ticket, one notification per failure, account status shows the error and Settings highlights **Log in**. No queueing or retry; the next event or a manual send tries again.
- Channel not set: automatic sends are skipped with a log line "messaging: no channel configured"; manual send returns 400 "Choose a channel in the project's Messaging step".
- Template empty: that kind is skipped.
- Agent adapter: a run that ends without the final JSON, or with `sent: false`, is a failed send with the agent's last 300 characters as the error. Each send is one agent process; bulk is one process per project.
- Login: only one pending login at a time; a second click returns the same URL. The loopback server binds `127.0.0.1` only and accepts a single callback.
- Tokens: refresh is attempted when `expiresAt - 60 s` has passed, or on a 401. Refresh failure with `invalid_grant` clears the tokens (user must log in again); other failures keep them and report the error.
- The OAuth `resource` parameter is sent on authorize, token and refresh requests (RFC 8707); if the server rejects `resource` (`invalid_target`/`invalid_request`), the request is retried once without it, and the outcome is remembered for the process.
- Nothing about tokens or the MCP server is passed to coding agents; the project's `mcpJson` is untouched.

## 6. Testing

- **Unit** (`engine/test/*.test.mjs`, built with the existing `build:test` bundle list extended): `templates` (fill, ticketVars incl. approved_ago, bulkList); `oauth` (PKCE vector: verifier → known S256 challenge; authorize URL contents; exchange/refresh against an in-process `node:http` fake token endpoint, including `invalid_grant` clearing tokens and the `resource` retry); `mcpclient` against an in-process fake MCP server (JSON and SSE responses, session id propagation, tool `isError`, 401→refresh→retry, 404→re-initialise); `setmore adapter` (two-call `send_message`, `confirmationToken` found in structured and text form, `sent: true` shortcut, message id extraction); `agent adapter` (parses the JSON envelope, `sent:false` → failure).
- **E2E** (`engine/test/e2e.mjs` extended): the test starts a fake Setmore MCP server and a fake auth server (`issuer` + `mcpUrl` overridden through `settings.accounts.setmore`). Flow: `POST /login` → follow the returned URL to the fake authorize endpoint, which redirects to the loopback callback with a code → engine exchanges it → `GET /api/accounts/setmore` is logged in; `review_ready` and `merge_nudge` from the existing lifecycle scenario each produce exactly one message on the fake server with the project's channel id and filled template; manual send with custom text; bulk send of two tickets produces one combined message containing both keys; a 401 from the fake MCP server after the fake auth server rotates tokens → refresh → send succeeds; after `logout`, an automatic send is recorded as failed with "Not logged in". Agent adapter: an e2e fake `fakemsg` script that prints the JSON envelope, wired as `agentCommand`, proves the manual send path for platform `agent`.
- `npm run test:engine` stays the single command; `npm run typecheck` covers both tsconfigs.

## 7. Migration and compatibility

- `normalizeProject` adds `messaging` with platform `none` and the default templates; `DEFAULT_SETTINGS.accounts.setmore` with empty `clientId`, port 47831, production URLs and scopes.
- `migrateState` adds `accounts: { setmore: { loggedIn: false } }`; the real status is computed from the token file on start.
- No change to existing routes or to the PR lifecycle state machine.

## 8. Files

- New: `engine/src/messaging/{templates,oauth,mcpclient,adapter,setmore,agent,index,service}.ts`, `engine/test/{templates,oauth,mcpclient,setmore,agentmsg}.test.mjs`, `engine/test/fakes/{mcp-server,auth-server}.mjs` (shared by unit and e2e).
- Modified: `engine/src/{types,store,orchestrator,server}.ts`, `engine/test/e2e.mjs`, `package.json` (`build:test` entry list), `src/{api,mock,ui}.ts(x)`, `src/views/{Settings,Projects,Dashboard}.tsx`, `src/styles.css`, `README.md`.
