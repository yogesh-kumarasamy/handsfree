# Messaging (Setmore collab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HandsFree posts "please review" and "waiting to be merged" messages to a per-project collab channel as the signed-in user, plus manual and bulk sends from the dashboard, through a direct Setmore MCP adapter (OAuth 2.1 + PKCE) with an agent-driven adapter as fallback.

**Architecture:** A new `engine/src/messaging/` package: pure template helpers, an OAuth helper + token store, a minimal streamable-HTTP MCP client, two `MessagingAdapter` implementations (`setmore`, `agent`), and a `MessagingService` that subscribes to the orchestrator's `PrEvents`, records every send on the ticket, and runs the loopback OAuth login. Routes expose sends, channel listing and account login; the UI adds an Accounts card, a Messaging project step, and selection + send dialog on the dashboard. Tests run against in-process fake auth and MCP servers shared by unit tests and the e2e.

**Tech Stack:** Node 20 (`fetch`, `node:http`, `node:crypto`), TypeScript via esbuild, `node --test`, React 18, existing e2e harness with fake CLIs. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-messaging-design.md` (facts about Setmore in §2; lifecycle events come from `docs/superpowers/specs/2026-10-15-pr-lifecycle-design.md`)

## Global Constraints

- No new runtime dependencies; HTTP via Node 20 `fetch`, servers via `node:http`.
- Tokens live only in `DATA_DIR/auth/setmore.json` (mode `0600`), never in `config.json`, `state.json`, or on the SSE stream. The SSE `account` event carries `AccountStatus` only.
- Default redirect: `http://127.0.0.1:47831/oauth/callback`; default scopes `openid offline_access awapis.chat.streams.push awapis.streams.read awapis.users.read`; default `mcpUrl https://mcp.setmore.com/mcp`, `issuer https://auth.setmore.com/o`.
- Messages are sent once per event (the lifecycle already fires `review_ready`/`merge_nudge` once); failed sends are recorded + notified, never retried automatically.
- Templates use `{placeholder}` with no shell quoting; placeholders: `{key} {summary} {pr_url} {pr_number} {project} {branch} {approved_ago} {list}`.
- Nothing about tokens or the MCP server is passed to coding agents; `mcpJson` is untouched.
- `npm run typecheck` and `npm run test:engine` must pass after every task. Commit after every task.

## Review Focus

1. **Setmore's `send_message` preview shape is unknown** — the `confirmationToken` may come back in `structuredContent`, nested JSON text, or prose; if not found the send must fail with the server's text in the error, never send twice, never loop. Pinned by the adapter unit tests in Task 4 (structured, nested, text, and "no token" cases).
2. **Token refresh racing with two sends** — two automatic sends in the same second (bulk per project + an event) must share one refresh and never clear tokens because the second refresh used a rotated refresh token. Pinned by the single-flight refresh test in Task 4.
3. **OAuth callback with the wrong `state`, an `error` param, or a second request** — must not exchange anything, must show a readable page, and must leave the login pending until the real callback or the 5-minute timeout. Pinned by the e2e "bad state is rejected" step in Task 5.
4. **Loopback port busy** (another app or a second HandsFree) — Log in must fail with "port … is in use" instead of hanging. Pinned by the e2e "port in use" step in Task 5.
5. **Bulk selection spanning projects with different channels/platforms** — one message per project, each to its own channel; a project with platform `none` is reported as failed for its keys, not silently dropped. Pinned by the service unit test in Task 5.

---

### Task 1: Types, defaults, migration, template helpers

**Files:**
- Modify: `engine/src/types.ts`, `engine/src/store.ts`, `package.json` (`build:test`)
- Create: `engine/src/messaging/templates.ts`, `engine/test/templates.test.mjs`
- Modify (compile only): `src/mock.ts`, `src/views/Projects.tsx` (`blankProject`), `engine/test/e2e.mjs` (config written to disk)

**Interfaces:**
- Produces (types): `MessagingPlatform`, `MessagingConfig`, `MessageTemplates`, `SetmoreAccountSettings`, `MessageKind`, `MessageRecord`, `AccountStatus`, `Settings.accounts`, `ProjectConfig.messaging`, `Ticket.messages`, `EngineState.accounts`, `EngineEvent` `account`; constants `DEFAULT_TEMPLATES`, `DEFAULT_AGENT_MESSAGE_COMMAND`, `DEFAULT_SETMORE_ACCOUNT`.
- Produces (templates): `fillTemplate(tpl, vars)`, `humanDuration(fromIso, nowMs?)`, `ticketVars(p, t, nowMs?)`, `bulkList(items)`.
- Produces (store): `normalizeSettings(raw)`, `normalizeProject` fills `messaging`, `migrateState` fills `accounts`.

- [ ] **Step 1: Failing template tests**

Create `engine/test/templates.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkList, fillTemplate, humanDuration, ticketVars } from "../dist/test/messaging/templates.js";

test("fillTemplate: replaces known placeholders, leaves unknown ones, no quoting", () => {
  assert.equal(fillTemplate("Hi {name}: {pr_url} {nope}", { name: "O'Brien", pr_url: "https://x/1" }), "Hi O'Brien: https://x/1 {nope}");
});

test("humanDuration: minutes, hours, days", () => {
  const t0 = Date.parse("2026-10-15T10:00:00Z");
  const iso = (min) => new Date(t0 - min * 60_000).toISOString();
  assert.equal(humanDuration(iso(0), t0), "0 min");
  assert.equal(humanDuration(iso(47), t0), "47 min");
  assert.equal(humanDuration(iso(60), t0), "1 h");
  assert.equal(humanDuration(iso(190), t0), "3 h 10 min");
  assert.equal(humanDuration(iso(26 * 60), t0), "1 d 2 h");
});

const p = { name: "ChatSupport Web" };
const t = { key: "CSW-1", summary: "Add greeting", branch: "handsfree/CSW-1", prUrl: "https://github.com/a/r/pull/7", pr: { number: 7, approvedAt: "2026-10-15T09:13:00Z" } };

test("ticketVars: all placeholders, approved_ago from pr.approvedAt", () => {
  const v = ticketVars(p, t, Date.parse("2026-10-15T10:00:00Z"));
  assert.deepEqual(v, { key: "CSW-1", summary: "Add greeting", pr_url: "https://github.com/a/r/pull/7", pr_number: "7", project: "ChatSupport Web", branch: "handsfree/CSW-1", approved_ago: "47 min" });
});

test("ticketVars: missing PR gives empty strings", () => {
  const v = ticketVars(p, { ...t, prUrl: undefined, pr: undefined });
  assert.equal(v.pr_url, "");
  assert.equal(v.pr_number, "");
  assert.equal(v.approved_ago, "");
});

test("bulkList: one line per ticket", () => {
  assert.equal(bulkList([{ p, t }, { p, t: { ...t, key: "CSW-2", summary: "Two", prUrl: undefined } }]), "- CSW-1 — Add greeting: https://github.com/a/r/pull/7\n- CSW-2 — Two: (no PR yet)");
});
```

Change `build:test` in `package.json` to bundle the messaging modules too (one entry per module; esbuild keeps the directory layout under `--outdir` when `--outbase` is set):

```json
    "build:test": "esbuild engine/src/prstate.ts engine/src/store.ts engine/src/messaging/templates.ts engine/src/messaging/oauth.ts engine/src/messaging/mcpclient.ts engine/src/messaging/setmore.ts engine/src/messaging/agent.ts engine/src/messaging/service.ts --bundle --platform=node --format=esm --target=node20 --outbase=engine/src --outdir=engine/dist/test",
```

Until later tasks create the other modules, create each as an empty module so the build works: `engine/src/messaging/oauth.ts`, `mcpclient.ts`, `setmore.ts`, `agent.ts`, `service.ts` each containing `export {};`. (Note: `store.js` and `prstate.js` move to `engine/dist/test/store.js` and `prstate.js` unchanged because `--outbase=engine/src` keeps their root position.)

- [ ] **Step 2: Watch it fail**

Run: `npm run test:unit`
Expected: `templates.test.mjs` fails on import (`fillTemplate` not exported / module missing).

- [ ] **Step 3: Types**

In `engine/src/types.ts`, after the `FixContext` block add:

```ts
export type MessagingPlatform = "none" | "setmore" | "agent";

export interface MessageTemplates {
  reviewReady: string;
  mergeNudge: string;
  manual: string;
  bulk: string;
}

export interface MessagingConfig {
  platform: MessagingPlatform;
  /** Channel id on the platform (Setmore channelId). */
  channelId: string;
  /** Display name, cached from the channel picker. */
  channelName: string;
  templates: MessageTemplates;
  /** platform "agent" only: command template; {prompt} is filled (shell-quoted). */
  agentCommand: string;
}

export interface SetmoreAccountSettings {
  clientId: string;
  /** Loopback port for the OAuth redirect; must match the registered redirect URI. */
  redirectPort: number;
  mcpUrl: string;
  issuer: string;
  scopes: string;
}

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

export interface AccountStatus {
  loggedIn: boolean;
  /** Display name / email from the id token when present. */
  user?: string;
  scope?: string;
  expiresAt?: string;
  /** Last refresh/call auth error; cleared on login. */
  error?: string;
  /** True while a login is in progress (loopback server listening). */
  loginPending?: boolean;
}

export const DEFAULT_TEMPLATES: MessageTemplates = {
  reviewReady: "Hey team, please review the PR for {key} — {summary}: {pr_url}",
  mergeNudge: "Hi team, this PR is approved and has been waiting {approved_ago} to be merged: {pr_url}",
  manual: "{key} — {summary}: {pr_url}",
  bulk: "Hi team, these PRs need eyes:\n{list}",
};

export const DEFAULT_AGENT_MESSAGE_COMMAND =
  "claude -p {prompt} --output-format json --max-turns 4 --allowedTools mcp__claude_ai_Setmore__send_message,mcp__claude_ai_Setmore__list_channels";

export const DEFAULT_SETMORE_ACCOUNT: SetmoreAccountSettings = {
  clientId: "",
  redirectPort: 47831,
  mcpUrl: "https://mcp.setmore.com/mcp",
  issuer: "https://auth.setmore.com/o",
  scopes: "openid offline_access awapis.chat.streams.push awapis.streams.read awapis.users.read",
};
```

Add to `ProjectConfig` (after `mergeNudgeAfterMin`): `messaging: MessagingConfig;`. Add to `Settings` (after `launchAtLogin`): `accounts: { setmore: SetmoreAccountSettings };`. Add to `Ticket` (after `fix?`): `/** Collab messages sent for this ticket, oldest first. */ messages?: MessageRecord[];`. Add to `EngineState` (after `prCheckErrors`): `accounts: { setmore: AccountStatus };`. Add to `EngineEvent`: `| { type: "account"; name: "setmore"; status: AccountStatus }`.

- [ ] **Step 4: Store defaults and migration**

In `engine/src/store.ts`:

```ts
import { CLAUDE_RESUME, DEFAULT_AGENT_MESSAGE_COMMAND, DEFAULT_SETMORE_ACCOUNT, DEFAULT_TEMPLATES, type Config, type EngineState, type MessagingConfig, type ProjectConfig, type Settings } from "./types";
```

`DEFAULT_SETTINGS` gains `accounts: { setmore: { ...DEFAULT_SETMORE_ACCOUNT } },`. Add:

```ts
export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.accounts = { setmore: { ...DEFAULT_SETMORE_ACCOUNT, ...(raw?.accounts?.setmore || {}) } };
  s.accounts.setmore.redirectPort = clamp(s.accounts.setmore.redirectPort, 1024, 65535, DEFAULT_SETMORE_ACCOUNT.redirectPort);
  s.prPollIntervalMin = clamp(s.prPollIntervalMin, 1, 60, DEFAULT_SETTINGS.prPollIntervalMin);
  return s;
}

export function normalizeMessaging(m: Partial<MessagingConfig> | undefined): MessagingConfig {
  const platform = m?.platform === "setmore" || m?.platform === "agent" ? m.platform : "none";
  return {
    platform,
    channelId: m?.channelId || "",
    channelName: m?.channelName || "",
    templates: { ...DEFAULT_TEMPLATES, ...(m?.templates || {}) },
    agentCommand: m?.agentCommand ?? DEFAULT_AGENT_MESSAGE_COMMAND,
  };
}
```

In `normalizeProject` add `messaging: normalizeMessaging(p.messaging),` after `mergeNudgeAfterMin`. In `loadConfig` use `settings: normalizeSettings(raw?.settings)`. In `migrateState` return also `accounts: { setmore: raw?.accounts?.setmore || { loggedIn: false } },`. Orchestrator `updateConfig` builds settings as `{ ...this.config.settings, ...next.settings }` — change it to `normalizeSettings({ ...this.config.settings, ...next.settings })`.

- [ ] **Step 5: `engine/src/messaging/templates.ts`**

```ts
// Message templates: plain {placeholder} substitution, no shell quoting (unlike shell.fill).
import type { ProjectConfig, Ticket } from "../types";

export function fillTemplate(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** "47 min", "3 h 10 min", "1 d 2 h". */
export function humanDuration(fromIso: string, nowMs = Date.now()) {
  const min = Math.max(0, Math.round((nowMs - Date.parse(fromIso)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export function ticketVars(p: Pick<ProjectConfig, "name">, t: Pick<Ticket, "key" | "summary" | "branch" | "prUrl" | "pr">, nowMs = Date.now()) {
  return {
    key: t.key,
    summary: t.summary,
    pr_url: t.prUrl || "",
    pr_number: t.pr?.number !== undefined ? String(t.pr.number) : "",
    project: p.name,
    branch: t.branch,
    approved_ago: t.pr?.approvedAt ? humanDuration(t.pr.approvedAt, nowMs) : "",
  };
}

export function bulkList(items: { p: Pick<ProjectConfig, "name">; t: Pick<Ticket, "key" | "summary" | "prUrl"> }[]) {
  return items.map(({ t }) => `- ${t.key} — ${t.summary}: ${t.prUrl || "(no PR yet)"}`).join("\n");
}
```

- [ ] **Step 6: Keep everything compiling**

