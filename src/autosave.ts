// Autosave for the project editor: debounced, never overlapping, latest value wins.
import type { Config, ProjectConfig } from "../engine/src/types";

export type QueueState = { kind: "idle" } | { kind: "waiting" } | { kind: "saving" } | { kind: "saved"; at: number } | { kind: "error"; error: string };

/**
 * Saves the latest scheduled value after `delayMs` of quiet. At most one save runs at a time: values scheduled
 * meanwhile replace each other and only the newest is saved once the running one ends. A value whose `key` matches
 * the last saved one is skipped. A failed value is kept and retried by the next `flush`.
 */
export class SaveQueue<T> {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { value: T };
  private failed?: { value: T };
  private inflight?: Promise<void>;
  private savedKey?: string;
  private lastError?: string;
  private closed = false;

  constructor(
    private save: (value: T) => Promise<void>,
    private key: (value: T) => string,
    private onState: (s: QueueState) => void,
    private delayMs = 600,
  ) {}

  /** Treat `value` as already saved (the version the editor opened with). */
  markSaved(value: T) {
    this.savedKey = this.key(value);
  }

  schedule(value: T) {
    if (this.closed) return;
    this.pending = { value };
    this.failed = undefined;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.inflight) this.start();
    }, this.delayMs);
    if (!this.inflight) this.onState({ kind: "waiting" });
  }

  /** Save what's pending (or what failed last) right away; resolves once nothing is queued or running. True when the last save worked. */
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending && this.failed) this.pending = this.failed;
    if (!this.inflight) this.start();
    while (this.inflight) await this.inflight;
    return this.lastError === undefined;
  }

  /** Drop what's pending and save nothing more (the project is being deleted); resolves once a running save ends. */
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = this.failed = undefined;
    while (this.inflight) await this.inflight;
  }

  private start() {
    const next = this.pending;
    this.pending = undefined;
    if (!next) return;
    const k = this.key(next.value);
    if (k === this.savedKey) {
      this.lastError = undefined;
      this.onState({ kind: "saved", at: Date.now() });
      return;
    }
    this.onState({ kind: "saving" });
    this.inflight = this.save(next.value)
      .then(
        () => {
          this.savedKey = k;
          this.lastError = undefined;
          this.failed = undefined;
          if (!this.pending) this.onState({ kind: "saved", at: Date.now() });
        },
        (e) => {
          this.lastError = String((e as Error)?.message || e);
          if (!this.pending) this.failed = next;
          this.onState({ kind: "error", error: this.lastError });
        },
      )
      .finally(() => {
        this.inflight = undefined;
        // A value scheduled during the save whose quiet period already ended (or was flushed) goes next.
        if (this.pending && !this.timer) this.start();
      });
  }
}

/** The config with `p` replacing the project of the same id, or appended when it is new. */
export function upsertProject(cfg: Config, p: ProjectConfig): Config {
  const exists = cfg.projects.some((x) => x.id === p.id);
  return { ...cfg, projects: exists ? cfg.projects.map((x) => (x.id === p.id ? p : x)) : [...cfg.projects, p] };
}

export type AutosaveStatus = QueueState | { kind: "blocked"; reasons: string[] };

/**
 * One editor session's autosave. `edit` is called with every change and the reasons it can't be saved (if any);
 * valid versions are written through `saveConfig` (re-reading the config first, so other projects and settings
 * aren't overwritten with stale copies).
 */
export class ProjectAutosaver {
  private queue: SaveQueue<ProjectConfig>;
  private queueState: QueueState = { kind: "idle" };
  private blocked: string[] = [];

  constructor(
    api: { getConfig(): Promise<Config>; saveConfig(cfg: Config): Promise<Config> },
    private opts: { saved?: ProjectConfig; onStatus?: (s: AutosaveStatus) => void; onSaved?: (p: ProjectConfig) => void; delayMs?: number },
  ) {
    this.queue = new SaveQueue<ProjectConfig>(
      async (p) => {
        await api.saveConfig(upsertProject(await api.getConfig(), p));
        opts.onSaved?.(p);
      },
      (p) => JSON.stringify(p),
      (s) => {
        this.queueState = s;
        this.emit();
      },
      opts.delayMs,
    );
    if (opts.saved) this.queue.markSaved(opts.saved);
  }

  get status(): AutosaveStatus {
    // A save still running or failing matters more than why the current text can't be saved.
    if (this.blocked.length && this.queueState.kind !== "saving" && this.queueState.kind !== "error") return { kind: "blocked", reasons: this.blocked };
    return this.queueState;
  }

  edit(p: ProjectConfig, blockers: string[]) {
    const was = JSON.stringify(this.status);
    this.blocked = blockers;
    if (!blockers.length) this.queue.schedule(p);
    if (JSON.stringify(this.status) !== was) this.emit();
  }

  /** Save the pending version now (step change, leaving the editor). True when everything is saved. */
  flush(): Promise<boolean> {
    return this.queue.flush();
  }

  /** Stop saving for good, e.g. before the project is deleted, so a late save can't bring it back. */
  close(): Promise<void> {
    return this.queue.close();
  }

  private emit() {
    this.opts.onStatus?.(this.status);
  }
}
