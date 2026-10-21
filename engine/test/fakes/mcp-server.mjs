// A fake MCP server over streamable HTTP: bearer auth, sessions. Default tools are Setmore-like (list_channels,
// two-call send_message); `tools: { name: { inputSchema, handler(args) → result } }` replaces them.
import http from "node:http";

export async function startFakeMcp({ validTokens = new Set(), sse = false, tools } = {}) {
  const received = [];
  const calls = [];
  const sessions = new Set();
  let n = 0;
  let sessionNotFoundOnce = false;
  const channels = [
    { channelId: "ch-core", name: "ChatSupport Team Core", isMember: true, memberCount: 10 },
    { channelId: "ch-cba", name: "CBA: Core Team", isMember: true, memberCount: 11 },
  ];
  const server = http.createServer(async (req, res) => {
    const reply = (code, msg, headers = {}) => {
      if (sse && msg) {
        res.writeHead(code, { "content-type": "text/event-stream", ...headers });
        res.end(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
      } else {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(msg ? JSON.stringify(msg) : "");
      }
    };
    if (req.method !== "POST" || new URL(req.url, "http://x").pathname !== "/mcp") return reply(404, { error: "not found" });
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!validTokens.has(token)) {
      res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://x/.well-known/oauth-protected-resource/mcp"', "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "Authentication is required to access this resource." }));
    }
    let body = "";
    for await (const c of req) body += c;
    const rpc = JSON.parse(body);
    calls.push({ method: rpc.method, params: rpc.params, session: req.headers["mcp-session-id"] });
    const ok = (result, headers) => reply(200, { jsonrpc: "2.0", id: rpc.id, result }, headers);
    const err = (code, message) => reply(200, { jsonrpc: "2.0", id: rpc.id, error: { code, message } });
    if (rpc.method === "initialize") {
      const sid = `sess-${++n}`;
      sessions.add(sid);
      return ok({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-setmore", version: "0" } }, { "mcp-session-id": sid });
    }
    const sid = req.headers["mcp-session-id"];
    if (!sid || !sessions.has(sid) || sessionNotFoundOnce) {
      sessionNotFoundOnce = false;
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "session not found" }));
    }
    if (rpc.method === "notifications/initialized") {
      res.writeHead(202);
      return res.end();
    }
    if (tools && rpc.method === "tools/list") return ok({ tools: Object.entries(tools).map(([name, t]) => ({ name, inputSchema: t.inputSchema })) });
    if (tools && rpc.method === "tools/call") {
      const { name, arguments: a = {} } = rpc.params;
      if (!tools[name]) return ok({ isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
      return ok(await tools[name].handler(a));
    }
    if (rpc.method !== "tools/call") return err(-32601, "method not found");
    const { name, arguments: a = {} } = rpc.params;
    const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
    if (name === "list_channels") {
      const q = (a.query || "").toLowerCase();
      return ok(text({ channels: channels.filter((c) => !q || c.name.toLowerCase().includes(q)) }));
    }
    if (name === "send_message") {
      if (!a.conversationId || !a.text) return ok({ isError: true, content: [{ type: "text", text: "conversationId and text are required" }] });
      if (!a.confirmationToken) {
        const confirmationToken = `tok-${++n}`;
        return ok({ content: [{ type: "text", text: `Preview: send to ${a.conversationId}: ${a.text}` }], structuredContent: { preview: { recipient: a.conversationId, text: a.text }, confirmationToken } });
      }
      if (!/^tok-\d+$/.test(a.confirmationToken)) return ok({ isError: true, content: [{ type: "text", text: "invalid confirmationToken" }] });
      const messageId = `m-${++n}`;
      received.push({ channelId: a.conversationId, text: a.text, idempotencyKey: a.idempotencyKey, messageId });
      return ok(text({ sent: true, messageId }));
    }
    return ok({ isError: true, content: [{ type: "text", text: `unknown tool ${name}` }] });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    received,
    calls,
    sessions,
    failNextWithSessionNotFound: () => (sessionNotFoundOnce = true),
    close: () => new Promise((r) => server.close(r)),
  };
}