- `src/mock.ts`: settings gain `accounts: { setmore: { ...DEFAULT_SETMORE_ACCOUNT, clientId: "hf-demo" } }` (import the constant); both projects gain `messaging: { platform: "setmore", channelId: "nN0pGzAWVcudEnhemVADfwCZi6iUlMiW", channelName: "ChatSupport Team Core", templates: { ...DEFAULT_TEMPLATES }, agentCommand: DEFAULT_AGENT_MESSAGE_COMMAND }` (second project: `platform: "none"`, empty channel); `demoState` returns gain `accounts: { setmore: { loggedIn: true, user: "yogesh@anywhere.co" } }` (empty scenario: `{ setmore: { loggedIn: false } }`).
- `src/views/Projects.tsx` `blankProject()`: add `messaging: { platform: "none", channelId: "", channelName: "", templates: { ...DEFAULT_TEMPLATES }, agentCommand: DEFAULT_AGENT_MESSAGE_COMMAND },` (import both constants).
- `engine/test/e2e.mjs`: the config written to disk needs no change (defaults fill in), but the `project` object used in `PUT /api/config` calls is normalised by the engine too. No edit required; run the e2e to confirm.

- [ ] **Step 7: Run everything**

Run: `npm run test:unit` → templates tests pass (5), earlier suites still pass.
Run: `npm run typecheck` → exit 0.
Run: `npm run test:e2e` → `✅ e2e passed`.

- [ ] **Step 8: Commit**

```bash
git add engine/src/types.ts engine/src/store.ts engine/src/orchestrator.ts engine/src/messaging engine/test/templates.test.mjs package.json src/mock.ts src/views/Projects.tsx
git commit -m "Messaging types, per-project templates/channel config, Setmore account settings, template helpers"
```

---

### Task 2: OAuth helper, token store, fake auth server

**Files:**
- Create: `engine/src/messaging/oauth.ts`, `engine/test/fakes/auth-server.mjs`, `engine/test/oauth.test.mjs`

**Interfaces:**
- Produces: `pkce(): { verifier: string; challenge: string }`, `randomState(): string`, `discover(issuer, f?): Promise<AuthMeta>`, `buildAuthorizeUrl(meta, o): string`, `exchangeCode(meta, o, f?)`, `refreshTokens(meta, o, f?)`, `decodeIdClaims(idToken?)`, `tokensFromResponse(r, nowMs?)`, `class OAuthError { code; description? }`, `interface StoredTokens`, `class TokenStore { constructor(file); load(); save(t); clear() }`.
- Produces (fake): `startFakeAuth({ validTokens }): Promise<{ url, authorizeCalls, tokenCalls, rotate(), setInvalidGrant(b), close() }>`.

- [ ] **Step 1: Fake auth server (test infrastructure, written first because the tests need it)**

Create `engine/test/fakes/auth-server.mjs`:

```js
// A fake OAuth 2.1 server: OIDC discovery, authorize (redirects straight back with a code), token (PKCE checked).
import http from "node:http";
import crypto from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function startFakeAuth({ validTokens = new Set() } = {}) {
  const codes = new Map(); // code → { challenge, redirectUri, resource }
  const refreshTokens = new Set();
  let n = 0;
  let invalidGrant = false;
  const authorizeCalls = [];
  const tokenCalls = [];
  const issue = () => {
    n++;
    const access = `at-${n}`;
    const refresh = `rt-${n}`;
    validTokens.add(access);
    refreshTokens.add(refresh);
    const idToken = `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify({ name: "Tester", email: "t@t.t", sub: "u1" }))}.sig`;
    return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer", scope: "openid offline_access awapis.chat.streams.push", id_token: idToken };
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/o/.well-known/openid-configuration") {
      return json(200, { issuer: base + "/o", authorization_endpoint: `${base}/o/oauth2/auth`, token_endpoint: `${base}/o/oauth2/v2/token`, revocation_endpoint: `${base}/o/oauth2/revoke`, code_challenge_methods_supported: ["S256"] });
    }
    if (url.pathname === "/o/oauth2/auth") {
      const q = Object.fromEntries(url.searchParams);
      authorizeCalls.push(q);
      const code = `code-${++n}`;
      codes.set(code, { challenge: q.code_challenge, redirectUri: q.redirect_uri, resource: q.resource });
      res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state || "")}` });
      return res.end();
    }
    if (url.pathname === "/o/oauth2/v2/token" && req.method === "POST") {
      let body = "";
      for await (const c of req) body += c;
      const f = Object.fromEntries(new URLSearchParams(body));
      tokenCalls.push(f);
      if (f.grant_type === "authorization_code") {
        const c = codes.get(f.code);
        if (!c) return json(400, { error: "invalid_grant", error_description: "unknown code" });
        if (b64url(crypto.createHash("sha256").update(f.code_verifier || "").digest()) !== c.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE mismatch" });
        if (c.redirectUri !== f.redirect_uri) return json(400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
        codes.delete(f.code);
        return json(200, issue());
      }
      if (f.grant_type === "refresh_token") {
        if (invalidGrant || !refreshTokens.has(f.refresh_token)) return json(400, { error: "invalid_grant", error_description: "refresh token revoked" });
        refreshTokens.delete(f.refresh_token);
        return json(200, issue());
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/o/oauth2/revoke" && req.method === "POST") return json(200, {});
    json(404, { error: "not found" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    issuer: `${base}/o`,
    authorizeCalls,
    tokenCalls,
    /** Make every current access token invalid (MCP answers 401 until a refresh). */
    rotate: () => validTokens.clear(),
    setInvalidGrant: (b) => (invalidGrant = b),
    close: () => new Promise((r) => server.close(r)),
  };
}
```

- [ ] **Step 2: Failing OAuth tests**

Create `engine/test/oauth.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeAuth } from "./fakes/auth-server.mjs";
import { buildAuthorizeUrl, decodeIdClaims, discover, exchangeCode, OAuthError, pkce, refreshTokens, TokenStore, tokensFromResponse } from "../dist/test/messaging/oauth.js";

test("pkce: S256 challenge of the verifier, base64url, no padding", () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  // RFC 7636 appendix B vector
  const { createHash } = await_import_crypto();
  const expect = createHash("sha256").update("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(expect, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});
function await_import_crypto() {
  return { createHash: (await_import => await_import)(globalThis.process.getBuiltinModule("node:crypto").createHash) };
}

test("discover: openid-configuration first, oauth-authorization-server fallback, error when neither", async () => {
  const auth = await startFakeAuth();
  try {
    const m = await discover(auth.issuer);
    assert.equal(m.tokenEndpoint, `${auth.issuer}/oauth2/v2/token`);
    await assert.rejects(discover(`${auth.url}/nothing`), /discover/);
  } finally {
    await auth.close();
  }
});

test("buildAuthorizeUrl: PKCE S256, state, scope, resource", async () => {
  const u = new URL(buildAuthorizeUrl({ authorizationEndpoint: "https://a/auth", tokenEndpoint: "https://a/t" }, { clientId: "cid", redirectUri: "http://127.0.0.1:1/cb", scope: "openid x", state: "st", challenge: "ch", resource: "https://m/mcp" }));
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("code_challenge"), "ch");
  assert.equal(u.searchParams.get("state"), "st");
  assert.equal(u.searchParams.get("scope"), "openid x");
  assert.equal(u.searchParams.get("resource"), "https://m/mcp");
});

test("exchangeCode + refresh against the fake server; invalid_grant surfaces as OAuthError", async () => {
  const auth = await startFakeAuth();
  try {
    const meta = await discover(auth.issuer);
    const { verifier, challenge } = pkce();
    const redirectUri = "http://127.0.0.1:1/cb";
    const authorize = await fetch(buildAuthorizeUrl(meta, { clientId: "cid", redirectUri, scope: "openid", state: "s", challenge, resource: "https://m/mcp" }), { redirect: "manual" });
    const code = new URL(authorize.headers.get("location")).searchParams.get("code");
    const r = await exchangeCode(meta, { clientId: "cid", code, redirectUri, verifier, resource: "https://m/mcp" });
    assert.equal(r.access_token, "at-2");
    assert.equal(auth.tokenCalls[0].resource, "https://m/mcp");
    const t = tokensFromResponse(r, Date.parse("2026-10-15T10:00:00Z"));
    assert.equal(t.expiresAt, "2026-10-15T11:00:00.000Z");
    assert.deepEqual(t.idClaims, { name: "Tester", email: "t@t.t" });
    const r2 = await refreshTokens(meta, { clientId: "cid", refreshToken: r.refresh_token, resource: "https://m/mcp" });
    assert.equal(r2.access_token, "at-3");
    auth.setInvalidGrant(true);
    await assert.rejects(refreshTokens(meta, { clientId: "cid", refreshToken: r2.refresh_token, resource: "https://m/mcp" }), (e) => e instanceof OAuthError && e.code === "invalid_grant");
    await assert.rejects(exchangeCode(meta, { clientId: "cid", code: "bogus", redirectUri, verifier, resource: "https://m/mcp" }), (e) => e instanceof OAuthError && /unknown code/.test(e.message));
  } finally {
    await auth.close();
  }
});

test("decodeIdClaims: payload only, tolerant of garbage", () => {
  const payload = Buffer.from(JSON.stringify({ name: "N", email: "e@x", extra: 1 })).toString("base64url");
  assert.deepEqual(decodeIdClaims(`h.${payload}.s`), { name: "N", email: "e@x" });
  assert.equal(decodeIdClaims("nope"), undefined);
  assert.equal(decodeIdClaims(undefined), undefined);
});

test("TokenStore: save is 0600, load round-trips, clear removes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-tok-"));
  const store = new TokenStore(path.join(dir, "auth", "setmore.json"));
  assert.equal(store.load(), undefined);
  store.save({ accessToken: "a", refreshToken: "r", expiresAt: "2026-10-15T11:00:00.000Z" });
  assert.equal((fs.statSync(path.join(dir, "auth", "setmore.json")).mode & 0o777).toString(8), "600");
  assert.equal(store.load().refreshToken, "r");
  store.clear();
  assert.equal(store.load(), undefined);
});
```

Simplify the first test's crypto import: replace the `await_import_crypto` contraption with a top-level `import crypto from "node:crypto";` and `crypto.createHash(...)`. (Write it that way in the file; the snippet above over-complicates it.)

- [ ] **Step 3: Watch it fail**

Run: `npm run test:unit`
Expected: `oauth.test.mjs` fails on import (`pkce` not exported).

- [ ] **Step 4: Implement `engine/src/messaging/oauth.ts`**

```ts
// OAuth 2.1 public client (PKCE) helpers and the on-disk token store. No library; Node fetch + crypto.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function pkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export const randomState = () => b64url(crypto.randomBytes(24));

export interface AuthMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

export class OAuthError extends Error {
  constructor(
    public code: string,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
  }
}

type Fetch = typeof fetch;

export async function discover(issuer: string, f: Fetch = fetch): Promise<AuthMeta> {
  const base = issuer.replace(/\/$/, "");
  for (const p of ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
    try {
      const r = await f(base + p, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) continue;
      const j = (await r.json()) as Record<string, string>;
      if (j.authorization_endpoint && j.token_endpoint) {
        return { authorizationEndpoint: j.authorization_endpoint, tokenEndpoint: j.token_endpoint, revocationEndpoint: j.revocation_endpoint };
      }
    } catch {
      /* try the next */
    }
  }
  throw new Error(`Couldn't discover the OAuth endpoints for ${issuer} (no openid-configuration or oauth-authorization-server metadata).`);
}

export function buildAuthorizeUrl(meta: AuthMeta, o: { clientId: string; redirectUri: string; scope: string; state: string; challenge: string; resource?: string }) {
  const u = new URL(meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("scope", o.scope);
  u.searchParams.set("state", o.state);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (o.resource) u.searchParams.set("resource", o.resource);
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

/** Servers that reject RFC 8707 `resource` are remembered per token endpoint for this process. */
const resourceRejected = new Set<string>();

async function tokenRequest(meta: AuthMeta, params: Record<string, string | undefined>, f: Fetch): Promise<TokenResponse> {
  const attempt = async (withResource: boolean) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && (withResource || k !== "resource")) body.set(k, v);
    const r = await f(meta.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let j: Record<string, string> = {};
    try {
      j = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new OAuthError(j.error || `http_${r.status}`, j.error_description || text.slice(0, 300));
    return j as unknown as TokenResponse;
  };
  const hasResource = params.resource !== undefined && !resourceRejected.has(meta.tokenEndpoint);
  try {
    return await attempt(hasResource);
  } catch (e) {
    if (hasResource && e instanceof OAuthError && (e.code === "invalid_target" || e.code === "invalid_request")) {
      resourceRejected.add(meta.tokenEndpoint);
      return attempt(false);
    }
    throw e;
  }
}

export function exchangeCode(meta: AuthMeta, o: { clientId: string; code: string; redirectUri: string; verifier: string; resource?: string }, f: Fetch = fetch) {
  return tokenRequest(meta, { grant_type: "authorization_code", client_id: o.clientId, code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier, resource: o.resource }, f);
}

export function refreshTokens(meta: AuthMeta, o: { clientId: string; refreshToken: string; resource?: string }, f: Fetch = fetch) {
  return tokenRequest(meta, { grant_type: "refresh_token", client_id: o.clientId, refresh_token: o.refreshToken, resource: o.resource }, f);
}

export async function revokeToken(meta: AuthMeta, o: { clientId: string; token: string }, f: Fetch = fetch) {
  if (!meta.revocationEndpoint) return;
  const body = new URLSearchParams({ token: o.token, client_id: o.clientId, token_type_hint: "refresh_token" });
  await f(meta.revocationEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
}

export function decodeIdClaims(idToken?: string): { name?: string; email?: string } | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const out: { name?: string; email?: string } = {};
    if (typeof payload.name === "string") out.name = payload.name;
    if (typeof payload.email === "string") out.email = payload.email;
    return out;
  } catch {
    return undefined;
  }
}

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope?: string;
  idClaims?: { name?: string; email?: string };
}

export function tokensFromResponse(r: TokenResponse, nowMs = Date.now(), prev?: StoredTokens): StoredTokens {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token || prev?.refreshToken,
    expiresAt: new Date(nowMs + (r.expires_in ?? 3600) * 1000).toISOString(),
    scope: r.scope || prev?.scope,
    idClaims: decodeIdClaims(r.id_token) || prev?.idClaims,
  };
}

