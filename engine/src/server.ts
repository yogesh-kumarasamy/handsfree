import http from "node:http";
import os from "node:os";
import { repoInfo } from "./git";
import type { Orchestrator } from "./orchestrator";
import { exec, SHELL } from "./shell";
import { normalizeProject } from "./store";
import type { Config, ProjectConfig } from "./types";

const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:1420"]);

async function doctor(o: Orchestrator) {
  const names = new Set(["git", "gh"]);
  // acli only matters to projects that use Jira.
  if (o.config.projects.some((p) => p.tracker.kind === "jira")) names.add("acli");
  for (const p of o.config.projects) for (const a of p.agents) if (a.enabled && a.command.trim()) names.add(a.command.trim().split(/\s+/)[0]);
  const items = await Promise.all(
    [...names].map(async (name) => {
      // Probes run in a scratch folder: an agent tool is whatever the user configured, and the engine's own
      // cwd is a real checkout in dev/test (a probe that touches files must not land there).
      const cwd = os.tmpdir();
      const found = await exec(SHELL, ["-c", `command -v ${name.replace(/[^\w./-]/g, "")}`], { timeoutMs: 5000, cwd });
      if (found.code !== 0) return { name, ok: false, detail: "Not found on PATH" };
      if (name === "gh") {
        const auth = await exec("gh", ["auth", "status"], { timeoutMs: 15000, cwd });
        const out = (auth.stdout + auth.stderr).split("\n").map((l) => l.trim()).find((l) => /Logged in/i.test(l));
        return { name, ok: auth.code === 0, detail: auth.code === 0 ? out?.replace(/^✓\s*/, "") || "Logged in" : "Not logged in — run `gh auth login`" };
      }
      const v = await exec(name, ["--version"], { timeoutMs: 10000, cwd });
      const line = (v.stdout || v.stderr).trim().split("\n")[0];
      return { name, ok: true, detail: line || found.stdout.trim() };
    }),
  );
  return items;
}

