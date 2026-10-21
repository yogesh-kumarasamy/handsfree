import { useEffect, useState } from "react";
import type { AccountStatus, Config, Settings } from "../../engine/src/types";
import { openExternal, setLaunchAtLogin, type Api, type DoctorItem } from "../api";
import { Toggle } from "../ui";

export function SettingsView({ api, config }: { api: Api; config: Config }) {
  const [doctor, setDoctor] = useState<DoctorItem[]>();
  const [checking, setChecking] = useState(false);
  const s = config.settings;
  const lin = s.accounts.linear;
  const updateLinear = (patch: Partial<typeof lin>) => update({ accounts: { ...s.accounts, linear: { ...lin, ...patch } } });
  const [linAcct, setLinAcct] = useState<AccountStatus>();
  const [linMsg, setLinMsg] = useState<string>();

  useEffect(() => {
    api.linearStatus().then(setLinAcct).catch(() => {});
    return api.subscribe((e) => {
      if (e.type === "account" && e.name === "linear") setLinAcct(e.status);
    });
  }, []);
  const linearLogin = async () => {
    setLinMsg(undefined);
    try {
      const { url } = await api.linearLogin();
      await openExternal(url);
      setLinMsg("Finish signing in to Linear in your browser, then come back here.");
    } catch (e) {
      setLinMsg(String((e as Error).message || e));
    }
  };

  const update = async (patch: Partial<Settings>) => {
    if (patch.launchAtLogin !== undefined) await setLaunchAtLogin(patch.launchAtLogin).catch(() => {});
    await api.saveConfig({ ...config, settings: { ...s, ...patch } });
  };

  const runDoctor = async () => {
    setChecking(true);
    setDoctor(await api.doctor());
    setChecking(false);
  };
  useEffect(() => {
    void runDoctor();
  }, []);

  const num = (key: "pollIntervalMin" | "prPollIntervalMin" | "maxParallel" | "agentTimeoutMin" | "slowAfterMin", min: number, max: number) => (
    <input
      className="input num-input"
      type="number"
      min={min}
      max={max}
      defaultValue={s[key]}
      onBlur={(e) => {
        const v = Math.min(max, Math.max(min, Number(e.target.value) || min));
        e.target.value = String(v);
        if (v !== s[key]) void update({ [key]: v });
      }}
    />
  );

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">App-wide behaviour. Repos, tracker queries, MCP and agents live on each project.</div>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Orchestrator</h3>
        <div className="setting-row">
          <div className="txt"><b>Check tickets every</b><span>How often each project's tracker query is run.</span></div>
          {num("pollIntervalMin", 1, 240)}<span className="muted">min</span>
        </div>
        <div className="setting-row">
          <div className="txt"><b>Check PRs every</b><span>How often open PRs are checked on GitHub for CI, reviews and merges.</span></div>
          {num("prPollIntervalMin", 1, 60)}<span className="muted">min</span>
        </div>
        <div className="setting-row">
          <div className="txt"><b>Max parallel tickets</b><span>Worktrees with an agent running at the same time, across all projects.</span></div>
          {num("maxParallel", 1, 12)}<span className="muted" style={{ width: 22 }} />
        </div>
        <div className="setting-row">
          <div className="txt"><b>Flag as slow after</b><span>Marks the ticket ⏱ and notifies you, so you can open it live and step in. The agent keeps running.</span></div>
          {num("slowAfterMin", 1, 600)}<span className="muted">min</span>
        </div>
        <div className="setting-row">
          <div className="txt"><b>Agent timeout</b><span>An agent running longer than this is stopped and the next one takes over.</span></div>
          {num("agentTimeoutMin", 5, 600)}<span className="muted">min</span>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 className="card-title">On this Mac</h3>
        <div className="setting-row">
          <div className="txt"><b>Launch at login</b><span>Start HandsFree in the menu bar when you log in.</span></div>
          <Toggle on={s.launchAtLogin} onChange={(v) => update({ launchAtLogin: v })} />
        </div>
        <div className="setting-row">
          <div className="txt"><b>Notifications</b><span>When a draft PR opens, an agent falls back, or a ticket fails.</span></div>
          <Toggle on={s.notifications} onChange={(v) => update({ notifications: v })} />
        </div>
        <div className="setting-row">
          <div className="txt"><b>Pause picking up new tickets</b><span>Running agents finish. Also in the menu bar icon.</span></div>
          <Toggle on={s.paused} onChange={(v) => (v ? api.pause() : api.resume())} />
        </div>
        <div className="setting-row">
          <div className="txt"><b>Closing the window</b><span>HandsFree keeps running in the menu bar. Quit from the menu bar icon.</span></div>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Linear</h3>
        <p className="card-sub">For projects whose tracker is Linear. HandsFree registers itself with Linear the first time you log in (no client id needed); tokens stay on this Mac.</p>
        <div className="setting-row">
          <div className="txt">
            <b>{linAcct?.loggedIn ? `Signed in${linAcct.user ? ` as ${linAcct.user}` : ""}` : linAcct?.loginPending ? "Waiting for the browser…" : "Not signed in"}</b>
            <span className={linAcct?.error ? "err-text" : ""}>{linAcct?.error || (linAcct?.loggedIn ? `Scopes: ${linAcct.scope || "—"}` : "Log in to let Linear projects find, comment on and close issues.")}</span>
          </div>
          {linAcct?.loggedIn ? (
            <button className="btn sm" onClick={() => api.linearLogout().then(() => api.linearStatus().then(setLinAcct))}>Log out</button>
          ) : (
            <button className="btn sm primary" disabled={linAcct?.loginPending} onClick={linearLogin}>Log in</button>
          )}
        </div>
        {linMsg && <div className="callout info"><span className="t">{linMsg}</span></div>}
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>Advanced</summary>
          <div className="grid3" style={{ marginTop: 10 }}>
            <div className="field"><label>Redirect port</label><input className="input num-input" type="number" min={1024} max={65535} value={lin.redirectPort} onChange={(e) => updateLinear({ redirectPort: Number(e.target.value) || 47832 })} /></div>
            <div className="field"><label>MCP URL</label><input className="input code" value={lin.mcpUrl} onChange={(e) => updateLinear({ mcpUrl: e.target.value })} /></div>
            <div className="field"><label>Issuer</label><input className="input code" value={lin.issuer} onChange={(e) => updateLinear({ issuer: e.target.value })} /></div>
          </div>
          <div className="field"><label>Scopes</label><input className="input code" value={lin.scopes} onChange={(e) => updateLinear({ scopes: e.target.value })} /></div>
        </details>
      </div>

      <div className="card card-pad">
        <div className="row">
          <h3 className="card-title" style={{ margin: 0 }}>System check</h3>
          <div className="spacer" />
          <button className="btn sm" onClick={runDoctor} disabled={checking}>{checking ? "Checking…" : "Re-check"}</button>
        </div>
        <p className="card-sub" style={{ marginTop: 4 }}>HandsFree uses the CLIs and logins already on your Mac — nothing is stored here.</p>
        {doctor?.map((d) => (
          <div key={d.name} className="setting-row" style={{ padding: "9px 0" }}>
            <span className={d.ok ? "check" : "cross"} style={{ width: 14 }}>{d.ok ? "✓" : "✕"}</span>
            <span className="mono" style={{ width: 110, fontWeight: 600 }}>{d.name}</span>
            <span className={`small ${d.ok ? "muted" : "err-text"}`} style={{ flex: 1 }}>{d.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