/** Tokens on disk, mode 0600, written atomically. */
export class TokenStore {
  constructor(private file: string) {}
  load(): StoredTokens | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as StoredTokens;
    } catch {
      return undefined;
    }
  }
  save(t: StoredTokens) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test:unit` → oauth tests pass (6). `npm run typecheck` → exit 0.

- [ ] **Step 6: Commit**

```bash
git add engine/src/messaging/oauth.ts engine/test/fakes/auth-server.mjs engine/test/oauth.test.mjs
git commit -m "OAuth 2.1 PKCE helpers, token store, fake auth server"
```

---

### Task 3: Streamable-HTTP MCP client and fake MCP server

**Files:**
- Create: `engine/src/messaging/mcpclient.ts`, `engine/test/fakes/mcp-server.mjs`, `engine/test/mcpclient.test.mjs`

**Interfaces:**
- Produces: `class McpClient(url, getToken, opts?)` with `initialize()`, `callTool(name, args): Promise<ToolResult>`; `class McpError`, `class AuthError`; `toolText(r)`, `toolJson(r)`.
- Produces (fake): `startFakeMcp({ validTokens, sse? }): Promise<{ url, received, calls, sessions, failNextWithSessionNotFound(), close() }>`.

- [ ] **Step 1: Fake MCP server**

Create `engine/test/fakes/mcp-server.mjs`:

```js
// A fake Setmore-like MCP server over streamable HTTP: bearer auth, sessions, list_channels, two-call send_message.
import http from "node:http";

export async function startFakeMcp({ validTokens = new Set(), sse = false } = {}) {
  const received = [];
  const calls = [];
  const sessions = new Set();
  let n = 0;
  let sessionNotFoundOnce = false;
  const channels = [
    { channelId: "ch-core", name: "ChatSupport Team Core", isMember: true, memberCount: 10 },
    { channelId: "ch-cba", name: "CBA: Core Team", isMember: true, memberCount: 11 },
  ];
  const server = http.createServer(async (req, res) => {
    const reply = (code, msg, headers = {}) => {
      if (sse && msg) {
        res.writeHead(code, { "content-type": "text/event-stream", ...headers });
        res.end(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      } else {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(msg ? JSON.stringify(msg) : "");
      }
    };
    if (req.method !== "POST" || new URL(req.url, "http://x").pathname !== "/mcp") return reply(404, { error: "not found" });
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!validTokens.has(token)) {
      res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://x/.well-known/oauth-protected-resource/mcp"', "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "Authentication is required to access this resource." }));
    }
    let body = "";
    for await (const c of req) body += c;
    const rpc = JSON.parse(body);
    calls.push({ method: rpc.method, params: rpc.params, session: req.headers["mcp-session-id"] });
    const ok = (result, headers) => reply(200, { jsonrpc: "2.0", id: rpc.id, result }, headers);
    const err = (code, message) => reply(200, { jsonrpc: "2.0", id: rpc.id, error: { code, message } });
    if (rpc.method === "initialize") {
      const sid = `sess-${++n}`;
      sessions.add(sid);
      return ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-setmore", version: "0" } }, { "mcp-session-id": sid });
    }
    const sid = req.headers["mcp-session-id"];
    if (!sid || !sessions.has(sid) || sessionNotFoundOnce) {
      sessionNotFoundOnce = false;
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "session not found" }));
    }
    if (rpc.method === "notifications/initialized") {
      res.writeHead(202);
      return res.end();
    }
    if (rpc.method !== "tools/call") return err(-32601, "method not found");
    const { name, arguments: a = {} } = rpc.params;
    const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
    if (name === "list_channels") {
      const q = (a.query || "").toLowerCase();
      return ok(text({ channels: channels.filter((c) => !q || c.name.toLowerCase().includes(q)) }));
    }
    if (name === "send_message") {
      if (!a.conversationId || !a.text) return ok({ isError: true, content: [{ type: "text", text: "conversationId and text are required" }] });
      if (!a.confirmationToken) {
        const confirmationToken = `tok-${++n}`;
        return ok({ content: [{ type: "text", text: `Preview: send to ${a.conversationId}: ${a.text}` }], structuredContent: { preview: { recipient: a.conversationId, text: a.text }, confirmationToken } });
      }
      if (!/^tok-\d+$/.test(a.confirmationToken)) return ok({ isError: true, content: [{ type: "text", text: "invalid confirmationToken" }] });
      const messageId = `m-${++n}`;
      received.push({ channelId: a.conversationId, text: a.text, idempotencyKey: a.idempotencyKey, messageId });
      return ok(text({ sent: true, messageId }));
    }
    return ok({ isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    received,
    calls,
    sessions,
    failNextWithSessionNotFound: () => (sessionNotFoundOnce = true),
    close: () => new Promise((r) => server.close(r)),
  };
}
```

- [ ] **Step 2: Failing client tests**

Create `engine/test/mcpclient.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeMcp } from "./fakes/mcp-server.mjs";
import { AuthError, McpClient, McpError, toolJson, toolText } from "../dist/test/messaging/mcpclient.js";

for (const sse of [false, true]) {
  test(`McpClient over ${sse ? "SSE" : "JSON"}: initialize once, session id propagated, tool results parsed`, async () => {
    const validTokens = new Set(["at-1"]);
    const mcp = await startFakeMcp({ validTokens, sse });
    try {
      const c = new McpClient(mcp.url, async () => "at-1");
      const r = await c.callTool("list_channels", { query: "core" });
      assert.deepEqual(toolJson(r).channels.map((x) => x.channelId), ["ch-core", "ch-cba"]);
      await c.callTool("list_channels", {});
      assert.deepEqual(mcp.calls.map((x) => x.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
      assert.equal(mcp.calls[2].session, "sess-1");
      assert.match(toolText(r), /"channels"/);
    } finally {
      await mcp.close();
    }
  });
}

test("McpClient: tool isError becomes McpError with the text", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]) });
  try {
    const c = new McpClient(mcp.url, async () => "t");
    await assert.rejects(c.callTool("send_message", { text: "x" }), (e) => e instanceof McpError && /conversationId/.test(e.message));
  } finally {
    await mcp.close();
  }
});

test("McpClient: 401 → onUnauthorized → retry once; second 401 → AuthError", async () => {
  const validTokens = new Set(["good"]);
  const mcp = await startFakeMcp({ validTokens });
  try {
    let token = "stale";
    let refreshes = 0;
    const c = new McpClient(mcp.url, async () => token, { onUnauthorized: async () => { refreshes++; token = "good"; } });
    const r = await c.callTool("list_channels", {});
    assert.equal(refreshes, 1);
    assert.ok(toolJson(r).channels.length);
    validTokens.clear();
    const c2 = new McpClient(mcp.url, async () => "nope", { onUnauthorized: async () => {} });
    await assert.rejects(c2.callTool("list_channels", {}), (e) => e instanceof AuthError);
  } finally {
    await mcp.close();
  }
});

test("McpClient: 404 on a known session re-initialises once and retries", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]) });
  try {
    const c = new McpClient(mcp.url, async () => "t");
    await c.callTool("list_channels", {});
    mcp.failNextWithSessionNotFound();
    await c.callTool("list_channels", {});
    assert.equal(mcp.calls.filter((x) => x.method === "initialize").length, 2);
    assert.equal(mcp.calls[mcp.calls.length - 1].session, "sess-2");
  } finally {
    await mcp.close();
  }
});

test("toolJson: structuredContent wins, else first JSON text block, else undefined", () => {
  assert.deepEqual(toolJson({ structuredContent: { a: 1 }, content: [{ type: "text", text: '{"b":2}' }] }), { a: 1 });
  assert.deepEqual(toolJson({ content: [{ type: "text", text: "hello" }, { type: "text", text: '{"b":2}' }] }), { b: 2 });
  assert.equal(toolJson({ content: [{ type: "text", text: "hello" }] }), undefined);
});
```

- [ ] **Step 3: Watch it fail**

Run: `npm run test:unit` → `mcpclient.test.mjs` fails on import.

- [ ] **Step 4: Implement `engine/src/messaging/mcpclient.ts`**

```ts
// Minimal MCP client over streamable HTTP (JSON or SSE responses), enough for tools/call. No SDK.

export class McpError extends Error {
  constructor(
    message: string,
    public code?: number,
  ) {
    super(message);
  }
}
export class AuthError extends Error {}

export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClientOpts {
  /** Called once on a 401 (refresh the token); the request is retried with a fresh token afterwards. */
  onUnauthorized?: () => Promise<void>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  clientVersion?: string;
}

const PROTOCOL = "2025-06-18";

export class McpClient {
  private sessionId?: string;
  private nextId = 1;
  private initialized?: Promise<void>;
  constructor(
    private url: string,
    private getToken: () => Promise<string>,
    private opts: McpClientOpts = {},
  ) {}

  async initialize() {
    if (!this.initialized) {
      this.initialized = (async () => {
        await this.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "HandsFree", version: this.opts.clientVersion || "0.1" } }, { retrySession: false });
        await this.rpc("notifications/initialized", {}, { notify: true, retrySession: false });
      })().catch((e) => {
        this.initialized = undefined;
        throw e;
      });
    }
    return this.initialized;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.initialize();
    const result = (await this.rpc("tools/call", { name, arguments: args })) as ToolResult;
    if (result?.isError) throw new McpError(toolText(result) || `${name} failed`);
    return result;
  }

  private async rpc(method: string, params: unknown, o: { notify?: boolean; retryAuth?: boolean; retrySession?: boolean } = {}): Promise<unknown> {
    const { notify = false, retryAuth = true, retrySession = true } = o;
    const id = notify ? undefined : this.nextId++;
    const f = this.opts.fetchImpl || fetch;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.getToken()}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const r = await f(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }), signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000) });
    const sid = r.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (r.status === 401) {
      if (retryAuth && this.opts.onUnauthorized) {
        await this.opts.onUnauthorized();
        return this.rpc(method, params, { ...o, retryAuth: false });
      }
      throw new AuthError("Not authorized by the messaging server — log in again.");
    }
    if (r.status === 404 && this.sessionId && retrySession && method !== "initialize") {
      this.sessionId = undefined;
      this.initialized = undefined;
      await this.initialize();
      return this.rpc(method, params, { ...o, retrySession: false });
    }
    if (r.status === 202 || r.status === 204) return undefined;
    const text = await r.text();
    if (!r.ok) throw new McpError(`HTTP ${r.status} from the messaging server: ${text.slice(0, 300)}`);
    if (notify) return undefined;
    const msg = parseResponse(text, r.headers.get("content-type") || "", id!);
    if (!msg) throw new McpError(`No JSON-RPC response for ${method}`);
    if (msg.error) throw new McpError(msg.error.message || "JSON-RPC error", msg.error.code);
    return msg.result;
  }
}

interface RpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function parseResponse(text: string, contentType: string, id: number): RpcMessage | undefined {
  if (contentType.includes("text/event-stream")) {
    const messages: RpcMessage[] = [];
    for (const event of text.split(/\n\n+/)) {
      const data = event.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* not JSON */
      }
    }
    return messages.find((m) => m.id === id) || messages[messages.length - 1];
  }
  try {
    const j = JSON.parse(text);
    return Array.isArray(j) ? j.find((m: RpcMessage) => m.id === id) : j;
  } catch {
    return undefined;
  }
}

export function toolText(r: ToolResult | undefined) {
  return (r?.content || []).filter((c) => c.type === "text" && c.text).map((c) => c.text as string).join("\n");
}

export function toolJson(r: ToolResult | undefined): any {
  if (!r) return undefined;
  if (r.structuredContent !== undefined) return r.structuredContent;
  for (const c of r.content || []) {
    if (c.type !== "text" || !c.text) continue;
    try {
      return JSON.parse(c.text);
    } catch {
      /* next block */
    }
  }
  return undefined;
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npm run test:unit` → mcpclient tests pass (6). `npm run typecheck` → exit 0.

```bash
git add engine/src/messaging/mcpclient.ts engine/test/fakes/mcp-server.mjs engine/test/mcpclient.test.mjs
git commit -m "Minimal streamable-HTTP MCP client with session, 401 and SSE handling; fake MCP server"
```

---

### Task 4: Messaging adapters (Setmore direct, agent fallback)

**Files:**
- Create: `engine/src/messaging/adapter.ts`, `engine/src/messaging/setmore.ts`, `engine/src/messaging/agent.ts`, `engine/src/messaging/index.ts`, `engine/test/setmore.test.mjs`, `engine/test/agentmsg.test.mjs`

**Interfaces:**
- Consumes: `McpClient`, `toolJson`, `toolText`, `AuthError`, `McpError` (Task 3); `TokenStore`, `discover`, `refreshTokens`, `tokensFromResponse`, `OAuthError`, `StoredTokens` (Task 2); `fill`, `sh` from `../shell`.
- Produces: `interface MessagingAdapter { platform; listChannels(query?): Promise<{ id; name }[]>; send(channelId, text, idempotencyKey): Promise<{ id?: string }> }`; `class SetmoreAdapter(settings, tokens, onStatus, fetchImpl?)` with `status(): AccountStatus`, `refresh()`; `class AgentAdapter(cmdTemplate, cwd?, run?)`; `findKey(obj, keys)`, `lastJson(s)`; `adapterFor(project, settings, deps)`.

- [ ] **Step 1: Failing adapter tests**

Create `engine/test/setmore.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeMcp } from "./fakes/mcp-server.mjs";
import { startFakeAuth } from "./fakes/auth-server.mjs";
import { TokenStore } from "../dist/test/messaging/oauth.js";
import { findKey, SetmoreAdapter } from "../dist/test/messaging/setmore.js";

