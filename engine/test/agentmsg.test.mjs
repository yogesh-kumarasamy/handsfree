import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentAdapter, lastJson } from "../dist/test/messaging/agent.js";

test("lastJson: whole string, fenced block, trailing object, none", () => {
  assert.deepEqual(lastJson('{"a":1}'), { a: 1 });
  assert.deepEqual(lastJson('Sure!\n```json\n{"sent":true,"id":"m"}\n```'), { sent: true, id: "m" });
  assert.deepEqual(lastJson('thinking... {"x":1} and then {"sent":false,"error":"no"}'), { sent: false, error: "no" });
  assert.equal(lastJson("nothing here"), undefined);
});

const fakeRun = (stdout, code = 0) => async () => ({ code, stdout, stderr: "", timedOut: false });

test("AgentAdapter.send: parses Claude's JSON envelope and the inner JSON", async () => {
  let cmd = "";
  const a = new AgentAdapter("claude -p {prompt}", undefined, async (c) => {
    cmd = c;
    return { code: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: 'Done.\n{"sent": true, "id": "m-7"}' }), stderr: "", timedOut: false };
  });
  const r = await a.send("ch-core", "hello {team}", "k");
  assert.equal(r.id, "m-7");
  assert.match(cmd, /^claude -p '/);
  assert.match(cmd, /hello \{team\}/);
  assert.match(cmd, /ch-core/);
  assert.match(cmd, /confirmationToken/);
});

test("AgentAdapter.send: sent:false, is_error, non-zero exit and no JSON are failures with the reason", async () => {
  await assert.rejects(new AgentAdapter("x {prompt}", undefined, fakeRun('{"sent":false,"error":"channel not found"}')).send("c", "t", "k"), /channel not found/);
  await assert.rejects(new AgentAdapter("x {prompt}", undefined, fakeRun(JSON.stringify({ is_error: true, result: "rate limited" }))).send("c", "t", "k"), /rate limited/);
  await assert.rejects(new AgentAdapter("x {prompt}", undefined, fakeRun("boom", 1)).send("c", "t", "k"), /exit 1/);
  await assert.rejects(new AgentAdapter("x {prompt}", undefined, fakeRun("I sent it, trust me")).send("c", "t", "k"), /did not confirm/);
});

test("AgentAdapter.listChannels: JSON array of {id,name}", async () => {
  const a = new AgentAdapter("x {prompt}", undefined, fakeRun('[{"id":"c1","name":"Core"}]'));
  assert.deepEqual(await a.listChannels("core"), [{ id: "c1", name: "Core" }]);
});
