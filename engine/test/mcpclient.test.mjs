import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeMcp } from "./fakes/mcp-server.mjs";
import { AuthError, McpClient, McpError, toolJson, toolText } from "../dist/test/messaging/mcpclient.js";

for (const sse of [false, true]) {
  test(`McpClient over ${sse ? "SSE" : "JSON"}: initialize once, session id propagated, tool results parsed`, async () => {
    const validTokens = new Set(["at-1"]);
    const mcp = await startFakeMcp({ validTokens, sse });
    try {
      const c = new McpClient(mcp.url, async () => "at-1");
      const r = await c.callTool("list_channels", { query: "core" });
      assert.deepEqual(toolJson(r).channels.map((x) => x.channelId), ["ch-core", "ch-cba"]);
      await c.callTool("list_channels", {});
      assert.deepEqual(mcp.calls.map((x) => x.method), ["initialize", "notifications/initialized", "tools/call", "tools/call"]);
      assert.equal(mcp.calls[2].session, "sess-1");
      assert.match(toolText(r), /"channels"/);
    } finally {
      await mcp.close();
    }
  });
}

test("McpClient: tool isError becomes McpError with the text", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]) });
  try {
    const c = new McpClient(mcp.url, async () => "t");
    await assert.rejects(c.callTool("send_message", { text: "x" }), (e) => e instanceof McpError && /conversationId/.test(e.message));
  } finally {
    await mcp.close();
  }
});

test("McpClient: 401 → onUnauthorized → retry once; second 401 → AuthError", async () => {
  const validTokens = new Set(["good"]);
  const mcp = await startFakeMcp({ validTokens });
  try {
    let token = "stale";
    let refreshes = 0;
    const c = new McpClient(mcp.url, async () => token, {
      onUnauthorized: async () => {
        refreshes++;
        token = "good";
      },
    });
    const r = await c.callTool("list_channels", {});
    assert.equal(refreshes, 1);
    assert.ok(toolJson(r).channels.length);
    validTokens.clear();
    const c2 = new McpClient(mcp.url, async () => "nope", { onUnauthorized: async () => {} });
    await assert.rejects(c2.callTool("list_channels", {}), (e) => e instanceof AuthError);
  } finally {
    await mcp.close();
  }
});

test("McpClient: 404 on a known session re-initialises once and retries", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]) });
  try {
    const c = new McpClient(mcp.url, async () => "t");
    await c.callTool("list_channels", {});
    mcp.failNextWithSessionNotFound();
    await c.callTool("list_channels", {});
    assert.equal(mcp.calls.filter((x) => x.method === "initialize").length, 2);
    assert.equal(mcp.calls[mcp.calls.length - 1].session, "sess-2");
  } finally {
    await mcp.close();
  }
});

test("toolJson: structuredContent wins, else first JSON text block, else undefined", () => {
  assert.deepEqual(toolJson({ structuredContent: { a: 1 }, content: [{ type: "text", text: '{"b":2}' }] }), { a: 1 });
  assert.deepEqual(toolJson({ content: [{ type: "text", text: "hello" }, { type: "text", text: '{"b":2}' }] }), { b: 2 });
  assert.equal(toolJson({ content: [{ type: "text", text: "hello" }] }), undefined);
});