const settings = (auth, mcp) => ({ clientId: "cid", redirectPort: 1, mcpUrl: mcp.url, issuer: auth.issuer, scopes: "openid" });
const store = () => new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hf-sm-")), "setmore.json"));
const future = new Date(Date.now() + 3600_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

test("findKey: recursive, first match", () => {
  assert.equal(findKey({ a: { b: [{ confirmationToken: "x" }] } }, ["confirmationToken"]), "x");
  assert.equal(findKey({ messageId: 5 }, ["messageId", "id"]), "5");
  assert.equal(findKey("nope", ["id"]), undefined);
});

test("SetmoreAdapter: listChannels and the two-call send_message with idempotencyKey", async () => {
  const validTokens = new Set(["at-x"]);
  const [auth, mcp] = [await startFakeAuth({ validTokens }), await startFakeMcp({ validTokens })];
  try {
    const tokens = store();
    tokens.save({ accessToken: "at-x", refreshToken: "rt-x", expiresAt: future });
    const statuses = [];
    const a = new SetmoreAdapter(settings(auth, mcp), tokens, (s) => statuses.push(s));
    assert.deepEqual(await a.listChannels("core"), [{ id: "ch-core", name: "ChatSupport Team Core" }, { id: "ch-cba", name: "CBA: Core Team" }]);
    const r = await a.send("ch-core", "hello team", "k1");
    assert.equal(r.id, "m-3");
    assert.deepEqual(mcp.received, [{ channelId: "ch-core", text: "hello team", idempotencyKey: "k1", messageId: "m-3" }]);
    const sends = mcp.calls.filter((c) => c.method === "tools/call" && c.params.name === "send_message");
    assert.equal(sends.length, 2);
    assert.equal(sends[0].params.arguments.confirmationToken, undefined);
    assert.equal(sends[1].params.arguments.confirmationToken, "tok-2");
  } finally {
    await auth.close();
    await mcp.close();
  }
});

test("SetmoreAdapter: not logged in → AuthError before any network call", async () => {
  const validTokens = new Set();
  const [auth, mcp] = [await startFakeAuth({ validTokens }), await startFakeMcp({ validTokens })];
  try {
    const a = new SetmoreAdapter(settings(auth, mcp), store(), () => {});
    await assert.rejects(a.send("ch-core", "x", "k"), /Not logged in/);
    assert.equal(mcp.calls.length, 0);
    assert.equal(a.status().loggedIn, false);
  } finally {
    await auth.close();
    await mcp.close();
  }
});

test("SetmoreAdapter: expired access token refreshes before the call; concurrent sends share one refresh", async () => {
  const validTokens = new Set();
  const [auth, mcp] = [await startFakeAuth({ validTokens }), await startFakeMcp({ validTokens })];
  try {
    const tokens = store();
    // Get a real refresh token from the fake server first.
    const meta = { tokenEndpoint: `${auth.issuer}/oauth2/v2/token` };
    const first = await (await fetch(meta.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=rt-0&client_id=cid" })).json().catch(() => null);
    // rt-0 is unknown → fall back to authorize+exchange through the adapter's own helpers is overkill; seed via the server's refresh path:
    // seed: run an authorize/exchange using fetch directly
    const { pkce, buildAuthorizeUrl, discover, exchangeCode, tokensFromResponse } = await import("../dist/test/messaging/oauth.js");
    const m = await discover(auth.issuer);
    const { verifier, challenge } = pkce();
    const loc = (await fetch(buildAuthorizeUrl(m, { clientId: "cid", redirectUri: "http://127.0.0.1:1/cb", scope: "openid", state: "s", challenge }), { redirect: "manual" })).headers.get("location");
    const code = new URL(loc).searchParams.get("code");
    const seeded = tokensFromResponse(await exchangeCode(m, { clientId: "cid", code, redirectUri: "http://127.0.0.1:1/cb", verifier }));
    tokens.save({ ...seeded, expiresAt: past }); // expired access token
    const statuses = [];
    const a = new SetmoreAdapter(settings(auth, mcp), tokens, (s) => statuses.push(s));
    const [r1, r2] = await Promise.all([a.send("ch-core", "one", "k1"), a.send("ch-core", "two", "k2")]);
    assert.ok(r1.id && r2.id);
    assert.equal(auth.tokenCalls.filter((c) => c.grant_type === "refresh_token").length, 1, "one refresh for two concurrent sends");
    assert.equal(mcp.received.length, 2);
    assert.equal(statuses[statuses.length - 1].loggedIn, true);
    assert.ok(first === null || first.error, "sanity: rt-0 was never valid");
  } finally {
    await auth.close();
    await mcp.close();
  }
});

test("SetmoreAdapter: 401 mid-session refreshes and retries; invalid_grant clears tokens and reports", async () => {
  const validTokens = new Set();
  const [auth, mcp] = [await startFakeAuth({ validTokens }), await startFakeMcp({ validTokens })];
  try {
    const { pkce, buildAuthorizeUrl, discover, exchangeCode, tokensFromResponse } = await import("../dist/test/messaging/oauth.js");
    const m = await discover(auth.issuer);
    const { verifier, challenge } = pkce();
    const loc = (await fetch(buildAuthorizeUrl(m, { clientId: "cid", redirectUri: "http://127.0.0.1:1/cb", scope: "openid", state: "s", challenge }), { redirect: "manual" })).headers.get("location");
    const code = new URL(loc).searchParams.get("code");
    const tokens = store();
    tokens.save(tokensFromResponse(await exchangeCode(m, { clientId: "cid", code, redirectUri: "http://127.0.0.1:1/cb", verifier })));
    const statuses = [];
    const a = new SetmoreAdapter(settings(auth, mcp), tokens, (s) => statuses.push(s));
    await a.send("ch-core", "before", "k1");
    auth.rotate(); // access token now rejected by MCP
    await a.send("ch-core", "after", "k2");
    assert.equal(mcp.received.length, 2);
    auth.rotate();
    auth.setInvalidGrant(true);
    await assert.rejects(a.send("ch-core", "never", "k3"), /log in again/);
    assert.equal(tokens.load(), undefined, "tokens cleared on invalid_grant");
    assert.equal(statuses[statuses.length - 1].loggedIn, false);
    assert.match(statuses[statuses.length - 1].error, /log in again/);
  } finally {
    await auth.close();
    await mcp.close();
  }
});

test("SetmoreAdapter: confirmationToken found in nested JSON text or prose; none → error, no second call", async () => {
  // A hand-rolled MCP server for odd preview shapes.
  const http = await import("node:http");
  const shapes = [
    { content: [{ type: "text", text: JSON.stringify({ data: { preview: {}, confirmationToken: "tok-9" } }) }] },
    { content: [{ type: "text", text: "Preview ready. confirmationToken: tok-9 — call again to send." }] },
    { content: [{ type: "text", text: "Preview ready, nothing else." }] },
  ];
  let shape = 0;
  const sends = [];
  const srv = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const rpc = JSON.parse(body);
    const ok = (result) => { res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })); };
    if (rpc.method === "initialize") return ok({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "0" } });
    if (rpc.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    const a = rpc.params.arguments;
    sends.push(a);
    if (a.confirmationToken) return ok({ content: [{ type: "text", text: JSON.stringify({ sent: true, id: "m-1" }) }] });
    return ok(shapes[shape]);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const tokens = store();
    tokens.save({ accessToken: "t", expiresAt: future });
    const a = new SetmoreAdapter({ clientId: "cid", redirectPort: 1, mcpUrl: `http://127.0.0.1:${srv.address().port}/mcp`, issuer: "http://127.0.0.1:1/o", scopes: "" }, tokens, () => {});
    shape = 0;
    assert.equal((await a.send("c", "x", "k")).id, "m-1");
    shape = 1;
    assert.equal((await a.send("c", "x", "k")).id, "m-1");
    shape = 2;
    const before = sends.length;
    await assert.rejects(a.send("c", "x", "k"), /no confirmationToken/);
    assert.equal(sends.length, before + 1, "no second call without a token");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
```

Create `engine/test/agentmsg.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentAdapter, lastJson } from "../dist/test/messaging/agent.js";

test("lastJson: whole string, fenced block, trailing object, none", () => {
  assert.deepEqual(lastJson('{"a":1}'), { a: 1 });
  assert.deepEqual(lastJson('Sure!\n```json\n{"sent":true,"id":"m"}\n```'), { sent: true, id: "m" });
  assert.deepEqual(lastJson('thinking... {"x":1} and then {"sent":false,"error":"no"}'), { sent: false, error: "no" });
  assert.equal(lastJson("nothing here"), undefined);
});

const fakeRun = (stdout, code = 0) => async () => ({ code, stdout, stderr: "", timedOut: false });

test("AgentAdapter.send: parses Claude's JSON envelope and the inner JSON", async () => {
  let cmd = "";
  const a = new AgentAdapter("claude -p {prompt}", undefined, async (c) => { cmd = c; return { code: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: 'Done.\n{"sent": true, "id": "m-7"}' }), stderr: "", timedOut: false }; });
  const r = await a.send("ch-core", "hello {team}", "k");
  assert.equal(r.id, "m-7");
  assert.match(cmd, /^claude -p '/);
  assert.match(cmd, /hello \{team\}/);
  assert.match(cmd, /ch-core/);
  assert.match(cmd, /confirmationToken/);
});

test("AgentAdapter.send: sent:false, is_error, non-zero exit and no JSON are failures with the reason", async () => {
  await assert.rejects(new AgentAdapter("x {prompt}", undefined, fakeRun('{"sent":false,"error":"channel not found"}')).send("c", "t", "k"), /channel not found/);
  await assert.rejects(new AgentAdapter("x {prompt}", undefined, fakeRun(JSON.stringify({ is_error: true, result: "rate limited" }))).send("c", "t", "k"), /rate limited/);
  await assert.rejects(new AgentAdapter("x {prompt}", undefined, fakeRun("boom", 1)).send("c", "t", "k"), /exit 1/);
  await assert.rejects(new AgentAdapter("x {prompt}", undefined, fakeRun("I sent it, trust me")).send("c", "t", "k"), /did not confirm/);
});

test("AgentAdapter.listChannels: JSON array of {id,name}", async () => {
  const a = new AgentAdapter("x {prompt}", undefined, fakeRun('[{"id":"c1","name":"Core"}]'));
  assert.deepEqual(await a.listChannels("core"), [{ id: "c1", name: "Core" }]);
});
```

- [ ] **Step 2: Watch them fail**

Run: `npm run test:unit` → both new files fail on import.

- [ ] **Step 3: `engine/src/messaging/adapter.ts`**

```ts
import type { MessagingPlatform } from "../types";

export interface MessagingAdapter {
  readonly platform: MessagingPlatform;
  listChannels(query?: string): Promise<{ id: string; name: string }[]>;
  /** Send `text` to the channel as the signed-in user. Resolves with the platform's message id when it reports one. */
  send(channelId: string, text: string, idempotencyKey: string): Promise<{ id?: string }>;
}
```

- [ ] **Step 4: `engine/src/messaging/setmore.ts`**

```ts
// Direct Setmore adapter: the user's own OAuth login + the Setmore MCP server. No agent in the loop.
import type { AccountStatus, SetmoreAccountSettings } from "../types";
import type { MessagingAdapter } from "./adapter";
import { AuthError, McpClient, McpError, toolJson, toolText } from "./mcpclient";
import { discover, OAuthError, refreshTokens, tokensFromResponse, type AuthMeta, type TokenStore } from "./oauth";

/** Depth-first search for the first of `keys` in a JSON value. */
export function findKey(v: unknown, keys: string[]): string | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  for (const k of keys) if (k in o && (typeof o[k] === "string" || typeof o[k] === "number")) return String(o[k]);
  for (const val of Object.values(o)) {
    const hit = findKey(val, keys);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export class SetmoreAdapter implements MessagingAdapter {
  readonly platform = "setmore" as const;
  private client: McpClient;
  private refreshing?: Promise<void>;
  private metaPromise?: Promise<AuthMeta>;

  constructor(
    private settings: SetmoreAccountSettings,
    private tokens: TokenStore,
    private onStatus: (s: AccountStatus) => void,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new McpClient(settings.mcpUrl, () => this.getToken(), { onUnauthorized: () => this.refresh(), fetchImpl });
  }

  status(error?: string): AccountStatus {
    const t = this.tokens.load();
    if (!t) return { loggedIn: false, error };
    return { loggedIn: true, user: t.idClaims?.email || t.idClaims?.name, scope: t.scope, expiresAt: t.expiresAt, error };
  }

  private meta() {
    this.metaPromise ||= discover(this.settings.issuer, this.fetchImpl).catch((e) => {
      this.metaPromise = undefined;
      throw e;
    });
    return this.metaPromise;
  }

  private async getToken() {
    const t = this.tokens.load();
    if (!t) throw new AuthError("Not logged in to Setmore. Settings → Accounts → Log in.");
    if (Date.parse(t.expiresAt) - 60_000 < Date.now()) await this.refresh();
    const fresh = this.tokens.load();
    if (!fresh) throw new AuthError("Setmore session expired — log in again.");
    return fresh.accessToken;
  }

  /** One refresh at a time; concurrent callers share it. */
  refresh(): Promise<void> {
    this.refreshing ||= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh() {
    const t = this.tokens.load();
    if (!t?.refreshToken) {
      this.tokens.clear();
      this.onStatus(this.status("Setmore session expired — log in again."));
      throw new AuthError("Setmore session expired — log in again.");
    }
    try {
      const r = await refreshTokens(await this.meta(), { clientId: this.settings.clientId, refreshToken: t.refreshToken, resource: this.settings.mcpUrl }, this.fetchImpl);
      this.tokens.save(tokensFromResponse(r, Date.now(), t));
      this.onStatus(this.status());
    } catch (e) {
      if (e instanceof OAuthError && e.code === "invalid_grant") {
        this.tokens.clear();
        this.onStatus(this.status("Setmore session expired — log in again."));
        throw new AuthError("Setmore session expired — log in again.");
      }
      this.onStatus(this.status(`Token refresh failed: ${(e as Error).message}`));
      throw e;
    }
  }

  async listChannels(query?: string) {
    const r = await this.client.callTool("list_channels", { ...(query ? { query } : {}), limit: 100 });
    const j = toolJson(r);
    const list: any[] = Array.isArray(j) ? j : Array.isArray(j?.channels) ? j.channels : [];
    return list.map((c) => ({ id: String(c.channelId ?? c.id ?? ""), name: String(c.name ?? c.channelId ?? "") })).filter((c) => c.id);
  }

  async send(channelId: string, text: string, idempotencyKey: string) {
    const args = { conversationType: "channel", conversationId: channelId, text, idempotencyKey };
    const first = await this.client.callTool("send_message", args);
    const j1 = toolJson(first);
    if (j1 && (j1.sent === true || j1.status === "sent")) return { id: findKey(j1, ["messageId", "id"]) };
    const token = findKey(j1, ["confirmationToken"]) ?? /confirmationToken["']?\s*[:=]\s*["']?([\w-]+)/.exec(toolText(first))?.[1];
    if (!token) throw new McpError(`send_message returned no confirmationToken: ${toolText(first).slice(0, 200) || "(empty response)"}`);
    const second = await this.client.callTool("send_message", { ...args, confirmationToken: token });
    const j2 = toolJson(second);
    return { id: findKey(j2, ["messageId", "id"]) };
  }
}
```

- [ ] **Step 5: `engine/src/messaging/agent.ts`**

```ts
// Agent-driven adapter: a configured agent command (default: claude -p with the user's Setmore connector) does the send.
import { fill, sh, type RunOpts, type RunResult } from "../shell";
import type { MessagingAdapter } from "./adapter";

type Runner = (cmd: string, opts?: RunOpts) => Promise<RunResult>;

/** The last JSON object/array in a string: whole string, a ```json fence, or the last `{`/`[` that parses. */
export function lastJson(s: string): any {
  const t = s.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* keep looking */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let last: any;
  while ((m = fence.exec(t))) {
    try {
      last = JSON.parse(m[1]);
    } catch {
      /* not JSON */
    }
  }
  if (last !== undefined) return last;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] !== "{" && t[i] !== "[") continue;
    for (let j = t.length; j > i; j--) {
      const ch = t[j - 1];
      if (ch !== "}" && ch !== "]") continue;
      try {
        return JSON.parse(t.slice(i, j));
      } catch {
        /* shrink */
      }
    }
  }
  return undefined;
}

