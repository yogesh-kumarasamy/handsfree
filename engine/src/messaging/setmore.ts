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
