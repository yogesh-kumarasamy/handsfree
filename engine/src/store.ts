import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_RESUME, type Config, type EngineState, type ProjectConfig, type Settings } from "./types";

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
};

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

export function normalizeProject(p: Partial<ProjectConfig>): ProjectConfig {
  return {
    id: p.id || cryptoId(),
    name: p.name || "Untitled",
    enabled: p.enabled ?? true,
    repoPath: p.repoPath || "",
    baseBranch: p.baseBranch || "main",
    remote: p.remote || "origin",
    jql: p.jql || "",
    jiraSearchCommand: p.jiraSearchCommand ?? "",
    jiraCommentCommand: p.jiraCommentCommand ?? "",
    mcpJson: p.mcpJson ?? '{\n  "mcpServers": {}\n}',
    agents: (p.agents || []).slice(0, 4).map((a) => ({
      id: a.id || cryptoId(),
      name: a.name || "Agent",
      command: a.command || "",
      enabled: a.enabled ?? true,
      exhaustionPatterns: a.exhaustionPatterns || [],
      // Older Claude agents had no resume command; give them the standard one.
      resumeCommand: a.resumeCommand ?? (/^\s*claude\b/.test(a.command || "") ? CLAUDE_RESUME : ""),
      sessionIdPattern: a.sessionIdPattern || "",
    })),
    promptExtra: p.promptExtra || "",
    draftPr: p.draftPr ?? true,
    ciAutoFix: p.ciAutoFix ?? true,
    ciFixMaxRounds: clamp(p.ciFixMaxRounds, 0, 5, 2),
    mergeNudgeAfterMin: clamp(p.mergeNudgeAfterMin, 5, 1440, 30),
  };
}

function clamp(v: unknown, min: number, max: number, dflt: number) {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== undefined && v !== "" ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}

export function loadConfig(): Config {
  const raw = readJson<Partial<Config>>(CONFIG_FILE);
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, ...(raw?.settings || {}) },
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