export class AgentAdapter implements MessagingAdapter {
  readonly platform = "agent" as const;
  constructor(
    private cmdTemplate: string,
    private cwd?: string,
    private run: Runner = sh,
  ) {}

  private async ask(prompt: string): Promise<{ value: any; raw: string }> {
    const r = await this.run(fill(this.cmdTemplate, { prompt }), { cwd: this.cwd, timeoutMs: 180_000, env: { HANDSFREE: "1" } });
    if (r.timedOut) throw new Error("The messaging agent timed out after 3 min.");
    const raw = (r.stdout || "").trim();
    if (r.code !== 0) throw new Error(`The messaging agent exited with exit ${r.code}: ${(r.stderr || raw).trim().slice(-300)}`);
    const outer = lastJson(raw);
    // Claude's --output-format json envelope: { type: "result", is_error, result: "<text>" }
    if (outer && typeof outer === "object" && "result" in outer) {
      if (outer.is_error) throw new Error(`The messaging agent failed: ${String(outer.result).slice(-300)}`);
      const inner = typeof outer.result === "string" ? lastJson(outer.result) : outer.result;
      return { value: inner, raw: String(outer.result) };
    }
    return { value: outer, raw };
  }

  async listChannels(query?: string) {
    const prompt = [
      `Using the list_channels tool${query ? ` with query ${JSON.stringify(query)}` : ""}, list the channels.`,
      'Print only a JSON array of objects with keys "id" (the channelId) and "name". No prose.',
    ].join("\n");
    const { value, raw } = await this.ask(prompt);
    if (!Array.isArray(value)) throw new Error(`The messaging agent did not return a channel list: ${raw.slice(-300)}`);
    return value.map((c: any) => ({ id: String(c.id ?? c.channelId ?? ""), name: String(c.name ?? "") })).filter((c) => c.id);
  }

  async send(channelId: string, text: string, idempotencyKey: string) {
    const prompt = [
      `Send the following message to the channel with id ${channelId} using the send_message tool (conversationType "channel", conversationId ${JSON.stringify(channelId)}, idempotencyKey ${JSON.stringify(idempotencyKey)}).`,
      "Send the text exactly as written between the markers, with no additions or rewording:",
      "<<<MESSAGE",
      text,
      "MESSAGE>>>",
      "You have the user's explicit consent to send this: call send_message once to get the confirmationToken, then call it again with the same arguments plus that confirmationToken.",
      'When done, print only one line of JSON: {"sent": true, "id": "<message id, or empty string>"} — or, if it could not be sent, {"sent": false, "error": "<why>"}.',
    ].join("\n");
    const { value, raw } = await this.ask(prompt);
    if (value && value.sent === true) return { id: value.id ? String(value.id) : undefined };
    if (value && value.sent === false) throw new Error(`The messaging agent could not send it: ${value.error || "no reason given"}`);
    throw new Error(`The messaging agent did not confirm the send: ${raw.slice(-300)}`);
  }
}
```

- [ ] **Step 6: `engine/src/messaging/index.ts`**

```ts
import type { AccountStatus, ProjectConfig, Settings } from "../types";
import type { MessagingAdapter } from "./adapter";
import { AgentAdapter } from "./agent";
import type { TokenStore } from "./oauth";
import { SetmoreAdapter } from "./setmore";

export interface AdapterDeps {
  tokens: TokenStore;
  onStatus: (s: AccountStatus) => void;
  /** One Setmore adapter per process, so token refreshes are shared. */
  setmore?: SetmoreAdapter;
  fetchImpl?: typeof fetch;
}

export function adapterFor(p: Pick<ProjectConfig, "messaging" | "repoPath">, settings: Settings, deps: AdapterDeps): MessagingAdapter | undefined {
  switch (p.messaging.platform) {
    case "setmore":
      deps.setmore ||= new SetmoreAdapter(settings.accounts.setmore, deps.tokens, deps.onStatus, deps.fetchImpl);
      return deps.setmore;
    case "agent":
      return new AgentAdapter(p.messaging.agentCommand, p.repoPath || undefined);
    default:
      return undefined;
  }
}
```

- [ ] **Step 7: Run tests, typecheck, commit**

Run: `npm run test:unit` → setmore (6) and agentmsg (4) tests pass. `npm run typecheck` → exit 0.

```bash
git add engine/src/messaging/adapter.ts engine/src/messaging/setmore.ts engine/src/messaging/agent.ts engine/src/messaging/index.ts engine/test/setmore.test.mjs engine/test/agentmsg.test.mjs
git commit -m "Messaging adapters: direct Setmore (MCP + OAuth refresh) and agent-driven fallback"
```

---

### Task 5: MessagingService, orchestrator wiring, routes, e2e

**Files:**
- Create: `engine/src/messaging/service.ts`, `engine/test/service.test.mjs`
- Modify: `engine/src/orchestrator.ts`, `engine/src/server.ts`, `src/api.ts`, `src/mock.ts`, `engine/test/e2e.mjs`

**Interfaces:**
- Consumes: `adapterFor`, `SetmoreAdapter.status/refresh`, `TokenStore`, `discover/pkce/randomState/buildAuthorizeUrl/exchangeCode/tokensFromResponse/revokeToken`, `fillTemplate/ticketVars/bulkList`, `PrEvents`.
- Produces: `class MessagingService(deps)` with `onPrEvent(e)`, `sendForTicket(t, kind, text)`, `sendManual(key, text?)`, `sendBulk(keys, text?)`, `sendTest(project)`, `listChannels(project, query?)`, `status()`, `loginUrl()`, `logout()`, `shutdown()`; `Orchestrator.messaging`; routes in §4.6 of the spec; `Api.sendMessage/sendBulk/testMessage/listChannels/setmoreStatus/setmoreLogin/setmoreLogout`.

- [ ] **Step 1: Failing service unit test (bulk across projects; `none` platform reported, not dropped)**

Create `engine/test/service.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessagingService } from "../dist/test/messaging/service.js";
import { TokenStore } from "../dist/test/messaging/oauth.js";

const templates = { reviewReady: "review {key} {pr_url}", mergeNudge: "nudge {key} {approved_ago}", manual: "{key} — {summary}: {pr_url}", bulk: "Eyes please:\n{list}" };
const proj = (id, platform, channelId = "ch-" + id) => ({ id, name: "P" + id, repoPath: "", messaging: { platform, channelId, channelName: "#" + id, templates, agentCommand: "" } });
const tick = (key, projectId) => ({ key, projectId, summary: "S " + key, branch: "b", prUrl: "https://x/" + key, attempts: [], status: "pr_ready", createdAt: "", updatedAt: "" });

function makeService(sent) {
  const config = { settings: { accounts: { setmore: { clientId: "c", redirectPort: 1, mcpUrl: "http://127.0.0.1:1/mcp", issuer: "http://127.0.0.1:1/o", scopes: "" } } }, projects: [proj("a", "agent"), proj("b", "agent"), proj("c", "none")] };
  const state = { tickets: { "A-1": tick("A-1", "a"), "A-2": tick("A-2", "a"), "B-1": tick("B-1", "b"), "C-1": tick("C-1", "c") }, accounts: { setmore: { loggedIn: false } } };
  const logs = [];
  const notices = [];
  const svc = new MessagingService({
    config: () => config,
    state: () => state,
    log: (k, s) => logs.push([k, s]),
    notify: (t, b) => notices.push([t, b]),
    persist: () => {},
    emit: () => {},
    tokens: new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hf-svc-")), "t.json")),
    // test seam: replace the real adapter factory
    adapterFor: (p) => (p.messaging.platform === "none" ? undefined : { platform: p.messaging.platform, listChannels: async () => [], send: async (ch, text, key) => { sent.push({ project: p.id, ch, text, key }); return { id: "m-" + sent.length }; } }),
  });
  return { svc, state, logs, notices };
}

test("sendBulk: one message per project to its own channel; platform none reported as failed", async () => {
  const sent = [];
  const { svc, state } = makeService(sent);
  const r = await svc.sendBulk(["A-1", "A-2", "B-1", "C-1", "NOPE-1"]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].ch, "ch-a");
  assert.match(sent[0].text, /^Eyes please:\n- A-1 — S A-1: https:\/\/x\/A-1\n- A-2/);
  assert.equal(sent[1].ch, "ch-b");
  assert.deepEqual(r.failed.map((f) => f.key).sort(), ["C-1", "NOPE-1"]);
  assert.match(r.failed.find((f) => f.key === "C-1").error, /no messaging platform/i);
  assert.equal(r.sent.length, 3, "a record per sent ticket");
  assert.equal(state.tickets["A-2"].messages[0].kind, "bulk");
  assert.equal(state.tickets["A-2"].messages[0].ok, true);
  assert.equal(state.tickets["C-1"].messages?.length ?? 0, 0, "nothing recorded for a project without messaging");
});

test("sendManual: template filled, custom text wins, failure recorded and notified", async () => {
  const sent = [];
  const { svc, state, notices } = makeService(sent);
  const rec = await svc.sendManual("A-1");
  assert.equal(rec.text, "A-1 — S A-1: https://x/A-1");
  assert.equal(rec.ok, true);
  assert.equal(rec.id, "m-1");
  const custom = await svc.sendManual("A-1", "custom {key}");
  assert.equal(custom.text, "custom {key}", "custom text is sent verbatim");
  await assert.rejects(svc.sendManual("C-1"), /Choose a channel|no messaging platform/i);
  // failing adapter
  const { svc: svc2, state: s2, notices: n2 } = makeService([]);
  svc2.deps.adapterFor = () => ({ platform: "agent", listChannels: async () => [], send: async () => { throw new Error("boom"); } });
  const failed = await svc2.sendManual("A-1").catch((e) => e);
  assert.match(String(failed.message || failed), /boom/);
  assert.equal(s2.tickets["A-1"].messages[0].ok, false);
  assert.match(s2.tickets["A-1"].messages[0].error, /boom/);
  assert.equal(n2.length, 1);
  assert.equal(state.tickets["A-1"].messages.length, 2);
});

test("onPrEvent: review_ready and merge_nudge send their templates; other kinds and empty templates are skipped", async () => {
  const sent = [];
  const { svc, state, logs } = makeService(sent);
  state.tickets["A-1"].pr = { approvedAt: new Date(Date.now() - 47 * 60_000).toISOString() };
  await svc.onPrEvent({ kind: "review_ready", key: "A-1", prUrl: "https://x/A-1", projectId: "a", at: "" });
  await svc.onPrEvent({ kind: "merge_nudge", key: "A-1", prUrl: "https://x/A-1", projectId: "a", at: "" });
  await svc.onPrEvent({ kind: "merged", key: "A-1", prUrl: "https://x/A-1", projectId: "a", at: "" });
  assert.deepEqual(sent.map((s) => s.text), ["review A-1 https://x/A-1", "nudge A-1 47 min"]);
  svc.deps.config().projects[0].messaging.templates.reviewReady = "";
  await svc.onPrEvent({ kind: "review_ready", key: "A-2", prUrl: "", projectId: "a", at: "" });
  assert.equal(sent.length, 2);
  assert.ok(logs.some(([k, s]) => k === "A-2" && /template is empty/.test(s)));
});
```

- [ ] **Step 2: Watch it fail**

Run: `npm run test:unit` → `service.test.mjs` fails on import.

- [ ] **Step 3: Implement `engine/src/messaging/service.ts`**

```ts
// Sends collab messages for PR events and on demand; owns the Setmore login (loopback OAuth) and records every send.
import http from "node:http";
import type { AccountStatus, Config, EngineEvent, EngineState, MessageKind, MessageRecord, PrEvent, ProjectConfig, Ticket } from "../types";
import type { MessagingAdapter } from "./adapter";
import { adapterFor as realAdapterFor, type AdapterDeps } from "./index";
import { buildAuthorizeUrl, discover, exchangeCode, pkce, randomState, revokeToken, tokensFromResponse, type TokenStore } from "./oauth";
import { SetmoreAdapter } from "./setmore";
import { bulkList, fillTemplate, ticketVars } from "./templates";

export interface ServiceDeps {
  config: () => Config;
  state: () => EngineState;
  log: (key: string, chunk: string) => void;
  notify: (title: string, body: string) => void;
  persist: () => void;
  emit: (e: EngineEvent) => void;
  tokens: TokenStore;
  fetchImpl?: typeof fetch;
  /** Test seam. */
  adapterFor?: (p: ProjectConfig, settings: Config["settings"], deps: AdapterDeps) => MessagingAdapter | undefined;
}

