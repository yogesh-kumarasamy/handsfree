import { test } from "node:test";
import assert from "node:assert/strict";
import { MessagingService } from "../dist/test/messaging/service.js";

const templates = { reviewReady: "review {key} {pr_url}", mergeNudge: "nudge {key} {approved_ago}", manual: "{key} — {summary}: {pr_url}", bulk: "Eyes please:\n{list}" };
const proj = (id, platform, channelId = "ch-" + id) => ({ id, name: "P" + id, repoPath: "", messaging: { platform, channelId, channelName: "#" + id, templates, agentCommand: "" } });
const tick = (key, projectId) => ({ key, projectId, summary: "S " + key, branch: "b", prUrl: "https://x/" + key, attempts: [], status: "pr_ready", createdAt: "", updatedAt: "" });

function makeService(sent) {
  const config = { settings: { accounts: {} }, projects: [proj("a", "agent"), proj("b", "agent"), proj("c", "none")] };
  const state = { tickets: { "A-1": tick("A-1", "a"), "A-2": tick("A-2", "a"), "B-1": tick("B-1", "b"), "C-1": tick("C-1", "c") }, accounts: {} };
  const logs = [];
  const notices = [];
  const svc = new MessagingService({
    config: () => config,
    state: () => state,
    log: (k, s) => logs.push([k, s]),
    notify: (t, b) => notices.push([t, b]),
    persist: () => {},
    emit: () => {},
    // test seam: replace the real adapter factory
    adapterFor: (p) =>
      p.messaging.platform === "none"
        ? undefined
        : {
            platform: p.messaging.platform,
            listChannels: async () => [],
            send: async (ch, text, key) => {
              sent.push({ project: p.id, ch, text, key });
              return { id: "m-" + sent.length };
            },
          },
  });
  return { svc, state, logs, notices };
}

test("sendBulk: one message per project to its own channel; platform none reported as failed", async () => {
  const sent = [];
  const { svc, state } = makeService(sent);
  const r = await svc.sendBulk(["A-1", "A-2", "B-1", "C-1", "NOPE-1"]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].ch, "ch-a");
  assert.match(sent[0].text, /^Eyes please:\n- A-1 — S A-1: https:\/\/x\/A-1\n- A-2/);
  assert.equal(sent[1].ch, "ch-b");
  assert.deepEqual(r.failed.map((f) => f.key).sort(), ["C-1", "NOPE-1"]);
  assert.match(r.failed.find((f) => f.key === "C-1").error, /no messaging platform/i);
  assert.equal(r.sent.length, 3, "a record per sent ticket");
  assert.equal(state.tickets["A-2"].messages[0].kind, "bulk");
  assert.equal(state.tickets["A-2"].messages[0].ok, true);
  assert.equal(state.tickets["C-1"].messages?.length ?? 0, 0, "nothing recorded for a project without messaging");
});

test("sendManual: template filled, custom text wins, failure recorded and notified", async () => {
  const sent = [];
  const { svc, state } = makeService(sent);
  const rec = await svc.sendManual("A-1");
  assert.equal(rec.text, "A-1 — S A-1: https://x/A-1");
  assert.equal(rec.ok, true);
  assert.equal(rec.id, "m-1");
  const custom = await svc.sendManual("A-1", "custom {key}");
  assert.equal(custom.text, "custom {key}", "custom text is sent verbatim");
  await assert.rejects(svc.sendManual("C-1"), /Choose a channel|no messaging platform/i);
  assert.equal(state.tickets["A-1"].messages.length, 2);
  // failing adapter
  const { svc: svc2, state: s2, notices: n2 } = makeService([]);
  svc2.deps.adapterFor = () => ({
    platform: "agent",
    listChannels: async () => [],
    send: async () => {
      throw new Error("boom");
    },
  });
  const failed = await svc2.sendManual("A-1").catch((e) => e);
  assert.match(String(failed.message || failed), /boom/);
  assert.equal(s2.tickets["A-1"].messages[0].ok, false);
  assert.match(s2.tickets["A-1"].messages[0].error, /boom/);
  assert.equal(n2.length, 1);
});

test("onPrEvent: review_ready and merge_nudge send their templates; other kinds and empty templates are skipped", async () => {
  const sent = [];
  const { svc, state, logs } = makeService(sent);
  state.tickets["A-1"].pr = { approvedAt: new Date(Date.now() - 47 * 60_000).toISOString() };
  await svc.onPrEvent({ kind: "review_ready", key: "A-1", prUrl: "https://x/A-1", projectId: "a", at: "" });
  await svc.onPrEvent({ kind: "merge_nudge", key: "A-1", prUrl: "https://x/A-1", projectId: "a", at: "" });
  await svc.onPrEvent({ kind: "merged", key: "A-1", prUrl: "https://x/A-1", projectId: "a", at: "" });
  assert.deepEqual(sent.map((s) => s.text), ["review A-1 https://x/A-1", "nudge A-1 47 min"]);
  svc.deps.config().projects[0].messaging.templates.reviewReady = "";
  await svc.onPrEvent({ kind: "review_ready", key: "A-2", prUrl: "", projectId: "a", at: "" });
  assert.equal(sent.length, 2);
  assert.ok(logs.some(([k, s]) => k === "A-2" && /template is empty/.test(s)));
});

test("sendBulk with text across projects: {list} must stay in the text so each project gets its own list; fully expanded text is refused", async () => {
  const sent = [];
  const { svc } = makeService(sent);
  const bad = await svc.sendBulk(["A-1", "B-1"], "Here: - A-1 and B-1 already expanded");
  assert.equal(sent.length, 0);
  assert.equal(bad.failed.length, 2);
  assert.match(bad.failed[0].error, /spans .*projects/i);
  const good = await svc.sendBulk(["A-1", "A-2", "B-1"], "Custom intro:\n{list}");
  assert.equal(good.failed.length, 0);
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /^Custom intro:\n- A-1 — S A-1: https:\/\/x\/A-1\n- A-2/);
  assert.doesNotMatch(sent[0].text, /B-1/);
  assert.match(sent[1].text, /^Custom intro:\n- B-1/);
});

test("postToProject: sends free text with the given idempotency key, no ticket; throws without platform or channel", async () => {
  const sent = [];
  const { svc, state } = makeService(sent);
  const r = await svc.postToProject(proj("a", "agent"), "3 open PRs", "routine", "routine:r1:2026");
  assert.deepEqual(sent, [{ project: "a", ch: "ch-a", text: "3 open PRs", key: "routine:r1:2026" }]);
  assert.equal(r.id, "m-1");
  assert.equal(state.tickets["A-1"].messages, undefined, "no ticket record");
  await assert.rejects(svc.postToProject(proj("c", "none"), "x", "routine", "k"), /No messaging platform/);
  await assert.rejects(svc.postToProject(proj("a", "agent", ""), "x", "routine", "k"), /Choose a channel/);
});
