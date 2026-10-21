import { useEffect, useState } from "react";
import type { AccountStatus, Config, Settings } from "../../engine/src/types";
import { openExternal, setLaunchAtLogin, type Api, type DoctorItem } from "../api";
import { Toggle } from "../ui";

export function SettingsView({ api, config }: { api: Api; config: Config }) {
  const [doctor, setDoctor] = useState<DoctorItem[]>();
  const [checking, setChecking] = useState(false);
  const [acct, setAcct] = useState<AccountStatus>();
  const [loginMsg, setLoginMsg] = useState<string>();
  const s = config.settings;
  const sm = s.accounts.setmore;
  const updateSetmore = (patch: Partial<typeof sm>) => update({ accounts: { ...s.accounts, setmore: { ...sm, ...patch } } });

  useEffect(() => {
    api.setmoreStatus().then(setAcct).catch(() => {});
    return api.subscribe((e) => {
      if (e.type === "account" && e.name === "setmore") setAcct(e.status);
    });
  }, []);
  const login = async () => {
    setLoginMsg(undefined);
    try {
      const { url } = await api.setmoreLogin();
      await openExternal(url);
      setLoginMsg("Finish signing in in your browser, then come back here.");
    } catch (e) {
      setLoginMsg(String((e as Error).message || e));
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
        <h3 className="card-title">Accounts · Setmore</h3>
        <p className="card-sub">Setmore collab messages are sent as you. HandsFree signs in once with the client id the auth team issued; tokens stay on this Mac.</p>
        <div className="field">
          <label>Setmore client id</label>
          <input className="input code" value={sm.clientId} placeholder="from the auth team" onChange={(e) => updateSetmore({ clientId: e.target.value })} />
          <span className="hint">Registered redirect URI: <span className="mono">http://127.0.0.1:{sm.redirectPort}/oauth/callback</span></span>
        </div>
        <div className="setting-row">
          <div className="txt">
            <b>{acct?.loggedIn ? `Signed in${acct.user ? ` as ${acct.user}` : ""}` : acct?.loginPending ? "Waiting for the browser…" : "Not signed in"}</b>
            <span className={acct?.error ? "err-text" : ""}>{acct?.error || (acct?.loggedIn ? `Scopes: ${acct.scope || "—"}` : "Enter the client id, then log in.")}</span>
          </div>
          {acct?.loggedIn ? (
            <button className="btn sm" onClick={() => api.setmoreLogout().then(() => api.setmoreStatus().then(setAcct))}>Log out</button>
          ) : (
            <button className="btn sm primary" disabled={!sm.clientId.trim() || acct?.loginPending} onClick={login}>Log in</button>
          )}
        </div>
        {loginMsg && <div className="callout info"><span className="t">{loginMsg}</span></div>}
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>Advanced</summary>
          <div className="grid3" style={{ marginTop: 10 }}>
            <div className="field"><label>Redirect port</label><input className="input num-input" type="number" min={1024} max={65535} value={sm.redirectPort} onChange={(e) => updateSetmore({ redirectPort: Number(e.target.value) || 47831 })} /></div>
            <div className="field"><label>MCP URL</label><input className="input code" value={sm.mcpUrl} onChange={(e) => updateSetmore({ mcpUrl: e.target.value })} /></div>
            <div className="field"><label>Issuer</label><input className="input code" value={sm.issuer} onChange={(e) => updateSetmore({ issuer: e.target.value })} /></div>
          </div>
          <div className="field"><label>Scopes</label><input className="input code" value={sm.scopes} onChange={(e) => updateSetmore({ scopes: e.target.value })} /></div>
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
