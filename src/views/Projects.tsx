import { useEffect, useState } from "react";
import {
  AGENT_PRESETS,
  DEFAULT_AGENT_MESSAGE_COMMAND,
  DEFAULT_TEMPLATES,
  DEFAULT_EXHAUSTION_PATTERNS,
  DEFAULT_JIRA_COMMENT,
  DEFAULT_JIRA_SEARCH,
  type AgentConfig,
  type Config,
  type FoundIssue,
  type MessageTemplates,
  type MessagingConfig,
  type MessagingPlatform,
  type ProjectConfig,
  DEFAULT_ROUTINE_COMMAND,
  ROUTINE_PRESETS,
  type EngineState,
  type RoutineConfig,
} from "../../engine/src/types";
import { describeCron, parseCron } from "../../engine/src/routines/cron";
import { pickFolder, type Api, type RepoInfo } from "../api";
import { ago, Icon, Toggle, until } from "../ui";

const uid = () => Math.random().toString(36).slice(2, 10);

function blankProject(): ProjectConfig {
  return {
    id: uid(),
    name: "",
    enabled: true,
    repoPath: "",
    baseBranch: "main",
    remote: "origin",
    jql: "assignee = currentUser() AND status = \"To Do\"",
    jiraSearchCommand: DEFAULT_JIRA_SEARCH,
    jiraCommentCommand: DEFAULT_JIRA_COMMENT,
    mcpJson: '{\n  "mcpServers": {}\n}',
    agents: AGENT_PRESETS.map((a) => ({ ...a, id: uid(), exhaustionPatterns: [...a.exhaustionPatterns] })),
    promptExtra: "",
    draftPr: true,
    ciAutoFix: true,
    ciFixMaxRounds: 2,
    mergeNudgeAfterMin: 30,
    messaging: { platform: "none", channelId: "", channelName: "", templates: { ...DEFAULT_TEMPLATES }, agentCommand: DEFAULT_AGENT_MESSAGE_COMMAND },
    routines: [],
  };
}

