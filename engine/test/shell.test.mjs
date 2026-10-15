import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../dist/test/shell.js";

test("start: stdin 'pipe' lets the caller write lines and end input; the child exits on EOF", async () => {
  let out = "";
  const run = start("cat", [], { stdin: "pipe", onData: (d) => (out += d) });
  run.write('{"type":"user","message":"hello"}\n');
  run.write("second\n");
  run.endInput();
  const res = await run.done;
  assert.equal(res.code, 0);
  assert.equal(out, '{"type":"user","message":"hello"}\nsecond\n');
});

test("start: without stdin option the child gets no input and still exits", async () => {
  const run = start("cat", []);
  const res = await run.done;
  assert.equal(res.code, 0);
  assert.equal(res.stdout, "");
});

test("start: write after the child exited does not throw", async () => {
  const run = start("true", [], { stdin: "pipe" });
  await run.done;
  assert.doesNotThrow(() => run.write("late\n"));
  assert.doesNotThrow(() => run.endInput());
});
