import fs from "node:fs";
import path from "node:path";
import { changedFiles, commitAll, commitsAhead, ensureWorktree, hasUncommitted, push, removeWorktree, worktreePath } from "./git";
import { createStreamFormatter } from "./streamfmt";
import { openPr, prState } from "./github";
import { commentOnIssue, searchIssues } from "./jira";
import { fill, SHELL, start, type Running } from "./shell";
import { loadConfig, loadState, logFile, normalizeProject, saveConfig, saveState } from "./store";
import type { AgentConfig, Attempt, Config, EngineEvent, EngineState, ProjectConfig, Ticket } from "./types";

const now = () => new Date().toISOString();
const TAIL_FOR_PATTERNS = 6000;

export class Orchestrator {
  config: Config = loadConfig();
  state: EngineState = loadState();
  private listeners = new Set<(e: EngineEvent) => void>();
  private running = new Map<string, Running | null>();
  private stopRequested = new Set<string>();
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
  private notify(title: string, body: string, kind: "pr" | "fallback" | "failed" | "info") {
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
    this.touch(t, { status: "failed", error, currentAgent: undefined, agentIndex: 0 });
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
        this.touch(t, { agentIndex: i, currentAgent: agent.name });

        const outcome = await this.runAgent(p, t, agent, attempt, i, chain.length, mcpFile);
        Object.assign(attempt, { endedAt: now(), outcome });
        this.touch(t);

        if (outcome === "success") {
          winner = agent;
          break;
        }
        if (outcome === "stopped") {
          this.log(t.key, "\n■ Stopped by you\n");
          return this.touch(t, { status: "stopped", currentAgent: undefined });
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
      this.touch(t, { currentAgent: undefined });
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
    const fmt = createStreamFormatter();
    const emit = (text: string) => {
      if (!text) return;
      lastOutput = Date.now();
      tail = (tail + text).slice(-TAIL_FOR_PATTERNS);
      this.log(t.key, text);
    };
    const run = start(SHELL, ["-c", cmd], {
      cwd: t.worktree,
      timeoutMs: this.config.settings.agentTimeoutMin * 60_000,
      env: { HANDSFREE: "1", HANDSFREE_ISSUE: t.key, CI: "1" },
      onData: (d) => emit(fmt.push(d)),
    });
    this.running.set(t.key, run);
    // Some agents print nothing until they finish. Show a heartbeat with what's changed so far.
    const heartbeat = setInterval(() => {
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

function describe(o: string) {
  return o === "exhausted" ? "hit a token/usage limit" : o === "timeout" ? "timed out" : o === "no_changes" ? "made no changes" : "failed";
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
