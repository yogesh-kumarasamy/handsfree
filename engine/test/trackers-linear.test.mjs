import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeMcp } from "./fakes/mcp-server.mjs";
import { ClientStore, TokenStore } from "../dist/test/messaging/oauth.js";
import { LinearTracker } from "../dist/test/trackers/linear.js";

const future = new Date(Date.now() + 3600_000).toISOString();
const issues = [{ id: "uuid-1", identifier: "ENG-7", title: "Add greeting", description: "Say hi", url: "https://linear.app/x/ENG-7" }];
const toolsA = {
  list_issues: { inputSchema: { properties: { assignee: {}, query: {}, limit: {} } }, handler: (a) => ({ calls: a, content: [{ type: "text", text: JSON.stringify({ issues }) }] }) },
  create_comment: { inputSchema: { properties: { issueId: {}, body: {} } }, handler: (a) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, got: a }) }] }) },
  update_issue: { inputSchema: { properties: { id: {}, state: {} } }, handler: (a) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, got: a }) }] }) },
};
const toolsB = {
  list_my_issues: { inputSchema: { properties: { limit: {} } }, handler: () => ({ content: [{ type: "text", text: JSON.stringify(issues) }] }) },
  create_comment: { inputSchema: { properties: { issue: {}, body: {} } }, handler: (a) => ({ content: [{ type: "text", text: JSON.stringify({ got: a }) }] }) },
};
const mk = (mcp) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-lin-"));
  const tokens = new TokenStore(path.join(dir, "t.json"));
  tokens.save({ accessToken: "t", expiresAt: future });
  const p = { repoPath: "", tracker: { kind: "linear", query: "greeting", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me" } };
  return new LinearTracker(p, { mcpUrl: mcp.url, issuer: "http://127.0.0.1:1", redirectPort: 1, scopes: "" }, tokens, new ClientStore(path.join(dir, "c.json")), () => {});
};

test("LinearTracker: schema-driven args, keys from identifier, comment and transition", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]), tools: toolsA });
  try {
    const l = mk(mcp);
    const found = await l.search();
    assert.deepEqual(found, [{ key: "ENG-7", summary: "Add greeting", description: "Say hi", id: "uuid-1", url: "https://linear.app/x/ENG-7" }]);
    const list = mcp.calls.find((c) => c.params?.name === "list_issues").params.arguments;
    assert.deepEqual(list, { assignee: "me", query: "greeting", limit: 50 });
    assert.deepEqual(await l.comment({ key: "ENG-7", trackerId: "uuid-1" }, "PR opened"), { skipped: false });
    assert.deepEqual(mcp.calls.find((c) => c.params?.name === "create_comment").params.arguments, { issueId: "uuid-1", body: "PR opened" });
    assert.deepEqual(await l.transition({ key: "ENG-7", trackerId: "uuid-1" }, "Done"), { skipped: false });
    assert.deepEqual(mcp.calls.find((c) => c.params?.name === "update_issue").params.arguments, { id: "uuid-1", state: "Done" });
  } finally {
    await mcp.close();
  }
});

test("LinearTracker: list_my_issues fallback, issue arg name, missing update_issue → transition skipped", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]), tools: toolsB });
  try {
    const l = mk(mcp);
    assert.equal((await l.search())[0].key, "ENG-7");
    await l.comment({ key: "ENG-7", trackerId: "uuid-1" }, "x");
    assert.deepEqual(mcp.calls.find((c) => c.params?.name === "create_comment").params.arguments, { issue: "uuid-1", body: "x" });
    assert.deepEqual(await l.transition({ key: "ENG-7", trackerId: "uuid-1" }, "Done"), { skipped: true });
  } finally {
    await mcp.close();
  }
});

test("LinearTracker: not logged in → AuthError, no network", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(), tools: toolsA });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-lin-"));
    const l = new LinearTracker({ repoPath: "", tracker: { kind: "linear", query: "", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me" } }, { mcpUrl: mcp.url, issuer: "http://127.0.0.1:1", redirectPort: 1, scopes: "" }, new TokenStore(path.join(dir, "t.json")), new ClientStore(path.join(dir, "c.json")), () => {});
    await assert.rejects(l.search(), /Not logged in to Linear/);
    assert.equal(mcp.calls.length, 0);
  } finally {
    await mcp.close();
  }
});
