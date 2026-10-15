import fs from "node:fs";
import path from "node:path";
import { changedFiles, commitAll, commitsAhead, ensureWorktree, hasUncommitted, push, removeWorktree, worktreePath } from "./git";
import { createStreamFormatter } from "./streamfmt";
import { openPr, prState } from "./github";
import { commentOnIssue, searchIssues } from "./jira";
import { exec, fill, q, SHELL, start, type Running } from "./shell";
import { loadConfig, loadState, logFile, normalizeProject, saveConfig, saveState } from "./store";
import { CLAUDE_RESUME, type AgentConfig, type Attempt, type Config, type EngineEvent, type EngineState, type NotifyKind, type ProjectConfig, type Ticket } from "./types";

const now = () => new Date().toISOString();
const TAIL_FOR_PATTERNS = 6000;

export class Orchestrator {
  config: Config = loadConfig();
  state: EngineState = loadState();
  private listeners = new Set<(e: EngineEvent) => void>();
  private running = new Map<string, Running | null>();
  private stopRequested = new Set<string>();
  private takeoverRequested = new Set<string>();
  private pollTimer?: NodeJS.Timeout;
  private polling = false;
  private stateTimer?: NodeJS.Timeout;

  start() {
    // Agents died with the previous engine process: put them back in the queue at the agent they were on.
    for (const t of Object.values(this.state.tickets)) {
      if (t.status === "running") {
        const last = t.attempts[t.attempts.length - 1];
        if (last && !last.endedAt) Object.assign(last, { endedAt: now(), outcome: "stopped", note: "HandsFree was quit" });
        t.status = "queued";
        this.log(t.key, "\n↺ HandsFree restarted — re-queued\n");
      }
    }
    this.persist();
    this.schedulePoll(3000);
  }

  // ---------- events ----------
  subscribe(fn: (e: EngineEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(e: EngineEvent) {
    for (const l of this.listeners) l(e);
  }
  private persist() {
    saveState(this.state);
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => this.emit({ type: "state", state: this.state }), 100);
  }
  private notify(title: string, body: string, kind: NotifyKind) {
    this.emit({ type: "notify", title, body, kind });
  }
  log(key: string, chunk: string) {
    fs.appendFileSync(logFile(key), chunk);
    this.emit({ type: "log", key, chunk });
  }
  readLog(key: string, max = 300_000) {
    try {
      const s = fs.readFileSync(logFile(key), "utf8");
      return s.length > max ? s.slice(-max) : s;
    } catch {
      return "";
    }
  }

  // ---------- config ----------
  updateConfig(next: Config) {
    const prevInterval = this.config.settings.pollIntervalMin;
    const wasPaused = this.config.settings.paused;
    this.config = {
      version: 1,
      settings: { ...this.config.settings, ...next.settings },
      projects: (next.projects || []).map(normalizeProject),
    };
    saveConfig(this.config);
    this.emit({ type: "config", config: this.config });
    if (prevInterval !== this.config.settings.pollIntervalMin || (wasPaused && !this.config.settings.paused)) this.schedulePoll(1000);
    this.pump();
    return this.config;
  }
  setPaused(paused: boolean) {
    return this.updateConfig({ ...this.config, settings: { ...this.config.settings, paused } });
  }
  project(id: string) {
    return this.config.projects.find((p) => p.id === id);
  }

  // ---------- polling ----------
  schedulePoll(delayMs?: number) {
    clearTimeout(this.pollTimer);
    const ms = delayMs ?? this.config.settings.pollIntervalMin * 60_000;
    this.state.nextPollAt = new Date(Date.now() + ms).toISOString();
    this.persist();
    this.pollTimer = setTimeout(() => void this.poll(), ms);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.checkMergedPrs();
      if (!this.config.settings.paused) {
        for (const p of this.config.projects.filter((x) => x.enabled)) {
          try {
            const { issues } = await searchIssues(p);
            delete this.state.pollErrors[p.id];
            for (const i of issues) {
              if (this.state.tickets[i.key]) continue; // each ticket is picked up once (until you Forget it)
              this.state.tickets[i.key] = {
                key: i.key,
                projectId: p.id,
                summary: i.summary || i.key,
                description: i.description,
                status: "queued",
                branch: `handsfree/${i.key}`,
                worktree: worktreePath(p, i.key),
                agentIndex: 0,
                attempts: [],
                createdAt: now(),
                updatedAt: now(),
              };
              this.log(i.key, `── HandsFree ▸ ${i.key}: ${i.summary}\npicked up by JQL for “${p.name}” at ${now()}\n`);
            }
          } catch (e) {
            this.state.pollErrors[p.id] = (e as Error).message;
          }
        }
        for (const id of Object.keys(this.state.pollErrors)) if (!this.project(id)?.enabled) delete this.state.pollErrors[id];
        this.state.lastPollAt = now();
      }
    } finally {
      this.polling = false;
      this.schedulePoll();
      this.pump();
    }
  }

