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
  let base = "";
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
  base = `http://127.0.0.1:${server.address().port}`;
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
