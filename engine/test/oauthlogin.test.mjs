import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startFakeAuth } from "./fakes/auth-server.mjs";
import { ClientStore, discover, registerClient, TokenStore } from "../dist/test/messaging/oauth.js";
import { LoopbackLogin } from "../dist/test/oauthlogin.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hf-login-"));
const port = () => 49900 + Math.floor(Math.random() * 90);

function makeLogin(auth, o = {}) {
  const dir = tmp();
  const tokens = new TokenStore(path.join(dir, "t.json"));
  const client = new ClientStore(path.join(dir, "c.json"));
  const statuses = [];
  const p = o.port || port();
  const login = new LoopbackLogin({
    name: "linear",
    issuer: () => auth.issuer,
    resource: () => "http://127.0.0.1:1/mcp",
    scopes: () => "read write",
    redirectPort: () => p,
    clientId: async () => {
      const redirectUri = `http://127.0.0.1:${p}/oauth/callback`;
      const cur = client.load();
      if (cur && cur.redirectUri === redirectUri) return { clientId: cur.clientId, clientSecret: cur.clientSecret };
      const r = await registerClient(await discover(auth.issuer), { redirectUri, clientName: "HandsFree" });
      client.save({ clientId: r.client_id, clientSecret: r.client_secret, redirectUri, registeredAt: new Date().toISOString() });
      return { clientId: r.client_id, clientSecret: r.client_secret };
    },
    tokens,
    onStatus: (s) => statuses.push(s),
    status: (error) => (tokens.load() ? { loggedIn: true, error } : { loggedIn: false, error }),
    fetchImpl: o.fetchImpl,
  });
  return { login, tokens, client, statuses, port: p };
}

test("registerClient: posts the metadata and returns a client id", async () => {
  const auth = await startFakeAuth();
  try {
    const r = await registerClient(await discover(auth.issuer), { redirectUri: "http://127.0.0.1:1/cb", clientName: "HandsFree" });
    assert.match(r.client_id, /^dyn-/);
    assert.equal(auth.registrations[0].token_endpoint_auth_method, "none");
    assert.deepEqual(auth.registrations[0].redirect_uris, ["http://127.0.0.1:1/cb"]);
  } finally {
    await auth.close();
  }
});

test("LoopbackLogin: registers once, logs in, reuses the client, re-registers when the port changes", async () => {
  const auth = await startFakeAuth({ requireRegistered: true });
  try {
    const a = makeLogin(auth);
    const url = await a.login.loginUrl();
    const cb = (await fetch(url, { redirect: "manual" })).headers.get("location");
    assert.equal((await fetch(cb)).status, 200);
    assert.equal(a.statuses.at(-1).loggedIn, true);
    assert.equal(auth.registrations.length, 1);
    // same port again → no new registration
    await a.login.logout();
    const url2 = await a.login.loginUrl();
    await fetch((await fetch(url2, { redirect: "manual" })).headers.get("location"));
    assert.equal(auth.registrations.length, 1);
    // new port → stored client's redirect URI no longer matches → re-register
    const b = makeLogin(auth);
    b.client.save({ ...a.client.load(), redirectUri: "http://127.0.0.1:1/oauth/callback" });
    await b.login.loginUrl().then((u) => fetch(u, { redirect: "manual" })).then((r) => fetch(r.headers.get("location")));
    assert.equal(auth.registrations.length, 2);
    assert.equal(b.statuses.at(-1).loggedIn, true);
  } finally {
    await auth.close();
  }
});

test("LoopbackLogin: wrong state rejected, duplicate callback not exchanged twice, busy port reported", async () => {
  const auth = await startFakeAuth();
  try {
    // Slow the token endpoint so the two callbacks overlap deterministically.
    const slowFetch = async (url, init) => {
      if (String(url).includes("/token")) await new Promise((r) => setTimeout(r, 300));
      return fetch(url, init);
    };
    const a = makeLogin(auth, { fetchImpl: slowFetch });
    const url = await a.login.loginUrl();
    assert.equal(await a.login.loginUrl(), url, "second click returns the same URL");
    const cb = (await fetch(url, { redirect: "manual" })).headers.get("location");
    assert.equal((await fetch(cb.replace(/state=[^&]*/, "state=forged"))).status, 400);
    assert.equal(a.login.pending, true);
    const [r1, r2] = await Promise.all([fetch(cb), fetch(cb)]);
    assert.deepEqual([r1.status, r2.status], [200, 200]);
    assert.equal(auth.tokenCalls.filter((c) => c.grant_type === "authorization_code").length, 1);
    assert.equal(a.login.pending, false);
    assert.equal(a.statuses.at(-1).loggedIn, true);
    assert.equal(a.statuses.at(-1).error, undefined);
    const blocker = http.createServer(() => {});
    await new Promise((r) => blocker.listen(a.port, "127.0.0.1", r));
    await a.login.logout();
    await assert.rejects(a.login.loginUrl(), new RegExp(`Port ${a.port} is in use`));
    await new Promise((r) => blocker.close(r));
  } finally {
    await auth.close();
  }
});

test("LoopbackLogin: text from the server is HTML-escaped on the callback page", async () => {
  const auth = await startFakeAuth();
  try {
    const a = makeLogin(auth);
    const url = await a.login.loginUrl();
    const cb = (await fetch(url, { redirect: "manual" })).headers.get("location");
    const u = new URL(cb);
    u.searchParams.delete("code");
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "<script>x</script>");
    const r = await fetch(u);
    assert.equal(r.status, 400);
    const html = await r.text();
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    assert.equal(a.login.pending, false);
  } finally {
    await auth.close();
  }
});
