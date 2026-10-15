// Clickable prototype entry: the real App on mock data, plus a bar to jump between journey steps.
import { useState } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { resetApi, type DemoOptions } from "./api";
import "./styles.css";

const SCREENS: { id: string; label: string; opts: DemoOptions }[] = [
  { id: "first-run", label: "First run", opts: { scenario: "empty" } },
  { id: "repo", label: "1 · Repository", opts: { scenario: "empty", view: "projects", editorNew: true, editorStep: 0 } },
  { id: "jira", label: "2 · Jira", opts: { scenario: "empty", view: "projects", editorNew: true, editorStep: 1, jiraTested: true } },
  { id: "mcp", label: "3 · MCP", opts: { scenario: "empty", view: "projects", editorNew: true, editorStep: 2 } },
  { id: "agents", label: "4 · Agents", opts: { scenario: "empty", view: "projects", editorNew: true, editorStep: 3 } },
  { id: "routines", label: "5 · Routines", opts: { scenario: "busy", view: "projects", editorStep: 5 } },
  { id: "review", label: "6 · Review", opts: { scenario: "empty", view: "projects", editorNew: true, editorStep: 6 } },
  { id: "dashboard", label: "Dashboard", opts: { scenario: "busy" } },
  { id: "fallback", label: "Ticket + fallback", opts: { scenario: "busy", ticket: "SET-982" } },
  { id: "manual", label: "Taken over", opts: { scenario: "busy", ticket: "CSW-1402" } },
  { id: "slow", label: "Slow run", opts: { scenario: "busy", ticket: "CSW-1421" } },
  { id: "projects", label: "Projects", opts: { scenario: "busy", view: "projects" } },
  { id: "settings", label: "Settings", opts: { scenario: "busy", view: "settings" } },
];

function Demo() {
  const start = Math.max(0, SCREENS.findIndex((s) => s.id === location.hash.slice(1)));
  const [i, setI] = useState(start);
  const pick = (n: number) => {
    window.__HF_DEMO__ = SCREENS[n].opts;
    resetApi();
    setI(n);
  };
  if (!window.__HF_DEMO__) window.__HF_DEMO__ = SCREENS[start].opts;
  return (
    <div className="demo-shell">
      <nav className="demo-bar" aria-label="Journey steps">
        <span className="demo-tag">Prototype · sample data</span>
        {SCREENS.map((s, n) => (
          <button key={s.id} id={`demo-${s.id}`} className={`demo-step ${n === i ? "on" : ""}`} onClick={() => pick(n)}>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="demo-app">
        <App key={i} />
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<Demo />);
