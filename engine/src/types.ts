// Shared between the engine and the React UI.

export interface AgentConfig {
  id: string;
  name: string;
  /** Shell command template. Placeholders: {prompt} {prompt_file} {mcp_file} {issue_key} {worktree} {branch}. Don't wrap them in quotes — HandsFree quotes them. */
  command: string;
  enabled: boolean;
  /** Case-insensitive regexes checked against the tail of the agent's output. A match = token/usage exhausted → next agent. */
  exhaustionPatterns: string[];
  /**
   * Interactive command to continue this agent's session when you take over.
   * Placeholders: {session_id} {mcp_file} {worktree} {issue_key}. Empty = plain shell in the worktree.
   */
  resumeCommand?: string;
  /** Regex with one capture group that finds the session id in the agent's output (Claude's stream-json is built in). */
  sessionIdPattern?: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** Absolute path to the git repo. */
  repoPath: string;
  baseBranch: string;
  remote: string;
  jql: string;
  /** Placeholders: {jql}. Must print JSON (or text containing issue keys). */
  jiraSearchCommand: string;
  /** Placeholders: {issue_key} {body}. Leave empty to skip the Jira comment. */
  jiraCommentCommand: string;
  /** Project-level MCP servers, e.g. {"mcpServers": {...}}. Written to {mcp_file} in each worktree. */
  mcpJson: string;
  agents: AgentConfig[];
  /** Extra instructions appended to every prompt for this project. */
  promptExtra: string;
  draftPr: boolean;
  /** When CI fails on the PR, run the agent chain in the same worktree with the failing logs. */
  ciAutoFix: boolean;
  /** Automatic CI fix rounds per PR before the ticket needs you (0..5). Manual "Fix CI" ignores this. */
  ciFixMaxRounds: number;
  /** Minutes an approved PR may wait before HandsFree raises a merge nudge (5..1440). */
  mergeNudgeAfterMin: number;
}

export interface Settings {
  pollIntervalMin: number;
  /** How often open PRs are checked on GitHub (1..60 min). */
  prPollIntervalMin: number;
  maxParallel: number;
  agentTimeoutMin: number;
  /** Flag a running agent as slow (and notify) after this many minutes. */
  slowAfterMin: number;
  paused: boolean;
  notifications: boolean;
  launchAtLogin: boolean;
}

export interface Config {
  version: 1;
  settings: Settings;
  projects: ProjectConfig[];
}

/**
 * Work phase: queued → running → (manual | failed | stopped).
 * PR phase: pr_draft | pr_ready | pr_ci_failed | pr_approved → merged | done.
 * "manual" = you took over. "done" = PR closed without merge (and legacy tickets).
 * A CI fix in progress is "running" with `ticket.fix` set.
 */
export type TicketStatus =
  | "queued"
  | "running"
  | "manual"
  | "failed"
  | "stopped"
  | "pr_draft"
  | "pr_ready"
  | "pr_ci_failed"
  | "pr_approved"
  | "merged"
  | "done";

/** Statuses with an open PR that the PR check keeps polling. */
export const PR_STATUSES: readonly TicketStatus[] = ["pr_draft", "pr_ready", "pr_ci_failed", "pr_approved"];

export type CiStatus = "none" | "pending" | "passing" | "failing";

export interface FailedCheck {
  name: string;
  detailsUrl?: string;
  /** GitHub Actions run id parsed from detailsUrl, when it is an Actions job. */
  runId?: string;
}

export interface PrInfo {
  url: string;
  number: number;
  draft: boolean;
  state: "open" | "merged" | "closed";
  headSha: string;
  ci: CiStatus;
  failedChecks: FailedCheck[];
  reviewDecision: "" | "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";
  /** Newest approving review's submittedAt from GitHub. Cleared if the decision changes. */
  approvedAt?: string;
  mergedAt?: string;
  /** Set when the review_ready event fired. Once per PR. */
  reviewRequestedAt?: string;
  /** Set when the merge_nudge event fired. Once per PR. */
  mergeNudgedAt?: string;
  /** Completed CI-fix rounds on this PR. */
  fixRounds: number;
  /** Head SHA the last fix round was started for; prevents re-fixing the same failure. */
  lastFixSha?: string;
  checkedAt: string;
}

