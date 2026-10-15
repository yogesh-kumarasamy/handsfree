import { useEffect, useMemo, useRef, useState } from "react";
import { PR_STATUSES, type Config, type EngineState, type ProjectConfig, type Ticket, type TicketStatus } from "../../engine/src/types";
import { openExternal, type Api } from "../api";
import { ago, CiPill, duration, Icon, Logo, ReviewPill, StatusBadge, until, useTick } from "../ui";

const WORK: TicketStatus[] = ["running", "manual", "failed", "stopped", "queued"];
const ORDER: TicketStatus[] = [...WORK, "pr_ci_failed", "pr_draft", "pr_ready", "pr_approved", "merged", "done"];

type Section = "work" | "prs" | "approved" | "merged";
function sectionOf(t: Ticket): Section {
  if (t.status === "pr_approved") return "approved";
  if (t.status === "merged" || t.status === "done") return "merged";
  if (PR_STATUSES.includes(t.status) || (t.fix && (t.status === "running" || t.status === "queued"))) return "prs";
  return "work";
}

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
  const [showClosed, setShowClosed] = useState(false);
  const [showAllMerged, setShowAllMerged] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [compose, setCompose] = useState<{ keys: string[]; text: string; sending?: boolean; result?: string }>();
  const projects = useMemo(() => Object.fromEntries(config.projects.map((p) => [p.id, p])), [config]);

  const sorted = useMemo(
    () => Object.values(state.tickets).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt)),
    [state],
  );
  const by = (s: Section) => sorted.filter((t) => sectionOf(t) === s);
  const work = by("work");
  const prs = by("prs");
  const approved = by("approved");
  const mergedAll = by("merged").filter((t) => showClosed || t.status !== "done");
  const merged = showAllMerged ? mergedAll : mergedAll.slice(0, 20);
  const n = (s: TicketStatus) => sorted.filter((t) => t.status === s).length;
  const exhausted = sorted.filter((t) => t.status === "pr_ci_failed" && (t.pr?.fixRounds ?? 0) >= (projects[t.projectId]?.ciFixMaxRounds ?? 0)).length;

  if (config.projects.length === 0) return <FirstRun onNewProject={onNewProject} />;

  const sel = selected ? state.tickets[selected] : undefined;
  const pollErrors = Object.entries(state.pollErrors || {});
  const toggle = (t: Ticket) => setSelected(t.key === selected ? undefined : t.key);
  const rowCls = (t: Ticket) => (t.key === selected ? "selected" : "");
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  const inState = (t: Ticket) => {
    if (t.status === "pr_approved" && t.pr?.approvedAt) return duration(t.pr.approvedAt);
    if (t.status === "running" && t.attempts.length) return duration(t.attempts[t.attempts.length - 1].startedAt);
    return ago(t.updatedAt);
  };
  const prLink = (t: Ticket) => t.prUrl && <button className="btn sm ghost" onClick={() => openExternal(t.prUrl!)}>PR ↗</button>;
  // Row buttons talk to the engine; its refusals ("CI isn't failing right now", gh errors) must reach the user.
  const act = (label: string, fn: () => Promise<unknown>) =>
    fn().then(() => setNotice(undefined), (e) => setNotice(`${label}: ${String((e as Error).message || e)}`));
  const togglePick = (key: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  // The dialog prefills the project's template; the engine fills {approved_ago} only for automatic sends.
  const openCompose = (keys: string[]) => {
    const tickets = keys.map((k) => state.tickets[k]).filter(Boolean);
    if (tickets.length === 0) return;
    const p = projects[tickets[0].projectId];
    const vars = (t: Ticket) => ({ key: t.key, summary: t.summary, pr_url: t.prUrl || "", pr_number: String(t.pr?.number ?? ""), project: projects[t.projectId]?.name || "", branch: t.branch, approved_ago: "" });
    const fillT = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? v[k] : m));
    const projectIds = new Set(tickets.map((t) => t.projectId));
    // One project: show the finished text. Several projects (several channels): keep {list} so the engine
    // fills each channel with only its own PRs.
    const text =
      keys.length === 1
        ? fillT(p?.messaging.templates.manual || "{key}: {pr_url}", vars(tickets[0]))
        : projectIds.size === 1
          ? fillT(p?.messaging.templates.bulk || "{list}", { ...vars(tickets[0]), list: tickets.map((t) => `- ${t.key} — ${t.summary}: ${t.prUrl || "(no PR yet)"}`).join("\n") })
          : fillT(p?.messaging.templates.bulk || "{list}", { ...vars(tickets[0]), project: "" });
    setCompose({ keys, text });
  };
  const sendCompose = async () => {
    if (!compose) return;
    setCompose({ ...compose, sending: true });
    try {
      if (compose.keys.length === 1) await api.sendMessage(compose.keys[0], compose.text);
      else {
        const r = await api.sendBulk(compose.keys, compose.text);
        if (r.failed.length) throw new Error(r.failed.map((f) => `${f.key}: ${f.error}`).join("; "));
      }
      setCompose(undefined);
      setPicked(new Set());
      setNotice(undefined);
    } catch (e) {
      setCompose({ ...compose, sending: false, result: String((e as Error).message || e) });
    }
  };
  const msgPill = (t: Ticket) => {
    const m = t.messages?.[t.messages.length - 1];
    if (!m) return null;
    return <span className={`pill ${m.ok ? "ok" : "bad"}`} title={m.error || m.text}>💬 {m.ok ? "sent" : "failed"}</span>;
  };
  const pickBox = (t: Ticket) => (
    <td onClick={stop} style={{ width: 28 }}>
      <input type="checkbox" checked={picked.has(t.key)} onChange={() => togglePick(t.key)} title="Select for a combined collab message" />
    </td>
  );
  const sendBtn = (t: Ticket) => <button className="btn sm ghost" onClick={() => openCompose([t.key])} title="Send to collab">💬</button>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-sub">
            Jira checked {ago(state.lastPollAt)} · {config.settings.paused ? "paused" : `next ${until(state.nextPollAt)}`}
            {" · "}PRs checked {ago(state.lastPrCheckAt)} · next {until(state.nextPrCheckAt)}
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => act("Check PRs", () => api.checkPrsNow())}>{Icon.refresh} Check PRs now</button>
          <button className="btn" onClick={() => api.pollNow()} disabled={config.settings.paused}>
            {Icon.refresh} Check Jira now
          </button>
        </div>
      </div>

      {notice && (
        <div className="callout err" style={{ marginBottom: 12 }}>
          <span className="t">{notice}</span>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={() => setNotice(undefined)} title="Dismiss">✕</button>
        </div>
      )}
      {picked.size > 0 && (
        <div className="callout info" style={{ marginBottom: 12 }}>
          <span className="t">{picked.size} selected</span>
          <div className="spacer" />
          <button className="btn sm primary" onClick={() => openCompose([...picked])}>Send to collab</button>
          <button className="btn sm ghost" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
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
          <div className="stat-label"><span className="dot" style={{ color: "var(--violet)" }} /> PRs open</div>
          <div className="stat-value">{prs.length}</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--accent)" }} /> Approved, waiting</div>
          <div className="stat-value">{approved.length}</div>
        </div>
        <div className="card stat">
          <div className="stat-label"><span className="dot" style={{ color: "var(--red)" }} /> Needs attention</div>
          <div className="stat-value">{n("failed") + n("stopped") + exhausted}</div>
        </div>
      </div>

      <div className={`dash-grid ${sel ? "with-detail" : ""}`}>
        <div style={{ minWidth: 0 }}>
          {/* In progress */}
          <div className="card section-card" style={{ overflow: "hidden" }}>
            <div className="section-head"><div className="card-title" style={{ margin: 0 }}>In progress</div><span className="count">{work.length}</span></div>
            {work.length === 0 ? (
              <div className="empty" style={{ padding: "28px 20px" }}>
                <p style={{ marginBottom: 0 }}>Nothing running. HandsFree checks your JQL every {config.settings.pollIntervalMin} min.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className={`tickets ${sel ? "compact" : ""}`}>
                  <thead><tr><th>Ticket</th><th>Status</th><th>Agent chain</th><th>Updated</th></tr></thead>
                  <tbody>
                    {work.map((t) => (
                      <tr key={t.key} className={rowCls(t)} onClick={() => toggle(t)}>
                        <td><div className="key">{t.key}</div><div className="summary small muted">{t.summary}</div></td>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <StatusBadge status={t.status} />
                            {t.slow && t.status === "running" && <span className="badge stopped" title="Running longer than your “slow” setting">⏱ slow</span>}
                          </div>
                        </td>
                        <td><Chain ticket={t} project={projects[t.projectId]} /></td>
                        <td className="small muted">{inState(t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Pull requests */}
          {prs.length > 0 && (
            <div className="card section-card" style={{ overflow: "hidden" }}>
              <div className="section-head"><div className="card-title" style={{ margin: 0 }}>Pull requests</div><span className="count">{prs.length}</span></div>
              <div className="table-wrap">
                <table className={`tickets ${sel ? "compact" : ""}`}>
                  <thead><tr><th /><th>Ticket</th><th>Status</th><th>CI</th><th>Review</th><th>Updated</th><th /></tr></thead>
                  <tbody>
                    {prs.map((t) => {
                      const p = projects[t.projectId];
                      const fixing = !!t.fix && (t.status === "running" || t.status === "queued");
                      const err = state.prCheckErrors?.[t.key];
                      return (
                        <tr key={t.key} className={rowCls(t)} onClick={() => toggle(t)}>
                          {pickBox(t)}
                          <td>
                            <div className="key">{t.key}</div>
                            <div className="summary small muted">{t.summary}</div>
                            {err && <div className="err-line" title={err}>PR check failed: {err.slice(0, 80)}</div>}
                          </td>
                          <td>
                            <div className="row" style={{ gap: 6 }}>
                              <StatusBadge
                                status={t.status}
                                label={fixing ? `${t.status === "queued" ? "Fix queued" : "Fixing CI"} ${t.fix!.round}/${Math.max(t.fix!.round, p?.ciFixMaxRounds ?? 0)}` : undefined}
                              />
                              {msgPill(t)}
                            </div>
                          </td>
                          <td><CiPill ci={t.pr?.ci} /></td>
                          <td><ReviewPill decision={t.pr?.reviewDecision} /></td>
                          <td className="small muted">{inState(t)}</td>
                          <td onClick={stop}>
                            <div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                              {t.status === "pr_draft" && <button className="btn sm primary" onClick={() => act(`Publish ${t.key}`, () => api.publish(t.key))}>Publish</button>}
                              {t.status === "pr_ci_failed" && <button className="btn sm primary" onClick={() => act(`Fix CI ${t.key}`, () => api.fixCi(t.key))}>Fix CI</button>}
                              {sendBtn(t)}
                              {prLink(t)}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Approved, not merged */}
          {approved.length > 0 && (
            <div className="card section-card" style={{ overflow: "hidden" }}>
              <div className="section-head"><div className="card-title" style={{ margin: 0 }}>Approved, not merged</div><span className="count">{approved.length}</span></div>
              <div className="table-wrap">
                <table className={`tickets ${sel ? "compact" : ""}`}>
                  <thead><tr><th /><th>Ticket</th><th>Approved</th><th>Waiting</th><th /></tr></thead>
                  <tbody>
                    {approved.map((t) => {
                      const limit = projects[t.projectId]?.mergeNudgeAfterMin ?? 30;
                      const waitedMin = t.pr?.approvedAt ? (Date.now() - new Date(t.pr.approvedAt).getTime()) / 60_000 : 0;
                      return (
                        <tr key={t.key} className={rowCls(t)} onClick={() => toggle(t)}>
                          {pickBox(t)}
                          <td><div className="key">{t.key}</div><div className="summary small muted">{t.summary}</div>{msgPill(t)}</td>
                          <td className="small muted">{ago(t.pr?.approvedAt)}</td>
                          <td className={`small ${waitedMin >= limit ? "overdue" : "muted"}`}>{t.pr?.approvedAt ? duration(t.pr.approvedAt) : "—"}{t.pr?.mergeNudgedAt ? " · nudged" : ""}</td>
                          <td onClick={stop}><div className="row" style={{ gap: 6, justifyContent: "flex-end" }}>{sendBtn(t)}{prLink(t)}</div></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Merged */}
          {by("merged").length > 0 && (
            <div className="card section-card" style={{ overflow: "hidden" }}>
              <div className="section-head">
                <div className="card-title" style={{ margin: 0 }}>Merged</div><span className="count">{mergedAll.length}</span>
                <div className="spacer" />
                <label className="row small muted" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed
                </label>
              </div>
              <div className="table-wrap">
                <table className={`tickets ${sel ? "compact" : ""}`}>
                  <thead><tr><th>Ticket</th><th>Status</th><th>Merged</th><th /></tr></thead>
                  <tbody>
                    {merged.map((t) => (
                      <tr key={t.key} className={rowCls(t)} onClick={() => toggle(t)}>
                        <td><div className="key">{t.key}</div><div className="summary small muted">{t.summary}</div></td>
                        <td><StatusBadge status={t.status} /></td>
                        <td className="small muted">{ago(t.pr?.mergedAt || t.updatedAt)}</td>
                        <td onClick={stop}><div className="row" style={{ justifyContent: "flex-end" }}>{prLink(t)}</div></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {mergedAll.length > 20 && !showAllMerged && (
                <div style={{ padding: "8px 14px 12px" }}><button className="btn sm ghost" onClick={() => setShowAllMerged(true)}>Show all {mergedAll.length}</button></div>
              )}
            </div>
          )}
        </div>

        {sel && <TicketDetail api={api} ticket={sel} project={projects[sel.projectId]} prError={state.prCheckErrors?.[sel.key]} onCompose={openCompose} onClose={() => setSelected(undefined)} />}
      </div>

      {compose && (
        <div className="modal-backdrop" onClick={() => !compose.sending && setCompose(undefined)}>
          <div className="modal card card-pad" onClick={stop}>
            <h3 className="card-title">Send to collab</h3>
            <p className="card-sub">
              {compose.keys.join(", ")} →{" "}
              {[...new Set(compose.keys.map((k) => state.tickets[k]?.projectId))].map((pid) => projects[pid!]?.messaging.channelName || projects[pid!]?.name || "the project's channel").join(", ")}
              {new Set(compose.keys.map((k) => state.tickets[k]?.projectId)).size > 1 && " · several projects: keep {list} in the text, each channel gets only its own PRs"}
            </p>
            <textarea className="textarea" rows={6} value={compose.text} onChange={(e) => setCompose({ ...compose, text: e.target.value })} />
            {compose.result && <div className="callout err" style={{ marginTop: 10 }}><span className="t">{compose.result}</span></div>}
            <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setCompose(undefined)} disabled={compose.sending}>Cancel</button>
              <button className="btn primary" onClick={sendCompose} disabled={compose.sending || !compose.text.trim()}>{compose.sending ? "Sending…" : "Send"}</button>
            </div>
          </div>
        </div>
      )}
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

function TicketDetail({ api, ticket, project, prError, onCompose, onClose }: { api: Api; ticket: Ticket; project?: ProjectConfig; prError?: string; onCompose: (keys: string[]) => void; onClose: () => void }) {
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
  const isPr = PR_STATUSES.includes(ticket.status);
  const fixing = !!ticket.fix && (ticket.status === "running" || ticket.status === "queued");
  const openLabel =
    ticket.status === "running" ? "👀 Open live" : ticket.status === "manual" ? "⌨ Reopen session" : isPr || ticket.status === "merged" ? "⌨ Open in Terminal" : "⌨ Take over";
  const openHint =
    ticket.status === "running"
      ? "See the agent working in Terminal. Press Enter there to take over and talk to it."
      : isPr || ticket.status === "merged"
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
            <button className="btn sm primary" onClick={() => openExternal(ticket.prUrl!)}>Open PR ↗</button>
          )}
          {ticket.prUrl && (
            <button className="btn sm" onClick={() => onCompose([ticket.key])} title="Post about this PR in the project's collab channel">💬 Send to collab</button>
          )}
          {ticket.status === "pr_draft" && <button className="btn sm" onClick={() => run(() => api.publish(ticket.key))} title="gh pr ready — marks the PR ready for review">Publish</button>}
          {ticket.status === "pr_ci_failed" && <button className="btn sm primary" onClick={() => run(() => api.fixCi(ticket.key))} title="Run the agent chain on the failing checks now">Fix CI</button>}
          {ticket.status !== "done" && ticket.status !== "merged" && (
            <button className={`btn sm ${ticket.status === "failed" || ticket.slow ? "primary" : ""}`} onClick={open} title={openHint}>
              {openLabel}
            </button>
          )}
          {ticket.status === "running" && <button className="btn sm danger" onClick={() => api.stop(ticket.key)}>Stop</button>}
          {(ticket.status === "failed" || ticket.status === "stopped") && (
            <button className="btn sm" onClick={() => api.retry(ticket.key)}>Retry chain</button>
          )}
          {ticket.status !== "running" && ticket.status !== "done" && ticket.status !== "merged" && ticket.status !== "manual" && !fixing && (
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
          {ticket.pr && (
            <>
              <dt>PR</dt>
              <dd className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                #{ticket.pr.number} · {ticket.pr.draft ? "draft" : "ready"} <CiPill ci={ticket.pr.ci} /> <ReviewPill decision={ticket.pr.reviewDecision} />
                <span className="small faint">checked {ago(ticket.pr.checkedAt)}</span>
              </dd>
              {ticket.pr.failedChecks.length > 0 && (
                <>
                  <dt>Failing</dt>
                  <dd>
                    {ticket.pr.failedChecks.map((c) => (
                      <span key={c.name + (c.detailsUrl || "")} style={{ marginRight: 8 }}>
                        {c.detailsUrl ? <a href="#" onClick={(e) => { e.preventDefault(); openExternal(c.detailsUrl!); }}>{c.name} ↗</a> : c.name}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              <dt>Fix rounds</dt>
              <dd>{ticket.pr.fixRounds} / {project?.ciFixMaxRounds ?? "—"}{project && !project.ciAutoFix ? " (auto-fix off)" : ""}</dd>
              {ticket.pr.approvedAt && (<><dt>Approved</dt><dd>{ago(ticket.pr.approvedAt)}{ticket.pr.mergeNudgedAt ? " · nudge sent" : ""}</dd></>)}
              {ticket.pr.mergedAt && (<><dt>Merged</dt><dd>{ago(ticket.pr.mergedAt)}</dd></>)}
            </>
          )}
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
        {prError && <div className="callout err"><span className="t">PR check failed: {prError}</span></div>}
        {fixing && ticket.fix && (
          <div className="callout info">
            <span className="t">🔧 CI fix round {ticket.fix.round} on {ticket.fix.headSha.slice(0, 7)} · {ticket.fix.failedChecks.map((c) => c.name).join(", ")}</span>
          </div>
        )}
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
          {ticket.messages && ticket.messages.length > 0 && (
            <>
              <div className="section-label">Messages</div>
              <div className="timeline" style={{ marginBottom: 14 }}>
                {[...ticket.messages].reverse().map((m, i) => (
                  <div key={i} className="tl-item">
                    <span className="tl-icon" style={{ background: m.ok ? "var(--accent-soft)" : "var(--red-soft)", color: m.ok ? "var(--accent)" : "var(--red)" }}>💬</span>
                    <div>
                      <div style={{ fontWeight: 550 }}>{m.kind.replace("_", " ")} → {m.channelName || m.channelId}</div>
                      <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{m.ok ? m.text : m.error}</div>
                    </div>
                    <span className="small faint">{ago(m.at)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
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
