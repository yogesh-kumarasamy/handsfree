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
}

export interface Settings {
  pollIntervalMin: number;
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

/** "manual" = you took over; HandsFree leaves it alone until you hand it back. */
export type TicketStatus = "queued" | "running" | "manual" | "pr_open" | "failed" | "stopped" | "done";

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
