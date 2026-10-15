import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_NAMING, type NamingConfig, type NamingRule } from "./naming";
import {
  CLAUDE_COMMAND,
  CLAUDE_RESUME,
  LEGACY_CLAUDE_COMMAND,
  DEFAULT_AGENT_MESSAGE_COMMAND,
  DEFAULT_DONE_STATUS,
  DEFAULT_LINEAR_ACCOUNT,
  DEFAULT_SETMORE_ACCOUNT,
  DEFAULT_TEMPLATES,
  type Config,
  type EngineState,
  type MessagingConfig,
  type ProjectConfig,
  type RoutineConfig,
  type Settings,
  type TrackerConfig,
  type TrackerKind,
} from "./types";

export const DATA_DIR =
  process.env.HF_DATA ||
  (process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "HandsFree")
    : path.join(os.homedir(), ".handsfree"));

export const LOG_DIR = path.join(DATA_DIR, "logs");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const STATE_FILE = path.join(DATA_DIR, "state.json");

fs.mkdirSync(LOG_DIR, { recursive: true });

export const DEFAULT_SETTINGS: Settings = {
  pollIntervalMin: 15,
  prPollIntervalMin: 3,
  maxParallel: 2,
  agentTimeoutMin: 90,
  slowAfterMin: 30,
  paused: false,
  notifications: true,
  launchAtLogin: false,
  accounts: { setmore: { ...DEFAULT_SETMORE_ACCOUNT }, linear: { ...DEFAULT_LINEAR_ACCOUNT } },
};

export function normalizeSettings(raw: Partial<Settings> | undefined): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.accounts = {
    setmore: { ...DEFAULT_SETMORE_ACCOUNT, ...(raw?.accounts?.setmore || {}) },
    linear: { ...DEFAULT_LINEAR_ACCOUNT, ...(raw?.accounts?.linear || {}) },
  };
  s.accounts.setmore.redirectPort = clamp(s.accounts.setmore.redirectPort, 1024, 65535, DEFAULT_SETMORE_ACCOUNT.redirectPort);
  s.accounts.linear.redirectPort = clamp(s.accounts.linear.redirectPort, 1024, 65535, DEFAULT_LINEAR_ACCOUNT.redirectPort);
  s.prPollIntervalMin = clamp(s.prPollIntervalMin, 1, 60, DEFAULT_SETTINGS.prPollIntervalMin);
  return s;
}

