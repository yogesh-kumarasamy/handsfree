// Scheduled agent runs per project; results go to the collab channel. One run at a time per routine, 2 across all.
import fs from "node:fs";
import type { Config, EngineState, MessageKind, ProjectConfig, RoutineConfig, RoutineRun, RoutineState } from "../types";
import { DEFAULT_ROUTINE_COMMAND } from "../types";
import { exec, fill, sh, type RunOpts, type RunResult } from "../shell";
import { lastJson } from "../messaging/agent";
import { fillTemplate } from "../messaging/templates";
import { nextRun, parseCron } from "./cron";

export interface RoutineDeps {
  config: () => Config;
  state: () => EngineState;
  persist: () => void;
  /** Append to the routine's own log (LOG_DIR/routine-<id>.log in the engine). */
  log: (routineId: string, chunk: string) => void;
  notify: (title: string, body: string) => void;
  messaging: { postToProject(p: ProjectConfig, text: string, kind: MessageKind, idempotencyKey: string): Promise<{ id?: string }> };
  run?: (cmd: string, opts?: RunOpts) => Promise<RunResult>;
  now?: () => Date;
  maxConcurrent?: number;
}

const TICK_MS = 30_000;

export class RoutineService {
  private timer?: NodeJS.Timeout;
  private running = new Set<string>();
  constructor(public deps: RoutineDeps) {}

  private now() {
    return (this.deps.now || (() => new Date()))();
  }
  private all(): { p: ProjectConfig; r: RoutineConfig }[] {
    return this.deps.config().projects.flatMap((p) => (p.routines || []).map((r) => ({ p, r })));
  }
  private stateFor(id: string): RoutineState {
    return (this.deps.state().routines[id] ||= {});
  }
  private schedule(r: RoutineConfig, after: Date): string | undefined {
    const spec = r.enabled ? parseCron(r.schedule) : undefined;
    if (!spec || spec instanceof Error) return undefined;
    const n = nextRun(spec, after);
    return n instanceof Error ? undefined : n.toISOString();
  }

  /** Clears runs that were cut off by a quit, schedules every routine, starts the 30 s tick. */
  start() {
    for (const st of Object.values(this.deps.state().routines)) {
      if (!st.running) continue;
      st.running = false;
      if (st.last && !st.last.endedAt) Object.assign(st.last, { endedAt: this.now().toISOString(), ok: false, output: "HandsFree was quit" });
    }
    this.configChanged();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
  }

  shutdown() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Recompute schedules: an overdue slot is kept (it runs once on the next tick), a future slot is recomputed from now
   * so an edited expression takes effect. State of routines that no longer exist is dropped unless they are running.
   */
  configChanged() {
    const s = this.deps.state();
    const now = this.now();
    const ids = new Set<string>();
    for (const { r } of this.all()) {
      ids.add(r.id);
      const st = this.stateFor(r.id);
      const next = this.schedule(r, now);
      if (!next) st.nextRunAt = undefined;
      else if (!(st.nextRunAt && Date.parse(st.nextRunAt) <= now.getTime())) st.nextRunAt = next;
    }
    for (const id of Object.keys(s.routines)) if (!ids.has(id) && !this.running.has(id)) delete s.routines[id];
    this.deps.persist();
  }

  async tick(now = this.now()) {
    const max = this.deps.maxConcurrent ?? 2;
    const runs: Promise<void>[] = [];
    for (const { p, r } of this.all()) {
      const st = this.deps.state().routines[r.id];
      if (!r.enabled || !st?.nextRunAt || Date.parse(st.nextRunAt) > now.getTime()) continue;
      if (this.running.has(r.id)) {
        // Still going when its next slot came: skip that slot (no overlapping runs of one routine).
        st.nextRunAt = this.schedule(r, now);
        this.deps.log(r.id, `\n· ${r.name}: skipped the ${now.toLocaleString()} slot, the previous run is still going\n`);
        this.deps.persist();
        continue;
      }
      if (this.running.size >= max) continue; // waits for the next tick; nextRunAt stays in the past
      runs.push(this.execute(p, r, now));
    }
    await Promise.all(runs);
  }

  /** Why `runNow(id)` would be refused, or undefined when it can start. */
  cannotRun(id: string): string | undefined {
    if (!this.all().some(({ r }) => r.id === id)) return "Unknown routine";
    if (this.running.has(id)) return "This routine is already running.";
    return undefined;
  }

  async runNow(id: string) {
    const why = this.cannotRun(id);
    if (why) throw new Error(why);
    const hit = this.all().find(({ r }) => r.id === id)!;
    await this.execute(hit.p, hit.r, this.now());
  }

