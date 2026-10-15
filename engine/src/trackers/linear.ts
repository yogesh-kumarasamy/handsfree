// Linear through its hosted MCP server, signed in with the user's own OAuth login (dynamic client registration).
// Tool argument names are read from tools/list, so small schema differences don't break HandsFree.
import { McpClient, McpError, toolJson } from "../messaging/mcpclient";
import type { ClientStore, TokenStore } from "../messaging/oauth";
import { TokenKeeper } from "../messaging/tokens";
import { TRACKER_NOUN, type AccountStatus, type FoundIssue, type LinearAccountSettings } from "../types";
import type { TicketRef, TrackerAdapter, TrackerProject } from "./adapter";

type Schema = { properties?: Record<string, unknown> } | undefined;

/** One per process: the token keeper, the MCP session and the cached tool list are shared by every Linear project. */
export class LinearConnection {
  readonly keeper: TokenKeeper;
  readonly mcp: McpClient;
  private toolsPromise?: Promise<Map<string, Schema>>;
  private warned = new Set<string>();

  constructor(settings: LinearAccountSettings, tokens: TokenStore, client: ClientStore, onStatus: (s: AccountStatus) => void, fetchImpl: typeof fetch = fetch) {
    this.keeper = new TokenKeeper(
      {
        label: "Linear",
        issuer: settings.issuer,
        mcpUrl: settings.mcpUrl,
        client: () => {
          const c = client.load();
          return c && { clientId: c.clientId, clientSecret: c.clientSecret };
        },
      },
      tokens,
      onStatus,
      fetchImpl,
    );
    this.mcp = new McpClient(settings.mcpUrl, () => this.keeper.getToken(), { onUnauthorized: () => this.keeper.refresh(), fetchImpl });
  }

  /** name → input schema, fetched once. */
  tools(): Promise<Map<string, Schema>> {
    this.toolsPromise ||= this.mcp
      .listTools()
      .then((list) => new Map(list.map((t) => [t.name, t.inputSchema] as [string, Schema])))
      .catch((e) => {
        this.toolsPromise = undefined;
        throw e;
      });
    return this.toolsPromise;
  }

  /** Logs a missing tool once per process. */
  warnOnce(tool: string) {
    if (this.warned.has(tool)) return;
    this.warned.add(tool);
    console.warn(`[handsfree] The Linear MCP server has no ${tool} tool; that step is skipped.`);
  }
}

/** The first of `names` the schema declares; without a schema, the first name (our best guess). */
function argName(schema: Schema, names: string[]): string | undefined {
  const props = schema?.properties;
  if (!props) return names[0];
  return names.find((n) => n in props);
}

function has(schema: Schema, name: string) {
  return !schema?.properties || name in schema.properties;
}

function toIssues(j: any): FoundIssue[] {
  const list: any[] = Array.isArray(j)
    ? j
    : Array.isArray(j?.issues)
      ? j.issues
      : Array.isArray(j?.nodes)
        ? j.nodes
        : Array.isArray(j?.data)
          ? j.data
          : Array.isArray(j?.data?.issues)
            ? j.data.issues
            : Array.isArray(j?.issues?.nodes)
              ? j.issues.nodes
              : [];
  const out: FoundIssue[] = [];
  for (const i of list) {
    if (!i || typeof i.identifier !== "string") continue;
    const issue: FoundIssue = { key: i.identifier, summary: String(i.title ?? "") };
    if (typeof i.description === "string" && i.description.trim()) issue.description = i.description;
    issue.id = typeof i.id === "string" || typeof i.id === "number" ? String(i.id) : i.identifier;
    if (typeof i.url === "string") issue.url = i.url;
    out.push(issue);
  }
  return out;
}

export class LinearTracker implements TrackerAdapter {
  readonly kind = "linear" as const;
  readonly noun = TRACKER_NOUN.linear;
  private conn: LinearConnection;

  constructor(
    private p: TrackerProject,
    settings: LinearAccountSettings,
    tokens: TokenStore,
    client: ClientStore,
    onStatus: (s: AccountStatus) => void,
    fetchImpl?: typeof fetch,
    conn?: LinearConnection,
  ) {
    this.conn = conn || new LinearConnection(settings, tokens, client, onStatus, fetchImpl);
  }

  async search(): Promise<FoundIssue[]> {
    const tools = await this.conn.tools();
    const t = this.p.tracker;
    const query = t.query.trim();
    if (tools.has("list_issues")) {
      const s = tools.get("list_issues");
      const args: Record<string, unknown> = {};
      if (t.linearAssignee.trim() && has(s, "assignee")) args.assignee = t.linearAssignee.trim();
      if (query && has(s, "query")) args.query = query;
      if (has(s, "limit")) args.limit = 50;
      const found = toIssues(toolJson(await this.conn.mcp.callTool("list_issues", args)));
      return query && !("query" in args) ? filterText(found, query) : found;
    }
    if (tools.has("list_my_issues")) {
      const args: Record<string, unknown> = has(tools.get("list_my_issues"), "limit") ? { limit: 50 } : {};
      // This tool takes no text filter: apply the project's filter here.
      return filterText(toIssues(toolJson(await this.conn.mcp.callTool("list_my_issues", args))), query);
    }
    throw new McpError("The Linear MCP server has no list_issues tool.");
  }

  async comment(t: TicketRef, body: string) {
    const tools = await this.conn.tools();
    if (!tools.has("create_comment")) {
      this.conn.warnOnce("create_comment");
      return { skipped: true };
    }
    const s = tools.get("create_comment");
    const idArg = argName(s, ["issueId", "id", "issue"]);
    if (!idArg) {
      this.conn.warnOnce("create_comment issue argument");
      return { skipped: true };
    }
    await this.conn.mcp.callTool("create_comment", { [idArg]: t.trackerId || t.key, body });
    return { skipped: false };
  }

  async transition(t: TicketRef, status: string) {
    if (!status.trim()) return { skipped: true };
    const tools = await this.conn.tools();
    if (!tools.has("update_issue")) {
      this.conn.warnOnce("update_issue");
      return { skipped: true };
    }
    const s = tools.get("update_issue");
    const idArg = argName(s, ["id", "issueId", "issue"]);
    const stateArg = argName(s, ["state", "stateId", "status"]);
    if (!idArg || !stateArg) {
      this.conn.warnOnce("update_issue state argument");
      return { skipped: true };
    }
    await this.conn.mcp.callTool("update_issue", { [idArg]: t.trackerId || t.key, [stateArg]: status });
    return { skipped: false };
  }
}

function filterText(list: FoundIssue[], query: string) {
  if (!query) return list;
  const q = query.toLowerCase();
  return list.filter((i) => `${i.key} ${i.summary} ${i.description || ""}`.toLowerCase().includes(q));
}
