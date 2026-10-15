import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCron, nextRun, parseCron } from "../dist/test/routines/cron.js";

const at = (s) => new Date(s); // local time strings like "2026-10-15T09:59:00"

test("parseCron: forms and errors", () => {
  assert.deepEqual(parseCron("0 10 * * 1-5").dow, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron("*/15 9-17 * * *").min, [0, 15, 30, 45]);
  assert.deepEqual(parseCron("0 9,13,17 * * *").hour, [9, 13, 17]);
  assert.deepEqual(parseCron("0 0 1 jan,jul mon").month, [1, 7]);
  assert.deepEqual(parseCron("0 0 * * 7").dow, [0], "7 is Sunday");
  assert.deepEqual(parseCron("1-5/2 * * * *").min, [1, 3, 5]);
  for (const bad of ["", "0 10 * *", "60 * * * *", "0 25 * * *", "0 0 32 * *", "0 0 * 13 *", "0 0 * * 8", "a b c d e"]) assert.ok(parseCron(bad) instanceof Error, bad);
});

test("nextRun: strictly after, day/month/year rollover, dow and dom rules", () => {
  const spec = parseCron("0 10 * * 1-5");
  assert.equal(nextRun(spec, at("2026-10-15T09:59:00")).toISOString(), at("2026-10-15T10:00:00").toISOString()); // Thursday
  assert.equal(nextRun(spec, at("2026-10-15T10:00:00")).toISOString(), at("2026-10-16T10:00:00").toISOString()); // strictly after
  assert.equal(nextRun(spec, at("2026-10-16T10:00:00")).toISOString(), at("2026-10-19T10:00:00").toISOString()); // skips the weekend
  assert.equal(nextRun(parseCron("0 9,13,17 * * *"), at("2026-12-31T17:00:00")).toISOString(), at("2027-01-01T09:00:00").toISOString());
  assert.equal(nextRun(parseCron("0 0 29 2 *"), at("2026-03-01T00:00:00")).toISOString(), at("2028-02-29T00:00:00").toISOString());
  assert.equal(nextRun(parseCron("0 0 15 * 1"), at("2026-10-01T00:00:00")).toISOString(), at("2026-10-05T00:00:00").toISOString(), "dom OR dow when both are restricted");
  assert.ok(nextRun(parseCron("0 0 31 2 *"), at("2026-01-01T00:00:00")) instanceof Error, "never matches → Error");
});

test("describeCron: the two presets and a fallback", () => {
  assert.equal(describeCron(parseCron("0 10 * * 1-5"), "0 10 * * 1-5"), "every weekday at 10:00");
  assert.equal(describeCron(parseCron("0 9,13,17 * * *"), "0 9,13,17 * * *"), "every day at 09:00, 13:00 and 17:00");
  assert.equal(describeCron(parseCron("*/15 * * * *"), "*/15 * * * *"), "*/15 * * * *");
});