export function Projects({
  api,
  config,
  editing,
  setEditing,
  initialStep,
  state,
}: {
  api: Api;
  config: Config;
  editing: string | null;
  setEditing: (id: string | null) => void;
  initialStep?: number;
  state?: EngineState;
}) {
  const save = async (projects: ProjectConfig[]) => {
    await api.saveConfig({ ...config, projects });
  };

  if (editing) {
    const existing = config.projects.find((p) => p.id === editing);
    return (
      <ProjectEditor
        api={api}
        initial={existing || blankProject()}
        isNew={!existing}
        initialStep={initialStep}
        state={state}
        onCancel={() => setEditing(null)}
        onSave={async (p) => {
          const exists = config.projects.some((x) => x.id === p.id);
          await save(exists ? config.projects.map((x) => (x.id === p.id ? p : x)) : [...config.projects, p]);
          setEditing(null);
        }}
        onDelete={
          existing
            ? async () => {
                if (!confirm(`Delete project “${existing.name}”? Running tickets keep going; worktrees stay on disk.`)) return;
                await save(config.projects.filter((x) => x.id !== existing.id));
                setEditing(null);
              }
            : undefined
        }
      />
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Projects</h1>
          <div className="page-sub">Each project is a repo + a JQL + MCP servers + an agent chain. Saved projects go live immediately.</div>
        </div>
        <button className="btn primary" onClick={() => setEditing("new")}>{Icon.plus} New project</button>
      </div>

      {config.projects.length === 0 ? (
        <div className="card empty">
          <p>No projects yet.</p>
          <button className="btn primary" onClick={() => setEditing("new")}>{Icon.plus} Create your first project</button>
        </div>
      ) : (
        <div className="project-list">
          {config.projects.map((p) => {
            const chain = p.agents.filter((a) => a.enabled);
            let servers = 0;
            try {
              servers = Object.keys(JSON.parse(p.mcpJson).mcpServers || {}).length;
            } catch {
              /* invalid json shows as 0 */
            }
            return (
              <div key={p.id} className="card project-card">
                <div>
                  <div className="project-name">
                    {p.name}
                    {!p.enabled && <span className="badge stopped">Off</span>}
                  </div>
                  <div className="project-meta" style={{ marginTop: 6 }}>
                    <span className="mono">{p.repoPath.replace(/^\/Users\/[^/]+/, "~")}</span>
                    <span>base <b className="mono">{p.baseBranch}</b></span>
                    <span>{servers} MCP server{servers === 1 ? "" : "s"}</span>
                    <span>{p.draftPr ? "Draft PRs" : "Ready PRs"}</span>
                  </div>
                </div>
                <div className="row">
                  <Toggle on={p.enabled} title={p.enabled ? "Pause this project" : "Activate this project"} onChange={(v) => save(config.projects.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)))} />
                  <button className="btn sm" onClick={() => setEditing(p.id)}>Edit</button>
                </div>
                <div className="jql" title={p.jql}>{p.jql}</div>
                <div className="chain" style={{ gridColumn: "1 / -1" }}>
                  {chain.length === 0 && <span className="err-text">No enabled agents</span>}
                  {chain.map((a, i) => (
                    <span key={a.id} className="row" style={{ gap: 4 }}>
                      {i > 0 && <span className="chain-arrow">›</span>}
                      <span className={`chain-step ${i === 0 ? "current" : ""}`}>{i + 1}. {a.name}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const STEPS = ["Repository", "Jira", "MCP servers", "Agent chain", "Messaging", "Routines", "Review"];
const ROUTINES = STEPS.indexOf("Routines");
/** Always the last step: computed so steps added before it don't shift a literal. */
const REVIEW = STEPS.length - 1;

function ProjectEditor({
  api,
  initial,
  isNew,
  initialStep,
  onCancel,
  onSave,
  onDelete,
  state,
}: {
  api: Api;
  initial: ProjectConfig;
  isNew: boolean;
  initialStep?: number;
  state?: EngineState;
  onCancel: () => void;
  onSave: (p: ProjectConfig) => Promise<void>;
  onDelete?: () => void;
}) {
  const [p, setP] = useState<ProjectConfig>(initial);
  const [step, setStep] = useState(initialStep ?? 0);
  const [repo, setRepo] = useState<RepoInfo>();
  const [jira, setJira] = useState<{ issues?: FoundIssue[]; error?: string; raw?: string; loading?: boolean }>();
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<{ list?: { id: string; name: string }[]; error?: string; loading?: boolean }>();
  const [channelQuery, setChannelQuery] = useState("");
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string }>();
  const set = (patch: Partial<ProjectConfig>) => setP((x) => ({ ...x, ...patch }));

  // Demo screenshots: pre-fill.
  useEffect(() => {
    if (window.__HF_DEMO__ && isNew && (initialStep ?? 0) > 0) {
      setP((x) => ({
        ...x,
        name: "ChatSupport Web",
        repoPath: "/Users/yogesh/code/chatsupport-web",
        jql: 'project = CSW AND assignee = currentUser() AND status = "To Do" ORDER BY priority DESC',
        mcpJson: JSON.stringify({ mcpServers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp/" } } }, null, 2),
      }));
    }
    if (window.__HF_DEMO__?.jiraTested) void testJira();
    if (window.__HF_DEMO__ && isNew && (initialStep ?? 0) === 0) void choose(true);
  }, []);

  useEffect(() => {
    if (p.repoPath && !isNew) api.repoInfo(p.repoPath).then(setRepo);
  }, []);

  const choose = async (demoOnly = false) => {
    const path = await pickFolder();
    if (!path) return;
    const info = await api.repoInfo(path);
    setRepo(info);
    const name = path.split("/").filter(Boolean).pop() || "";
    setP((x) => ({
      ...x,
      repoPath: info.toplevel || path,
      baseBranch: info.defaultBranch || x.baseBranch,
      remote: info.remotes?.includes("origin") ? "origin" : info.remotes?.[0] || x.remote,
      name: x.name || (demoOnly ? "ChatSupport Web" : name.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())),
    }));
  };

  const testJira = async () => {
    setJira({ loading: true });
    try {
      setJira(await api.testJira(p));
    } catch (e) {
      setJira({ error: String((e as Error).message || e) });
    }
  };

  let mcpError: string | undefined;
  let mcpServers: string[] = [];
  try {
    const parsed = JSON.parse(p.mcpJson || "{}");
    if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Must be a JSON object");
    mcpServers = Object.keys(parsed.mcpServers || {});
  } catch (e) {
    mcpError = (e as Error).message;
  }

  const enabledAgents = p.agents.filter((a) => a.enabled && a.command.trim());
  const problems = [
    !p.name.trim() && "Give the project a name",
    !p.repoPath && "Choose a repository",
    repo && !repo.ok && "The folder isn't a git repository",
    !p.jql.trim() && "Add a JQL",
    mcpError && "MCP JSON is invalid",
    enabledAgents.length === 0 && "Enable at least one agent with a command",
    p.messaging.platform !== "none" && !p.messaging.channelId && "Pick a collab channel (Messaging step)",
    p.routines.some((r) => parseCron(r.schedule) instanceof Error) && "Fix the routine schedule(s)",
  ].filter(Boolean) as string[];

  const setAgent = (id: string, patch: Partial<AgentConfig>) => set({ agents: p.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  const setMsg = (patch: Partial<MessagingConfig>) => set({ messaging: { ...p.messaging, ...patch } });
  const setTpl = (k: keyof MessageTemplates, v: string) => setMsg({ templates: { ...p.messaging.templates, [k]: v } });
  const loadChannels = async () => {
    setChannels({ loading: true });
    const r = await api.listChannels(p, channelQuery).catch((e) => ({ channels: [], error: String((e as Error).message || e) }));
    setChannels({ list: r.channels, error: r.error });
  };
  const sendTest = async () => {
    setTestMsg(undefined);
    const r = await api.testMessage(p);
    setTestMsg({ ok: r.ok, text: r.ok ? `Sent to ${p.messaging.channelName || p.messaging.channelId}` : r.error || "Failed" });
  };
  const move = (i: number, d: -1 | 1) => {
    const a = [...p.agents];
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    set({ agents: a });
  };

  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">{isNew ? "New project" : p.name}</h1>
          <div className="page-sub">{isNew ? "A few quick steps. It starts picking up tickets as soon as you save." : "Changes apply from the next ticket."}</div>
        </div>
        <div className="row">
          {onDelete && <button className="btn ghost danger" onClick={onDelete}>Delete</button>}
          <button className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </div>

      <div className="steps">
        {STEPS.map((s, i) => (
          <button key={s} className={`step ${i === step ? "active" : ""} ${i < step ? "done" : ""}`} onClick={() => setStep(i)}>
            <span className="step-num">{i < step ? "✓" : i + 1}</span>
            {s}
          </button>
        ))}
      </div>

      <div className="card card-pad">
        {step === 0 && (
          <>
            <h3 className="card-title">Repository</h3>
            <p className="card-sub">The local git repo HandsFree works in. Each ticket gets its own worktree under <span className="mono">.worktrees/&lt;KEY&gt;</span>, so your checkout is never touched.</p>
            <div className="field">
              <label>Repository folder</label>
              <div className="row">
                <input className="input code" value={p.repoPath} placeholder="/Users/you/code/my-repo" onChange={(e) => set({ repoPath: e.target.value })} onBlur={() => p.repoPath && api.repoInfo(p.repoPath).then(setRepo)} />
                <button className="btn" onClick={() => choose()}>Choose…</button>
              </div>
              {repo && (repo.ok
                ? <div className="callout ok"><span className="check">✓</span><span className="t">Git repo found · default branch <b className="mono">{repo.defaultBranch}</b> · remotes: {repo.remotes?.join(", ") || "none"}</span></div>
                : <div className="callout err"><span className="t">{repo.error || "Not a git repository"}</span></div>)}
            </div>
            <div className="field">
              <label>Project name</label>
              <input className="input" value={p.name} placeholder="e.g. ChatSupport Web" onChange={(e) => set({ name: e.target.value })} />
            </div>
            <div className="grid3">
              <div className="field">
                <label>Base branch</label>
                <input className="input code" value={p.baseBranch} onChange={(e) => set({ baseBranch: e.target.value })} />
                <span className="hint">Worktrees branch off this; PRs target it.</span>
              </div>
              <div className="field">
                <label>Remote</label>
                <input className="input code" value={p.remote} onChange={(e) => set({ remote: e.target.value })} />
              </div>
              <div className="field">
                <label>Pull requests</label>
                <div className="row" style={{ height: 34 }}>
                  <Toggle on={p.draftPr} onChange={(v) => set({ draftPr: v })} />
                  <span>{p.draftPr ? "Open as draft" : "Open ready for review"}</span>
                </div>
              </div>
            </div>
            <h3 className="card-title" style={{ marginTop: 22 }}>After the PR opens</h3>
            <p className="card-sub">HandsFree keeps checking the PR on GitHub (Settings → <i>Check PRs every</i>).</p>
            <div className="grid3">
              <div className="field">
                <label>CI fails</label>
                <div className="row" style={{ height: 34 }}>
                  <Toggle on={p.ciAutoFix} onChange={(v) => set({ ciAutoFix: v })} />
                  <span>{p.ciAutoFix ? "Agents fix it in the same worktree" : "Just show it as failing"}</span>
                </div>
              </div>
              <div className="field">
                <label>Max automatic fix rounds</label>
                <input className="input num-input" type="number" min={0} max={5} value={p.ciFixMaxRounds} onChange={(e) => set({ ciFixMaxRounds: Math.min(5, Math.max(0, Number(e.target.value) || 0)) })} />
                <span className="hint">Per PR. “Fix CI” on the dashboard always works.</span>
              </div>
              <div className="field">
                <label>Approved but not merged after</label>
                <div className="row">
                  <input className="input num-input" type="number" min={5} max={1440} value={p.mergeNudgeAfterMin} onChange={(e) => set({ mergeNudgeAfterMin: Math.min(1440, Math.max(5, Number(e.target.value) || 30)) })} />
                  <span className="muted">min</span>
                </div>
                <span className="hint">Then HandsFree nudges you (and, later, the team).</span>
              </div>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h3 className="card-title">Jira</h3>
            <p className="card-sub">Which tickets to pick up. HandsFree runs this through your Jira CLI (<span className="mono">acli</span>), using the login already on your Mac — no tokens stored here. Jira status is never changed; HandsFree only comments the PR link.</p>
            <div className="field">
              <label>JQL</label>
              <textarea className="textarea code" rows={3} value={p.jql} onChange={(e) => set({ jql: e.target.value })} />
              <span className="hint">Tip: add a label like <span className="mono">labels = handsfree</span> to control exactly what gets picked up. Each ticket is only picked up once.</span>
            </div>
            <div className="row" style={{ marginBottom: 14 }}>
              <button className="btn" onClick={testJira} disabled={jira?.loading}>{jira?.loading ? "Running…" : "Test JQL"}</button>
              {jira?.issues && <span className="small muted">{jira.issues.length} ticket{jira.issues.length === 1 ? "" : "s"} match right now</span>}
            </div>
            {jira?.error && <div className="callout err" style={{ marginBottom: 14 }}><span className="t mono" style={{ whiteSpace: "pre-wrap" }}>{jira.error}</span></div>}
            {jira?.issues && jira.issues.length > 0 && (
              <div className="issue-list" style={{ marginBottom: 18 }}>
                {jira.issues.slice(0, 8).map((i) => (
                  <div key={i.key} className="issue-row"><span className="key">{i.key}</span><span>{i.summary}</span></div>
                ))}
              </div>
            )}
            <details>
              <summary className="small muted" style={{ cursor: "pointer", marginBottom: 12 }}>Advanced: CLI commands</summary>
              <div className="field">
                <label>Search command</label>
                <input className="input code" value={p.jiraSearchCommand} onChange={(e) => set({ jiraSearchCommand: e.target.value })} />
                <span className="hint"><span className="mono">{"{jql}"}</span> is filled in for you. Must print JSON (or any text containing issue keys).</span>
              </div>
              <div className="field">
                <label>Comment command</label>
                <input className="input code" value={p.jiraCommentCommand} onChange={(e) => set({ jiraCommentCommand: e.target.value })} />
                <span className="hint"><span className="mono">{"{issue_key}"}</span> and <span className="mono">{"{body}"}</span> are filled in. Leave empty to skip commenting.</span>
              </div>
            </details>
          </>
        )}

        {step === 2 && (
          <>
            <h3 className="card-title">MCP servers</h3>
            <p className="card-sub">Project-level MCP config. It's written to <span className="mono">.handsfree/mcp.json</span> inside each worktree and passed to agents through <span className="mono">{"{mcp_file}"}</span>. Servers that need a login use whatever is already logged in on your Mac.</p>
            <div className="field">
              <label>mcp.json</label>
              <textarea className="textarea code" rows={14} value={p.mcpJson} spellCheck={false} onChange={(e) => set({ mcpJson: e.target.value })} />
              {mcpError
                ? <div className="callout err"><span className="t">Invalid JSON: {mcpError}</span></div>
                : <div className="callout ok"><span className="check">✓</span><span className="t">Valid · {mcpServers.length} server{mcpServers.length === 1 ? "" : "s"}{mcpServers.length ? `: ${mcpServers.join(", ")}` : ""}</span></div>}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h3 className="card-title">Agent chain</h3>
            <p className="card-sub">Agents run top to bottom. If one exits with an error, makes no changes, times out or hits a token/usage limit, the next one continues <b>in the same worktree</b>. Up to 4.</p>
            {p.agents.map((a, i) => (
              <div key={a.id} className={`agent-row ${a.enabled ? "" : "disabled"}`}>
                <div className="agent-order">{i + 1}</div>
                <div>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <input className="input" style={{ maxWidth: 220, fontWeight: 600 }} value={a.name} onChange={(e) => setAgent(a.id, { name: e.target.value })} />
                    {i === 0 && <span className="agent-tag">Primary</span>}
                    {i > 0 && <span className="agent-tag" style={{ color: "var(--faint)" }}>Fallback {i}</span>}
                  </div>
                  <div className="field" style={{ marginBottom: 8 }}>
                    <input className="input code" value={a.command} placeholder="Headless command, e.g. mytool run {prompt}" onChange={(e) => setAgent(a.id, { command: e.target.value })} />
                    {!a.command.trim() && <span className="hint" style={{ color: "var(--amber)" }}>Add this agent's headless command to enable it.</span>}
                  </div>
                  <details>
                    <summary className="small muted" style={{ cursor: "pointer" }}>Token-exhaustion patterns ({a.exhaustionPatterns.length})</summary>
                    <textarea className="textarea code" rows={4} style={{ marginTop: 8 }} value={a.exhaustionPatterns.join("\n")} onChange={(e) => setAgent(a.id, { exhaustionPatterns: e.target.value.split("\n").filter((x) => x.trim()) })} />
                    <span className="hint small muted">One regex per line, matched against the end of the agent's output.</span>
                  </details>
                  <details style={{ marginTop: 6 }}>
                    <summary className="small muted" style={{ cursor: "pointer" }}>
                      Take over {a.resumeCommand?.trim() ? "· resumes the session" : "· opens a shell"}
                    </summary>
                    <div className="field" style={{ marginTop: 8, marginBottom: 8 }}>
                      <label className="small">Resume command</label>
                      <input className="input code" value={a.resumeCommand || ""} placeholder="e.g. mytool resume {session_id}" onChange={(e) => setAgent(a.id, { resumeCommand: e.target.value })} />
                      <span className="hint">Interactive command that continues this agent's session when you take over. Placeholders: <span className="mono">{"{session_id} {mcp_file} {worktree} {issue_key}"}</span>. Leave empty to get a shell in the worktree.</span>
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <label className="small">Session ID pattern</label>
                      <input className="input code" value={a.sessionIdPattern || ""} placeholder="e.g. session[:\s]+([\w-]+)" onChange={(e) => setAgent(a.id, { sessionIdPattern: e.target.value })} />
                      <span className="hint">Regex with one group that finds the session ID in the agent's output. Claude's is built in.</span>
                    </div>
                  </details>
                </div>
                <div className="agent-controls">
                  <Toggle on={a.enabled} onChange={(v) => setAgent(a.id, { enabled: v })} />
                  <div className="row" style={{ gap: 2, marginTop: 6 }}>
                    <button className="btn ghost sm" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</button>
                    <button className="btn ghost sm" disabled={i === p.agents.length - 1} onClick={() => move(i, 1)} title="Move down">↓</button>
                    <button className="btn ghost sm" onClick={() => set({ agents: p.agents.filter((x) => x.id !== a.id) })} title="Remove">✕</button>
                  </div>
                </div>
              </div>
            ))}
            {p.agents.length < 4 && (
              <div className="row" style={{ marginBottom: 16 }}>
                <select className="select" style={{ maxWidth: 240 }} value="" onChange={(e) => {
                  const preset = AGENT_PRESETS.find((x) => x.name === e.target.value);
                  set({ agents: [...p.agents, { id: uid(), ...(preset || { name: "Custom agent", command: "", enabled: true, exhaustionPatterns: [...DEFAULT_EXHAUSTION_PATTERNS] }) }] });
                }}>
                  <option value="" disabled>+ Add agent…</option>
                  {AGENT_PRESETS.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                  <option value="__custom">Custom…</option>
                </select>
              </div>
            )}
            <div className="callout info" style={{ marginBottom: 16 }}>
              <span className="t">
                Placeholders (HandsFree quotes them — don't add quotes): <span className="mono">{"{prompt}"}</span> <span className="mono">{"{prompt_file}"}</span> <span className="mono">{"{mcp_file}"}</span> <span className="mono">{"{issue_key}"}</span> <span className="mono">{"{worktree}"}</span> <span className="mono">{"{branch}"}</span>
              </span>
            </div>
            <div className="field">
              <label>Extra instructions for this project</label>
              <textarea className="textarea" rows={3} placeholder="e.g. Use pnpm. Run pnpm test and pnpm lint before committing." value={p.promptExtra} onChange={(e) => set({ promptExtra: e.target.value })} />
              <span className="hint">Appended to every prompt. Agents are told to commit but not push — HandsFree pushes and opens the PR.</span>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h3 className="card-title">Messaging</h3>
            <p className="card-sub">Where HandsFree tells the team about this project's PRs: when CI passes on a published PR, when an approved PR waits too long, and whenever you press Send.</p>
            <div className="field">
              <label>Platform</label>
              <select className="select" style={{ maxWidth: 360 }} value={p.messaging.platform} onChange={(e) => setMsg({ platform: e.target.value as MessagingPlatform })}>
                <option value="none">None — don't message</option>
                <option value="setmore">Setmore collab (direct, signed in via Settings → Accounts)</option>
                <option value="agent">Agent (any platform your MCP connectors reach)</option>
              </select>
            </div>
            {p.messaging.platform !== "none" && (
              <>
                {p.messaging.platform === "agent" && (
                  <div className="field">
                    <label>Agent command</label>
                    <input className="input code" value={p.messaging.agentCommand} onChange={(e) => setMsg({ agentCommand: e.target.value })} />
                    <span className="hint"><span className="mono">{"{prompt}"}</span> is filled in. The agent must have the platform's send_message tool; the default uses Claude with the Setmore connector.</span>
                  </div>
                )}
                <div className="field">
                  <label>Channel</label>
                  <div className="row">
                    <input className="input" style={{ maxWidth: 240 }} placeholder="filter by name" value={channelQuery} onChange={(e) => setChannelQuery(e.target.value)} />
                    <button className="btn" onClick={loadChannels} disabled={channels?.loading}>{channels?.loading ? "Loading…" : "Load channels"}</button>
                    <span className="small muted">{p.messaging.channelName ? `Selected: ${p.messaging.channelName}` : p.messaging.channelId ? `Selected id: ${p.messaging.channelId}` : "None selected"}</span>
                  </div>
                  {channels?.error && <div className="callout err"><span className="t">{channels.error}</span></div>}
                  {channels?.list && (
                    <div className="issue-list" style={{ marginTop: 8 }}>
                      {channels.list.length === 0 && <div className="issue-row small muted">No channels found.</div>}
                      {channels.list.map((c) => (
                        <div key={c.id} className="issue-row" style={{ cursor: "pointer" }} onClick={() => setMsg({ channelId: c.id, channelName: c.name })}>
                          <span className="key">{c.id === p.messaging.channelId ? "✓" : ""}</span><span>{c.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <input className="input code" style={{ marginTop: 8 }} placeholder="or paste a channel id" value={p.messaging.channelId} onChange={(e) => setMsg({ channelId: e.target.value })} />
                </div>
                {(
                  [
                    ["reviewReady", "CI passed on a published PR"],
                    ["mergeNudge", "Approved but not merged after the project's delay"],
                    ["manual", "Send button (prefilled, editable)"],
                    ["bulk", "Several selected PRs ({list} = one line per PR)"],
                  ] as [keyof MessageTemplates, string][]
                ).map(([k, label]) => (
                  <div key={k} className="field">
                    <label>{label}</label>
                    <textarea className="textarea" rows={2} value={p.messaging.templates[k]} onChange={(e) => setTpl(k, e.target.value)} />
                  </div>
                ))}
                <div className="callout info" style={{ marginBottom: 14 }}>
                  <span className="t">Placeholders: <span className="mono">{"{key} {summary} {pr_url} {pr_number} {project} {branch} {approved_ago} {list}"}</span>. Leave a template empty to skip that message.</span>
                </div>
                <div className="row">
                  <button className="btn" onClick={sendTest} disabled={!p.messaging.channelId}>Send test message</button>
                  {testMsg && <span className={`small ${testMsg.ok ? "muted" : "err-text"}`}>{testMsg.text}</span>}
                </div>
              </>
            )}
          </>
        )}

        {step === ROUTINES && <RoutinesStep api={api} p={p} set={set} state={state} saved={isNew ? [] : initial.routines.map((r) => r.id)} />}

        {step === REVIEW && (
          <>
            <h3 className="card-title">Review</h3>
            <p className="card-sub">Once saved, HandsFree checks this JQL on the next poll and starts working.</p>
            <dl className="review-grid">
              <dt>Name</dt><dd>{p.name || <span className="err-text">missing</span>}</dd>
              <dt>Repository</dt><dd className="mono">{p.repoPath || <span className="err-text">missing</span>}</dd>
              <dt>Base / remote</dt><dd className="mono">{p.baseBranch} · {p.remote}</dd>
              <dt>JQL</dt><dd className="mono">{p.jql}</dd>
              <dt>MCP servers</dt><dd>{mcpError ? <span className="err-text">invalid JSON</span> : mcpServers.join(", ") || "none"}</dd>
              <dt>Agent chain</dt>
              <dd className="chain">
                {enabledAgents.map((a, i) => (
                  <span key={a.id} className="row" style={{ gap: 4 }}>
                    {i > 0 && <span className="chain-arrow">›</span>}
                    <span className={`chain-step ${i === 0 ? "current" : ""}`}>{a.name}</span>
                  </span>
                ))}
              </dd>
              <dt>Pull requests</dt><dd>{p.draftPr ? "Draft" : "Ready for review"}, PR link commented on the Jira ticket</dd>
              <dt>Messaging</dt>
              <dd>{p.messaging.platform === "none" ? "off" : `${p.messaging.platform === "setmore" ? "Setmore collab" : "agent"} → ${p.messaging.channelName || p.messaging.channelId || "no channel"}`}</dd>
              <dt>Routines</dt>
              <dd>{p.routines.length === 0 ? "none" : p.routines.map((r) => `${r.name}${r.enabled ? "" : " (off)"} · ${cronText(r.schedule)}`).join(" · ")}</dd>
              <dt>After the PR</dt>
              <dd>
                {p.ciAutoFix ? `CI failures fixed automatically, up to ${p.ciFixMaxRounds} round${p.ciFixMaxRounds === 1 ? "" : "s"}` : "CI failures only shown"} · nudge after {p.mergeNudgeAfterMin} min approved · worktree removed on merge, merge commented on the ticket
              </dd>
            </dl>
            {problems.length > 0 && (
              <div className="callout warn" style={{ marginTop: 16 }}>
                <span className="t">{problems.join(" · ")}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="footer-bar">
        <button className="btn" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        <div className="spacer" />
        {step < STEPS.length - 1 ? (
          <button className="btn primary" onClick={() => setStep(step + 1)}>Continue</button>
        ) : (
          <button
            className="btn primary"
            disabled={problems.length > 0 || saving}
            onClick={async () => {
              setSaving(true);
              await onSave(p);
              setSaving(false);
            }}
          >
            {isNew ? "Save & activate" : "Save changes"}
          </button>
        )}
      </div>
    </div>
  );
}

function cronText(schedule: string) {
  const spec = parseCron(schedule);
  return spec instanceof Error ? `invalid: ${spec.message}` : describeCron(spec, schedule);
}

function RoutinesStep({
  api,
  p,
  set,
  state,
  saved,
}: {
  api: Api;
  p: ProjectConfig;
  set: (patch: Partial<ProjectConfig>) => void;
  state?: EngineState;
  /** Routine ids the engine already knows (saved config); only those can Run now. */
  saved: string[];
}) {
  const [result, setResult] = useState<Record<string, { ok: boolean; text: string }>>({});
  const setRoutine = (id: string, patch: Partial<RoutineConfig>) => set({ routines: p.routines.map((r) => (r.id === id ? { ...r, ...patch } : r)) });
  const add = (name: string) => {
    const preset = ROUTINE_PRESETS.find((x) => x.name === name);
    const r: RoutineConfig = preset
      ? { ...preset, id: uid() }
      : { id: uid(), name: "Custom routine", enabled: true, schedule: "0 10 * * 1-5", prompt: "", agentCommand: "", postToChannel: true, timeoutMin: 15 };
    set({ routines: [...p.routines, r] });
  };
  const runNow = async (id: string) => {
    try {
      await api.runRoutine(id);
      setResult((x) => ({ ...x, [id]: { ok: true, text: "Started — the result shows below when it finishes." } }));
    } catch (e) {
      setResult((x) => ({ ...x, [id]: { ok: false, text: String((e as Error).message || e) } }));
    }
  };
  return (
    <>
      <h3 className="card-title">Routines</h3>
      <p className="card-sub">
        Scheduled agent runs for this project — a daily PR report, a Sentry check — whose final text is posted to the project's collab channel
        {p.messaging.platform === "none" ? " (no messaging platform yet: results stay in HandsFree)" : ""}. Optional.
      </p>
      {!p.enabled && p.routines.length > 0 && (
        <div className="callout warn" style={{ marginBottom: 12 }}><span className="t">Paused with the project: routines don't run while the project is Off.</span></div>
      )}
      {p.routines.map((r) => {
        const spec = parseCron(r.schedule);
        const st = state?.routines?.[r.id];
        const isSaved = saved.includes(r.id);
        const res = result[r.id];
        return (
          <div key={r.id} className={`card card-pad routine-card ${r.enabled ? "" : "disabled"}`}>
            <div className="row" style={{ marginBottom: 10 }}>
              <input className="input" style={{ maxWidth: 260, fontWeight: 600 }} value={r.name} onChange={(e) => setRoutine(r.id, { name: e.target.value })} />
              <Toggle on={r.enabled} title={r.enabled ? "Turn this routine off" : "Turn this routine on"} onChange={(v) => setRoutine(r.id, { enabled: v })} />
              <div className="spacer" />
              <button
                className="btn sm"
                disabled={!isSaved || st?.running || !p.enabled}
                title={!p.enabled ? "Paused with the project" : isSaved ? "Run it now, ignoring the schedule" : "Save the project first"}
                onClick={() => runNow(r.id)}
              >
                {st?.running ? "Running…" : "Run now"}
              </button>
              <button
                className="btn ghost sm danger"
                onClick={() => confirm(`Delete routine “${r.name}”?`) && set({ routines: p.routines.filter((x) => x.id !== r.id) })}
              >
                Delete
              </button>
            </div>
            <div className="field">
              <label>Schedule (cron, local time)</label>
              <input className="input code" style={{ maxWidth: 260 }} value={r.schedule} onChange={(e) => setRoutine(r.id, { schedule: e.target.value })} />
              {spec instanceof Error ? <span className="hint err-text">{spec.message}</span> : <span className="hint">{describeCron(spec, r.schedule)}</span>}
            </div>
            <div className="field">
              <label>Prompt</label>
              <textarea className="textarea" rows={6} value={r.prompt} onChange={(e) => setRoutine(r.id, { prompt: e.target.value })} />
              <span className="hint">Placeholders: <span className="mono">{"{project} {repo} {repo_path} {channel} {now} {last_run} {last_run_human}"}</span>. The agent's final text is the report.</span>
            </div>
            <details>
              <summary className="small muted" style={{ cursor: "pointer" }}>Advanced</summary>
              <div className="field" style={{ marginTop: 8 }}>
                <label className="small">Agent command</label>
                <input className="input code" value={r.agentCommand} placeholder={DEFAULT_ROUTINE_COMMAND} onChange={(e) => setRoutine(r.id, { agentCommand: e.target.value })} />
                <span className="hint">
                  <span className="mono">{"{prompt}"}</span> is filled in. Must print Claude's <span className="mono">--output-format json</span> envelope. Runs in the repo. List the
                  tools the prompt needs with <span className="mono">--allowedTools</span> (the presets do); nothing is pre-approved otherwise. Opt into
                  <span className="mono"> --dangerously-skip-permissions</span> yourself only if you accept that the agent can run anything.
                </span>
              </div>
              <div className="row" style={{ gap: 18 }}>
                <label className="row small">
                  <Toggle on={r.postToChannel} onChange={(v) => setRoutine(r.id, { postToChannel: v })} /> Post the result to the collab channel
                </label>
                <label className="row small">
                  Timeout
                  <input className="input" type="number" min={1} max={120} style={{ width: 70 }} value={r.timeoutMin} onChange={(e) => setRoutine(r.id, { timeoutMin: Number(e.target.value) || 15 })} />
                  min
                </label>
              </div>
            </details>
            <div className="routine-status small muted">
              <span>Next run: {r.enabled && st?.nextRunAt ? until(st.nextRunAt) : "—"}</span>
              <span>
                Last run:{" "}
                {st?.last ? (
                  <>
                    {ago(st.last.startedAt)} <span className={`pill ${st.running ? "wait" : st.last.ok ? "ok" : "bad"}`}>{st.running ? "running" : st.last.ok ? "ok" : "failed"}</span>{" "}
                    {(st.last.output || "").split("\n")[0].slice(0, 120)}
                  </>
                ) : (
                  "never"
                )}
              </span>
            </div>
            {res && <div className={`callout ${res.ok ? "info" : "err"}`} style={{ marginTop: 8 }}><span className="t">{res.text}</span></div>}
          </div>
        );
      })}
      <div className="row" style={{ marginBottom: 8 }}>
        <select className="select" style={{ maxWidth: 240 }} value="" onChange={(e) => add(e.target.value)}>
          <option value="" disabled>+ Add routine…</option>
          {ROUTINE_PRESETS.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          <option value="__custom">Custom…</option>
        </select>
      </div>
      <div className="callout info">
        <span className="t">
          The Sentry check uses your claude.ai Sentry connector in Claude Code: run <span className="mono">claude</span>, type <span className="mono">/mcp</span> and authenticate Sentry once.
        </span>
      </div>
    </>
  );
}
