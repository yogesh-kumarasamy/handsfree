// The project editor's autosave (src/autosave.ts) driven like the editor drives it, against the demo mock API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectAutosaver, SaveQueue, upsertProject } from "../dist/test/ui/autosave.js";
import { firstProblemStep, projectProblems, REVIEW } from "../dist/test/ui/projectcheck.js";
import { createMockApi } from "../dist/test/ui/mock.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = (p) => projectProblems(p).map((x) => x.text);

/** A mock API that counts saves and checks none overlap. */
function countingApi(delayMs = 0) {
  const api = createMockApi({ scenario: "busy" });
  const stats = { saves: 0, running: 0, overlapped: false };
  const saveConfig = api.saveConfig;
  api.saveConfig = async (cfg) => {
    stats.saves++;
    stats.running++;
    if (stats.running > 1) stats.overlapped = true;
    await sleep(delayMs);
    stats.running--;
    return saveConfig(cfg);
  };
  return { api, stats };
}

test("leaving mid-edit keeps the change: a tracker filter edit is in config after flush, without pressing anything", async () => {
  const { api } = countingApi();
  const p1 = (await api.getConfig()).projects.find((p) => p.id === "p1");
  const saver = new ProjectAutosaver(api, { saved: p1, delayMs: 10_000 });
  const edited = { ...p1, tracker: { ...p1.tracker, query: "labels = handsfree" } };
  saver.edit(edited, problems(edited));
  // The editor unmounts (sidebar → Dashboard) long before the debounce fires; its cleanup flushes.
  assert.equal(await saver.flush(), true);
  assert.equal((await api.getConfig()).projects.find((p) => p.id === "p1").tracker.query, "labels = handsfree");
});

test("an invalid edit is never saved; fixing it saves", async () => {
  const { api, stats } = countingApi();
  const p1 = (await api.getConfig()).projects.find((p) => p.id === "p1");
  const statuses = [];
  const saver = new ProjectAutosaver(api, { saved: p1, delayMs: 5, onStatus: (s) => statuses.push(s) });
  const broken = { ...p1, naming: { ...p1.naming, branch: { template: "x/{key}", pattern: "([" } } };
  saver.edit(broken, problems(broken));
  await sleep(20);
  await saver.flush();
  assert.equal(stats.saves, 0);
  assert.equal(saver.status.kind, "blocked");
  assert.match(saver.status.reasons.join(), /Branch naming/);
  assert.equal((await api.getConfig()).projects.find((p) => p.id === "p1").naming.branch.pattern, p1.naming.branch.pattern);

  const fixed = { ...p1, naming: { ...p1.naming, branch: { template: "x/{key}", pattern: "^x/" } } };
  saver.edit(fixed, problems(fixed));
  await sleep(20);
  await saver.flush();
  assert.equal(stats.saves, 1);
  assert.equal(saver.status.kind, "saved");
  assert.equal((await api.getConfig()).projects.find((p) => p.id === "p1").naming.branch.pattern, "^x/");
});

test("fast typing saves once per pause, and saves never overlap", async () => {
  const { api, stats } = countingApi(30);
  const p1 = (await api.getConfig()).projects.find((p) => p.id === "p1");
  const saver = new ProjectAutosaver(api, { saved: p1, delayMs: 20 });
  let q = "";
  for (const c of "labels = hf") {
    q += c;
    saver.edit({ ...p1, tracker: { ...p1.tracker, query: q } }, []);
    await sleep(2);
  }
  await sleep(40); // the pause: one save starts and is still running…
  for (const c of " AND x") {
    q += c;
    saver.edit({ ...p1, tracker: { ...p1.tracker, query: q } }, []);
    await sleep(2);
  }
  await saver.flush(); // …the second burst waits for it, then saves only its latest value.
  assert.equal(stats.saves, 2);
  assert.equal(stats.overlapped, false);
  assert.equal((await api.getConfig()).projects.find((p) => p.id === "p1").tracker.query, "labels = hf AND x");
});

test("SaveQueue drops older pending values and skips what is already saved", async () => {
  const saved = [];
  let release;
  const q = new SaveQueue(
    (v) => {
      saved.push(v);
      return saved.length === 1 ? new Promise((r) => (release = r)) : Promise.resolve();
    },
    (v) => String(v),
    () => {},
    5,
  );
  q.markSaved("a");
  q.schedule("a");
  await q.flush();
  assert.deepEqual(saved, []);
  q.schedule("b");
  const first = q.flush();
  q.schedule("c");
  q.schedule("d");
  release();
  await first;
  await q.flush();
  assert.deepEqual(saved, ["b", "d"]);
});

test("a failed save shows the error, keeps the value and retries it on the next flush", async () => {
  let fail = true;
  const got = [];
  const states = [];
  const q = new SaveQueue(
    async (v) => {
      if (fail) throw new Error("engine down");
      got.push(v);
    },
    (v) => v,
    (s) => states.push(s.kind),
    5,
  );
  q.schedule("x");
  assert.equal(await q.flush(), false);
  assert.equal(states.at(-1), "error");
  fail = false;
  assert.equal(await q.flush(), true);
  assert.deepEqual(got, ["x"]);
  assert.equal(states.at(-1), "saved");
});

test("a new project is saved as a disabled draft and activation enables it", async () => {
  const api = createMockApi({ scenario: "busy" });
  const p1 = (await api.getConfig()).projects.find((p) => p.id === "p1");
  const draft = { ...p1, id: "new1", name: "New", enabled: false, draft: true, tracker: { ...p1.tracker, query: "" } };
  const saver = new ProjectAutosaver(api, { delayMs: 5 });
  // Drafts save even with problems (the missing query); they never run.
  assert.ok(problems(draft).length > 0);
  saver.edit(draft, []);
  await saver.flush();
  let stored = (await api.getConfig()).projects.find((p) => p.id === "new1");
  assert.equal(stored.draft, true);
  assert.equal(stored.enabled, false);
  assert.equal(firstProblemStep(stored), 1); // Continue setup opens the Tracker step

  const { draft: _, ...rest } = { ...draft, tracker: { ...draft.tracker, query: "labels = x" } };
  assert.equal(firstProblemStep({ ...rest, draft: true }), REVIEW);
  saver.edit({ ...rest, enabled: true }, []);
  assert.equal(await saver.flush(), true);
  stored = (await api.getConfig()).projects.find((p) => p.id === "new1");
  assert.equal(stored.enabled, true);
  assert.equal(stored.draft, undefined);
});

test("upsertProject replaces by id or appends, leaving the rest of the config alone", () => {
  const cfg = { version: 1, settings: { paused: true }, projects: [{ id: "a", name: "A" }, { id: "b", name: "B" }] };
  assert.deepEqual(upsertProject(cfg, { id: "b", name: "B2" }).projects.map((p) => p.name), ["A", "B2"]);
  assert.deepEqual(upsertProject(cfg, { id: "c", name: "C" }).projects.map((p) => p.id), ["a", "b", "c"]);
  assert.equal(upsertProject(cfg, { id: "c" }).settings.paused, true);
});

test("close drops a pending save, so deleting a draft can't be undone by a late autosave", async () => {
  const got = [];
  const q = new SaveQueue(async (v) => void got.push(v), (v) => v, () => {}, 5);
  q.schedule("draft");
  await q.close();
  q.schedule("again");
  await q.flush();
  await sleep(20);
  assert.deepEqual(got, []);
});
