import { useEffect, useMemo, useState } from "react";
import type { Config, EngineState } from "../engine/src/types";
import { getApi, notify, onTrayTogglePause, type Api } from "./api";
import { Icon, Logo, until, useTick } from "./ui";
import { Dashboard } from "./views/Dashboard";
import { Projects } from "./views/Projects";
import { SettingsView } from "./views/Settings";

type View = "dashboard" | "projects" | "settings";

export default function App() {
  const demo = window.__HF_DEMO__;
  const [api, setApi] = useState<Api>();
  const [config, setConfig] = useState<Config>();
  const [state, setState] = useState<EngineState>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<View>(demo?.view || "dashboard");
  const [editing, setEditing] = useState<string | null>(
    demo?.editorNew ? "new" : demo?.editorStep !== undefined ? "p1" : null,
  );

  const [gen, setGen] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  useTick();

  // Bumping `gen` (the Refresh button) tears down the event stream, refetches, and resubscribes.
  useEffect(() => {
    let unsub = () => {};
    let alive = true;
    setRefreshing(true);
    setRefreshError(undefined);
    getApi()
      .then(async (a) => {
        setApi(a);
        const [c, s] = await Promise.all([a.getConfig(), a.getState()]);
        if (!alive) return;
        setConfig(c);
        setState(s);
        setError(undefined);
        unsub = a.subscribe((e) => {
          if (e.type === "state") setState(e.state);
          if (e.type === "config") setConfig(e.config);
          if (e.type === "notify") void notifyIfEnabled(e.title, e.body);
        });
      })
      // The first load failing means the engine is down: full-screen error. A later Refresh failing is shown inline.
      .catch((e) => (gen === 0 ? setError(String(e?.message || e)) : setRefreshError(String(e?.message || e))))
      .finally(() => setRefreshing(false));
    return () => {
      alive = false;
      unsub();
    };
  }, [gen]);

  // Read the latest notification setting without re-subscribing.
  const notifyIfEnabled = async (title: string, body: string) => {
    const a = await getApi();
    const c = await a.getConfig();
    if (c.settings.notifications) await notify(title, body);
  };

  const paused = !!config?.settings.paused;
  const active = !!config?.projects.some((p) => p.enabled);
  const togglePause = async () => {
    if (!api) return;
    const c = await api.getConfig();
    if (c.settings.paused) await api.resume();
    else await api.pause();
  };

  useEffect(() => {
    let off = () => {};
    onTrayTogglePause(() => void togglePause()).then((f) => (off = f));
    return () => off();
  }, [api]);

  const counts = useMemo(() => {
    const t = Object.values(state?.tickets || {});
    return { running: t.filter((x) => x.status === "running").length };
  }, [state]);

  if (error) {
    return (
      <div className="empty">
        <Logo size={48} />
        <h2>HandsFree couldn't start</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!api || !config || !state) return <div className="empty muted">Starting…</div>;

  const go = (v: View) => {
    setView(v);
    setEditing(null);
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">HandsFree</div>
            <div className="brand-sub">you walk, it runs</div>
          </div>
        </div>
        <button className={`nav-item ${view === "dashboard" ? "active" : ""}`} onClick={() => go("dashboard")}>
          {Icon.dashboard} Dashboard
          {counts.running > 0 && <span className="count">{counts.running} running</span>}
        </button>
        <button className={`nav-item ${view === "projects" ? "active" : ""}`} onClick={() => go("projects")}>
          {Icon.projects} Projects
          <span className="count">{config.projects.length || ""}</span>
        </button>
        <button className={`nav-item ${view === "settings" ? "active" : ""}`} onClick={() => go("settings")}>
          {Icon.settings} Settings
        </button>

        <div className="sidebar-foot">
          <div className="engine-line">
            <span className="dot" style={{ color: paused ? "var(--amber)" : active ? "var(--accent)" : "var(--faint)" }} />
            {paused ? "Paused" : active ? "Watching Jira" : "Idle"}
          </div>
          <div className="engine-sub">
            {paused
              ? "Running agents finish; no new tickets."
              : active
                ? `Next check ${until(state.nextPollAt)}${state.nextPrCheckAt ? ` · PRs ${until(state.nextPrCheckAt)}` : ""}`
                : "Add a project to start"}
          </div>
          {refreshError && <div className="engine-sub err-text" title={refreshError}>Refresh failed: {refreshError.slice(0, 60)}</div>}
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={togglePause}>
              {paused ? Icon.play : Icon.pause} {paused ? "Resume" : "Pause"}
            </button>
            <button className="btn sm ghost" onClick={() => setGen((g) => g + 1)} disabled={refreshing} title="Reload config and state from the engine">
              <span className={refreshing ? "spin" : ""}>{Icon.refresh}</span> Refresh
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {view === "dashboard" && (
          <Dashboard
            api={api}
            config={config}
            state={state}
            initialTicket={demo?.ticket}
            onNewProject={() => {
              setView("projects");
              setEditing("new");
            }}
          />
        )}
        {view === "projects" && (
          <Projects api={api} config={config} editing={editing} setEditing={setEditing} initialStep={demo?.editorStep} />
        )}
        {view === "settings" && <SettingsView api={api} config={config} />}
      </main>
    </div>
  );
}
