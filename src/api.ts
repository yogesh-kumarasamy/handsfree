import type { Config, EngineEvent, EngineState, FoundIssue, ProjectConfig } from "../engine/src/types";
import { createMockApi } from "./mock";

export interface RepoInfo {
  ok: boolean;
  toplevel?: string;
  defaultBranch?: string;
  remotes?: string[];
  error?: string;
}

export interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Api {
  getConfig(): Promise<Config>;
  saveConfig(cfg: Config): Promise<Config>;
  getState(): Promise<EngineState>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  pollNow(): Promise<void>;
  retry(key: string): Promise<void>;
  stop(key: string): Promise<void>;
  cleanup(key: string): Promise<void>;
  forget(key: string): Promise<void>;
  getLog(key: string): Promise<string>;
  /**
   * Open the ticket in Terminal, for any agent. Running → live output (Enter there = take over).
   * Failed/stopped/yours → continue the agent's session right away.
   */
  open(key: string): Promise<{ command: string }>;
  /** Give a taken-over ticket back: "pr" opens a PR with your changes, "agents" re-runs the chain. */
  handBack(key: string, mode: "pr" | "agents"): Promise<void>;
  testJira(project: ProjectConfig): Promise<{ issues: FoundIssue[]; error?: string; raw?: string }>;
  repoInfo(path: string): Promise<RepoInfo>;
  doctor(): Promise<DoctorItem[]>;
  subscribe(cb: (e: EngineEvent) => void): () => void;
}

declare global {
  interface Window {
    __HF_DEMO__?: DemoOptions;
    __TAURI_INTERNALS__?: unknown;
  }
}

export interface DemoOptions {
  scenario: "empty" | "busy";
  view?: "dashboard" | "projects" | "settings";
  editorStep?: number;
  editorNew?: boolean;
  ticket?: string;
  jiraTested?: boolean;
}

export const isTauri = () => typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

function createHttpApi(base: string, token: string): Api {
  const call = async <T>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "x-handsfree-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || res.statusText);
    return (text ? JSON.parse(text) : undefined) as T;
  };
  // POST that surfaces the engine's {"error": "..."} message as a plain Error.
  const action = <T>(path: string, body: unknown): Promise<T> =>
    call<T>(path, "POST", body).catch((e) => {
      let msg = String((e as Error).message || e);
      try {
        msg = JSON.parse(msg).error || msg;
      } catch {
        /* plain text */
      }
      throw new Error(msg);
    });
  return {
    getConfig: () => call("/api/config"),
    saveConfig: (cfg) => call("/api/config", "PUT", cfg),
    getState: () => call("/api/state"),
    pause: () => call("/api/pause", "POST"),
    resume: () => call("/api/resume", "POST"),
    pollNow: () => call("/api/poll-now", "POST"),
    retry: (k) => call(`/api/tickets/${encodeURIComponent(k)}/retry`, "POST"),
    stop: (k) => call(`/api/tickets/${encodeURIComponent(k)}/stop`, "POST"),
    cleanup: (k) => call(`/api/tickets/${encodeURIComponent(k)}/cleanup`, "POST"),
    forget: (k) => call(`/api/tickets/${encodeURIComponent(k)}/forget`, "POST"),
    getLog: async (k) => (await call<{ log: string }>(`/api/tickets/${encodeURIComponent(k)}/log`)).log,
    open: (k) => action(`/api/tickets/${encodeURIComponent(k)}/open`, {}),
    handBack: (k, mode) => action(`/api/tickets/${encodeURIComponent(k)}/handback`, { mode }),
    testJira: (project) => call("/api/test-jira", "POST", { project }),
    repoInfo: (path) => call("/api/repo-info", "POST", { path }),
    doctor: () => call("/api/doctor"),
    subscribe(cb) {
      let es: EventSource | undefined;
      let closed = false;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const open = () => {
        es = new EventSource(`${base}/api/events?token=${encodeURIComponent(token)}`);
        es.onmessage = (m) => cb(JSON.parse(m.data));
        es.onerror = () => {
          es?.close();
          if (!closed) retry = setTimeout(open, 2000);
        };
      };
      open();
      return () => {
        closed = true;
        clearTimeout(retry);
        es?.close();
      };
    },
  };
}

let apiPromise: Promise<Api> | undefined;

/** Demo only: drop the cached API so a new scenario gets fresh mock data. */
export function resetApi() {
  apiPromise = undefined;
}

export function getApi(): Promise<Api> {
  if (!apiPromise) {
    apiPromise = (async () => {
      if (window.__HF_DEMO__ || !isTauri()) return createMockApi(window.__HF_DEMO__ || { scenario: "busy" });
      const { invoke } = await import("@tauri-apps/api/core");
      // The engine may still be starting; wait until it answers.
      for (let i = 0; i < 50; i++) {
        const info = await invoke<{ port: number; token: string }>("get_engine_info");
        const base = `http://127.0.0.1:${info.port}`;
        try {
          const r = await fetch(`${base}/api/health`);
          if (r.ok) return createHttpApi(base, info.token);
        } catch {
          /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error("The HandsFree engine did not start. Is Node.js installed (`node -v` in Terminal)?");
    })();
  }
  return apiPromise;
}

// ---- Mac platform helpers (no-ops in the browser demo) ----

export async function pickFolder(): Promise<string | null> {
  if (!isTauri()) return "/Users/yogesh/code/chatsupport-web";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: true, multiple: false, title: "Choose the git repository" });
  return typeof r === "string" ? r : null;
}

export async function notify(title: string, body: string) {
  if (!isTauri()) return;
  const n = await import("@tauri-apps/plugin-notification");
  let granted = await n.isPermissionGranted();
  if (!granted) granted = (await n.requestPermission()) === "granted";
  if (granted) n.sendNotification({ title, body });
}

export async function setLaunchAtLogin(on: boolean) {
  if (!isTauri()) return;
  const a = await import("@tauri-apps/plugin-autostart");
  if (on) await a.enable();
  else await a.disable();
}

export async function onTrayTogglePause(cb: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("tray-toggle-pause", cb);
}

export async function openExternal(url: string) {
  if (!isTauri()) {
    window.open(url, "_blank");
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_url", { url });
}
