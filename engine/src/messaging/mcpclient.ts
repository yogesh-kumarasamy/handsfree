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

  /** The server's tools with their input schemas (first page; enough for the servers HandsFree talks to). */
  async listTools(): Promise<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }[]> {
    await this.initialize();
    const result = (await this.rpc("tools/list", {})) as { tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] } | undefined;
    return result?.tools || [];
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
    const r = await f(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, params }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });
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
      const data = event
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
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
  return (r?.content || [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text as string)
    .join("\n");
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
