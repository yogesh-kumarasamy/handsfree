import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateState, normalizeProject } from "../dist/test/store.js";

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

test("normalizeProject: legacy Jira fields migrate into tracker", () => {
  const p = normalizeProject({ id: "p", name: "P", jql: "project = X", jiraSearchCommand: "acli custom {jql}", jiraCommentCommand: "-" });
  assert.deepEqual(p.tracker, { kind: "jira", query: "project = X", searchCommand: "acli custom {jql}", commentCommand: "-", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me" });
  assert.equal("jql" in p, false);
});

test("normalizeProject: a legacy empty Jira comment command keeps meaning 'never comment'", () => {
  assert.equal(normalizeProject({ jql: "x", jiraCommentCommand: "" }).tracker.commentCommand, "-");
  assert.equal(normalizeProject({ jql: "x" }).tracker.commentCommand, "-");
  assert.equal(normalizeProject({ jql: "x", jiraCommentCommand: "acli c {issue_key} {body}" }).tracker.commentCommand, "acli c {issue_key} {body}");
});

test("normalizeProject: tracker defaults per kind; unknown kind falls back to jira", () => {
  assert.equal(normalizeProject({ tracker: { kind: "github", query: "label:hf" } }).tracker.doneStatus, "closed");
  assert.equal(normalizeProject({ tracker: { kind: "linear" } }).tracker.doneStatus, "Done");
  assert.equal(normalizeProject({ tracker: { kind: "nope" } }).tracker.kind, "jira");
});

test("migrateState: accounts.linear defaults to logged out", () => {
  assert.deepEqual(migrateState({ tickets: {} }, { version: 1, settings: {}, projects: [] }).accounts.linear, { loggedIn: false });
});
