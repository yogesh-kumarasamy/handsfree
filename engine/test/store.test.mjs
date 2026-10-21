import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateState, normalizeProject, normalizeRoutine, normalizeSettings, withRequiredScope } from "../dist/test/store.js";

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

test("normalizeProject: legacy Jira fields migrate into tracker", () => {
  const p = normalizeProject({ id: "p", name: "P", jql: "project = X", jiraSearchCommand: "acli custom {jql}", jiraCommentCommand: "-" });
  assert.deepEqual(p.tracker, { kind: "jira", query: "project = X", searchCommand: "acli custom {jql}", commentCommand: "-", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me", linearState: "Todo", pickupLabel: "PICKUP_READY", inProgressStatus: "In Progress" });
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
  assert.equal(normalizeProject({ tracker: { kind: "linear" } }).tracker.linearState, "Todo");
  assert.equal(normalizeProject({ tracker: { kind: "linear", linearState: "" } }).tracker.linearState, "", "an explicitly empty status stays empty");
  assert.equal(normalizeProject({ tracker: { kind: "nope" } }).tracker.kind, "jira");
});

test("migrateState: accounts.linear defaults to logged out", () => {
  assert.deepEqual(migrateState({ tickets: {} }, { version: 1, settings: {}, projects: [] }).accounts.linear, { loggedIn: false });
});

test("normalizeProject: the old Claude preset command is upgraded to the stream-json input form", () => {
  const old = "claude -p {prompt} --mcp-config {mcp_file} --output-format stream-json --verbose --dangerously-skip-permissions";
  const p = normalizeProject({ id: "p1", agents: [{ id: "a", name: "Claude Code", command: old }] });
  assert.equal(
    p.agents[0].command,
    "claude -p --input-format stream-json --output-format stream-json --verbose --mcp-config {mcp_file} --dangerously-skip-permissions",
  );
});

test("normalizeProject: naming defaults to HandsFree's old names with no patterns; partial configs are filled in", () => {
  const p = normalizeProject({ id: "p1" });
  assert.deepEqual(p.naming, {
    branch: { template: "handsfree/{key}", pattern: "" },
    commit: { template: "{key}: {summary}", pattern: "" },
    prTitle: { template: "{key}: {summary}", pattern: "" },
  });
  const q = normalizeProject({ id: "p1", naming: { branch: { template: "{key}/{type}/{slug}", pattern: "^X" } } });
  assert.deepEqual(q.naming.branch, { template: "{key}/{type}/{slug}", pattern: "^X" });
  assert.deepEqual(q.naming.commit, { template: "{key}: {summary}", pattern: "" });
  const r = normalizeProject({ id: "p1", naming: { branch: { template: "   ", pattern: "" } } });
  assert.equal(r.naming.branch.template, "handsfree/{key}", "a blank template falls back to the default");
});

test("normalizeProject: old default Jira searches gain issuetype and labels ({type}, pickup label)", () => {
  const old = 'acli jira workitem search --jql {jql} --fields "key,summary,description" --limit 50 --json';
  const tracker = { kind: "jira", query: "project = X", searchCommand: old, commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me", linearState: "" };
  const p = normalizeProject({ id: "p1", tracker });
  const now = 'acli jira workitem search --jql {jql} --fields "key,summary,description,issuetype,labels" --limit 50 --json';
  assert.equal(p.tracker.searchCommand, now);
  const withType = 'acli jira workitem search --jql {jql} --fields "key,summary,description,issuetype" --limit 50 --json';
  assert.equal(normalizeProject({ id: "p1", tracker: { ...tracker, searchCommand: withType } }).tracker.searchCommand, now);
  const custom = normalizeProject({ id: "p1", tracker: { ...tracker, searchCommand: "mytool search {jql}" } });
  assert.equal(custom.tracker.searchCommand, "mytool search {jql}");
});

test("normalizeProject: a customised Claude command is left alone", () => {
  const custom = "claude -p {prompt} --model opus --output-format stream-json --verbose";
  const p = normalizeProject({ id: "p1", agents: [{ id: "a", name: "Claude Code", command: custom }] });
  assert.equal(p.agents[0].command, custom);
});

test("saved Setmore scopes without the server's required scope get it appended; present ones are kept as-is", () => {
  const required = "setmore.apis-internal.fullaccess";
  assert.equal(withRequiredScope("openid offline_access awapis.streams.read", required), `openid offline_access awapis.streams.read ${required}`);
  assert.equal(withRequiredScope(` openid  ${required} awapis.users.read `, required), `openid ${required} awapis.users.read`);
  assert.equal(withRequiredScope(undefined, required), required);
  const s = normalizeSettings({ accounts: { setmore: { clientId: "cid", scopes: "openid offline_access awapis.chat.streams.push" } } });
  assert.equal(s.accounts.setmore.scopes, `openid offline_access awapis.chat.streams.push ${required}`);
  assert.equal(s.accounts.setmore.clientId, "cid");
  assert.match(normalizeSettings(undefined).accounts.setmore.scopes, /\bsetmore\.apis-internal\.fullaccess\b/);
});

test("normalizeProject: pickup label defaults on; in-progress status per kind, never for GitHub", () => {
  const jira = normalizeProject({ tracker: { kind: "jira", query: "x" } }).tracker;
  assert.equal(jira.pickupLabel, "PICKUP_READY");
  assert.equal(jira.inProgressStatus, "In Progress");
  assert.equal(normalizeProject({ tracker: { kind: "linear" } }).tracker.inProgressStatus, "In Progress");
  assert.equal(normalizeProject({ tracker: { kind: "github", query: "x", inProgressStatus: "In Progress" } }).tracker.inProgressStatus, "", "GitHub's transition closes the issue");
  assert.equal(normalizeProject({ tracker: { kind: "jira", query: "x", pickupLabel: "", inProgressStatus: "" } }).tracker.pickupLabel, "", "empty = pick up everything");
  assert.equal(normalizeProject({ jql: "x" }).tracker.pickupLabel, "PICKUP_READY", "0.1 configs too");
});

test("normalizeProject: the old default GitHub search gains labels; a custom one is kept", () => {
  const tracker = { kind: "github", query: "label:hf", searchCommand: "gh issue list --repo {repo} --search {query} --state open --limit 50 --json number,title,body,url" };
  assert.match(normalizeProject({ tracker }).tracker.searchCommand, /--json number,title,body,url,labels$/);
  assert.equal(normalizeProject({ tracker: { ...tracker, searchCommand: "gh issue list --repo {repo}" } }).tracker.searchCommand, "gh issue list --repo {repo}");
});
