import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const SHELL = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";

/** Single-quote a value for a POSIX shell. */
export function q(s: string) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Fill {placeholders} in a user command template with shell-quoted values. Unknown placeholders are left as-is. */
export function fill(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? q(vars[k]) : m));
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOpts {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onData?: (chunk: string) => void;
  /** "pipe" keeps stdin open so the caller can `write` to the child (agents that take messages mid-run). Default: no stdin. */
  stdin?: "pipe" | "ignore";
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
  }, 5000).unref();
}

export interface Running {
  done: Promise<RunResult>;
  kill: () => void;
  /** Write to the child's stdin (no-op unless started with stdin: "pipe", or after it exited). */
  write: (text: string) => void;
  /** Close the child's stdin (EOF). Safe to call more than once. */
  endInput: () => void;
}

/** Spawn a program (no shell) or a shell command (file = SHELL, args = ["-c", cmd]) in its own process group. */
export function start(file: string, args: string[], opts: RunOpts = {}): Running {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true, // own process group, so we can kill the agent and everything it spawned
    stdio: [opts.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
  });
  // A write after the child is gone raises EPIPE asynchronously; swallow it so callers never crash the engine.
  child.stdin?.on("error", () => {});
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const cap = (s: string, add: string) => (s.length > 2_000_000 ? s.slice(-1_000_000) : s) + add;
  child.stdout!.setEncoding("utf8").on("data", (d: string) => {
    stdout = cap(stdout, d);
    opts.onData?.(d);
  });
  child.stderr!.setEncoding("utf8").on("data", (d: string) => {
    stderr = cap(stderr, d);
    opts.onData?.(d);
  });
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, opts.timeoutMs)
    : undefined;
  const done = new Promise<RunResult>((resolve) => {
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(e.message), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
  const stdin = child.stdin;
  return {
    done,
    kill: () => killTree(child),
    write: (text) => {
      if (stdin && !stdin.destroyed && stdin.writable) stdin.write(text);
    },
    endInput: () => {
      if (stdin && !stdin.destroyed && stdin.writable) stdin.end();
    },
  };
}

export const exec = (file: string, args: string[], opts?: RunOpts) => start(file, args, opts).done;
export const sh = (cmd: string, opts?: RunOpts) => start(SHELL, ["-c", cmd], opts).done;

/**
 * Apps launched from Finder/Dock get a minimal PATH, so `claude`, `gh`, `acli` (Homebrew, npm -g, nvm…) aren't found.
 * Ask the user's interactive login shell for its PATH once at startup.
 */
export async function loadLoginPath() {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local/bin"), path.join(os.homedir(), ".bun/bin")];
  let shellPath = "";
  if (!process.env.HF_SKIP_LOGIN_PATH) {
    const r = await exec(SHELL, ["-ilc", 'printf "__HFPATH__%s__HFPATH__" "$PATH"'], { timeoutMs: 15_000 });
    const m = /__HFPATH__(.*?)__HFPATH__/s.exec(r.stdout);
    if (m) shellPath = m[1];
  }
  const parts = [...shellPath.split(":"), ...(process.env.PATH || "").split(":"), ...extra].filter(Boolean);
  process.env.PATH = [...new Set(parts)].join(":");
}