const now = () => new Date().toISOString();
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export class MessagingService {
  private adapterDeps: AdapterDeps;
  private pending?: { url: string; server: http.Server; state: string; verifier: string; redirectUri: string; timer: NodeJS.Timeout };

  constructor(public deps: ServiceDeps) {
    this.adapterDeps = { tokens: deps.tokens, fetchImpl: deps.fetchImpl, onStatus: (s) => this.setStatus(s) };
  }

  // ---------- status ----------
  private setmore(): SetmoreAdapter {
    this.adapterDeps.setmore ||= new SetmoreAdapter(this.deps.config().settings.accounts.setmore, this.deps.tokens, this.adapterDeps.onStatus, this.deps.fetchImpl);
    return this.adapterDeps.setmore;
  }
  status(): AccountStatus {
    return { ...this.setmore().status(), loginPending: !!this.pending };
  }
  private setStatus(s: AccountStatus) {
    const status = { ...s, loginPending: !!this.pending };
    this.deps.state().accounts.setmore = status;
    this.deps.persist();
    this.deps.emit({ type: "account", name: "setmore", status });
  }
  /** Called once at engine start to reflect the token file. */
  init() {
    this.setStatus(this.setmore().status());
  }

  // ---------- resolving ----------
  private adapter(p: ProjectConfig) {
    return (this.deps.adapterFor || realAdapterFor)(p, this.deps.config().settings, this.adapterDeps);
  }
  private resolve(t: Ticket): { p: ProjectConfig; adapter: MessagingAdapter } {
    const p = this.deps.config().projects.find((x) => x.id === t.projectId);
    if (!p) throw new Error("Its project was deleted.");
    const adapter = this.adapter(p);
    if (!adapter) throw new Error(`No messaging platform is set for “${p.name}” (project → Messaging).`);
    if (!p.messaging.channelId) throw new Error(`Choose a channel in the Messaging step of “${p.name}”.`);
    return { p, adapter };
  }

  // ---------- sending ----------
  private record(t: Ticket, rec: MessageRecord) {
    (t.messages ||= []).push(rec);
    if (t.messages.length > 50) t.messages.splice(0, t.messages.length - 50);
    t.updatedAt = now();
    this.deps.persist();
  }

  /** Send `text` for one ticket; records the outcome on the ticket and throws on failure (after recording). */
  async sendForTicket(t: Ticket, kind: MessageKind, text: string): Promise<MessageRecord> {
    const { p, adapter } = this.resolve(t);
    const base = { kind, at: now(), platform: adapter.platform, channelId: p.messaging.channelId, channelName: p.messaging.channelName, text };
    const idempotencyKey = `${t.key}:${kind}:${t.pr?.headSha || ""}:${base.at.slice(0, 16)}`;
    try {
      const { id } = await adapter.send(p.messaging.channelId, text, idempotencyKey);
      const rec: MessageRecord = { ...base, ok: true, id };
      this.record(t, rec);
      this.deps.log(t.key, `\n💬 Sent to ${p.messaging.channelName || p.messaging.channelId} (${kind})\n`);
      return rec;
    } catch (e) {
      const error = String((e as Error).message || e).slice(0, 400);
      const rec: MessageRecord = { ...base, ok: false, error };
      this.record(t, rec);
      this.deps.log(t.key, `\n! Message to ${p.messaging.channelName || p.messaging.channelId} failed: ${error}\n`);
      this.deps.notify(`${t.key}: message not sent`, error);
      throw e;
    }
  }

  async onPrEvent(e: PrEvent) {
    if (e.kind !== "review_ready" && e.kind !== "merge_nudge") return;
    const t = this.deps.state().tickets[e.key];
    const p = t && this.deps.config().projects.find((x) => x.id === t.projectId);
    if (!t || !p) return;
    if (p.messaging.platform === "none") return;
    const tpl = e.kind === "review_ready" ? p.messaging.templates.reviewReady : p.messaging.templates.mergeNudge;
    if (!tpl.trim()) return this.deps.log(t.key, `· messaging: the ${e.kind} template is empty, nothing sent\n`);
    if (!p.messaging.channelId) return this.deps.log(t.key, "· messaging: no channel configured, nothing sent\n");
    await this.sendForTicket(t, e.kind, fillTemplate(tpl, ticketVars(p, t))).catch(() => undefined);
  }

  async sendManual(key: string, text?: string) {
    const t = this.deps.state().tickets[key];
    if (!t) throw new Error("Unknown ticket");
    const { p } = this.resolve(t);
    return this.sendForTicket(t, "manual", text?.trim() || fillTemplate(p.messaging.templates.manual, ticketVars(p, t)));
  }

  async sendBulk(keys: string[], text?: string): Promise<{ sent: MessageRecord[]; failed: { key: string; error: string }[] }> {
    const sent: MessageRecord[] = [];
    const failed: { key: string; error: string }[] = [];
    const groups = new Map<string, Ticket[]>();
    for (const key of keys) {
      const t = this.deps.state().tickets[key];
      if (!t) {
        failed.push({ key, error: "Unknown ticket" });
        continue;
      }
      (groups.get(t.projectId) || groups.set(t.projectId, []).get(t.projectId)!).push(t);
    }
    for (const [projectId, tickets] of groups) {
      const p = this.deps.config().projects.find((x) => x.id === projectId);
      let adapter: MessagingAdapter | undefined;
      try {
        adapter = p && this.adapter(p);
        if (!p || !adapter) throw new Error(`No messaging platform is set for “${p?.name || projectId}”.`);
        if (!p.messaging.channelId) throw new Error(`Choose a channel in the Messaging step of “${p.name}”.`);
      } catch (e) {
        for (const t of tickets) failed.push({ key: t.key, error: (e as Error).message });
        continue;
      }
      const list = bulkList(tickets.map((t) => ({ p, t })));
      const body = fillTemplate(text?.trim() || p.messaging.templates.bulk, { ...ticketVars(p, tickets[0]), list });
      const at = now();
      const base = { kind: "bulk" as const, at, platform: adapter.platform, channelId: p.messaging.channelId, channelName: p.messaging.channelName, text: body };
      try {
        const { id } = await adapter.send(p.messaging.channelId, body, `bulk:${tickets.map((t) => t.key).join(",")}:${at.slice(0, 16)}`);
        for (const t of tickets) {
          const rec = { ...base, ok: true, id };
          this.record(t, rec);
          sent.push(rec);
          this.deps.log(t.key, `\n💬 Sent to ${p.messaging.channelName || p.messaging.channelId} (bulk, ${tickets.length} tickets)\n`);
        }
      } catch (e) {
        const error = String((e as Error).message || e).slice(0, 400);
        for (const t of tickets) {
          this.record(t, { ...base, ok: false, error });
          failed.push({ key: t.key, error });
        }
        this.deps.notify("Bulk message not sent", error);
      }
    }
    return { sent, failed };
  }

  async sendTest(p: ProjectConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      const adapter = this.adapter(p);
      if (!adapter) return { ok: false, error: "Pick a platform first." };
      if (!p.messaging.channelId) return { ok: false, error: "Pick a channel first." };
      await adapter.send(p.messaging.channelId, `HandsFree test message from “${p.name || "a project"}” at ${new Date().toLocaleString()}`, `test:${Date.now()}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e).slice(0, 400) };
    }
  }

  async listChannels(p: ProjectConfig, query?: string) {
    const adapter = this.adapter(p);
    if (!adapter) throw new Error("Pick a platform first.");
    return adapter.listChannels(query);
  }

  // ---------- Setmore login ----------
  async loginUrl(): Promise<string> {
    if (this.pending) return this.pending.url;
    const s = this.deps.config().settings.accounts.setmore;
    if (!s.clientId.trim()) throw new Error("Enter the Setmore client id first (from the auth team).");
    const meta = await discover(s.issuer, this.deps.fetchImpl);
    const { verifier, challenge } = pkce();
    const state = randomState();
    const redirectUri = `http://127.0.0.1:${s.redirectPort}/oauth/callback`;
    const url = buildAuthorizeUrl(meta, { clientId: s.clientId, redirectUri, scope: s.scopes, state, challenge, resource: s.mcpUrl });
    const server = http.createServer((req, res) => void this.onCallback(req, res, meta));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(s.redirectPort, "127.0.0.1", () => resolve());
    }).catch((e: NodeJS.ErrnoException) => {
      throw new Error(e.code === "EADDRINUSE" ? `Port ${s.redirectPort} is in use — close the app using it, or register another redirect port.` : e.message);
    });
    const timer = setTimeout(() => this.finishLogin("Login timed out after 5 minutes."), LOGIN_TIMEOUT_MS);
    this.pending = { url, server, state, verifier, redirectUri, timer };
    this.setStatus(this.setmore().status());
    return url;
  }

  private async onCallback(req: http.IncomingMessage, res: http.ServerResponse, meta: Awaited<ReturnType<typeof discover>>) {
    const page = (code: number, title: string, body: string) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:-apple-system,sans-serif;padding:40px"><h2>${title}</h2><p>${body}</p></body>`);
    };
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") return page(404, "Not found", "HandsFree is waiting for the sign-in callback.");
    const p = this.pending;
    if (!p) return page(400, "No sign-in in progress", "Start the login from HandsFree → Settings → Accounts.");
    if (url.searchParams.get("state") !== p.state) return page(400, "Sign-in rejected", "The state parameter didn't match. Start the login again from HandsFree.");
    const err = url.searchParams.get("error");
    if (err) {
      page(400, "Sign-in failed", `${err}: ${url.searchParams.get("error_description") || ""}`);
      return this.finishLogin(`Sign-in failed: ${err}`);
    }
    const code = url.searchParams.get("code");
    if (!code) return page(400, "Sign-in rejected", "No code in the callback.");
    try {
      const s = this.deps.config().settings.accounts.setmore;
      const r = await exchangeCode(meta, { clientId: s.clientId, code, redirectUri: p.redirectUri, verifier: p.verifier, resource: s.mcpUrl }, this.deps.fetchImpl);
      this.deps.tokens.save(tokensFromResponse(r));
      page(200, "Signed in to Setmore", "You can close this tab and go back to HandsFree.");
      this.finishLogin();
    } catch (e) {
      page(500, "Sign-in failed", String((e as Error).message || e));
      this.finishLogin(`Sign-in failed: ${(e as Error).message}`);
    }
  }

  private finishLogin(error?: string) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    p.server.close();
    this.pending = undefined;
    this.setStatus(this.setmore().status(error));
  }

  async logout() {
    const t = this.deps.tokens.load();
    const s = this.deps.config().settings.accounts.setmore;
    if (t?.refreshToken) {
      await discover(s.issuer, this.deps.fetchImpl)
        .then((meta) => revokeToken(meta, { clientId: s.clientId, token: t.refreshToken! }, this.deps.fetchImpl))
        .catch(() => undefined);
    }
    this.deps.tokens.clear();
    this.finishLogin();
    this.setStatus(this.setmore().status());
  }

  shutdown() {
    this.finishLogin();
  }
}
```

Note the test seam `deps.adapterFor` and the public `deps` (the unit test swaps the adapter on `svc.deps`).

- [ ] **Step 4: Run the service tests**

Run: `npm run test:unit` → service tests pass (3).

- [ ] **Step 5: Orchestrator wiring**

In `engine/src/orchestrator.ts`:
- imports: `import path from "node:path";` already exists; add `import { MessagingService } from "./messaging/service"; import { TokenStore } from "./messaging/oauth"; import { DATA_DIR, loadConfig, loadState, logFile, normalizeProject, normalizeSettings, saveConfig, saveState } from "./store";` (merge with the existing `./store` import).
- field: `messaging = new MessagingService({ config: () => this.config, state: () => this.state, log: (k, s) => this.log(k, s), notify: (t, b) => this.notify(t, b, "failed"), persist: () => this.persist(), emit: (e) => this.emit(e), tokens: new TokenStore(path.join(DATA_DIR, "auth", "setmore.json")) });` (declared after `prEvents`; field initialisers may reference `this` methods).
- `start()`: after `this.prEvents.on((e) => this.onPrEvent(e));` add `this.prEvents.on((e) => void this.messaging.onPrEvent(e));` and `this.messaging.init();`.
- `updateConfig`: `settings: normalizeSettings({ ...this.config.settings, ...next.settings }),`.
- `shutdown()`: add `this.messaging.shutdown();`.
- `forget(key)`: unchanged (messages go with the ticket).

- [ ] **Step 6: Routes**

In `engine/src/server.ts`, extend the ticket regex with `|message` and inside the `if (m)` block add before the `retry` line:

```ts
        if (m[2] === "message") {
          const { text } = await body<{ text?: string }>();
          try {
            return send(200, await o.messaging.sendManual(key, text));
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        }
```

Add to the `switch`:

```ts
        case "POST /api/messages/bulk": {
          const { keys, text } = await body<{ keys: string[]; text?: string }>();
          return send(200, await o.messaging.sendBulk(Array.isArray(keys) ? keys : [], text));
        }
        case "POST /api/messaging/test": {
          const { project } = await body<{ project: ProjectConfig }>();
          return send(200, await o.messaging.sendTest(normalizeProject(project)));
        }
        case "POST /api/messaging/channels": {
          const { project, query } = await body<{ project: ProjectConfig; query?: string }>();
          try {
            return send(200, { channels: await o.messaging.listChannels(normalizeProject(project), query) });
          } catch (e) {
            return send(200, { channels: [], error: (e as Error).message });
          }
        }
        case "GET /api/accounts/setmore":
          return send(200, o.messaging.status());
        case "POST /api/accounts/setmore/login":
          try {
            return send(200, { url: await o.messaging.loginUrl() });
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        case "POST /api/accounts/setmore/logout":
          await o.messaging.logout();
          return send(200, {});
```

- [ ] **Step 7: `src/api.ts` and `src/mock.ts`**

`Api` interface additions:

```ts
  /** Send one ticket's collab message (template-filled unless `text` is given). */
  sendMessage(key: string, text?: string): Promise<MessageRecord>;
  sendBulk(keys: string[], text?: string): Promise<{ sent: MessageRecord[]; failed: { key: string; error: string }[] }>;
  testMessage(project: ProjectConfig): Promise<{ ok: boolean; error?: string }>;
  listChannels(project: ProjectConfig, query?: string): Promise<{ channels: { id: string; name: string }[]; error?: string }>;
  setmoreStatus(): Promise<AccountStatus>;
  /** Starts the loopback OAuth flow; open the returned URL in the browser. */
  setmoreLogin(): Promise<{ url: string }>;
  setmoreLogout(): Promise<void>;
```

(import `AccountStatus`, `MessageRecord` types.) `createHttpApi`:

```ts
    sendMessage: (k, text) => action(`/api/tickets/${encodeURIComponent(k)}/message`, { text }),
    sendBulk: (keys, text) => call("/api/messages/bulk", "POST", { keys, text }),
    testMessage: (project) => call("/api/messaging/test", "POST", { project }),
    listChannels: (project, query) => call("/api/messaging/channels", "POST", { project, query }),
    setmoreStatus: () => call("/api/accounts/setmore"),
    setmoreLogin: () => action("/api/accounts/setmore/login", {}),
    setmoreLogout: () => call("/api/accounts/setmore/logout", "POST"),
```

`src/mock.ts` additions (inside the returned object):

```ts
    sendMessage: async (k, text) => {
      const t = state.tickets[k];
      const rec = { kind: "manual" as const, at: new Date().toISOString(), platform: "setmore" as const, channelId: "nN0p", channelName: "ChatSupport Team Core", text: text || `${k} — ${t?.summary}: ${t?.prUrl}`, ok: true, id: "m-demo" };
      if (t) {
        state = { ...state, tickets: { ...state.tickets, [k]: { ...t, messages: [...(t.messages || []), rec] } } };
        emit({ type: "state", state });
      }
      return rec;
    },
    sendBulk: async (keys, text) => {
      const recs = keys.map((k) => ({ kind: "bulk" as const, at: new Date().toISOString(), platform: "setmore" as const, channelId: "nN0p", channelName: "ChatSupport Team Core", text: text || `Hi team, these PRs need eyes:\n${keys.map((x) => `- ${x}`).join("\n")}`, ok: true, id: "m-demo" }));
      return { sent: recs, failed: [] };
    },
    testMessage: async () => ({ ok: true }),
    listChannels: async (_p, query) => ({ channels: [{ id: "nN0pGzAWVcudEnhemVADfwCZi6iUlMiW", name: "ChatSupport Team Core" }, { id: "UN1xRascNHnbVXP99Pw2ztIQfgPTt7qF", name: "CBA: Core Team" }].filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase())) }),
    setmoreStatus: async () => state.accounts.setmore,
    setmoreLogin: async () => {
      setTimeout(() => {
        state = { ...state, accounts: { setmore: { loggedIn: true, user: "yogesh@anywhere.co" } } };
        emit({ type: "account", name: "setmore", status: state.accounts.setmore });
      }, 1000);
      return { url: "https://auth.setmore.com/o/oauth2/auth?demo=1" };
    },
    setmoreLogout: async () => {
      state = { ...state, accounts: { setmore: { loggedIn: false } } };
      emit({ type: "account", name: "setmore", status: state.accounts.setmore });
    },
