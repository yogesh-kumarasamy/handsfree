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
  /** RFC 7591 dynamic client registration endpoint, when the server offers one. */
  registrationEndpoint?: string;
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
        return {
          authorizationEndpoint: j.authorization_endpoint,
          tokenEndpoint: j.token_endpoint,
          revocationEndpoint: j.revocation_endpoint,
          registrationEndpoint: j.registration_endpoint,
        };
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

/** `clientSecret` is sent (client_secret_post) only when the client has one, e.g. from a registration. */
export function exchangeCode(
  meta: AuthMeta,
  o: { clientId: string; clientSecret?: string; code: string; redirectUri: string; verifier: string; resource?: string },
  f: Fetch = fetch,
) {
  return tokenRequest(
    meta,
    { grant_type: "authorization_code", client_id: o.clientId, client_secret: o.clientSecret || undefined, code: o.code, redirect_uri: o.redirectUri, code_verifier: o.verifier, resource: o.resource },
    f,
  );
}

export function refreshTokens(meta: AuthMeta, o: { clientId: string; clientSecret?: string; refreshToken: string; resource?: string }, f: Fetch = fetch) {
  return tokenRequest(meta, { grant_type: "refresh_token", client_id: o.clientId, client_secret: o.clientSecret || undefined, refresh_token: o.refreshToken, resource: o.resource }, f);
}

export interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
}

/** RFC 7591 dynamic client registration for a native public client with a loopback redirect. */
export async function registerClient(meta: AuthMeta, o: { redirectUri: string; clientName: string }, f: Fetch = fetch): Promise<RegisteredClient> {
  if (!meta.registrationEndpoint) throw new OAuthError("registration_failed", "the server offers no registration_endpoint");
  const r = await f(meta.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: o.clientName,
      redirect_uris: [o.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new OAuthError("registration_failed", `HTTP ${r.status}: ${text.slice(0, 300)}`);
  let j: Partial<RegisteredClient> = {};
  try {
    j = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!j.client_id) throw new OAuthError("registration_failed", `no client_id in the response: ${text.slice(0, 300)}`);
  return { client_id: j.client_id, client_secret: j.client_secret || undefined, redirect_uris: j.redirect_uris || [o.redirectUri] };
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

/** A JSON secret on disk, mode 0600, written atomically. */
class SecretFile<T> {
  constructor(private file: string) {}
  load(): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as T;
    } catch {
      return undefined;
    }
  }
  save(t: T) {
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

/** Tokens on disk, mode 0600, written atomically. */
export class TokenStore extends SecretFile<StoredTokens> {}

export interface StoredClient {
  clientId: string;
  clientSecret?: string;
  /** The redirect URI the client was registered with; a different port means registering again. */
  redirectUri: string;
  registeredAt: string;
}

/** A dynamically registered OAuth client on disk, mode 0600. */
export class ClientStore extends SecretFile<StoredClient> {}
