import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkList, fillTemplate, humanDuration, ticketVars } from "../dist/test/messaging/templates.js";

test("fillTemplate: replaces known placeholders, leaves unknown ones, no quoting", () => {
  assert.equal(fillTemplate("Hi {name}: {pr_url} {nope}", { name: "O'Brien", pr_url: "https://x/1" }), "Hi O'Brien: https://x/1 {nope}");
});

test("humanDuration: minutes, hours, days", () => {
  const t0 = Date.parse("2026-10-15T10:00:00Z");
  const iso = (min) => new Date(t0 - min * 60_000).toISOString();
  assert.equal(humanDuration(iso(0), t0), "0 min");
  assert.equal(humanDuration(iso(47), t0), "47 min");
  assert.equal(humanDuration(iso(60), t0), "1 h");
  assert.equal(humanDuration(iso(190), t0), "3 h 10 min");
  assert.equal(humanDuration(iso(26 * 60), t0), "1 d 2 h");
});

const p = { name: "ChatSupport Web" };
const t = { key: "CSW-1", summary: "Add greeting", branch: "handsfree/CSW-1", prUrl: "https://github.com/a/r/pull/7", pr: { number: 7, approvedAt: "2026-10-15T09:13:00Z" } };

test("ticketVars: all placeholders, approved_ago from pr.approvedAt", () => {
  const v = ticketVars(p, t, Date.parse("2026-10-15T10:00:00Z"));
  assert.deepEqual(v, { key: "CSW-1", summary: "Add greeting", pr_url: "https://github.com/a/r/pull/7", pr_number: "7", project: "ChatSupport Web", branch: "handsfree/CSW-1", approved_ago: "47 min" });
});

test("ticketVars: missing PR gives empty strings", () => {
  const v = ticketVars(p, { ...t, prUrl: undefined, pr: undefined });
  assert.equal(v.pr_url, "");
  assert.equal(v.pr_number, "");
  assert.equal(v.approved_ago, "");
});

test("bulkList: one line per ticket", () => {
  assert.equal(bulkList([{ p, t }, { p, t: { ...t, key: "CSW-2", summary: "Two", prUrl: undefined } }]), "- CSW-1 — Add greeting: https://github.com/a/r/pull/7\n- CSW-2 — Two: (no PR yet)");
});
