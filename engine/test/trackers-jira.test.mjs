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

test("JiraTracker.comment: empty = default command, '-' = skipped; a failing transition throws", async () => {
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return cmd.includes("transition") ? { code: 1, stdout: "", stderr: "no such status", timedOut: false } : { code: 0, stdout: "", stderr: "", timedOut: false }; };
  const p = { repoPath: "", tracker: { kind: "jira", query: "project = X", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "" } };
  assert.deepEqual(await new JiraTracker(p, run).comment({ key: "X-1" }, "hello"), { skipped: false });
  assert.equal(calls[0], "acli jira workitem comment create --key 'X-1' --body 'hello'");
  assert.deepEqual(await new JiraTracker({ ...p, tracker: { ...p.tracker, commentCommand: "-" } }, run).comment({ key: "X-1" }, "hello"), { skipped: true });
  await assert.rejects(new JiraTracker(p, run).transition({ key: "X-1" }, "Done"), /no such status/);
});
