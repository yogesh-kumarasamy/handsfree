// Loopback OAuth login (PKCE, 127.0.0.1 redirect) used by the accounts HandsFree signs in to (Setmore).
import http from "node:http";
import { buildAuthorizeUrl, discover, exchangeCode, pkce, randomState, revokeToken, tokensFromResponse, type AuthMeta, type TokenStore } from "./messaging/oauth";
import type { AccountStatus } from "./types";

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TITLES: Record<LoopbackLoginOptions["name"], string> = { setmore: "Setmore" };

export interface LoopbackLoginOptions {
  name: "setmore";
  issuer: () => string;
  /** RFC 8707 resource indicator (the MCP server URL). */
  resource: () => string;
  scopes: () => string;
  redirectPort: () => number;
  /** The OAuth client to use. May register one (dynamic registration); throws with a user-facing message when there is none. */
  clientId: () => Promise<{ clientId: string; clientSecret?: string }>;
  tokens: TokenStore;
  onStatus: (s: AccountStatus) => void;
  status: (error?: string) => AccountStatus;
  fetchImpl?: typeof fetch;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface Pending {
  url: string;
  server: http.Server;
  state: string;
  verifier: string;
  redirectUri: string;
  client: { clientId: string; clientSecret?: string };
  timer: NodeJS.Timeout;
  exchanging?: boolean;
}

export class LoopbackLogin {
  private current?: Pending;
  /** A login being set up (client, discovery, listen): a second click joins it instead of starting another. */
  private starting?: Promise<string>;
  /** State of the login that just succeeded: a late duplicate callback for it is answered kindly, not as an error. */
  private completedState?: string;

  constructor(private o: LoopbackLoginOptions) {}

  get pending() {
    return !!this.current;
  }

  private get title() {
    return TITLES[this.o.name];
  }

  /** Start a login (or return the one in progress): listens on the loopback port and returns the authorize URL. */
  loginUrl(): Promise<string> {
    if (this.current) return Promise.resolve(this.current.url);
    this.starting ||= this.startLogin().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async startLogin(): Promise<string> {
    const client = await this.o.clientId();
    const meta = await discover(this.o.issuer(), this.o.fetchImpl);
    const { verifier, challenge } = pkce();
    const state = randomState();
    const port = this.o.redirectPort();
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const url = buildAuthorizeUrl(meta, { clientId: client.clientId, redirectUri, scope: this.o.scopes(), state, challenge, resource: this.o.resource() });
    const server = http.createServer((req, res) => void this.onCallback(req, res, meta));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    }).catch((e: NodeJS.ErrnoException) => {
      throw new Error(e.code === "EADDRINUSE" ? `Port ${port} is in use — close the app using it, or choose another redirect port.` : e.message);
    });
    const timer = setTimeout(() => this.finish("Login timed out after 5 minutes."), LOGIN_TIMEOUT_MS);
    this.current = { url, server, state, verifier, redirectUri, client, timer };
    this.completedState = undefined;
    this.o.onStatus(this.o.status());
    return url;
  }

  private async onCallback(req: http.IncomingMessage, res: http.ServerResponse, meta: AuthMeta) {
    const page = (code: number, title: string, body: string) => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:-apple-system,sans-serif;padding:40px"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></body>`,
      );
    };
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") return page(404, "Not found", "HandsFree is waiting for the sign-in callback.");
    const p = this.current;
    const state = url.searchParams.get("state");
    if (!p) {
      if (state && state === this.completedState) return page(200, `Signed in to ${this.title}`, "You can close this tab and go back to HandsFree.");
      return page(400, "No sign-in in progress", "Start the login from HandsFree → Settings → Accounts.");
    }
    if (state !== p.state) return page(400, "Sign-in rejected", "The state parameter didn't match. Start the login again from HandsFree.");
    const err = url.searchParams.get("error");
    if (err) {
      page(400, "Sign-in failed", `${err}: ${url.searchParams.get("error_description") || ""}`);
      return this.finish(`Sign-in failed: ${err}`);
    }
    const code = url.searchParams.get("code");
    if (!code) return page(400, "Sign-in rejected", "No code in the callback.");
    // The browser may retry or prefetch the callback: the code is one-time, so only the first request exchanges it.
    if (p.exchanging) return page(200, `Signed in to ${this.title}`, "This sign-in is already being completed. You can close this tab.");
    p.exchanging = true;
    try {
      const r = await exchangeCode(
        meta,
        { clientId: p.client.clientId, clientSecret: p.client.clientSecret, code, redirectUri: p.redirectUri, verifier: p.verifier, resource: this.o.resource() },
        this.o.fetchImpl,
      );
      this.o.tokens.save(tokensFromResponse(r));
      this.completedState = p.state;
      this.finish();
      page(200, `Signed in to ${this.title}`, "You can close this tab and go back to HandsFree.");
    } catch (e) {
      this.finish(`Sign-in failed: ${(e as Error).message}`);
      page(500, "Sign-in failed", String((e as Error).message || e));
    }
  }

  private finish(error?: string) {
    const p = this.current;
    if (!p) return;
    clearTimeout(p.timer);
    p.server.close();
    this.current = undefined;
    this.o.onStatus(this.o.status(error));
  }

  /** Revoke the refresh token (best effort), forget the tokens and cancel a login in progress. */
  async logout() {
    const t = this.o.tokens.load();
    if (t?.refreshToken) {
      await Promise.all([discover(this.o.issuer(), this.o.fetchImpl), this.o.clientId()])
        .then(([meta, client]) => revokeToken(meta, { clientId: client.clientId, token: t.refreshToken! }, this.o.fetchImpl))
        .catch(() => undefined);
    }
    this.o.tokens.clear();
    this.finish();
    this.o.onStatus(this.o.status());
  }

  shutdown() {
    this.finish();
  }
}
