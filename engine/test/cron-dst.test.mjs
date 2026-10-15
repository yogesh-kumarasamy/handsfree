// DST fall-back: the ambiguous local hour must never make nextRun return a time at or before `after`.
// node --test runs each file in its own process, so pinning TZ here affects only this file.
process.env.TZ = "America/New_York";
import { test } from "node:test";
import assert from "node:assert/strict";

const { nextRun, parseCron } = await import("../dist/test/routines/cron.js");

test("nextRun across the New York fall-back hour stays strictly after `after`", () => {
  // 2026-11-01 06:10Z = 01:10 EST, the second 01:xx of the night (the first was EDT).
  const after = new Date("2026-11-01T06:10:00Z");
  const n = nextRun(parseCron("* * * * *"), after);
  assert.ok(n > after, `${n.toISOString()} must be after ${after.toISOString()}`);
  assert.equal(n.toISOString(), "2026-11-01T06:11:00.000Z");
  assert.equal(nextRun(parseCron("*/15 * * * *"), new Date("2026-11-01T06:20:00Z")).toISOString(), "2026-11-01T06:30:00.000Z");
  // and in the first (EDT) 01:xx hour it proceeds minute by minute too
  assert.equal(nextRun(parseCron("* * * * *"), new Date("2026-11-01T05:59:00Z")).toISOString(), "2026-11-01T06:00:00.000Z");
});
