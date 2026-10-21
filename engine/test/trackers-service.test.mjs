import { test } from "node:test";
import assert from "node:assert/strict";
import { TrackerService } from "../dist/test/trackers/service.js";

const project = (kind) => ({ repoPath: "", remote: "origin", tracker: { kind, query: "x", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "", repo: "o/r" } });

test("trackerFor: github gets the GitHub adapter, everything else Jira", () => {
  const s = new TrackerService();
  assert.equal(s.trackerFor(project("github")).kind, "github");
  assert.equal(s.trackerFor(project("jira")).kind, "jira");
  assert.equal(s.noun(project("github")), "GitHub issue");
  assert.equal(s.noun(project("jira")), "Jira ticket");
});