  private async checkMergedPrs() {
    for (const t of Object.values(this.state.tickets).filter((x) => x.status === "pr_open" && x.prUrl)) {
      const p = this.project(t.projectId);
      if (!p) continue;
      const s = await prState(p.repoPath, t.prUrl!);
      if (s === "MERGED" || s === "CLOSED") {
        try {
          await removeWorktree(p, t);
          this.log(t.key, `\n✓ PR ${s.toLowerCase()} — worktree removed\n`);
        } catch (e) {
          this.log(t.key, `\n! PR ${s.toLowerCase()} but worktree removal failed: ${(e as Error).message}\n`);
        }
        this.touch(t, { status: "done" });
      }
    }
  }

  // ---------- queue ----------
  pump() {
    if (this.config.settings.paused) return;
    const queued = Object.values(this.state.tickets)
      .filter((t) => t.status === "queued" && this.project(t.projectId)?.enabled && !this.running.has(t.key))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const t of queued) {
      if (this.running.size >= this.config.settings.maxParallel) break;
      this.running.set(t.key, null);
      void this.runTicket(t).finally(() => {
        this.running.delete(t.key);
        this.stopRequested.delete(t.key);
        this.takeoverRequested.delete(t.key);
        this.pump();
      });
    }
  }

  private touch(t: Ticket, patch: Partial<Ticket> = {}) {
    Object.assign(t, patch, { updatedAt: now() });
    this.persist();
  }

  private fail(t: Ticket, error: string, notifyUser = true) {
    this.log(t.key, `\n✖ ${error}\n`);
    this.touch(t, { status: "failed", error, currentAgent: undefined, agentIndex: 0, slow: undefined });
    if (notifyUser) this.notify(`${t.key} failed`, error, "failed");
  }

  private async runTicket(t: Ticket) {
    const p = this.project(t.projectId);
    if (!p) return this.fail(t, "Its project was deleted.");
    this.touch(t, { status: "running", error: undefined });

    try {
      this.log(t.key, `\nworktree  ${t.worktree}\nbranch    ${t.branch}\n`);
      this.log(t.key, `${await ensureWorktree(p, t)}\n`);
      t.baseRef ||= `${p.remote}/${p.baseBranch}`;
    } catch (e) {
      return this.fail(t, `Couldn't create the worktree: ${(e as Error).message}`);
    }

    const hf = path.join(t.worktree, ".handsfree");
    fs.mkdirSync(hf, { recursive: true });
    const mcpFile = path.join(hf, "mcp.json");
    fs.writeFileSync(mcpFile, p.mcpJson.trim() || '{"mcpServers":{}}');

    const alreadyDone = t.attempts.some((a) => a.outcome === "success") && !t.prUrl;
    let winner: AgentConfig | undefined;

    if (!alreadyDone) {
      const chain = p.agents.filter((a) => a.enabled && a.command.trim());
      if (chain.length === 0) return this.fail(t, "No enabled agent with a command in this project.");
      for (let i = t.agentIndex; i < chain.length; i++) {
        if (this.stopRequested.has(t.key)) break;
        const agent = chain[i];
        const attempt: Attempt = { agentName: agent.name, startedAt: now() };
        t.attempts.push(attempt);
        this.touch(t, { agentIndex: i, currentAgent: agent.name, slow: undefined });

        const outcome = await this.runAgent(p, t, agent, attempt, i, chain.length, mcpFile);
        Object.assign(attempt, { endedAt: now(), outcome });
        this.touch(t);

        if (outcome === "success") {
          winner = agent;
          break;
        }
        if (outcome === "taken_over") {
          this.log(t.key, "\n👤 You took over. HandsFree leaves this ticket alone until you hand it back.\n");
          return this.touch(t, { status: "manual", currentAgent: undefined, slow: undefined });
        }
        if (outcome === "stopped") {
          this.log(t.key, "\n■ Stopped by you\n");
          return this.touch(t, { status: "stopped", currentAgent: undefined, slow: undefined });
        }
        const next = chain[i + 1];
        if (next) {
          this.log(t.key, `\n↪ Falling back to Agent ${i + 2}/${chain.length} · ${next.name} (continuing in the same worktree)\n`);
          this.notify(`${t.key}: ${agent.name} → ${next.name}`, `${agent.name} ${describe(outcome)}. ${next.name} is taking over.`, "fallback");
        }
      }
      if (!winner) return this.fail(t, "Every agent in the chain failed. Check the log, then Retry.");
    }

    // ---- push, PR, Jira ----
    try {
      this.touch(t, { currentAgent: undefined, slow: undefined });
      this.log(t.key, `\n⇡ Pushing ${t.branch}\n`);
      await push(p, t);
      const lastOk = [...t.attempts].reverse().find((a) => a.outcome === "success");
      const body = prBody(t, lastOk?.agentName || winner?.name || "agent", this.readLog(t.key, 20_000));
      const url = await openPr(p, t, body);
      this.log(t.key, `✓ ${p.draftPr ? "Draft PR" : "PR"} ${url}\n`);
      this.touch(t, { prUrl: url, status: "pr_open", agentIndex: 0 });
      this.notify(`Draft PR ready · ${t.key}`, t.summary, "pr");
    } catch (e) {
      return this.fail(t, `Agents finished, but opening the PR failed: ${(e as Error).message}. Retry will only redo this step.`);
    }
    try {
      const r = await commentOnIssue(p, t.key, `HandsFree opened a ${p.draftPr ? "draft " : ""}PR for this ticket: ${t.prUrl}`);
      if (!r.skipped) {
        this.log(t.key, "✓ Commented the PR link on Jira\n");
        this.touch(t, { jiraCommented: true });
      }
    } catch (e) {
      this.log(t.key, `! Jira comment failed: ${(e as Error).message}\n`);
    }
  }

  private async runAgent(p: ProjectConfig, t: Ticket, agent: AgentConfig, attempt: Attempt, i: number, total: number, mcpFile: string) {
    const promptFile = path.join(t.worktree, ".handsfree", "prompt.md");
    const prompt = buildPrompt(p, t, i > 0 || t.attempts.length > 1);
    fs.writeFileSync(promptFile, prompt);
    const cmd = fill(agent.command, {
      prompt,
      prompt_file: promptFile,
      mcp_file: mcpFile,
      issue_key: t.key,
      worktree: t.worktree,
      branch: t.branch,
    });
    this.log(t.key, `\n▶ Agent ${i + 1}/${total} · ${agent.name}\n$ ${agent.command}\n`);

    let tail = "";
    let lastOutput = Date.now();
    const startedAt = Date.now();
    const fmt = createStreamFormatter((id) => {
      attempt.sessionId = id;
      this.touch(t);
    });
    const emit = (text: string) => {
      if (!text) return;
      lastOutput = Date.now();
      tail = (tail + text).slice(-TAIL_FOR_PATTERNS);
      this.log(t.key, text);
    };
    // Other agents: find their session id with the agent's own pattern, so "Take over" can resume it.
    let sessionRe: RegExp | undefined;
    try {
      sessionRe = agent.sessionIdPattern?.trim() ? new RegExp(agent.sessionIdPattern) : undefined;
    } catch {
      this.log(t.key, `! Ignoring invalid session id pattern for ${agent.name}\n`);
    }
    let raw = "";
    const run = start(SHELL, ["-c", cmd], {
      cwd: t.worktree,
      timeoutMs: this.config.settings.agentTimeoutMin * 60_000,
      env: { HANDSFREE: "1", HANDSFREE_ISSUE: t.key, CI: "1" },
      onData: (d) => {
        if (sessionRe && !attempt.sessionId) {
          raw = (raw + d).slice(-8000);
          const m = sessionRe.exec(raw);
          if (m?.[1]) {
            attempt.sessionId = m[1];
            this.touch(t);
          }
        }
        emit(fmt.push(d));
      },
    });
    this.running.set(t.key, run);
    // Some agents print nothing until they finish. Show a heartbeat with what's changed so far,
    // and flag the ticket as slow once it passes the "slow after" setting.
    const heartbeat = setInterval(() => {
      const elapsedMin = (Date.now() - startedAt) / 60_000;
      if (!t.slow && elapsedMin >= this.config.settings.slowAfterMin) {
        this.touch(t, { slow: true });
        this.log(t.key, `⏱ Running for ${Math.round(elapsedMin)} min, longer than your ${this.config.settings.slowAfterMin} min “slow” setting. Watch it or take over from the dashboard.\n`);
        this.notify(`${t.key} is taking a while`, `${agent.name} has been running ${Math.round(elapsedMin)} min. Watch it or take over.`, "slow");
      }
      if (Date.now() - lastOutput < 60_000) return;
      void changedFiles(t.worktree, t.baseRef).then((n) => {
        const min = Math.round((Date.now() - startedAt) / 60_000);
        this.log(t.key, `· still running · ${min} min · ${n} file${n === 1 ? "" : "s"} changed so far\n`);
        lastOutput = Date.now();
      });
    }, 15_000);
    const res = await run.done;
    clearInterval(heartbeat);
    emit(fmt.flush());
    this.running.set(t.key, null);
    attempt.exitCode = res.code;

    if (this.takeoverRequested.has(t.key)) return "taken_over" as const;
    if (this.stopRequested.has(t.key)) return "stopped" as const;
    if (res.timedOut) {
      attempt.note = `No result after ${this.config.settings.agentTimeoutMin} min`;
      this.log(t.key, `\n✖ ${agent.name} timed out\n`);
      return "timeout" as const;
    }
    const hit = agent.exhaustionPatterns.find((pat) => {
      try {
        return new RegExp(pat, "i").test(tail);
      } catch {
        return false;
      }
    });
    if (hit) attempt.note = `Matched “${hit}”`;
    if (res.code !== 0) {
      this.log(t.key, `\n✖ ${agent.name} exited with code ${res.code}${hit ? ` · matched exhaustion pattern “${hit}”` : ""}\n`);
      return hit ? ("exhausted" as const) : ("failed" as const);
    }
    if (hit) {
      this.log(t.key, `\n✖ ${agent.name} hit a usage limit (matched “${hit}”)\n`);
      return "exhausted" as const;
    }
    try {
      if (await hasUncommitted(t.worktree)) {
        this.log(t.key, "\n• Committing changes the agent left uncommitted\n");
        await commitAll(t.worktree, `${t.key}: ${t.summary}`);
      }
      const ahead = await commitsAhead(t.worktree, t.baseRef!);
      if (ahead === 0) {
        attempt.note = "Exited without changes";
        this.log(t.key, `\n✖ ${agent.name} finished but made no changes\n`);
        return "no_changes" as const;
      }
      this.log(t.key, `\n✓ ${agent.name} finished · ${ahead} commit${ahead === 1 ? "" : "s"}\n`);
      return "success" as const;
    } catch (e) {
      attempt.note = (e as Error).message.slice(0, 200);
      return "failed" as const;
    }
  }

  // ---------- actions ----------
  stop(key: string) {
    const r = this.running.get(key);
    const t = this.state.tickets[key];
    if (!t) return;
    if (this.running.has(key)) {
      this.stopRequested.add(key);
      r?.kill();
    } else if (t.status === "queued") {
      this.touch(t, { status: "stopped" });
    }
  }
  retry(key: string) {
    const t = this.state.tickets[key];
    if (!t || this.running.has(key)) return;
    this.log(key, `\n↻ Retry requested at ${now()}\n`);
    this.touch(t, { status: "queued", error: undefined, agentIndex: 0 });
    this.pump();
  }
  async cleanup(key: string) {
    const t = this.state.tickets[key];
    const p = t && this.project(t.projectId);
    if (!t || this.running.has(key)) return;
    if (p) await removeWorktree(p, t).catch((e) => this.log(key, `! cleanup: ${(e as Error).message}\n`));
    this.log(key, "\n🧹 Worktree removed\n");
    this.touch(t, { status: "done" });
  }
  /** The interactive command that continues an attempt's session, for any agent. "" = plain shell. */
  private resumeCommandFor(t: Ticket, idx: number) {
    const a = t.attempts[idx];
    if (!a || a.agentName === "You") return "";
    const agent = this.project(t.projectId)?.agents.find((x) => x.name === a.agentName);
    const isClaude = /^\s*claude\b/.test(agent?.command || "") || /claude/i.test(a.agentName);
    const tpl = agent?.resumeCommand?.trim() || (isClaude ? CLAUDE_RESUME : "");
    if (!tpl) return "";
    const mcpFile = path.join(t.worktree, ".handsfree", "mcp.json");
    const vars: Record<string, string> = { mcp_file: mcpFile, worktree: t.worktree, issue_key: t.key, branch: t.branch };
    if (a.sessionId) vars.session_id = a.sessionId;
    else if (tpl.includes("{session_id}")) {
      // No id captured: Claude can still pick up the latest session in this folder; others get a shell.
      return isClaude ? fill(`claude --continue --mcp-config {mcp_file}`, vars) : "";
    }
    return fill(tpl, vars);
  }

  /** Set by index.ts so Terminal windows can call back into the engine (Enter = take over). */
  api?: { port: number; token: string };

  /**
   * One "Open" for every ticket, for any agent:
   * - agent running → Terminal shows its live output; pressing Enter takes over (stops the agent and
   *   continues its session in the same window).
   * - otherwise → continue the last agent's session right away (or a shell in the worktree).
   */
  async open(key: string) {
    const t = this.state.tickets[key];
    if (!t) throw new Error("Unknown ticket");
    if (this.running.has(key)) return this.openTerminal(key, undefined, "live");
    if (t.status === "pr_open" || t.status === "done") return this.openTerminal(key, undefined, "resume");
    return this.takeOver(key);
  }

  private async openTerminal(key: string, attemptIndex?: number, mode: "resume" | "live" = "resume") {
    const t = this.state.tickets[key];
    if (!t) throw new Error("Unknown ticket");
    if (!fs.existsSync(t.worktree)) throw new Error("The worktree was already removed.");
    const idx = attemptIndex ?? lastAgentAttempt(t);
    const a = t.attempts[idx];
    // Resuming a session the agent is still writing to would fork it.
    const stillRunning = !!a && !a.endedAt && this.running.has(key);
    const resume = mode === "resume" && !stillRunning ? this.resumeCommandFor(t, idx) : "";
    const label = a ? `attempt ${idx + 1} · ${a.agentName}${a.outcome ? ` · ${a.outcome.replace("_", " ")}` : " · running"}` : "no attempts yet";

    const header = [
      "#!/bin/zsh",
      `export PATH=${q(process.env.PATH || "")}`,
      `cd ${q(t.worktree)} || exit 1`,
      "clear",
      `echo ${q(`HandsFree ▸ ${t.key}: ${t.summary}`)}`,
      `echo ${q(`${label}   ·   branch ${t.branch}`)}`,
      `echo ${q(`worktree ${t.worktree}`)}`,
      "echo",
    ];
    const takeoverUrl = this.api ? `http://127.0.0.1:${this.api.port}/api/tickets/${encodeURIComponent(key)}/takeover?text=1` : "";
    const after = `echo; echo ${q("When you're done: in HandsFree, choose “Open PR with my changes” or “Hand back to agents”.")}`;
    const body =
      mode === "live"
        ? [
            `echo ${q(`👀 ${a?.agentName || "The agent"} is working. Live output below.`)}`,
            `echo '   Press Enter to take over: stops the agent and continues its session here.'`,
            `echo '   Close this window to just stop watching (the agent keeps going).'`,
            "echo",
            `tail -n 200 -f ${q(logFile(key))} & TAILPID=$!`,
            "read -r _",
            "kill $TAILPID 2>/dev/null",
            "echo; echo '⏸ Taking over…'",
            `CMD=$(curl -sf -X POST -H ${q(`x-handsfree-token: ${this.api?.token || ""}`)} -H 'content-type: application/json' -d '{}' ${q(takeoverUrl)})`,
            "if [ $? -ne 0 ]; then echo 'Could not take over. Is HandsFree still running?'; else",
            "  echo; git status --short; echo",
            '  if [ -n "$CMD" ]; then echo "$ $CMD"; eval "$CMD"; else echo "This agent has no resume command, so here is a shell in the worktree."; fi',
            `  ${after}`,
            "fi",
          ]
        : [
            `echo '── last lines of the HandsFree log ──'`,
            `tail -n 25 ${q(logFile(key))}`,
            "echo",
            `echo '── git status ──'`,
            "git status --short",
            "echo",
            ...(resume
              ? [`echo ${q(`$ ${resume}`)}`, resume]
              : [
                  `echo ${q(
                    stillRunning
                      ? "The agent is still running, so this is a plain shell. Use Take over to stop it and continue its session."
                      : "No resumable session for this agent (set a Resume command on it in Projects). You're in the worktree.",
                  )}`,
                ]),
            ...(t.status === "manual" ? [after] : []),
          ];
    // Keep the window usable afterwards.
    const script = [...header, ...body, 'exec "${SHELL:-/bin/zsh}" -l'].join("\n");

    // Owner-only folder: live scripts carry the engine's per-launch token.
    const dir = path.join(path.dirname(logFile(key)), "..", "terminal");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}-${mode}.command`);
    fs.writeFileSync(file, `${script}\n`, { mode: 0o700 });
    fs.chmodSync(file, 0o700);

    const opener = process.env.HF_OPEN_CMD || "open";
    const r = await exec(opener, [file], { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(`Couldn't open Terminal: ${(r.stderr || r.stdout).trim()}`);
    if (mode === "resume") this.log(key, `\n⌨ Opened Terminal${resume ? ` · ${resume}` : " · shell"}\n`);
    return { command: mode === "live" ? "live view · press Enter in Terminal to take over" : resume || `cd ${q(t.worktree)}`, file };
  }

  /**
   * Stop the agent (if running) and hand the ticket to you.
   * open=false is used by a live Terminal window: it only needs the resume command back.
   */
  async takeOver(key: string, open = true): Promise<{ command: string; resume: string }> {
    const t = this.state.tickets[key];
    if (!t) throw new Error("Unknown ticket");
    if (!["running", "failed", "stopped", "manual", "queued"].includes(t.status)) throw new Error(`Can't take over a ticket that is ${t.status}.`);
    if (this.running.has(key)) {
      this.takeoverRequested.add(key);
      this.stopRequested.add(key);
      this.running.get(key)?.kill();
      const t0 = Date.now();
      while (this.running.has(key) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 200));
      if (this.running.has(key)) throw new Error("The agent didn't stop in time. Try again.");
    } else {
      this.log(key, "\n👤 You took over. HandsFree leaves this ticket alone until you hand it back.\n");
      this.touch(t, { status: "manual", currentAgent: undefined, slow: undefined });
    }
    const idx = lastAgentAttempt(t);
    const resume = this.resumeCommandFor(t, idx);
    if (!open) {
      this.log(key, `\n⌨ Took over in Terminal${resume ? ` · ${resume}` : " · shell"}\n`);
      return { command: resume || `cd ${q(t.worktree)}`, resume };
    }
    const r = await this.openTerminal(key, idx, "resume");
    return { command: r.command, resume };
  }

  /**
   * Give a taken-over ticket back to HandsFree.
   * - "pr": commit what's there and go straight to push → draft PR → Jira comment.
   * - "agents": run the agent chain again; the prompt tells agents a person changed things.
   */
  async handBack(key: string, mode: "pr" | "agents") {
    const t = this.state.tickets[key];
    if (!t) throw new Error("Unknown ticket");
    if (this.running.has(key)) throw new Error("It's already running.");
    if (!fs.existsSync(t.worktree)) throw new Error("The worktree was removed.");
    if (mode === "pr") {
      if (await hasUncommitted(t.worktree)) await commitAll(t.worktree, `${t.key}: ${t.summary}`);
      const ahead = await commitsAhead(t.worktree, t.baseRef || `${this.project(t.projectId)?.remote || "origin"}/${this.project(t.projectId)?.baseBranch || "main"}`);
      if (ahead === 0) throw new Error("There are no changes on this branch yet, so there's nothing to open a PR with.");
      t.attempts.push({ agentName: "You", startedAt: now(), endedAt: now(), outcome: "success", note: "Handed back with your changes" });
      this.log(key, `\n↩ Handed back · opening a PR with your changes (${ahead} commit${ahead === 1 ? "" : "s"})\n`);
    } else {
      this.log(key, "\n↩ Handed back to the agents\n");
    }
    this.touch(t, { status: "queued", error: undefined, agentIndex: 0 });
    this.pump();
  }

  forget(key: string) {
    if (this.running.has(key)) return;
    delete this.state.tickets[key];
    try {
      fs.unlinkSync(logFile(key));
    } catch {
      /* no log */
    }
    this.persist();
  }
  shutdown() {
    for (const r of this.running.values()) r?.kill();
  }
}

