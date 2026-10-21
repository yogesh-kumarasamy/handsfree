import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraTracker, parseIssues } from "../dist/test/trackers/jira.js";

test("JiraTracker.transition: default command, status shell-quoted; empty status skips; custom template", async () => {
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  const p = { repoPath: "", tracker: { kind: "jira", query: "project = X", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Won't Do", repo: "", linearAssignee: "" } };
  await new JiraTracker(p, run).transition({ key: "X-1" }, "Won't Do");
  assert.equal(calls[0], `acli jira workitem transition --key 'X-1' --status 'Won'\\''t Do' --yes`);
  assert.deepEqual(await new JiraTracker(p, run).transition({ key: "X-1" }, ""), { skipped: true });
  await new JiraTracker({ ...p, tracker: { ...p.tracker, transitionCommand: "mytool {issue_key} {status}" } }, run).transition({ key: "X-1" }, "Done");
  assert.equal(calls[1], "mytool 'X-1' 'Done'");
  assert.equal(parseIssues('[{"key":"X-2","fields":{"summary":"S"}}]')[0].key, "X-2");
});

test("parseIssues: the Jira issue type is mapped onto the branch type keyword", () => {
  const list = parseIssues('[{"key":"X-3","fields":{"summary":"S","issuetype":{"name":"Bug"}}},{"key":"X-4","fields":{"summary":"T","issuetype":{"name":"Story"}}},{"key":"X-5","fields":{"summary":"U"}}]');
  assert.deepEqual(list.map((i) => [i.key, i.type]), [["X-3", "bug"], ["X-4", "feature"], ["X-5", undefined]]);
});

test("JiraTracker.comment: empty = default command, '-' = skipped; a failing transition throws", async () => {
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return cmd.includes("transition") ? { code: 1, stdout: "", stderr: "no such status", timedOut: false } : { code: 0, stdout: "", stderr: "", timedOut: false }; };
  const p = { repoPath: "", tracker: { kind: "jira", query: "project = X", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "" } };
  assert.deepEqual(await new JiraTracker(p, run).comment({ key: "X-1" }, "hello"), { skipped: false });
  assert.equal(calls[0], "acli jira workitem comment create --key 'X-1' --body 'hello'");
  assert.deepEqual(await new JiraTracker({ ...p, tracker: { ...p.tracker, commentCommand: "-" } }, run).comment({ key: "X-1" }, "hello"), { skipped: true });
  await assert.rejects(new JiraTracker(p, run).transition({ key: "X-1" }, "Done"), /no such status/);
});

test("parseIssues: labels are kept", () => {
  const [i] = parseIssues('[{"key":"X-6","fields":{"summary":"S","labels":["support","PICKUP_READY"]}}]');
  assert.deepEqual(i.labels, ["support", "PICKUP_READY"]);
});

test("JiraTracker.addLabel: acli edit with the existing labels plus the new one (no duplicate); failure throws", async () => {
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "", timedOut: false }; };
  const p = { repoPath: "", tracker: { kind: "jira", query: "project = X", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "" } };
  await new JiraTracker(p, run).addLabel({ key: "X-1", labels: ["support", "pickup_ready"] }, "PICKUP_READY");
  assert.equal(calls[0], "acli jira workitem edit --key 'X-1' --labels 'support,PICKUP_READY' --yes");
  await new JiraTracker(p, run).addLabel({ key: "X-2" }, "PICKUP_READY");
  assert.equal(calls[1], "acli jira workitem edit --key 'X-2' --labels 'PICKUP_READY' --yes");
  const bad = async () => ({ code: 1, stdout: "", stderr: "You do not have permission to edit", timedOut: false });
  await assert.rejects(new JiraTracker(p, bad).addLabel({ key: "X-1" }, "PICKUP_READY"), /permission/);
});
