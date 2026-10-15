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

function issueList(j: any): any[] {
  return Array.isArray(j)
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
}

const CLOSED_TYPES = ["completed", "canceled", "cancelled"];

/** An issue's status name, whichever shape the server uses. */
function stateName(i: any): string | undefined {
  const v = i?.state?.name ?? i?.status?.name ?? i?.state ?? i?.status;
  return typeof v === "string" ? v : undefined;
}

/**
 * Raw issues → FoundIssue. Always drops archived, completed/canceled and already-done issues, whatever the server did
 * with the filters; with `states`, keeps only issues in one of them (issues without a status name are kept).
 */
function toIssues(raw: any[], o: { doneStatus: string; states: string[] }): FoundIssue[] {
  const done = o.doneStatus.trim().toLowerCase();
  const wanted = o.states.map((x) => x.toLowerCase());
  const out: FoundIssue[] = [];
  for (const i of raw) {
    if (!i || typeof i.identifier !== "string") continue;
    if (i.archivedAt) continue;
    if (typeof i.state?.type === "string" && CLOSED_TYPES.includes(i.state.type.toLowerCase())) continue;
    const name = stateName(i)?.toLowerCase();
    if (name && done && name === done) continue;
    if (name && wanted.length && !wanted.includes(name)) continue;
    const issue: FoundIssue = { key: i.identifier, summary: String(i.title ?? "") };
    if (typeof i.description === "string" && i.description.trim()) issue.description = i.description;
    issue.id = typeof i.id === "string" || typeof i.id === "number" ? String(i.id) : i.identifier;
    if (typeof i.url === "string") issue.url = i.url;
    out.push(issue);
  }
  return out;
}

const MAX_ISSUES = 50;

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
    const t = this.p.tracker;
    const query = t.query.trim();
    const states = (t.linearState || "").split(",").map((x) => x.trim()).filter(Boolean);
    // Without either, every issue assigned to you (in any status) would be picked up.
    if (!query && !states.length) throw new Error("Set a status or a filter for Linear so HandsFree doesn't pick up every issue assigned to you.");
    const keep = { doneStatus: t.doneStatus, states };
    const tools = await this.conn.tools();
    if (tools.has("list_issues")) {
      const s = tools.get("list_issues");
      const base: Record<string, unknown> = {};
      if (t.linearAssignee.trim() && has(s, "assignee")) base.assignee = t.linearAssignee.trim();
      const stateArg = states.length ? argName(s, ["state", "status", "stateName"]) : undefined;
      if (s?.properties && "includeArchived" in s.properties) base.includeArchived = false;
      if (query && has(s, "query")) base.query = query;
      if (has(s, "limit")) base.limit = MAX_ISSUES;
      // One value per call unless the schema takes a list.
      const stateType = stateArg ? (s?.properties?.[stateArg] as { type?: string } | undefined)?.type : undefined;
      const calls: Record<string, unknown>[] = !stateArg
        ? [base]
        : stateType === "array"
          ? [{ ...withState(base, stateArg, states) }]
          : states.map((st) => withState(base, stateArg, st));
      const seen = new Map<string, FoundIssue>();
      for (const args of calls) {
        for (const i of toIssues(issueList(toolJson(await this.conn.mcp.callTool("list_issues", args))), keep)) if (!seen.has(i.key)) seen.set(i.key, i);
        if (seen.size >= MAX_ISSUES) break;
      }
      const found = [...seen.values()].slice(0, MAX_ISSUES);
      return query && !("query" in base) ? filterText(found, query) : found;
    }
    if (tools.has("list_my_issues")) {
      const args: Record<string, unknown> = has(tools.get("list_my_issues"), "limit") ? { limit: MAX_ISSUES } : {};
      // This tool takes no text filter: apply the project's filter here.
      return filterText(toIssues(issueList(toolJson(await this.conn.mcp.callTool("list_my_issues", args))), keep), query);
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

/** `base` with the status argument inserted after the assignee (keeps argument order readable in logs). */
function withState(base: Record<string, unknown>, arg: string, value: unknown) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) {
    out[k] = v;
    if (k === "assignee") out[arg] = value;
  }
  if (!(arg in out)) out[arg] = value;
  return out;
}

function filterText(list: FoundIssue[], query: string) {
  if (!query) return list;
  const q = query.toLowerCase();
  return list.filter((i) => `${i.key} ${i.summary} ${i.description || ""}`.toLowerCase().includes(q));
}
