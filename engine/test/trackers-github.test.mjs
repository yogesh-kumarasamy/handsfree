import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubTracker, parseGithubIssues, parseRepoFromRemote } from "../dist/test/trackers/github.js";
import { hasLabel } from "../dist/test/trackers/adapter.js";

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

test("GithubTracker.repo: a pasted URL, trailing slash or .git all resolve to owner/name", async () => {
  const mk = (repo) => new GithubTracker({ repoPath: "", remote: "origin", tracker: { kind: "github", repo, query: "is:open", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "", linearAssignee: "", linearState: "" } }, async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }));
  for (const v of ["acme/repo", "https://github.com/acme/repo", "https://github.com/acme/repo/", "https://github.com/acme/repo.git", "github.com/acme/repo", " acme/repo "]) {
    assert.equal(await mk(v).repo(), "acme/repo", v);
  }
});

test("parseGithubIssues: labels give the branch type (bug label → bug, otherwise feature; no labels → unset)", () => {
  const j = parseGithubIssues(
    JSON.stringify([
      { number: 1, title: "A", labels: [{ name: "enhancement" }, { name: "bug" }] },
      { number: 2, title: "B", labels: [{ name: "docs" }] },
      { number: 3, title: "C", labels: [] },
    ]),
    "repo",
  );
  assert.deepEqual(j.map((i) => i.type), ["bug", "feature", undefined]);
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

test("parseGithubIssues: label names are kept; hasLabel ignores case", () => {
  const [i] = parseGithubIssues(JSON.stringify([{ number: 1, title: "A", labels: [{ name: "pickup_ready" }, { name: "bug" }] }]), "repo");
  assert.deepEqual(i.labels, ["pickup_ready", "bug"]);
  assert.equal(hasLabel(i.labels, "PICKUP_READY"), true);
  assert.equal(hasLabel(i.labels, "ready"), false);
  assert.equal(hasLabel(undefined, "PICKUP_READY"), false);
  assert.equal(hasLabel(["x"], " "), false, "an empty label never matches");
});

test("GithubTracker.addLabel: gh issue edit --add-label; a missing repo label is created, then the edit retried", async () => {
  const calls = [];
  let created = false;
  const run = async (cmd) => {
    calls.push(cmd);
    if (cmd.startsWith("gh label create")) created = true;
    if (cmd.startsWith("gh issue edit") && !created) return { code: 1, stdout: "", stderr: "could not add label: 'PICKUP_READY' not found", timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  const p = { repoPath: "", remote: "origin", tracker: { kind: "github", query: "label:hf", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "closed", repo: "acme/repo", linearAssignee: "" } };
  assert.deepEqual(await new GithubTracker(p, run).addLabel({ key: "repo#12", trackerId: "12" }, "PICKUP_READY"), { skipped: false });
  assert.equal(calls[0], "gh issue edit '12' --repo 'acme/repo' --add-label 'PICKUP_READY'");
  assert.match(calls[1], /^gh label create 'PICKUP_READY' --repo 'acme\/repo' .*--force$/);
  assert.equal(calls[2], calls[0]);
  const denied = async () => ({ code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible", timedOut: false });
  await assert.rejects(new GithubTracker(p, denied).addLabel({ key: "repo#12", trackerId: "12" }, "PICKUP_READY"), /403/);
});