  private async execute(p: ProjectConfig, r: RoutineConfig, now: Date) {
    const st = this.stateFor(r.id);
    const run: RoutineRun = { startedAt: now.toISOString() };
    const prevOk = st.lastOk;
    st.last = run;
    st.running = true;
    this.running.add(r.id);
    // Schedule the next slot from now, so an overdue routine runs once and moves on (no catch-up storm).
    st.nextRunAt = this.schedule(r, now);
    this.deps.persist();
    try {
      const vars = {
        project: p.name,
        repo: await repoSlug(p),
        repo_path: p.repoPath,
        channel: p.messaging.channelName || p.messaging.channelId,
        last_run: prevOk ? new Date(prevOk).toLocaleString() : "the beginning",
        now: now.toISOString(),
      };
      const prompt = fillTemplate(r.prompt, vars);
      const cmd = fill(r.agentCommand.trim() || DEFAULT_ROUTINE_COMMAND, { prompt });
      this.deps.log(r.id, `\n▶ ${r.name} · ${run.startedAt}\n$ ${cmd.slice(0, 300)}\n`);
      const res = await (this.deps.run || sh)(cmd, {
        cwd: p.repoPath || undefined,
        timeoutMs: r.timeoutMin * 60_000,
        env: { HANDSFREE: "1", HANDSFREE_ROUTINE: r.id },
        onData: (d) => this.deps.log(r.id, d),
      });
      if (res.timedOut) throw new Error(`Timed out after ${r.timeoutMin} min`);
      if (res.code !== 0) throw new Error(`The agent exited with exit ${res.code}: ${(res.stderr || res.stdout || "").trim().slice(-400)}`);
      const env = lastJson(res.stdout || "");
      if (!env || typeof env !== "object" || !("result" in env)) throw new Error(`The agent did not print a result envelope: ${(res.stdout || "").trim().slice(-400)}`);
      if (env.is_error) throw new Error(String(env.result).slice(-400));
      run.output = String(env.result ?? "").trim().slice(0, 4000);
      run.ok = true;
      st.lastOk = run.startedAt;
      this.deps.log(r.id, `\n✓ ${r.name} finished\n${run.output}\n`);
      await this.post(p, r, run);
    } catch (e) {
      run.ok = false;
      run.output = String((e as Error).message || e).slice(0, 4000);
      this.deps.log(r.id, `\n✖ ${run.output}\n`);
      this.deps.notify(`${r.name} failed`, run.output.slice(0, 200));
    } finally {
      run.endedAt = this.now().toISOString();
      st.running = false;
      this.running.delete(r.id);
      // The routine may have been deleted while it ran.
      if (!this.all().some((x) => x.r.id === r.id)) delete this.deps.state().routines[r.id];
      this.deps.persist();
    }
  }

  private async post(p: ProjectConfig, r: RoutineConfig, run: RoutineRun) {
    if (!r.postToChannel) return;
    if (p.messaging.platform === "none" || !p.messaging.channelId) {
      run.posted = false;
      run.postError = "no messaging platform or channel configured for this project";
      this.deps.log(r.id, `· not posted: ${run.postError}\n`);
      return;
    }
    try {
      await this.deps.messaging.postToProject(p, run.output || "", "routine", `routine:${r.id}:${run.startedAt}`);
      run.posted = true;
      this.deps.log(r.id, `💬 posted to ${p.messaging.channelName || p.messaging.channelId}\n`);
    } catch (e) {
      run.posted = false;
      run.postError = String((e as Error).message || e).slice(0, 400);
      this.deps.log(r.id, `! post failed: ${run.postError}\n`);
      this.deps.notify(`${r.name}: report not posted`, run.postError);
    }
  }
}

/** "owner/name" from a GitHub remote URL (https, ssh, git@), else undefined. */
export function repoSlugFromUrl(url: string): string | undefined {
  const u = url.trim();
  const m = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(u);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** {repo}: owner/name for GitHub remotes, else the remote URL, else the repo path. */
export async function repoSlug(p: Pick<ProjectConfig, "repoPath" | "remote">): Promise<string> {
  if (!p.repoPath || !fs.existsSync(p.repoPath)) return p.repoPath || "";
  const r = await exec("git", ["-C", p.repoPath, "remote", "get-url", p.remote || "origin"], { timeoutMs: 10_000 });
  const url = r.code === 0 ? r.stdout.trim() : "";
  return (url && repoSlugFromUrl(url)) || url || p.repoPath;
}
