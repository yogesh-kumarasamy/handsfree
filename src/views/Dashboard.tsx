import { useEffect, useMemo, useRef, useState } from "react";
import { PR_STATUSES, type Config, type EngineState, type ProjectConfig, type Ticket, type TicketStatus } from "../../engine/src/types";
import { openExternal, type Api } from "../api";
import { ago, duration, Icon, Logo, StatusBadge, until, useTick } from "../ui";

const ORDER: TicketStatus[] = ["running", "manual", "failed", "stopped", "queued", "pr_ci_failed", "pr_draft", "pr_ready", "pr_approved", "merged", "done"];

export function Dashboard({
  api,
  config,
  state,
  initialTicket,
  onNewProject,
}: {
  api: Api;
  config: Config;
  state: EngineState;
  initialTicket?: string;
  onNewProject: () => void;
}) {
  useTick();
  const [selected, setSelected] = useState<string | undefined>(initialTicket);
  const [showDone, setShowDone] = useState(false);
  const projects = useMemo(() => Object.fromEntries(config.projects.map((p) => [p.id, p])), [config]);

  const tickets = useMemo(
    () =>
      Object.values(state.tickets)
        .filter((t) => showDone || (t.status !== "done" && t.status !== "merged"))
        .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)),
    [state, showDone],
  );
  const all = Object.values(state.tickets);
  const n = (s: TicketStatus) => all.filter((t) => t.status === s).length;

  if (config.projects.length === 0) return <FirstRun onNewProject={onNewProject} />;

  const sel = selected ? state.tickets[selected] : undefined;
  const pollErrors = Object.entries(state.pollErrors || {});

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">
            Last checked Jira {ago(state.lastPollAt)} ·{" "}
            {config.settings.paused ? "paused" : `next check ${until(state.nextPollAt)}`}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => api.pollNow()} disabled={config.settings.paused}>
            {Icon.refresh} Check Jira now
          </button>
        </div>
      </div>

      {pollErrors.map(([pid, err]) => (
        <div key={pid} className="callout err" style={{ marginBottom: 12 }}>
          <b>{projects[pid]?.name || pid}:</b> <span className="t">{err}</span>
        </div>
      ))}

      <div className="stats">
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--blue)" }} /> Running</div>
          <div className="stat-value">{n("running")} <small>/ {config.settings.maxParallel} slots</small></div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--faint)" }} /> Queued</div>
          <div className="stat-value">{n("queued")}</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--violet)" }} /> Draft PRs open</div>
          <div className="stat-value">{n("pr_draft") + n("pr_ready") + n("pr_ci_failed")}</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--red)" }} /> Needs attention</div>
          <div className="stat-value">{n("failed") + n("stopped")}</div>
        </div>
      </div>

      <div className={`dash-grid ${sel ? "with-detail" : ""}`}>
        <div className="card" style={{ overflow: "hidden", alignSelf: "start" }}>
          <div className="row" style={{ padding: "12px 14px 4px" }}>
            <div className="card-title" style={{ margin: 0 }}>Tickets</div>
            <div className="spacer" />
            <label className="row small muted" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show merged
            </label>
          </div>
          {tickets.length === 0 ? (
            <div className="empty" style={{ padding: "40px 20px" }}>
              <p style={{ marginBottom: 0 }}>No tickets yet. HandsFree checks your JQL every {config.settings.pollIntervalMin} min.</p>
            </div>
          ) : (
            <div className="table-wrap">
            <table className={`tickets ${sel ? "compact" : ""}`}>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Status</th>
                  <th>Agent chain</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.key} className={t.key === selected ? "selected" : ""} onClick={() => setSelected(t.key === selected ? undefined : t.key)}>
                    <td>
                      <div className="key">{t.key}</div>
                      <div className="summary small muted">{t.summary}</div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <StatusBadge status={t.status} />
                        {t.slow && t.status === "running" && <span className="badge stopped" title="Running longer than your “slow” setting">⏱ slow</span>}
                      </div>
                    </td>
                    <td><Chain ticket={t} project={projects[t.projectId]} /></td>
                    <td className="small muted">{t.status === "running" && t.attempts.length ? duration(t.attempts[t.attempts.length - 1].startedAt) : ago(t.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>

        {sel && <TicketDetail api={api} ticket={sel} project={projects[sel.projectId]} onClose={() => setSelected(undefined)} />}
      </div>
    </div>
  );
}

function Chain({ ticket, project }: { ticket: Ticket; project?: ProjectConfig }) {
  const chain = (project?.agents || []).filter((a) => a.enabled).map((a) => a.name);
  const result = (name: string) => {
    const tries = ticket.attempts.filter((a) => a.agentName === name);
    const last = tries[tries.length - 1];
    if (!last) return "";
    if (!last.endedAt) return "current";
    return last.outcome === "success" ? "ok" : "bad";
  };
  return (
    <div className="chain">
      {chain.map((name, i) => (
        <span key={name} className="row" style={{ gap: 4 }}>
          {i > 0 && <span className="chain-arrow">›</span>}
          <span className={`chain-step ${result(name)}`}>{name}</span>
        </span>
      ))}
    </div>
  );
}

function TicketDetail({ api, ticket, project, onClose }: { api: Api; ticket: Ticket; project?: ProjectConfig; onClose: () => void }) {
  const [log, setLog] = useState("");
  const [term, setTerm] = useState<{ ok: boolean; text: string }>();
  const logRef = useRef<HTMLPreElement>(null);

  const run = async (fn: () => Promise<unknown>, ok?: (r: any) => string) => {
    try {
      const r = await fn();
      setTerm(ok ? { ok: true, text: ok(r) } : undefined);
    } catch (e) {
      setTerm({ ok: false, text: String((e as Error).message || e) });
    }
  };
  const open = () => run(() => api.open(ticket.key), (r) => `Opened Terminal · ${r.command}`);
  const openLabel =
    ticket.status === "running" ? "👀 Open live" : ticket.status === "manual" ? "⌨ Reopen session" : PR_STATUSES.includes(ticket.status) ? "⌨ Open in Terminal" : "⌨ Take over";
  const openHint =
    ticket.status === "running"
      ? "See the agent working in Terminal. Press Enter there to take over and talk to it."
      : PR_STATUSES.includes(ticket.status)
        ? "Open the worktree and the last agent session in Terminal"
        : "Continue the last agent's session in Terminal, in this ticket's worktree";

  useEffect(() => {
    let alive = true;
    setTerm(undefined);
    api.getLog(ticket.key).then((l) => alive && setLog(l));
    const unsub = api.subscribe((e) => {
      if (e.type === "log" && e.key === ticket.key) setLog((l) => (l + e.chunk).slice(-200_000));
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [ticket.key]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const outcomeIcon = (o?: string) =>
    !o ? { bg: "var(--blue-soft)", fg: "var(--blue)", ch: "•" }
    : o === "success" ? { bg: "var(--accent-soft)", fg: "var(--accent)", ch: "✓" }
    : o === "exhausted" ? { bg: "var(--amber-soft)", fg: "var(--amber)", ch: "↪" }
    : o === "taken_over" ? { bg: "var(--amber-soft)", fg: "var(--amber)", ch: "✋" }
    : { bg: "var(--red-soft)", fg: "var(--red)", ch: "✕" };

  const outcomeText: Record<string, string> = {
    success: "Finished",
    exhausted: "Tokens exhausted → fallback",
    failed: "Failed",
    no_changes: "No changes made",
    timeout: "Timed out",
    stopped: "Stopped by you",
    taken_over: "You took over",
  };

  return (
    <div className="card detail">
      <div className="detail-head">
        <div className="row">
          <span className="key">{ticket.key}</span>
          <StatusBadge status={ticket.status} />
          <div className="spacer" />
          <button className="btn ghost sm" onClick={onClose} title="Close">✕</button>
        </div>
        <div style={{ marginTop: 6, fontWeight: 550, lineHeight: 1.4 }}>{ticket.summary}</div>
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
          {ticket.prUrl && (
            <button className="btn sm primary" onClick={() => openExternal(ticket.prUrl!)}>Open draft PR ↗</button>
          )}
          {ticket.status !== "done" && (
            <button className={`btn sm ${ticket.status === "failed" || ticket.slow ? "primary" : ""}`} onClick={open} title={openHint}>
              {openLabel}
            </button>
          )}
          {ticket.status === "running" && <button className="btn sm danger" onClick={() => api.stop(ticket.key)}>Stop</button>}
          {(ticket.status === "failed" || ticket.status === "stopped") && (
            <button className="btn sm" onClick={() => api.retry(ticket.key)}>Retry chain</button>
          )}
          {ticket.status !== "running" && ticket.status !== "done" && ticket.status !== "manual" && (
            <button className="btn sm" onClick={() => api.cleanup(ticket.key)}>Clean up worktree</button>
          )}
          {ticket.status !== "running" && (
            <button className="btn sm ghost" onClick={() => api.forget(ticket.key)} title="Remove from HandsFree; it will be picked up again if your JQL still matches">Forget</button>
          )}
        </div>
      </div>
      <div className="detail-body">
        <dl className="kv">
          <dt>Project</dt><dd>{project?.name}</dd>
          <dt>Branch</dt><dd className="mono">{ticket.branch}</dd>
          <dt>Worktree</dt><dd className="mono" title={ticket.worktree}>{ticket.worktree.replace(/^\/Users\/[^/]+/, "~")}</dd>
          <dt>Jira</dt><dd>{ticket.jiraCommented ? "PR link commented ✓" : ticket.prUrl ? "Comment pending" : "—"}</dd>
        </dl>

        {ticket.status === "manual" && (
          <div className="callout warn" style={{ flexDirection: "column", gap: 8 }}>
            <span className="t">
              <b>You have this ticket.</b> HandsFree won't touch it until you hand it back.
            </span>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="btn sm primary" onClick={() => run(() => api.handBack(ticket.key, "pr"))} title="Commit what's in the worktree, push, open a draft PR and comment on Jira">
                Open PR with my changes
              </button>
              <button className="btn sm" onClick={() => run(() => api.handBack(ticket.key, "agents"))} title="Run the agent chain again; agents are told you changed things">
                Hand back to agents
              </button>
            </div>
          </div>
        )}
        {ticket.slow && ticket.status === "running" && (
          <div className="callout warn">
            <span className="t">⏱ This is taking longer than usual. Open it live to see what the agent is doing, and press Enter there if you want to step in.</span>
          </div>
        )}
        {ticket.error && <div className="callout err"><span className="t">{ticket.error}</span></div>}
        {term && (
          <div className={`callout ${term.ok ? "ok" : "err"}`}>
            <span className="t mono" style={{ overflowWrap: "anywhere" }}>{term.text}</span>
          </div>
        )}

        <div>
          <div className="section-label">Attempts</div>
          <div className="timeline">
            {ticket.attempts.length === 0 && <div className="small muted">Waiting for a free slot.</div>}
            {ticket.attempts.map((a, i) => {
              const ic = outcomeIcon(a.outcome);
              return (
                <div key={i} className="tl-item">
                  <span className="tl-icon" style={{ background: ic.bg, color: ic.fg }}>{ic.ch}</span>
                  <div>
                    <div style={{ fontWeight: 550 }}>{a.agentName}</div>
                    <div className="small muted">
                      {a.outcome ? outcomeText[a.outcome] : "Working…"}
                      {a.exitCode !== undefined && a.exitCode !== null ? ` · exit ${a.exitCode}` : ""}
                      {a.note ? ` · ${a.note}` : ""}
                    </div>
                  </div>
                  <span className="small faint">{duration(a.startedAt, a.endedAt)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <div className="section-label">Live log</div>
          <pre className="log" ref={logRef}>{log || "No output yet."}</pre>
        </div>
      </div>
    </div>
  );
}

function FirstRun({ onNewProject }: { onNewProject: () => void }) {
  return (
    <div className="page">
      <div className="card empty">
        <Logo size={56} />
        <h2>Let your tickets walk themselves to a PR</h2>
        <p>
          Add a project and HandsFree will watch Jira, give each ticket its own git worktree, run your agents
          one after another until one succeeds, and open a draft PR.
        </p>
        <button className="btn primary" onClick={onNewProject}>{Icon.plus} Create your first project</button>
        <div className="journey">
          {[
            ["Pick a repo", "Any local git repo + base branch"],
            ["Add a JQL", "Which tickets to pick up"],
            ["MCP servers", "JSON passed to every agent"],
            ["Agent chain", "Up to 4, in fallback order"],
          ].map(([b, s], i) => (
            <div key={b} className="journey-step">
              <div className="journey-num">{i + 1}</div>
              <b>{b}</b>
              <span>{s}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
