import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateState, normalizeProject, normalizeRoutine } from "../dist/test/store.js";

const cfg = (draftPr) => ({ version: 1, settings: {}, projects: [{ id: "p1", draftPr }] });
const ticket = (status, projectId = "p1") => ({ key: "X-1", projectId, status, branch: "", worktree: "", agentIndex: 0, attempts: [], createdAt: "", updatedAt: "" });

test("pr_open becomes pr_draft for draft projects", () => {
  const s = migrateState({ tickets: { "X-1": ticket("pr_open") } }, cfg(true));
  assert.equal(s.tickets["X-1"].status, "pr_draft");
});

test("pr_open becomes pr_ready for ready-PR projects", () => {
  const s = migrateState({ tickets: { "X-1": ticket("pr_open") } }, cfg(false));
  assert.equal(s.tickets["X-1"].status, "pr_ready");
});

test("pr_open with an unknown project defaults to pr_draft", () => {
  const s = migrateState({ tickets: { "X-1": ticket("pr_open", "gone") } }, cfg(false));
  assert.equal(s.tickets["X-1"].status, "pr_draft");
});

test("other statuses, poll timestamps and error maps are kept; missing maps are created", () => {
  const s = migrateState({ tickets: { "X-1": ticket("running") }, lastPollAt: "a", nextPollAt: "b" }, cfg(true));
  assert.equal(s.tickets["X-1"].status, "running");
  assert.equal(s.lastPollAt, "a");
  assert.equal(s.nextPollAt, "b");
  assert.deepEqual(s.pollErrors, {});
  assert.deepEqual(s.prCheckErrors, {});
});

test("empty file gives an empty state", () => {
  assert.deepEqual(migrateState(undefined, cfg(true)).tickets, {});
});

test("routines: missing state map is created and kept when present", () => {
  assert.deepEqual(migrateState(undefined, cfg(true)).routines, {});
  const r = { r1: { nextRunAt: "x", last: { startedAt: "a", ok: true } } };
  assert.deepEqual(migrateState({ tickets: {}, routines: r }, cfg(true)).routines, r);
});

test("normalizeProject gives routines: [] and normalizeRoutine fills defaults and clamps timeout", () => {
  assert.deepEqual(normalizeProject({ name: "P" }).routines, []);
  const r = normalizeRoutine({ name: "X", timeoutMin: 500 });
  assert.ok(r.id);
  assert.equal(r.enabled, true);
  assert.equal(r.schedule, "0 10 * * 1-5");
  assert.equal(r.prompt, "");
  assert.equal(r.agentCommand, "");
  assert.equal(r.postToChannel, true);
  assert.equal(r.timeoutMin, 120);
  assert.equal(normalizeRoutine({ timeoutMin: 0 }).timeoutMin, 1);
  assert.equal(normalizeRoutine({}).timeoutMin, 15);
  assert.equal(normalizeRoutine({ schedule: "bad" }).schedule, "bad", "invalid cron kept as text");
  assert.equal(normalizeProject({ routines: [{ name: "Y" }] }).routines[0].name, "Y");
});
