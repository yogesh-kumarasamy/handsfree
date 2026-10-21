// What keeps a project from being saved (or activated), and which editor step each problem belongs to.
import type { ProjectConfig } from "../engine/src/types";
import { checkName, type NamingConfig } from "../engine/src/naming";
import { parseCron } from "../engine/src/routines/cron";

export const STEPS = ["Repository", "Tracker", "MCP servers", "Agent chain", "Messaging", "Routines", "Review"];
export const ROUTINES = STEPS.indexOf("Routines");
/** Always the last step: computed so steps added before it don't shift a literal. */
export const REVIEW = STEPS.length - 1;

/** A ticket to preview the naming templates with; the key shape matches what trackers hand out. */
export const NAMING_SAMPLE = { key: "ABC-123", summary: "Add greeting to the README", type: "bug" };
export const NAMING_ROWS: { k: keyof NamingConfig; label: string; hint: string }[] = [
  { k: "branch", label: "Branch", hint: "Created at pick-up. {type} comes from the ticket's issue type or labels (bug, feature, spike, improvement…)." },
  { k: "commit", label: "Commit subject", hint: "Used for HandsFree's own commits and told to the agent. Agent commits that don't match the pattern are reworded to the template before the push." },
  { k: "prTitle", label: "PR title", hint: "Checked before the PR is opened." },
];

/** The first naming rule whose template can't satisfy its own pattern (or whose regex is invalid), as a sentence; "" when all is well. */
export function namingProblem(naming: NamingConfig): string {
  for (const row of NAMING_ROWS) {
    const r = checkName(naming[row.k], NAMING_SAMPLE);
    if (!r.ok) return `${row.label} naming: ${r.error}`;
  }
  return "";
}

/** The MCP JSON's parse error, if any. */
export function mcpJsonError(mcpJson: string): string | undefined {
  try {
    const parsed = JSON.parse(mcpJson || "{}");
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Must be a JSON object");
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export interface Problem {
  step: number;
  text: string;
}

/** Everything that must be fixed before the project can run, in step order. `repoOk === false` means the folder isn't a git repo. */
export function projectProblems(p: ProjectConfig, repoOk?: boolean): Problem[] {
  const tk = p.tracker;
  const list: [number, string | false | undefined][] = [
    [0, !p.name.trim() && "Give the project a name"],
    [0, !p.repoPath && "Choose a repository"],
    [0, repoOk === false && "The folder isn't a git repository"],
    [0, namingProblem(p.naming)],
    [1, tk.kind !== "linear" && !tk.query.trim() && (tk.kind === "jira" ? "Add a JQL" : "Add a tracker query")],
    [1, tk.kind === "linear" && !tk.query.trim() && !tk.linearState.trim() && "Set a Linear status or a text filter"],
    [2, mcpJsonError(p.mcpJson) && "MCP JSON is invalid"],
    [3, !p.agents.some((a) => a.enabled && a.command.trim()) && "Enable at least one agent with a command"],
    [4, p.messaging.platform !== "none" && !p.messaging.channelId && "Pick a collab channel (Messaging step)"],
    [ROUTINES, p.routines.some((r) => parseCron(r.schedule) instanceof Error) && "Fix the routine schedule(s)"],
  ];
  return list.filter((x): x is [number, string] => !!x[1]).map(([step, text]) => ({ step, text }));
}

/** Where "Continue setup" opens a draft: the first step with a problem, or Review when there is none. */
export function firstProblemStep(p: ProjectConfig): number {
  return projectProblems(p)[0]?.step ?? REVIEW;
}
