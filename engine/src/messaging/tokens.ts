// Access-token upkeep for an MCP account (Setmore): load, refresh early, one refresh at a time, report status.
import type { AccountStatus } from "../types";
import { AuthError } from "./mcpclient";
import { discover, OAuthError, refreshTokens, tokensFromResponse, type AuthMeta, type TokenStore } from "./oauth";

export interface TokenKeeperSettings {
  /** "Setmore" — used in user-facing errors. */
  label: string;
  issuer: string;
  /** RFC 8707 resource (the MCP server URL). */
  mcpUrl: string;
  /** The OAuth client the tokens belong to; read on every refresh (a registered client may change on re-login). */
  client: () => { clientId: string; clientSecret?: string } | undefined;
}

export class TokenKeeper {
  private refreshing?: Promise<void>;
  private metaPromise?: Promise<AuthMeta>;

  constructor(
    private settings: TokenKeeperSettings,
    private tokens: TokenStore,
    private onStatus: (s: AccountStatus) => void,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  status(error?: string): AccountStatus {
    const t = this.tokens.load();
    if (!t) return { loggedIn: false, error };
    return { loggedIn: true, user: t.idClaims?.email || t.idClaims?.name, scope: t.scope, expiresAt: t.expiresAt, error };
  }

  private get expired() {
    return `${this.settings.label} session expired — log in again.`;
  }

  private meta() {
    this.metaPromise ||= discover(this.settings.issuer, this.fetchImpl).catch((e) => {
      this.metaPromise = undefined;
      throw e;
    });
    return this.metaPromise;
  }

  async getToken() {
    const t = this.tokens.load();
    if (!t) throw new AuthError(`Not logged in to ${this.settings.label}. Settings → Accounts → Log in.`);
    if (Date.parse(t.expiresAt) - 60_000 < Date.now()) await this.refresh();
    const fresh = this.tokens.load();
    if (!fresh) throw new AuthError(this.expired);
    return fresh.accessToken;
  }

  /** One refresh at a time; concurrent callers share it. */
  refresh(): Promise<void> {
    this.refreshing ||= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh() {
    const t = this.tokens.load();
    const client = this.settings.client();
    if (!t?.refreshToken || !client) {
      this.tokens.clear();
      this.onStatus(this.status(this.expired));
      throw new AuthError(this.expired);
    }
    try {
      const r = await refreshTokens(
        await this.meta(),
        { clientId: client.clientId, clientSecret: client.clientSecret, refreshToken: t.refreshToken, resource: this.settings.mcpUrl },
        this.fetchImpl,
      );
      this.tokens.save(tokensFromResponse(r, Date.now(), t));
      this.onStatus(this.status());
    } catch (e) {
      if (e instanceof OAuthError && e.code === "invalid_grant") {
        // Another refresh (a re-login, or an adapter rebuilt by settingsChanged) may have rotated the token
        // meanwhile: then ours was simply consumed, and the newer tokens on disk are the good ones.
        const current = this.tokens.load();
        if (current && current.refreshToken !== t.refreshToken) {
          this.onStatus(this.status());
          return;
        }
        this.tokens.clear();
        this.onStatus(this.status(this.expired));
        throw new AuthError(this.expired);
      }
      this.onStatus(this.status(`Token refresh failed: ${(e as Error).message}`));
      throw e;
    }
  }
}