export function startServer(o: Orchestrator, port: number, token: string) {
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-handsfree-token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    }
    if (req.method === "OPTIONS") return void res.writeHead(204).end();

    const url = new URL(req.url || "/", "http://127.0.0.1");
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };

    if (url.pathname === "/api/health") return send(200, { ok: true });

    // Every other route needs the token. Custom header forces a CORS preflight, so other websites can't call us.
    const auth = req.headers["x-handsfree-token"] || (url.pathname === "/api/events" ? url.searchParams.get("token") : undefined);
    if (auth !== token) return send(401, { error: "unauthorized" });

    const body = async <T>(): Promise<T> => {
      let s = "";
      for await (const c of req) s += c;
      return (s ? JSON.parse(s) : {}) as T;
    };

    try {
      const m = url.pathname.match(/^\/api\/tickets\/([^/]+)\/(retry|stop|cleanup|forget|log|open|takeover|handback|publish|fix-ci|message|feedback|pickup-ready)$/);
      if (m) {
        const key = decodeURIComponent(m[1]);
        if (m[2] === "feedback") {
          const { text } = await body<{ text?: string }>();
          try {
            o.feedback(key, text || "");
            return send(200, {});
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        }
        if (m[2] === "message") {
          const { text } = await body<{ text?: string }>();
          try {
            return send(200, await o.messaging.sendManual(key, text));
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        }
        if (m[2] === "publish" || m[2] === "fix-ci" || m[2] === "pickup-ready") {
          try {
            if (m[2] === "publish") await o.publish(key);
            else if (m[2] === "pickup-ready") await o.markPickupReady(key);
            else await o.fixCi(key);
            return send(200, {});
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        }
        if (m[2] === "log") return send(200, { log: o.readLog(key) });
        if (m[2] === "open" || m[2] === "takeover" || m[2] === "handback") {
          const b = await body<{ mode?: string }>();
          try {
            if (m[2] === "open") return send(200, await o.open(key));
            if (m[2] === "takeover") {
              // Called from a live Terminal window: reply with just the resume command as text.
              const r = await o.takeOver(key, false);
              if (url.searchParams.get("text")) return void res.writeHead(200, { "content-type": "text/plain" }).end(r.resume);
              return send(200, r);
            }
            await o.handBack(key, b.mode === "pr" ? "pr" : "agents");
            return send(200, {});
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        }
        if (m[2] === "retry") o.retry(key);
        if (m[2] === "stop") o.stop(key);
        if (m[2] === "cleanup") await o.cleanup(key);
        if (m[2] === "forget") o.forget(key);
        return send(200, {});
      }
      const rm = url.pathname.match(/^\/api\/routines\/([^/]+)\/(run|log)$/);
      if (rm) {
        const id = decodeURIComponent(rm[1]);
        if (rm[2] === "log") return send(200, { log: o.readRoutineLog(id) });
        if (req.method !== "POST") return send(404, { error: "not found" });
        // Answer once the run has started; its progress and result arrive through state events.
        const why = o.routines.cannotRun(id);
        if (why) return send(400, { error: why });
        void o.routines.runNow(id).catch(() => undefined);
        return send(200, {});
      }
      switch (`${req.method} ${url.pathname}`) {
        case "POST /api/routines/tick": {
          // Test-only: run due routines now (optionally as of a given instant) instead of waiting for the 30 s tick.
          if (process.env.HF_TEST !== "1") return send(404, { error: "not found" });
          const { now } = await body<{ now?: string }>();
          await o.routines.tick(now ? new Date(now) : undefined);
          return send(200, {});
        }
        case "GET /api/config":
          return send(200, o.config);
        case "PUT /api/config":
          return send(200, o.updateConfig(await body<Config>()));
        case "GET /api/state":
          return send(200, o.state);
        case "POST /api/pause":
          o.setPaused(true);
          return send(200, {});
        case "POST /api/resume":
          o.setPaused(false);
          return send(200, {});
        case "POST /api/poll-now":
          void o.poll();
          return send(200, {});
        case "POST /api/messages/bulk": {
          const { keys, text } = await body<{ keys: string[]; text?: string }>();
          return send(200, await o.messaging.sendBulk(Array.isArray(keys) ? keys : [], text));
        }
        case "POST /api/messaging/test": {
          const { project } = await body<{ project: ProjectConfig }>();
          return send(200, await o.messaging.sendTest(normalizeProject(project)));
        }
        case "POST /api/messaging/channels": {
          const { project, query } = await body<{ project: ProjectConfig; query?: string }>();
          try {
            return send(200, { channels: await o.messaging.listChannels(normalizeProject(project), query) });
          } catch (e) {
            return send(200, { channels: [], error: (e as Error).message });
          }
        }
        case "GET /api/accounts/setmore":
          return send(200, o.messaging.status());
        case "POST /api/accounts/setmore/login":
          try {
            return send(200, { url: await o.messaging.loginUrl() });
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        case "POST /api/accounts/setmore/logout":
          await o.messaging.logout();
          return send(200, {});
        case "GET /api/accounts/linear":
          return send(200, o.trackers.status());
        case "POST /api/accounts/linear/login":
          try {
            return send(200, { url: await o.trackers.loginUrl() });
          } catch (e) {
            return send(400, { error: (e as Error).message });
          }
        case "POST /api/accounts/linear/logout":
          await o.trackers.logout();
          return send(200, {});
        case "POST /api/check-prs-now":
          o.checkPrsNow();
          return send(200, {});
        case "POST /api/test-tracker": {
          const { project } = await body<{ project: ProjectConfig }>();
          try {
            return send(200, { issues: await o.trackers.trackerFor(normalizeProject(project)).search() });
          } catch (e) {
            return send(200, { issues: [], error: (e as Error).message });
          }
        }
        case "POST /api/repo-info":
          return send(200, await repoInfo((await body<{ path: string }>()).path));
        case "GET /api/doctor":
          return send(200, await doctor(o));
        case "GET /api/events": {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          res.write(`data: ${JSON.stringify({ type: "state", state: o.state })}\n\n`);
          const off = o.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
          const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
          req.on("close", () => {
            off();
            clearInterval(ping);
          });
          return;
        }
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
