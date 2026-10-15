// Direct Setmore adapter: the user's own OAuth login + the Setmore MCP server. No agent in the loop.
import type { AccountStatus, SetmoreAccountSettings } from "../types";
import type { MessagingAdapter } from "./adapter";
import { McpClient, McpError, toolJson, toolText } from "./mcpclient";
import type { TokenStore } from "./oauth";
import { TokenKeeper } from "./tokens";

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

/** True when `key: true` appears anywhere in a JSON value. */
export function findFlag(v: unknown, key: string): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o[key] === true) return true;
  return Object.values(o).some((val) => findFlag(val, key));
}

export class SetmoreAdapter implements MessagingAdapter {
  readonly platform = "setmore" as const;
  private client: McpClient;
  private keeper: TokenKeeper;

  constructor(
    settings: SetmoreAccountSettings,
    tokens: TokenStore,
    onStatus: (s: AccountStatus) => void,
    fetchImpl: typeof fetch = fetch,
  ) {
    // Setmore is a public client registered by the auth team: no secret.
    this.keeper = new TokenKeeper({ label: "Setmore", issuer: settings.issuer, mcpUrl: settings.mcpUrl, client: () => ({ clientId: settings.clientId }) }, tokens, onStatus, fetchImpl);
    this.client = new McpClient(settings.mcpUrl, () => this.keeper.getToken(), { onUnauthorized: () => this.keeper.refresh(), fetchImpl });
  }

  status(error?: string): AccountStatus {
    return this.keeper.status(error);
  }

  /** One refresh at a time; concurrent callers share it. */
  refresh(): Promise<void> {
    return this.keeper.refresh();
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
    if (findFlag(j1, "sent") || findKey(j1, ["status"]) === "sent") return { id: findKey(j1, ["messageId", "id"]) };
    const token = findKey(j1, ["confirmationToken"]) ?? /confirmationToken["']?\s*[:=]\s*["']?([^\s"',}]+)/.exec(toolText(first))?.[1];
    if (!token) throw new McpError(`send_message returned no confirmationToken: ${toolText(first).slice(0, 200) || "(empty response)"}`);
    const second = await this.client.callTool("send_message", { ...args, confirmationToken: token });
    const j2 = toolJson(second);
    return { id: findKey(j2, ["messageId", "id"]) };
  }
}