export function normalizeMessaging(m: Partial<MessagingConfig> | undefined): MessagingConfig {
  const platform = m?.platform === "setmore" || m?.platform === "agent" ? m.platform : "none";
  return {
    platform,
    channelId: m?.channelId || "",
    channelName: m?.channelName || "",
    templates: { ...DEFAULT_TEMPLATES, ...(m?.templates || {}) },
    agentCommand: m?.agentCommand ?? DEFAULT_AGENT_MESSAGE_COMMAND,
  };
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

type LegacyJiraFields = { jql?: string; jiraSearchCommand?: string; jiraCommentCommand?: string };

export function normalizeTracker(p: Partial<ProjectConfig> & LegacyJiraFields): TrackerConfig {
  const t = p.tracker as Partial<TrackerConfig> | undefined;
  if (!t) {
    // 0.1 config: Jira only. There an empty comment command meant "don't comment"; now "-" says that.
    return {
      kind: "jira",
      query: p.jql || "",
      searchCommand: p.jiraSearchCommand ?? "",
      commentCommand: p.jiraCommentCommand?.trim() ? p.jiraCommentCommand : "-",
      transitionCommand: "",
      doneStatus: "Done",
      repo: "",
      linearAssignee: "me",
      linearState: "Todo",
    };
  }
  const kind: TrackerKind = t.kind === "github" || t.kind === "linear" ? t.kind : "jira";
  return {
    kind,
    query: t.query || "",
    searchCommand: t.searchCommand ?? "",
    commentCommand: t.commentCommand ?? "",
    transitionCommand: t.transitionCommand ?? "",
    doneStatus: t.doneStatus ?? DEFAULT_DONE_STATUS[kind],
    repo: t.repo || "",
    linearAssignee: t.linearAssignee ?? "me",
    linearState: t.linearState ?? "Todo",
  };
}

export function normalizeProject(p: Partial<ProjectConfig> & LegacyJiraFields): ProjectConfig {
  return {
    id: p.id || cryptoId(),
    name: p.name || "Untitled",
    enabled: p.enabled ?? true,
    repoPath: p.repoPath || "",
    baseBranch: p.baseBranch || "main",
    remote: p.remote || "origin",
    tracker: normalizeTracker(p),
    mcpJson: p.mcpJson ?? '{\n  "mcpServers": {}\n}',
    agents: (p.agents || []).slice(0, 4).map((a) => ({
      id: a.id || cryptoId(),
      name: a.name || "Agent",
      // The stock Claude command moved its prompt to stdin so you can message the agent mid-run; customised ones are yours.
      command: (a.command || "").trim() === LEGACY_CLAUDE_COMMAND ? CLAUDE_COMMAND : a.command || "",
      enabled: a.enabled ?? true,
      exhaustionPatterns: a.exhaustionPatterns || [],
      // Older Claude agents had no resume command; give them the standard one.
      resumeCommand: a.resumeCommand ?? (/^\s*claude\b/.test(a.command || "") ? CLAUDE_RESUME : ""),
      sessionIdPattern: a.sessionIdPattern || "",
    })),
    promptExtra: p.promptExtra || "",
    naming: normalizeNaming(p.naming),
    draftPr: p.draftPr ?? true,
    ciAutoFix: p.ciAutoFix ?? true,
    ciFixMaxRounds: clamp(p.ciFixMaxRounds, 0, 5, 2),
    mergeNudgeAfterMin: clamp(p.mergeNudgeAfterMin, 5, 1440, 30),
    messaging: normalizeMessaging(p.messaging),
    routines: (p.routines || []).map(normalizeRoutine),
  };
}

/** Missing or blank templates fall back to HandsFree's classic names; patterns default to "no check". */
export function normalizeNaming(n: Partial<Record<keyof NamingConfig, Partial<NamingRule>>> | undefined): NamingConfig {
  const rule = (k: keyof NamingConfig): NamingRule => ({
    template: (n?.[k]?.template ?? "").trim() || DEFAULT_NAMING[k].template,
    pattern: (n?.[k]?.pattern ?? "").trim(),
  });
  return { branch: rule("branch"), commit: rule("commit"), prTitle: rule("prTitle") };
}

function clamp(v: unknown, min: number, max: number, dflt: number) {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== undefined && v !== "" ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}

export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(CONFIG_FILE);
  return {
    version: 1,
    settings: normalizeSettings(raw?.settings),
    projects: (raw?.projects || []).map(normalizeProject),
  };
}

export function saveConfig(cfg: Config) {
  writeJsonAtomic(CONFIG_FILE, cfg);
}

/** Upgrade a state file from an older HandsFree. Exported for tests. */
export function migrateState(raw: Partial<EngineState> | undefined, cfg: Config): EngineState {
  const tickets = raw?.tickets || {};
  for (const t of Object.values(tickets)) {
    // 0.1 had a single "pr_open"; the first PR check will set the exact status.
    if ((t.status as string) === "pr_open") {
      const p = cfg.projects.find((x) => x.id === t.projectId);
      t.status = p && p.draftPr === false ? "pr_ready" : "pr_draft";
    }
  }
  return {
    tickets,
    pollErrors: raw?.pollErrors || {},
    prCheckErrors: raw?.prCheckErrors || {},
    lastPollAt: raw?.lastPollAt,
    nextPollAt: raw?.nextPollAt,
    lastPrCheckAt: raw?.lastPrCheckAt,
    nextPrCheckAt: raw?.nextPrCheckAt,
    accounts: { setmore: raw?.accounts?.setmore || { loggedIn: false }, linear: raw?.accounts?.linear || { loggedIn: false } },
    routines: raw?.routines || {},
  };
}

export function loadState(cfg: Config): EngineState {
  return migrateState(readJson<Partial<EngineState>>(STATE_FILE), cfg);
}

export function saveState(state: EngineState) {
  writeJsonAtomic(STATE_FILE, state);
}

export function logFile(key: string) {
  return path.join(LOG_DIR, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.log`);
}

export function cryptoId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function normalizeRoutine(r: Partial<RoutineConfig>): RoutineConfig {
  return {
    id: r.id || cryptoId(),
    name: r.name || "Routine",
    enabled: r.enabled ?? true,
    schedule: typeof r.schedule === "string" ? r.schedule : "0 10 * * 1-5",
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    agentCommand: typeof r.agentCommand === "string" ? r.agentCommand : "",
    postToChannel: r.postToChannel ?? true,
    timeoutMin: clamp(r.timeoutMin, 1, 120, 15),
  };
}

export function routineLogFile(id: string) {
  return path.join(LOG_DIR, `routine-${id.replace(/[^A-Za-z0-9_-]/g, "_")}.log`);
}
