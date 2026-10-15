import { test } from "node:test";
import assert from "node:assert/strict";
import { keyedLock } from "../dist/test/lock.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("keyedLock: calls with the same key run one after another, in order", async () => {
  const lock = keyedLock();
  const events = [];
  const job = (name, ms) => async () => {
    events.push(`${name} start`);
    await sleep(ms);
    events.push(`${name} end`);
    return name;
  };
  const results = await Promise.all([lock("repo", job("a", 30)), lock("repo", job("b", 5)), lock("repo", job("c", 5))]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(events, ["a start", "a end", "b start", "b end", "c start", "c end"]);
});

test("keyedLock: different keys run concurrently", async () => {
  const lock = keyedLock();
  const events = [];
  const job = (name, ms) => async () => {
    events.push(`${name} start`);
    await sleep(ms);
    events.push(`${name} end`);
  };
  await Promise.all([lock("one", job("a", 30)), lock("two", job("b", 5))]);
  assert.deepEqual(events, ["a start", "b start", "b end", "a end"]);
});

test("keyedLock: a failing job releases the key for the next one", async () => {
  const lock = keyedLock();
  await assert.rejects(lock("repo", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await lock("repo", async () => "ok"), "ok");
});
