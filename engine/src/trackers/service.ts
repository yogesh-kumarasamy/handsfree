// Picks the tracker adapter for a project.
import { TRACKER_NOUN, type ProjectConfig } from "../types";
import type { TrackerAdapter, TrackerProject } from "./adapter";
import { GithubTracker } from "./github";
import { JiraTracker } from "./jira";

export class TrackerService {
  trackerFor(p: TrackerProject): TrackerAdapter {
    return p.tracker.kind === "github" ? new GithubTracker(p) : new JiraTracker(p);
  }

  noun(p: Pick<ProjectConfig, "tracker">) {
    return TRACKER_NOUN[p.tracker.kind];
  }
}