export interface FixContext {
  /** 1-based. */
  round: number;
  /** The failing commit. */
  headSha: string;
  failedChecks: FailedCheck[];
  /** Trimmed failing-step logs. */
  logs: string;
  requestedAt: string;
}

export type PrEventKind = "review_ready" | "merge_nudge" | "merged" | "ci_fix_exhausted";

export interface PrEvent {
  kind: PrEventKind;
  key: string;
  prUrl: string;
  projectId: string;
  at: string;
}

export type AttemptOutcome = "success" | "exhausted" | "failed" | "no_changes" | "timeout" | "stopped" | "taken_over";

export interface Attempt {
  agentName: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  outcome?: AttemptOutcome;
  note?: string;
  /** Claude Code session id (from stream-json), so you can `claude --resume` it later. */
  sessionId?: string;
}

export interface Ticket {
  key: string;
  projectId: string;
  summary: string;
  description?: string;
  status: TicketStatus;
  branch: string;
  worktree: string;
  baseRef?: string;
  /** Index into the project's enabled agent chain the next run starts from. */
  agentIndex: number;
  currentAgent?: string;
  attempts: Attempt[];
  prUrl?: string;
  /** What GitHub last told us about the PR. Absent until the first PR check. */
  pr?: PrInfo;
  /** Present while a CI fix is queued or running. */
  fix?: FixContext;
  /** Set while the current agent has run longer than settings.slowAfterMin. */
  slow?: boolean;
  jiraCommented?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EngineState {
  tickets: Record<string, Ticket>;
  lastPollAt?: string;
  nextPollAt?: string;
  pollErrors: Record<string, string>;
  lastPrCheckAt?: string;
  nextPrCheckAt?: string;
  /** Per ticket key: the last `gh` error from the PR check. */
  prCheckErrors: Record<string, string>;
}

export interface FoundIssue {
  key: string;
  summary: string;
  description?: string;
}

export type EngineEvent =
  | { type: "state"; state: EngineState }
  | { type: "config"; config: Config }
  | { type: "log"; key: string; chunk: string }
  | { type: "notify"; title: string; body: string; kind: NotifyKind };

export type NotifyKind = "pr" | "fallback" | "failed" | "slow" | "info";

export const CLAUDE_RESUME = "claude --resume {session_id} --mcp-config {mcp_file}";

export const DEFAULT_EXHAUSTION_PATTERNS = [
  "rate.?limit",
  "usage limit",
  "quota",
  "credit balance",
  "limit reached",
  "out of (tokens|credits)",
  "too many requests",
  "\\b429\\b",
];

export const AGENT_PRESETS: Omit<AgentConfig, "id">[] = [
  {
    name: "Claude Code",
    command: "claude -p {prompt} --mcp-config {mcp_file} --output-format stream-json --verbose --dangerously-skip-permissions",
    enabled: true,
    exhaustionPatterns: DEFAULT_EXHAUSTION_PATTERNS,
    resumeCommand: "claude --resume {session_id} --mcp-config {mcp_file}",
  },
  {
    name: "Grok",
    command: "grok --prompt {prompt}",
    enabled: true,
    exhaustionPatterns: DEFAULT_EXHAUSTION_PATTERNS,
  },
  {
    name: "Antigravity",
    command: "",
    enabled: false,
    exhaustionPatterns: DEFAULT_EXHAUSTION_PATTERNS,
  },
];

export const DEFAULT_JIRA_SEARCH =
  'acli jira workitem search --jql {jql} --fields "key,summary,description" --limit 50 --json';
export const DEFAULT_JIRA_COMMENT = "acli jira workitem comment create --key {issue_key} --body {body}";
