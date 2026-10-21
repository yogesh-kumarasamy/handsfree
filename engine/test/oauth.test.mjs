import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeAuth } from "./fakes/auth-server.mjs";
import { buildAuthorizeUrl, decodeIdClaims, discover, exchangeCode, OAuthError, pkce, refreshTokens, TokenStore, tokensFromResponse } from "../dist/test/messaging/oauth.js";

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("pkce: S256 challenge of the verifier, base64url, no padding", () => {
  const { verifier, challenge } = pkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, b64url(crypto.createHash("sha256").update(verifier).digest()));
  // RFC 7636 appendix B vector, to pin the encoding
  assert.equal(b64url(crypto.createHash("sha256").update("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk").digest()), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("discover: openid-configuration first, error when nothing is served", async () => {
  const auth = await startFakeAuth();
  try {
    const m = await discover(auth.issuer);
    assert.equal(m.tokenEndpoint, `${auth.issuer}/oauth2/v2/token`);
    assert.equal(m.authorizationEndpoint, `${auth.issuer}/oauth2/auth`);
    await assert.rejects(discover(`${auth.url}/nothing`), /discover/);
  } finally {
    await auth.close();
  }
});

test("buildAuthorizeUrl: PKCE S256, state, scope, resource", () => {
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
  const store = new TokenStore(path.join(dir, "auth", "linear.json"));
  assert.equal(store.load(), undefined);
  store.save({ accessToken: "a", refreshToken: "r", expiresAt: "2026-10-15T11:00:00.000Z" });
  assert.equal((fs.statSync(path.join(dir, "auth", "linear.json")).mode & 0o777).toString(8), "600");
  assert.equal(store.load().refreshToken, "r");
  store.clear();
  assert.equal(store.load(), undefined);
});