```

- [ ] **Step 8: E2E (failing first, then green)**

In `engine/test/e2e.mjs`:

Imports at the top: `import { startFakeAuth } from "./fakes/auth-server.mjs"; import { startFakeMcp } from "./fakes/mcp-server.mjs";`. After the fakes for CLIs, add a messaging agent fake:

```js
// messaging agent fake: prints Claude's JSON envelope and records the prompt
script("fakemsg", `echo "$@" >> "${root}/msg.log"; echo '{"type":"result","is_error":false,"result":"ok\\n{\\"sent\\": true, \\"id\\": \\"agent-1\\"}"}'`);
```

Before the engine is spawned, start the fake servers and pick a callback port:

```js
const validTokens = new Set();
const auth = await startFakeAuth({ validTokens });
const mcp = await startFakeMcp({ validTokens });
const cbPort = 49000 + Math.floor(Math.random() * 500);
```

Insert the following block **after** the Publish step (`assert.equal((await ticket("DEMO-1")).status, "pr_ready");`) and before the paused step:

```js
  // ---- Messaging: configure Setmore + log in through the fake auth server
  const cfgM = await api("/api/config");
  project.messaging = { platform: "setmore", channelId: "ch-core", channelName: "ChatSupport Team Core", templates: { reviewReady: "Hey team, please review {key} — {summary}: {pr_url}", mergeNudge: "Hi team, {key} is approved and waiting {approved_ago}: {pr_url}", manual: "{key}: {pr_url}", bulk: "Eyes please:\n{list}" }, agentCommand: "" };
  await api("/api/config", "PUT", { ...cfgM, settings: { ...cfgM.settings, accounts: { setmore: { clientId: "hf-test", redirectPort: cbPort, mcpUrl: mcp.url, issuer: auth.issuer, scopes: "openid offline_access" } } }, projects: [project] });
  assert.equal((await api("/api/accounts/setmore")).loggedIn, false);
  // automatic send without a login is recorded as failed, not thrown
  const noLogin = await api("/api/tickets/DEMO-1/message", "POST", { text: "early" });
  assert.match(noLogin.error, /Not logged in/);
  assert.equal((await ticket("DEMO-1")).messages.at(-1).ok, false);

  const login = await api("/api/accounts/setmore/login", "POST", {});
  assert.match(login.url, new RegExp(`^${auth.issuer}/oauth2/auth\\?`));
  assert.equal((await api("/api/accounts/setmore")).loginPending, true);
  // a second click returns the same URL; a busy port is reported, not hung
  assert.equal((await api("/api/accounts/setmore/login", "POST", {})).url, login.url);
  const authorize = await fetch(login.url, { redirect: "manual" });
  const callback = authorize.headers.get("location");
  assert.match(callback, new RegExp(`^http://127\\.0\\.0\\.1:${cbPort}/oauth/callback\\?code=`));
  // wrong state is rejected and the login stays pending
  const bad = await fetch(callback.replace(/state=[^&]*/, "state=forged"));
  assert.equal(bad.status, 400);
  assert.equal((await api("/api/accounts/setmore")).loginPending, true);
  const done = await fetch(callback);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Signed in/);
  const acct = await waitFor(async () => {
    const a = await api("/api/accounts/setmore");
    return a.loggedIn && !a.loginPending && a;
  }, "setmore logged in");
  assert.equal(acct.user, "t@t.t");
  assert.equal(auth.tokenCalls[0].resource, mcp.url, "resource indicator sent");

  // port in use → clear error
  await api("/api/accounts/setmore/logout", "POST");
  const http = await import("node:http");
  const blocker = http.createServer(() => {});
  await new Promise((r) => blocker.listen(cbPort, "127.0.0.1", r));
  assert.match((await api("/api/accounts/setmore/login", "POST", {})).error, new RegExp(`Port ${cbPort} is in use`));
  await new Promise((r) => blocker.close(r));
  // log in again for the rest of the run
  const login2 = await api("/api/accounts/setmore/login", "POST", {});
  await fetch((await fetch(login2.url, { redirect: "manual" })).headers.get("location"));
  await waitFor(async () => (await api("/api/accounts/setmore")).loggedIn, "logged in again");
```

After the existing `review_ready` assertion (`"review_ready fired once"`) add:

```js
  const reviewMsg = await waitFor(async () => mcp.received.find((m) => /please review DEMO-1/.test(m.text)), "review message sent");
  assert.equal(reviewMsg.channelId, "ch-core");
  assert.match(reviewMsg.text, /pull\/101/);
  assert.equal((await ticket("DEMO-1")).messages.at(-1).kind, "review_ready");
```

After the nudge assertion (`"nudge fired once"`) add:

```js
  await waitFor(async () => mcp.received.find((m) => /approved and waiting/.test(m.text)), "nudge message sent");
  assert.equal(mcp.received.filter((m) => /DEMO-1/.test(m.text)).length, 2, "one review + one nudge message");

  // ---- Manual, bulk, 401→refresh, logout, agent adapter
  const manual = await api("/api/tickets/DEMO-1/message", "POST", { text: "custom hello" });
  assert.equal(manual.ok, true);
  assert.equal(mcp.received.at(-1).text, "custom hello");
  const bulk = await api("/api/messages/bulk", "POST", { keys: ["DEMO-1", "DEMO-2"] });
  assert.equal(bulk.failed.length, 0);
  assert.equal(bulk.sent.length, 2);
  assert.match(mcp.received.at(-1).text, /^Eyes please:\n- DEMO-1 — Add greeting: .*pull\/101\n- DEMO-2 — Second ticket: .*pull\/102$/);
  auth.rotate();
  const afterRotate = await api("/api/tickets/DEMO-1/message", "POST", {});
  assert.equal(afterRotate.ok, true, "401 → refresh → sent");
  assert.equal(afterRotate.text, "DEMO-1: https://github.com/acme/repo/pull/101");
  await api("/api/accounts/setmore/logout", "POST");
  assert.equal((await api("/api/accounts/setmore")).loggedIn, false);
  assert.match((await api("/api/tickets/DEMO-1/message", "POST", {})).error, /Not logged in/);
  // agent adapter
  project.messaging = { ...project.messaging, platform: "agent", agentCommand: "fakemsg {prompt}" };
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });
  const viaAgent = await api("/api/tickets/DEMO-1/message", "POST", { text: "via agent" });
  assert.equal(viaAgent.ok, true);
  assert.equal(viaAgent.id, "agent-1");
  assert.match(fs.readFileSync(path.join(root, "msg.log"), "utf8"), /via agent[\s\S]*confirmationToken/);
  project.messaging = { ...project.messaging, platform: "setmore" };
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });
```

In the `finally` at the end add `await auth.close(); await mcp.close();`.

Note: the `{ text: "early" }` call happens before login and must return an error. `sendManual` records then throws; the route turns it into 400 `{error}` and `api()` returns that JSON.

Run: `npm run test:e2e` → `✅ e2e passed`. `npm run typecheck` → exit 0. `npm run test:unit` → all pass.

- [ ] **Step 9: Commit**

```bash
git add engine/src/messaging/service.ts engine/test/service.test.mjs engine/src/orchestrator.ts engine/src/server.ts src/api.ts src/mock.ts engine/test/e2e.mjs
git commit -m "MessagingService: PR-event sends, manual and bulk sends, Setmore loopback login; routes and API"
```

---

### Task 6: UI — Accounts card, Messaging project step, dashboard sends

**Files:**
- Modify: `src/views/Settings.tsx`, `src/views/Projects.tsx`, `src/views/Dashboard.tsx`, `src/App.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `Api.sendMessage/sendBulk/testMessage/listChannels/setmoreStatus/setmoreLogin/setmoreLogout`, `EngineEvent` `account`, `EngineState.accounts`, `Ticket.messages`.

- [ ] **Step 1: Settings → Accounts card**

In `src/views/Settings.tsx` add state and a card between "On this Mac" and "System check":

```tsx
  const [acct, setAcct] = useState<AccountStatus>();
  const [loginMsg, setLoginMsg] = useState<string>();
  const sm = s.accounts.setmore;
  const updateSetmore = (patch: Partial<typeof sm>) => update({ accounts: { setmore: { ...sm, ...patch } } });
  useEffect(() => {
    api.setmoreStatus().then(setAcct).catch(() => {});
    return api.subscribe((e) => {
      if (e.type === "account" && e.name === "setmore") setAcct(e.status);
    });
  }, []);
  const login = async () => {
    setLoginMsg(undefined);
    try {
      const { url } = await api.setmoreLogin();
      await openExternal(url);
      setLoginMsg("Finish signing in in your browser, then come back here.");
    } catch (e) {
      setLoginMsg(String((e as Error).message || e));
    }
  };
```

```tsx
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Accounts</h3>
        <p className="card-sub">Setmore collab messages are sent as you. HandsFree signs in once with the client id the auth team issued; tokens stay on this Mac.</p>
        <div className="field">
          <label>Setmore client id</label>
          <input className="input code" value={sm.clientId} placeholder="from the auth team" onChange={(e) => updateSetmore({ clientId: e.target.value })} />
          <span className="hint">Registered redirect URI: <span className="mono">http://127.0.0.1:{sm.redirectPort}/oauth/callback</span></span>
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>{acct?.loggedIn ? `Signed in${acct.user ? ` as ${acct.user}` : ""}` : acct?.loginPending ? "Waiting for the browser…" : "Not signed in"}</b>
            <span className={acct?.error ? "err-text" : ""}>{acct?.error || (acct?.loggedIn ? `Scopes: ${acct.scope || "—"}` : "Enter the client id, then log in.")}</span>
          </div>
          {acct?.loggedIn ? (
            <button className="btn sm" onClick={() => api.setmoreLogout().then(() => api.setmoreStatus().then(setAcct))}>Log out</button>
          ) : (
            <button className="btn sm primary" disabled={!sm.clientId.trim() || acct?.loginPending} onClick={login}>Log in</button>
          )}
        </div>
        {loginMsg && <div className="callout info"><span className="t">{loginMsg}</span></div>}
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>Advanced</summary>
          <div className="grid3" style={{ marginTop: 10 }}>
            <div className="field"><label>Redirect port</label><input className="input num-input" type="number" min={1024} max={65535} value={sm.redirectPort} onChange={(e) => updateSetmore({ redirectPort: Number(e.target.value) || 47831 })} /></div>
            <div className="field"><label>MCP URL</label><input className="input code" value={sm.mcpUrl} onChange={(e) => updateSetmore({ mcpUrl: e.target.value })} /></div>
            <div className="field"><label>Issuer</label><input className="input code" value={sm.issuer} onChange={(e) => updateSetmore({ issuer: e.target.value })} /></div>
          </div>
          <div className="field"><label>Scopes</label><input className="input code" value={sm.scopes} onChange={(e) => updateSetmore({ scopes: e.target.value })} /></div>
        </details>
      </div>
```

Imports: `import { openExternal, setLaunchAtLogin, type Api, type DoctorItem } from "../api";` and `import type { AccountStatus, Config, Settings } from "../../engine/src/types";`.