/** Index of the last attempt that ran an agent (skips "You" hand-backs). */
function lastAgentAttempt(t: Ticket) {
  let i = t.attempts.length - 1;
  while (i > 0 && t.attempts[i].agentName === "You") i--;
  return i;
}

function describe(o: string) {
  return o === "exhausted"
    ? "hit a token/usage limit"
    : o === "timeout"
      ? "timed out"
      : o === "no_changes"
        ? "made no changes"
        : o === "taken_over"
          ? "was stopped so a person could take over"
          : "failed";
}

export function buildPrompt(p: ProjectConfig, t: Ticket, continuing: boolean) {
  const prev = t.attempts.filter((a) => a.endedAt);
  return [
    `You are working unattended on Jira ticket ${t.key}: ${t.summary}`,
    "",
    "## Ticket",
    t.description?.trim() ||
      "(No description was fetched. If you have a Jira MCP server or the `acli` CLI, read the full ticket before starting.)",
    "",
    "## How to work",
    `- You are in a git worktree on branch \`${t.branch}\`, based on \`${t.baseRef || p.baseBranch}\`. Only change files here.`,
    "- Implement the ticket completely. Add or update tests. Run the project's tests and linters and fix what fails.",
    `- Commit your work with clear messages starting with "${t.key}:". Do NOT push and do NOT open a pull request — HandsFree does that after you finish.`,
    "- Nobody is watching. Don't ask questions or wait for input; make reasonable assumptions and list them at the end.",
    "- Ignore the `.handsfree/` folder.",
    "- Finish with a short summary: what you changed, how you tested it, and any assumptions or follow-ups.",
    ...(continuing && prev.length
      ? [
          "",
          "## Previous attempts",
          ...prev.map((a) => `- ${a.agentName}: ${describe(a.outcome || "failed")}${a.note ? ` (${a.note})` : ""}`),
          "Another agent already worked in this worktree. Start with `git status` and `git log` to see what it did, keep what's good, and finish the job.",
          ...(prev.some((a) => a.outcome === "taken_over")
            ? ["A person took over this ticket and may have changed or committed code. Treat their changes as intentional and build on them."]
            : []),
        ]
      : []),
    ...(p.promptExtra.trim() ? ["", "## Project notes", p.promptExtra.trim()] : []),
  ].join("\n");
}

function prBody(t: Ticket, agentName: string, log: string) {
  // The agent's final summary is the last part of its output.
  const lastRun = log.split(/\n▶ Agent /).pop() || "";
  // Claude's stream-json result ("■ done …") carries its final summary; otherwise use the end of the output.
  const result = /\n■ done[^\n]*\n\n([\s\S]*?)(?:\n[✓✖] |$)/.exec(lastRun)?.[1];
  const summary = (result ?? lastRun.split("\n").slice(2).join("\n").replace(/\n[✓✖].*$/s, "")).replace(/\n· still running[^\n]*/g, "").trim().slice(-3500);
  return [
    `Automated by **HandsFree** for **${t.key}**: ${t.summary}`,
    "",
    `Agent: ${agentName}${t.attempts.length > 1 ? ` (after ${t.attempts.length - 1} fallback${t.attempts.length > 2 ? "s" : ""})` : ""}`,
    "",
    "### Agent summary",
    summary ? "```\n" + summary + "\n```" : "_No summary captured._",
  ].join("\n");
}
