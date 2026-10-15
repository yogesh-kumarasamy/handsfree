// One interface for every ticket tracker: find work, comment on it, move it to "done" on merge.
import { sh, type RunOpts, type RunResult } from "../shell";
import type { FoundIssue, ProjectConfig, Ticket, TrackerKind } from "../types";

export type TicketRef = Pick<Ticket, "key" | "trackerId">;

/**
 * `skipped` with a `reason`: the tracker couldn't do it (logged on the ticket). `skipped` without one: the project
 * asked for nothing (no done status, comment command "-").
 */
export interface StepResult {
  skipped: boolean;
  reason?: string;
}

export interface TrackerAdapter {
  readonly kind: TrackerKind;
  /** "Jira ticket" / "GitHub issue" / "Linear issue" — for prompts and logs. */
  readonly noun: string;
  search(): Promise<FoundIssue[]>;
  comment(t: TicketRef, body: string): Promise<StepResult>;
  /** Move to `status`; `skipped` when there is no status or the tracker can't (then with a `reason`). */
  transition(t: TicketRef, status: string): Promise<StepResult>;
}

/** The project fields a tracker reads. */
export type TrackerProject = Pick<ProjectConfig, "repoPath" | "tracker"> & Partial<Pick<ProjectConfig, "remote">>;

/** Runs a shell command (test seam). */
export type Run = (cmd: string, opts?: RunOpts) => Promise<RunResult>;
export const defaultRun: Run = (cmd, opts) => sh(cmd, opts);

/** First lines of a failed command's output, for error messages. */
export function failure(r: RunResult) {
  return (r.stderr || r.stdout).trim().slice(0, 600) || `exit ${r.code}`;
}
