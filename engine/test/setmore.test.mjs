import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { startFakeMcp } from "./fakes/mcp-server.mjs";
import { startFakeAuth } from "./fakes/auth-server.mjs";
import { buildAuthorizeUrl, discover, exchangeCode, pkce, TokenStore, tokensFromResponse } from "../dist/test/messaging/oauth.js";
import { findKey, SetmoreAdapter } from "../dist/test/messaging/setmore.js";

const settings = (auth, mcp) => ({ clientId: "cid", redirectPort: 1, mcpUrl: mcp.url, issuer: auth.issuer, scopes: "openid" });
const store = () => new TokenStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hf-sm-")), "setmore.json"));
const future = new Date(Date.now() + 3600_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

/** A real login against the fake auth server, so the refresh token is one the server knows. */
async function seedTokens(auth) {
  const m = await discover(auth.issuer);
  const { verifier, challenge } = pkce();
  const redirectUri = "http://127.0.0.1:1/cb";
  const loc = (await fetch(buildAuthorizeUrl(m, { clientId: "cid", redirectUri, scope: "openid", state: "s", challenge }), { redirect: "manual" })).headers.get("location");
  const code = new URL(loc).searchParams.get("code");
  return tokensFromResponse(await exchangeCode(m, { clientId: "cid", code, redirectUri, verifier }));
}

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
    tokens.save({ ...(await seedTokens(auth)), expiresAt: past });
    const statuses = [];
    const a = new SetmoreAdapter(settings(auth, mcp), tokens, (s) => statuses.push(s));
    const [r1, r2] = await Promise.all([a.send("ch-core", "one", "k1"), a.send("ch-core", "two", "k2")]);
    assert.ok(r1.id && r2.id);
    assert.equal(auth.tokenCalls.filter((c) => c.grant_type === "refresh_token").length, 1, "one refresh for two concurrent sends");
    assert.equal(mcp.received.length, 2);
    assert.equal(statuses[statuses.length - 1].loggedIn, true);
  } finally {
    await auth.close();
    await mcp.close();
  }
});

test("SetmoreAdapter: 401 mid-session refreshes and retries; invalid_grant clears tokens and reports", async () => {
  const validTokens = new Set();
  const [auth, mcp] = [await startFakeAuth({ validTokens }), await startFakeMcp({ validTokens })];
  try {
    const tokens = store();
    tokens.save(await seedTokens(auth));
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
    const ok = (result) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    };
    if (rpc.method === "initialize") return ok({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "0" } });
    if (rpc.method === "notifications/initialized") {
      res.writeHead(202);
      return res.end();
    }
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

test("SetmoreAdapter: a dotted/base64 confirmationToken in prose is captured whole; nested sent:true counts as sent", async () => {
  const shapes = [
    { content: [{ type: "text", text: "Preview ready. confirmationToken: eyJhbGc.eyJzdWIi.sig+/= — call again." }] },
    { content: [{ type: "text", text: JSON.stringify({ result: { sent: true, messageId: "m-9" } }) }] },
  ];
  let shape = 0;
  const sends = [];
  const srv = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const rpc = JSON.parse(body);
    const ok = (result) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    };
    if (rpc.method === "initialize") return ok({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "0" } });
    if (rpc.method === "notifications/initialized") {
      res.writeHead(202);
      return res.end();
    }
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
    assert.equal(sends[sends.length - 1].confirmationToken, "eyJhbGc.eyJzdWIi.sig+/=");
    shape = 1;
    const before = sends.length;
    assert.equal((await a.send("c", "x", "k")).id, "m-9");
    assert.equal(sends.length, before + 1, "nested sent:true needs no second call");
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test("SetmoreAdapter: a refresh that loses the race (rotated token → invalid_grant) does not clear the newer tokens", async () => {
  const validTokens = new Set();
  const [auth, mcp] = [await startFakeAuth({ validTokens }), await startFakeMcp({ validTokens })];
  try {
    const tokens = store();
    tokens.save({ ...(await seedTokens(auth)), expiresAt: past });
    const statuses = [];
    // Two adapters on one token file (what settingsChanged() or a re-login produces mid-refresh).
    const a = new SetmoreAdapter(settings(auth, mcp), tokens, (s) => statuses.push(s));
    const b = new SetmoreAdapter(settings(auth, mcp), tokens, (s) => statuses.push(s));
    const [ra, rb] = await Promise.all([a.refresh().then(() => "ok", (e) => e), b.refresh().then(() => "ok", (e) => e)]);
    assert.ok(ra === "ok" || rb === "ok", "one refresh wins");
    assert.ok(tokens.load(), "the winner's tokens survive the loser's invalid_grant");
    assert.equal(statuses[statuses.length - 1].loggedIn, true);
    assert.notEqual((await a.send("ch-core", "after race", "k")).id, undefined);
  } finally {
    await auth.close();
    await mcp.close();
  }
});
