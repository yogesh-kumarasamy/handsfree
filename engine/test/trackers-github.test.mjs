import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubTracker, parseGithubIssues, parseRepoFromRemote } from "../dist/test/trackers/github.js";

test("parseRepoFromRemote: ssh, https, ssh://, non-github", () => {
  assert.equal(parseRepoFromRemote("git@github.com:acme/repo.git"), "acme/repo");
  assert.equal(parseRepoFromRemote("https://github.com/acme/repo"), "acme/repo");
  assert.equal(parseRepoFromRemote("https://github.com/acme/repo.git/"), "acme/repo");
  assert.equal(parseRepoFromRemote("ssh://git@github.com/acme/repo.git"), "acme/repo");
  assert.equal(parseRepoFromRemote("https://gitlab.com/acme/repo.git"), undefined);
});

test("parseGithubIssues: JSON and text fallback, key = repo#number", () => {
  const j = parseGithubIssues(JSON.stringify([{ number: 12, title: "Fix login", body: "steps", url: "https://github.com/acme/repo/issues/12" }]), "repo");
  assert.deepEqual(j, [{ key: "repo#12", summary: "Fix login", description: "steps", id: "12", url: "https://github.com/acme/repo/issues/12" }]);
  assert.deepEqual(parseGithubIssues("#7  Crash on save\n#8\tSlow list", "repo").map((i) => [i.key, i.summary]), [["repo#7", "Crash on save"], ["repo#8", "Slow list"]]);
});

test("GithubTracker: search/comment/close commands with the resolved repo; empty doneStatus skips", async () => {
  const calls = [];
  const run = async (cmd) => { calls.push(cmd); return { code: 0, stdout: cmd.includes("issue list") ? "[]" : "", stderr: "", timedOut: false }; };
  const p = { repoPath: "", remote: "origin", tracker: { kind: "github", query: "label:hf", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "closed", repo: "acme/repo", linearAssignee: "" } };
  const g = new GithubTracker(p, run);
  await g.search();
  assert.match(calls[0], /^gh issue list --repo 'acme\/repo' --search 'label:hf' --state open --limit 50 --json/);
  await g.comment({ key: "repo#12", trackerId: "12" }, "hi there");
  assert.match(calls[1], /^gh issue comment '12' --repo 'acme\/repo' --body 'hi there'$/);
  await g.transition({ key: "repo#12" }, "closed");
  assert.match(calls[2], /^gh issue close '12' --repo 'acme\/repo' --reason completed$/);
  assert.deepEqual(await new GithubTracker({ ...p, tracker: { ...p.tracker, doneStatus: "" } }, run).transition({ key: "repo#12" }, ""), { skipped: true });
  await assert.rejects(new GithubTracker({ ...p, tracker: { ...p.tracker, repo: "" }, repoPath: "/nonexistent" }, run).search(), /Set the GitHub repo/);
});

test("GithubTracker: repo derived from the project's remote; '-' comment command skips", async () => {
  const calls = [];
  const run = async (cmd) => {
    calls.push(cmd);
    if (cmd.startsWith("git ")) return { code: 0, stdout: "git@github.com:acme/widgets.git\n", stderr: "", timedOut: false };
    return { code: 0, stdout: '[{"number":3,"title":"T","body":"","url":"u"}]', stderr: "", timedOut: false };
  };
  const p = { repoPath: "/r", remote: "upstream", tracker: { kind: "github", query: "is:open", searchCommand: "", commentCommand: "-", transitionCommand: "", doneStatus: "closed", repo: "", linearAssignee: "" } };
  const g = new GithubTracker(p, run);
  const found = await g.search();
  assert.match(calls[0], /remote get-url 'upstream'/);
  assert.equal(found[0].key, "widgets#3");
  assert.match(calls[1], /--repo 'acme\/widgets'/);
  assert.deepEqual(await g.comment({ key: "widgets#3", trackerId: "3" }, "x"), { skipped: true });
});
