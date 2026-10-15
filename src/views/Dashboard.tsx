import { useEffect, useMemo, useRef, useState } from "react";
import type { Config, EngineState, ProjectConfig, Ticket, TicketStatus } from "../../engine/src/types";
import { openExternal, type Api } from "../api";
import { ago, duration, Icon, Logo, StatusBadge, until } from "../ui";

const ORDER: TicketStatus[] = ["running", "queued", "failed", "stopped", "pr_open", "done"];

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
  const [selected, setSelected] = useState<string | undefined>(initialTicket);
  const [showDone, setShowDone] = useState(false);
  const projects = useMemo(() => Object.fromEntries(config.projects.map((p) => [p.id, p])), [config]);

  const tickets = useMemo(
    () =>
      Object.values(state.tickets)
        .filter((t) => showDone || t.status !== "done")
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
          <div className="stat-value">{n("pr_open")}</div>
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
                    <td><StatusBadge status={t.status} /></td>
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

  const openTerminal = async (attempt?: number) => {
    try {
      const r = await api.openTerminal(ticket.key, attempt);
      setTerm({ ok: true, text: `Opened Terminal · ${r.command}` });
    } catch (e) {
      setTerm({ ok: false, text: String((e as Error).message || e) });
    }
  };
  const canResume = (i: number) => {
    const a = ticket.attempts[i];
    return !!a?.endedAt && (!!a.sessionId || /claude/i.test(a.agentName));
  };

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
    : { bg: "var(--red-soft)", fg: "var(--red)", ch: "✕" };

  const outcomeText: Record<string, string> = {
    success: "Finished",
    exhausted: "Tokens exhausted → fallback",
    failed: "Failed",
    no_changes: "No changes made",
    timeout: "Timed out",
    stopped: "Stopped by you",
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
            <button
              className="btn sm"
              onClick={() => openTerminal()}
              title={ticket.status === "running" ? "Plain shell in the worktree (the agent is still running)" : "Resume the last agent session in Terminal"}
            >
              ⌨ Open in Terminal
            </button>
          )}
          {ticket.status === "running" && <button className="btn sm danger" onClick={() => api.stop(ticket.key)}>Stop</button>}
          {(ticket.status === "failed" || ticket.status === "stopped") && (
            <button className="btn sm primary" onClick={() => api.retry(ticket.key)}>Retry chain</button>
          )}
          {ticket.status !== "running" && ticket.status !== "done" && (
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
                  <div className="row" style={{ gap: 6 }}>
                    {canResume(i) && ticket.status !== "done" && (
                      <button className="btn ghost sm" onClick={() => openTerminal(i)} title={a.sessionId ? `claude --resume ${a.sessionId}` : "claude --continue in the worktree"}>
                        Resume ↗
                      </button>
                    )}
                    <span className="small faint">{duration(a.startedAt, a.endedAt)}</span>
                  </div>
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
