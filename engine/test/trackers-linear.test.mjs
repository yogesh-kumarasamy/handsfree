import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeMcp } from "./fakes/mcp-server.mjs";
import { ClientStore, TokenStore } from "../dist/test/messaging/oauth.js";
import { LinearTracker } from "../dist/test/trackers/linear.js";

const future = new Date(Date.now() + 3600_000).toISOString();
const issues = [{ id: "uuid-1", identifier: "ENG-7", title: "Add greeting", description: "Say hi", url: "https://linear.app/x/ENG-7", labels: [{ name: "Bug" }] }];
const toolsA = {
  list_issues: { inputSchema: { properties: { assignee: {}, query: {}, limit: {} } }, handler: (a) => ({ calls: a, content: [{ type: "text", text: JSON.stringify({ issues }) }] }) },
  create_comment: { inputSchema: { properties: { issueId: {}, body: {} } }, handler: (a) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, got: a }) }] }) },
  update_issue: { inputSchema: { properties: { id: {}, state: {} } }, handler: (a) => ({ content: [{ type: "text", text: JSON.stringify({ ok: true, got: a }) }] }) },
};
const toolsB = {
  list_my_issues: { inputSchema: { properties: { limit: {} } }, handler: () => ({ content: [{ type: "text", text: JSON.stringify(issues) }] }) },
  create_comment: { inputSchema: { properties: { issue: {}, body: {} } }, handler: (a) => ({ content: [{ type: "text", text: JSON.stringify({ got: a }) }] }) },
};
const mk = (mcp, over = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-lin-"));
  const tokens = new TokenStore(path.join(dir, "t.json"));
  tokens.save({ accessToken: "t", expiresAt: future });
  const p = { repoPath: "", tracker: { kind: "linear", query: "greeting", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me", ...over } };
  return new LinearTracker(p, { mcpUrl: mcp.url, issuer: "http://127.0.0.1:1", redirectPort: 1, scopes: "" }, tokens, new ClientStore(path.join(dir, "c.json")), () => {});
};

test("LinearTracker: schema-driven args, keys from identifier, comment and transition", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]), tools: toolsA });
  try {
    const l = mk(mcp);
    const found = await l.search();
    assert.deepEqual(found, [{ key: "ENG-7", summary: "Add greeting", description: "Say hi", id: "uuid-1", url: "https://linear.app/x/ENG-7", type: "bug" }]);
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
    const skipped = await l.transition({ key: "ENG-7", trackerId: "uuid-1" }, "Done");
    assert.equal(skipped.skipped, true);
    assert.match(skipped.reason, /update_issue/, "a skip says why");
  } finally {
    await mcp.close();
  }
});

test("LinearTracker: not logged in → AuthError, no network", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(), tools: toolsA });
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-lin-"));
    const l = new LinearTracker({ repoPath: "", tracker: { kind: "linear", query: "", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me", linearState: "Todo" } }, { mcpUrl: mcp.url, issuer: "http://127.0.0.1:1", redirectPort: 1, scopes: "" }, new TokenStore(path.join(dir, "t.json")), new ClientStore(path.join(dir, "c.json")), () => {});
    await assert.rejects(l.search(), /Not logged in to Linear/);
    assert.equal(mcp.calls.length, 0);
  } finally {
    await mcp.close();
  }
});

// Linear-like list_issues with state + includeArchived declared; the server answers with every assigned issue it has.
const mixed = [
  { id: "u1", identifier: "ENG-1", title: "Todo one", state: { name: "Todo", type: "unstarted" } },
  { id: "u2", identifier: "ENG-2", title: "Shipped", state: { name: "Done", type: "completed" } },
  { id: "u3", identifier: "ENG-3", title: "Old", state: { name: "Todo", type: "unstarted" }, archivedAt: "2026-01-01T00:00:00Z" },
  { id: "u4", identifier: "ENG-4", title: "Dropped", state: { name: "Won't fix", type: "canceled" } },
  { id: "u5", identifier: "ENG-5", title: "Merged elsewhere", status: "done" },
  { id: "u6", identifier: "ENG-6", title: "Doing", state: { name: "In Progress", type: "started" } },
];
const toolsS = {
  list_issues: {
    inputSchema: { properties: { assignee: {}, state: { type: "string" }, includeArchived: {}, query: {}, limit: {} } },
    handler: (a) => ({ content: [{ type: "text", text: JSON.stringify({ issues: a.state ? mixed.filter((i) => (i.state?.name || i.status) === a.state || i.archivedAt || i.state?.type !== "unstarted") : mixed }) }] }),
  },
};

test("LinearTracker: status filter passed (state + includeArchived:false); done, canceled and archived issues dropped", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]), tools: toolsS });
  try {
    const l = mk(mcp, { query: "", linearState: "Todo" });
    const found = await l.search();
    const args = mcp.calls.find((c) => c.params?.name === "list_issues").params.arguments;
    assert.deepEqual(args, { assignee: "me", state: "Todo", includeArchived: false, limit: 50 });
    // The server ignored part of the filter: the safety net keeps only unarchived issues in the asked status,
    // never done (by name or by type) or canceled ones.
    assert.deepEqual(found.map((i) => i.key), ["ENG-1"]);
  } finally {
    await mcp.close();
  }
});

test("LinearTracker: several statuses → one call per status (string schema), results merged", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]), tools: toolsS });
  try {
    const l = mk(mcp, { query: "", linearState: "Todo, In Progress" });
    const found = await l.search();
    const states = mcp.calls.filter((c) => c.params?.name === "list_issues").map((c) => c.params.arguments.state);
    assert.deepEqual(states, ["Todo", "In Progress"]);
    assert.deepEqual(found.map((i) => i.key).sort(), ["ENG-1", "ENG-6"]);
  } finally {
    await mcp.close();
  }
});

test("LinearTracker: no status and no filter → refused before any network call", async () => {
  const mcp = await startFakeMcp({ validTokens: new Set(["t"]), tools: toolsS });
  try {
    await assert.rejects(mk(mcp, { query: "", linearState: "" }).search(), /Set a status or a filter for Linear/);
    assert.equal(mcp.calls.length, 0);
  } finally {
    await mcp.close();
  }
});

test("LinearTracker: skip reasons — no create_comment tool, update_issue without a state argument; '-' comment command skips silently", async () => {
  const mcp = await startFakeMcp({
    validTokens: new Set(["t"]),
    tools: { list_my_issues: toolsB.list_my_issues, update_issue: { inputSchema: { properties: { id: {}, title: {} } }, handler: () => ({ content: [] }) } },
  });
  try {
    const l = mk(mcp);
    const c = await l.comment({ key: "ENG-7", trackerId: "uuid-1" }, "x");
    assert.equal(c.skipped, true);
    assert.match(c.reason, /create_comment/);
    const t = await l.transition({ key: "ENG-7", trackerId: "uuid-1" }, "Done");
    assert.equal(t.skipped, true);
    assert.match(t.reason, /update_issue has no state argument/);
    assert.deepEqual(await mk(mcp, { commentCommand: "-" }).comment({ key: "ENG-7", trackerId: "uuid-1" }, "x"), { skipped: true });
    assert.equal(mcp.calls.filter((c) => c.params?.name === "create_comment" || c.params?.name === "update_issue").length, 0);
  } finally {
    await mcp.close();
  }
});
