import { test } from "node:test";
import assert from "node:assert/strict";
import { ANYWHERE_NAMING, DEFAULT_NAMING, checkName, conformSubject, issueTypeOf, renderName, slugify, worktreeDirName } from "../dist/test/naming.js";

test("worktreeDirName: Jira keys are kept; a GitHub key's # (a URL fragment to Vite/esbuild) and other unsafe characters become dashes", () => {
  assert.equal(worktreeDirName("CHAT-2893"), "CHAT-2893");
  assert.equal(worktreeDirName("workspace#34"), "workspace-34");
  assert.equal(worktreeDirName("my.repo#5"), "my.repo-5");
  assert.equal(worktreeDirName("a b/c?d%e"), "a-b-c-d-e");
  assert.equal(worktreeDirName("##"), "ticket");
});

const vars = { key: "CHAT-2920", summary: "Pull request template with four review sections", type: "bug" };

test("slugify: kebab-case, ascii only, trimmed to the limit on a word boundary when possible", () => {
  assert.equal(slugify("Pull request template with four review sections"), "pull-request-template-with-four-review-sections");
  assert.equal(slugify("  Fix: CORS pre-flight (dashboard-api) !! "), "fix-cors-pre-flight-dashboard-api");
  assert.equal(slugify("Ünïcode & symbols → removed"), "unicode-symbols-removed");
  assert.equal(slugify("a very long summary that keeps going and going well past the limit we set", 30), "a-very-long-summary-that-keeps");
  assert.equal(slugify(""), "change");
});

test("renderName: fills {key} {summary} {slug} {type} {type_cc}", () => {
  assert.equal(renderName("{key}/{type}/{slug}", vars), "CHAT-2920/bug/pull-request-template-with-four-review-sections");
  assert.equal(renderName("{type_cc}: {key} {summary}", vars), "fix: CHAT-2920 Pull request template with four review sections");
  assert.equal(renderName("{type_cc}: {key} {summary}", { ...vars, type: "feature" }), "feat: CHAT-2920 Pull request template with four review sections");
  assert.equal(renderName("handsfree/{key}", vars), "handsfree/CHAT-2920");
});

test("renderName: unknown placeholders are left alone, a missing type falls back to feature", () => {
  assert.equal(renderName("{key}/{nope}", vars), "CHAT-2920/{nope}");
  assert.equal(renderName("{key}/{type}", { key: "X-1", summary: "s" }), "X-1/feature");
});

test("checkName: renders and validates against the pattern; empty pattern always passes", () => {
  const ok = checkName({ template: "{key}/{type}/{slug}", pattern: "^[A-Za-z]{1,10}-\\d+/(feature|bug)/.*" }, vars);
  assert.deepEqual(ok, { value: "CHAT-2920/bug/pull-request-template-with-four-review-sections", ok: true });
  const bad = checkName({ template: "handsfree/{key}", pattern: "^[A-Za-z]{1,10}-\\d+/(feature|bug)/.*" }, vars);
  assert.equal(bad.ok, false);
  assert.equal(bad.value, "handsfree/CHAT-2920");
  assert.match(bad.error, /doesn't match/);
  assert.equal(checkName({ template: "handsfree/{key}", pattern: "" }, vars).ok, true);
});

test("checkName: an invalid regex is reported, not thrown", () => {
  const r = checkName({ template: "{key}", pattern: "([" }, vars);
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid regex/);
});

test("conformSubject: a subject that matches is kept; one that doesn't is rewritten with the template, using the subject as the summary", () => {
  const rule = { template: "{type_cc}: {key} {summary}", pattern: ANYWHERE_NAMING.commit.pattern };
  assert.equal(conformSubject(rule, vars, "fix: CHAT-2920 add the template"), "fix: CHAT-2920 add the template");
  assert.equal(conformSubject(rule, vars, "CHAT-2920: point PR body guidance at pull-requests.md"), "fix: CHAT-2920 point PR body guidance at pull-requests.md");
  assert.equal(conformSubject(rule, vars, "add the template"), "fix: CHAT-2920 add the template");
  assert.equal(conformSubject(rule, vars, "Merge branch 'main' into CHAT-2920/bug/x"), "Merge branch 'main' into CHAT-2920/bug/x");
});

test("conformSubject: with no pattern every subject is kept", () => {
  assert.equal(conformSubject(DEFAULT_NAMING.commit, vars, "whatever"), "whatever");
});

test("issueTypeOf: maps tracker issue types and labels onto the branch type keywords", () => {
  assert.equal(issueTypeOf("Bug"), "bug");
  assert.equal(issueTypeOf("Defect"), "bug");
  assert.equal(issueTypeOf("Story"), "feature");
  assert.equal(issueTypeOf("Task"), "feature");
  assert.equal(issueTypeOf("Spike"), "spike");
  assert.equal(issueTypeOf("Improvement"), "improvement");
  assert.equal(issueTypeOf("Hotfix"), "hotfix");
  assert.equal(issueTypeOf(undefined), "feature");
  assert.equal(issueTypeOf(["enhancement", "bug"]), "bug");
  assert.equal(issueTypeOf([]), "feature");
});

test("ANYWHERE_NAMING: the conventionsbot rules accept what HandsFree generates", () => {
  const b = checkName(ANYWHERE_NAMING.branch, vars);
  assert.equal(b.ok, true, b.error);
  const c = checkName(ANYWHERE_NAMING.commit, vars);
  assert.equal(c.ok, true, c.error);
  const t = checkName(ANYWHERE_NAMING.prTitle, vars);
  assert.equal(t.ok, true, t.error);
  assert.equal(checkName({ ...ANYWHERE_NAMING.branch, template: "handsfree/{key}" }, vars).ok, false, "the old HandsFree branch is rejected");
});