- [ ] **Step 2: Project editor → Messaging step**

In `src/views/Projects.tsx`: `const STEPS = ["Repository", "Jira", "MCP servers", "Agent chain", "Messaging", "Review"];`. The existing `{step === 4 && (` Review block becomes `{step === 5 && (`. Add state and helpers in `ProjectEditor`:

```tsx
  const [channels, setChannels] = useState<{ list?: { id: string; name: string }[]; error?: string; loading?: boolean }>();
  const [channelQuery, setChannelQuery] = useState("");
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string }>();
  const setMsg = (patch: Partial<MessagingConfig>) => set({ messaging: { ...p.messaging, ...patch } });
  const setTpl = (k: keyof MessageTemplates, v: string) => setMsg({ templates: { ...p.messaging.templates, [k]: v } });
  const loadChannels = async () => {
    setChannels({ loading: true });
    const r = await api.listChannels(p, channelQuery).catch((e) => ({ channels: [], error: String((e as Error).message || e) }));
    setChannels({ list: r.channels, error: r.error });
  };
  const sendTest = async () => {
    setTestMsg(undefined);
    const r = await api.testMessage(p);
    setTestMsg({ ok: r.ok, text: r.ok ? `Sent to ${p.messaging.channelName || p.messaging.channelId}` : r.error || "Failed" });
  };
```

Add to `problems`: `p.messaging.platform !== "none" && !p.messaging.channelId && "Pick a collab channel (Messaging step)"`.

New step block (insert before the Review block):

```tsx
        {step === 4 && (
          <>
            <h3 className="card-title">Messaging</h3>
            <p className="card-sub">Where HandsFree tells the team about this project's PRs: when CI passes on a published PR, when an approved PR waits too long, and whenever you press Send.</p>
            <div className="field">
              <label>Platform</label>
              <select className="select" style={{ maxWidth: 320 }} value={p.messaging.platform} onChange={(e) => setMsg({ platform: e.target.value as MessagingPlatform })}>
                <option value="none">None — don't message</option>
                <option value="setmore">Setmore collab (direct, signed in via Settings → Accounts)</option>
                <option value="agent">Agent (any platform your MCP connectors reach)</option>
              </select>
            </div>
            {p.messaging.platform !== "none" && (
              <>
                {p.messaging.platform === "agent" && (
                  <div className="field">
                    <label>Agent command</label>
                    <input className="input code" value={p.messaging.agentCommand} onChange={(e) => setMsg({ agentCommand: e.target.value })} />
                    <span className="hint"><span className="mono">{"{prompt}"}</span> is filled in. The agent must have the platform's send_message tool; the default uses Claude with the Setmore connector.</span>
                  </div>
                )}
                <div className="field">
                  <label>Channel</label>
                  <div className="row">
                    <input className="input" style={{ maxWidth: 240 }} placeholder="filter by name" value={channelQuery} onChange={(e) => setChannelQuery(e.target.value)} />
                    <button className="btn" onClick={loadChannels} disabled={channels?.loading}>{channels?.loading ? "Loading…" : "Load channels"}</button>
                    <span className="small muted">{p.messaging.channelName ? `Selected: ${p.messaging.channelName}` : p.messaging.channelId ? `Selected id: ${p.messaging.channelId}` : "None selected"}</span>
                  </div>
                  {channels?.error && <div className="callout err"><span className="t">{channels.error}</span></div>}
                  {channels?.list && (
                    <div className="issue-list" style={{ marginTop: 8 }}>
                      {channels.list.length === 0 && <div className="issue-row small muted">No channels found.</div>}
                      {channels.list.map((c) => (
                        <div key={c.id} className="issue-row" style={{ cursor: "pointer" }} onClick={() => setMsg({ channelId: c.id, channelName: c.name })}>
                          <span className="key">{c.id === p.messaging.channelId ? "✓" : ""}</span><span>{c.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <input className="input code" style={{ marginTop: 8 }} placeholder="or paste a channel id" value={p.messaging.channelId} onChange={(e) => setMsg({ channelId: e.target.value })} />
                </div>
                {(
                  [
                    ["reviewReady", "CI passed on a published PR"],
                    ["mergeNudge", "Approved but not merged after the project's delay"],
                    ["manual", "Send button (prefilled, editable)"],
                    ["bulk", "Several selected PRs ({list} = one line per PR)"],
                  ] as [keyof MessageTemplates, string][]
                ).map(([k, label]) => (
                  <div key={k} className="field">
                    <label>{label}</label>
                    <textarea className="textarea" rows={2} value={p.messaging.templates[k]} onChange={(e) => setTpl(k, e.target.value)} />
                  </div>
                ))}
                <div className="callout info" style={{ marginBottom: 14 }}>
                  <span className="t">Placeholders: <span className="mono">{"{key} {summary} {pr_url} {pr_number} {project} {branch} {approved_ago} {list}"}</span>. Leave a template empty to skip that message.</span>
                </div>
                <div className="row">
                  <button className="btn" onClick={sendTest} disabled={!p.messaging.channelId}>Send test message</button>
                  {testMsg && <span className={`small ${testMsg.ok ? "muted" : "err-text"}`}>{testMsg.text}</span>}
                </div>
              </>
            )}
          </>
        )}
```

Imports: add `type MessagingConfig, type MessagingPlatform, type MessageTemplates` to the `../../engine/src/types` import. In the Review step add after the "After the PR" row:

```tsx
              <dt>Messaging</dt>
              <dd>{p.messaging.platform === "none" ? "off" : `${p.messaging.platform === "setmore" ? "Setmore collab" : "agent"} → ${p.messaging.channelName || p.messaging.channelId || "no channel"}`}</dd>
```

- [ ] **Step 3: Dashboard selection, send dialog, message pills**

In `src/views/Dashboard.tsx`:

State in `Dashboard()`:

```tsx
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [compose, setCompose] = useState<{ keys: string[]; text: string; sending?: boolean; result?: string }>();
  const togglePick = (key: string) => setPicked((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const openCompose = (keys: string[]) => {
    const tickets = keys.map((k) => state.tickets[k]).filter(Boolean);
    const p = projects[tickets[0]?.projectId];
    const vars = (t: Ticket) => ({ key: t.key, summary: t.summary, pr_url: t.prUrl || "", pr_number: String(t.pr?.number ?? ""), project: projects[t.projectId]?.name || "", branch: t.branch, approved_ago: "" });
    const fillT = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k] : m));
    const text =
      keys.length === 1
        ? fillT(p?.messaging.templates.manual || "{key}: {pr_url}", vars(tickets[0]))
        : fillT(p?.messaging.templates.bulk || "{list}", { ...vars(tickets[0]), list: tickets.map((t) => `- ${t.key} — ${t.summary}: ${t.prUrl || "(no PR yet)"}`).join("\n") });
    setCompose({ keys, text });
  };
  const sendCompose = async () => {
    if (!compose) return;
    setCompose({ ...compose, sending: true });
    try {
      if (compose.keys.length === 1) await api.sendMessage(compose.keys[0], compose.text);
      else {
        const r = await api.sendBulk(compose.keys, compose.text);
        if (r.failed.length) throw new Error(r.failed.map((f) => `${f.key}: ${f.error}`).join("; "));
      }
      setCompose(undefined);
      setPicked(new Set());
      setNotice(undefined);
    } catch (e) {
      setCompose({ ...compose, sending: false, result: String((e as Error).message || e) });
    }
  };
```

(`{approved_ago}` is left empty in the dialog preview; the engine fills it for automatic sends. The dialog sends the text verbatim.)

Table changes in *Pull requests* and *Approved, not merged*: add a first `<th />` column with a checkbox per row `<td onClick={stop}><input type="checkbox" checked={picked.has(t.key)} onChange={() => togglePick(t.key)} /></td>`; add a per-row `<button className="btn sm ghost" onClick={() => openCompose([t.key])} title="Send to collab">💬</button>` in the actions cell; after the status badge show the last message pill:

```tsx
{t.messages?.length ? <span className={`pill ${t.messages[t.messages.length - 1].ok ? "ok" : "bad"}`} title={t.messages[t.messages.length - 1].error || t.messages[t.messages.length - 1].text}>💬 {t.messages[t.messages.length - 1].ok ? "sent" : "failed"}</span> : null}
```

Selection bar, rendered above the sections when `picked.size > 0`:

```tsx
      {picked.size > 0 && (
        <div className="callout info" style={{ marginBottom: 12 }}>
          <span className="t">{picked.size} selected</span>
          <div className="spacer" />
          <button className="btn sm primary" onClick={() => openCompose([...picked])}>Send to collab</button>
          <button className="btn sm ghost" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
```

Compose dialog (rendered at the end of the page `div`):

```tsx
      {compose && (
        <div className="modal-backdrop" onClick={() => !compose.sending && setCompose(undefined)}>
          <div className="modal card card-pad" onClick={stop}>
            <h3 className="card-title">Send to collab</h3>
            <p className="card-sub">{compose.keys.join(", ")} → {projects[state.tickets[compose.keys[0]]?.projectId]?.messaging.channelName || "the project's channel"}</p>
            <textarea className="textarea" rows={6} value={compose.text} onChange={(e) => setCompose({ ...compose, text: e.target.value })} />
            {compose.result && <div className="callout err"><span className="t">{compose.result}</span></div>}
            <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setCompose(undefined)} disabled={compose.sending}>Cancel</button>
              <button className="btn primary" onClick={sendCompose} disabled={compose.sending || !compose.text.trim()}>{compose.sending ? "Sending…" : "Send"}</button>
            </div>
          </div>
        </div>
      )}
```

`TicketDetail`: add a **Send to collab** button (`onClick={() => onCompose([ticket.key])}`; pass `onCompose` as a new prop from `Dashboard`) next to Open PR when `ticket.prUrl`, and a "Messages" section after the attempts timeline:

```tsx
        {ticket.messages && ticket.messages.length > 0 && (
          <div>
            <div className="section-label">Messages</div>
            <div className="timeline">
              {[...ticket.messages].reverse().map((m, i) => (
                <div key={i} className="tl-item">
                  <span className="tl-icon" style={{ background: m.ok ? "var(--accent-soft)" : "var(--red-soft)", color: m.ok ? "var(--accent)" : "var(--red)" }}>💬</span>
                  <div>
                    <div style={{ fontWeight: 550 }}>{m.kind.replace("_", " ")} → {m.channelName || m.channelId}</div>
                    <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{m.ok ? m.text : m.error}</div>
                  </div>
                  <span className="small faint">{ago(m.at)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
```

CSS (`src/styles.css`):

```css
.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: center; justify-content: center; z-index: 50; }
.modal { width: min(640px, 92vw); max-height: 85vh; overflow: auto; }
```

`src/App.tsx`: no change needed (the `account` event is consumed in Settings via its own subscription).

- [ ] **Step 4: Typecheck, build, eyeball**

Run: `npm run typecheck` → exit 0. `npm run build` → `✓ built`.
Run: `npm run dev`: Settings shows the Accounts card (demo: logged in); Projects → edit → step 5 "Messaging" shows platform/channel/templates and Load channels lists two demo channels; Dashboard: tick two PR rows → "2 selected · Send to collab" → dialog with the bulk text → Send closes it and a 💬 pill appears on the rows.

- [ ] **Step 5: Commit**

```bash
git add src/views/Settings.tsx src/views/Projects.tsx src/views/Dashboard.tsx src/styles.css
git commit -m "UI: Setmore account login, project Messaging step, dashboard send and bulk send"
```

---

### Task 7: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document**

Under "Using it" add step 7:

```
7. **Messaging.** Settings → *Accounts*: paste the Setmore `client_id` from the auth team and press **Log in** (browser sign-in, tokens stay on this Mac). In each project's *Messaging* step pick the platform (Setmore collab, or an agent run with your own MCP connectors), load and pick the channel, and edit the four templates. HandsFree then posts "please review" when CI passes on a published PR and "waiting to be merged" when an approved PR sits past the project's delay — once each. **Send to collab** on a PR (or a selection of PRs) sends the prefilled, editable text.
```

In the diagram append:

```
   CI passes  ─▶ "ready for review" ─▶ collab message (once)
   approved   ─▶ "waiting to be merged" nudge ─▶ collab message (once)
```

Under "Where things live" add: `- Setmore login: ~/Library/Application Support/HandsFree/auth/setmore.json (mode 600)`.

Under "One-time setup" add a line: `Setmore collab messages need an OAuth client id for HandsFree (public client, PKCE, redirect http://127.0.0.1:47831/oauth/callback) — ask the auth team.`

- [ ] **Step 2: Verify and commit**

Run: `npm run typecheck && npm run test:engine` → pass.

```bash
git add README.md
git commit -m "README: messaging setup and behaviour"
```

---

## Self-review notes

- Spec coverage: §3 types → Task 1; §4.1 templates → Task 1; §4.2 oauth → Task 2; §4.3 client → Task 3; §4.4 adapters → Task 4; §4.5 service (events, manual, bulk, test, channels, login/logout) → Task 5; §4.6 routes/api → Task 5; §4.7 UI → Task 6; §5 edge cases: not-logged-in (Task 5 e2e), channel not set / empty template (Task 5 unit), agent failure shapes (Task 4 unit), single pending login + busy port + wrong state (Task 5 e2e), refresh on 401 / invalid_grant (Task 4 unit, Task 5 e2e), `resource` retry (Task 2 implementation; the fake accepts `resource`, so the retry path is exercised only by code review — noted as a Review Focus item below); §6 tests as listed; §7 migration → Task 1.
- Review Focus 1 → Task 4 odd-shapes test. 2 → Task 4 concurrent-refresh test. 3 → Task 5 e2e wrong-state step. 4 → Task 5 e2e busy-port step. 5 → Task 5 service unit test.
- Type consistency: `MessageRecord.kind` uses `MessageKind`; `AccountStatus.loginPending` set only by the service; `adapterFor(p, settings, deps)` signature identical in `index.ts`, the service seam and the unit test; `Api.sendMessage` returns `MessageRecord` (the route returns the record on success, `{error}` on failure, which `action()` turns into a thrown Error).
- Known untested path: the RFC 8707 `resource` rejection retry in `tokenRequest` (no server in the fakes rejects it). Flagged for the final reviewer.
