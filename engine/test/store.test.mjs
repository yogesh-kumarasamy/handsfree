import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateState, normalizeProject, normalizeRoutine, normalizeSettings } from "../dist/test/store.js";
import { DEFAULT_AGENT_MESSAGE_COMMAND, DEFAULT_TEMPLATES } from "../dist/test/types.js";

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
  assert.deepEqual(p.tracker, { kind: "jira", query: "project = X", searchCommand: "acli custom {jql}", commentCommand: "-", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me", linearState: "Todo" });
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

test("normalizeProject: the old default Jira search command gains issuetype so {type} can be derived", () => {
  const old = 'acli jira workitem search --jql {jql} --fields "key,summary,description" --limit 50 --json';
  const tracker = { kind: "jira", query: "project = X", searchCommand: old, commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me", linearState: "" };
  const p = normalizeProject({ id: "p1", tracker });
  assert.equal(p.tracker.searchCommand, 'acli jira workitem search --jql {jql} --fields "key,summary,description,issuetype" --limit 50 --json');
  const custom = normalizeProject({ id: "p1", tracker: { ...tracker, searchCommand: "mytool search {jql}" } });
  assert.equal(custom.tracker.searchCommand, "mytool search {jql}");
});

test("normalizeProject: a customised Claude command is left alone", () => {
  const custom = "claude -p {prompt} --model opus --output-format stream-json --verbose";
  const p = normalizeProject({ id: "p1", agents: [{ id: "a", name: "Claude Code", command: custom }] });
  assert.equal(p.agents[0].command, custom);
});

test("normalizeProject: a Setmore-direct project becomes an agent project with the default command; channel and templates kept", () => {
  const p = normalizeProject({
    id: "p1",
    messaging: { platform: "setmore", channelId: "nN0p", channelName: "ChatSupport Team Core", templates: { reviewReady: "eyes on {pr_url}" }, agentCommand: "old {prompt}" },
  });
  assert.equal(p.messaging.platform, "agent");
  assert.equal(p.messaging.agentCommand, DEFAULT_AGENT_MESSAGE_COMMAND);
  assert.equal(p.messaging.channelId, "nN0p");
  assert.equal(p.messaging.channelName, "ChatSupport Team Core");
  assert.equal(p.messaging.templates.reviewReady, "eyes on {pr_url}");
  assert.equal(p.messaging.templates.bulk, DEFAULT_TEMPLATES.bulk);
  // Agent projects keep their own command; unknown platforms are off.
  assert.equal(normalizeProject({ messaging: { platform: "agent", agentCommand: "my {prompt}" } }).messaging.agentCommand, "my {prompt}");
  assert.equal(normalizeProject({ messaging: { platform: "slack" } }).messaging.platform, "none");
});

test("settings: an old accounts.setmore block loads and is dropped; settings without it load", () => {
  const old = normalizeSettings({ pollIntervalMin: 7, accounts: { setmore: { clientId: "cid", scopes: "openid" }, linear: { redirectPort: 50000 } } });
  assert.equal(old.pollIntervalMin, 7);
  assert.deepEqual(Object.keys(old.accounts), ["linear"]);
  assert.equal(old.accounts.linear.redirectPort, 50000);
  const fresh = normalizeSettings({ accounts: { linear: {} } });
  assert.deepEqual(Object.keys(fresh.accounts), ["linear"]);
  assert.equal(normalizeSettings(undefined).accounts.setmore, undefined);
});

test("migrateState: an old accounts.setmore status is dropped", () => {
  const s = migrateState({ tickets: {}, accounts: { setmore: { loggedIn: true }, linear: { loggedIn: true } } }, { version: 1, settings: {}, projects: [] });
  assert.deepEqual(s.accounts, { linear: { loggedIn: true } });
});
