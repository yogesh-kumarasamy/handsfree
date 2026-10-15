// End-to-end test of the engine with fake acli / gh / agents. Run: npm run test:engine
// Scenario: JQL finds 2 tickets. Agent 1 ("grok") hits a rate limit; agent 2 ("claude") commits.
// Expect: fallback, push to a bare remote, draft PR, Jira comment, then cleanup after "merge".
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hf-e2e-"));
const bin = path.join(root, "bin");
const data = path.join(root, "data");
const repo = path.join(root, "repo");
const remote = path.join(root, "remote.git");
fs.mkdirSync(bin);
fs.mkdirSync(data);

const sh = (c, cwd = root) => execSync(c, { cwd, stdio: "pipe" }).toString().trim();
const script = (name, body) => {
  fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
  fs.chmodSync(path.join(bin, name), 0o755);
};

// --- a repo with a bare "origin"
sh(`git init -q --bare ${remote}`);
sh(`git init -q -b main ${repo}`);
sh(`git config user.email t@t.t && git config user.name T`, repo);
fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
sh(`git add -A && git commit -qm init && git remote add origin ${remote} && git push -q -u origin main`, repo);

// --- fakes
script("acli", `
if [ "$1 $2 $3" = "jira workitem search" ]; then
  echo '[{"key":"DEMO-1","fields":{"summary":"Add greeting","description":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Say hi in README"}]}]}}},{"key":"DEMO-2","fields":{"summary":"Second ticket"}}]'
  exit 0
fi
if [ "$1 $2 $3 $4" = "jira workitem comment create" ]; then echo "$@" >> "${root}/comments.log"; exit 0; fi
exit 1`);
script("gh", `
case "$1 $2" in
  "pr list") echo "" ;;
  "pr create") n=$(cat "${root}/prn" 2>/dev/null || echo 100); n=$((n+1)); echo $n > "${root}/prn"; echo "$@" >> "${root}/prs.log"; echo "https://github.com/acme/repo/pull/$n" ;;
  "pr view") n="\${3##*/}"; cat "${root}/pr-$n.json" 2>/dev/null || echo "{\\"number\\":$n,\\"url\\":\\"https://github.com/acme/repo/pull/$n\\",\\"state\\":\\"OPEN\\",\\"isDraft\\":true,\\"headRefOid\\":\\"aaa111\\",\\"mergedAt\\":null,\\"reviewDecision\\":\\"\\",\\"latestReviews\\":[],\\"statusCheckRollup\\":[]}" ;;
  "pr ready") echo "$@" >> "${root}/ready.log" ;;
  "run view") echo "$@" >> "${root}/runs.log"; echo "Run $3 ▸ job test"; echo "FAIL tests/greeting.test.js: expected hi, got hello" ;;
  "auth status") echo "Logged in to github.com as tester"; exit 0 ;;
esac`);
// stand-in for macOS `open`: keep a copy of the Terminal launcher so the test can read it
script("fakeopen", `cp "$1" "${root}/opened.command"`);
// a non-Claude agent that prints its session id and keeps working (for watch / take over)
script("fakeslow", `echo "SESSION: abc-12345678"; echo "thinking…"; sleep 60`);
// agent 1: edits a file, then dies on a rate limit
script("fakegrok", `echo "working on $HANDSFREE_ISSUE"; echo "partial" > partial.txt; echo "Error: 429 rate limit exceeded" >&2; exit 1`);
// agent 2: sees the previous work, commits
script("fakeclaude", `test -f "$2" || exit 9; grep -q "Previous attempts" "$2" && echo "saw previous attempt"; test -f "$4" || exit 8; echo "hi" >> README.md; git add -A; git commit -qm "$HANDSFREE_ISSUE: greeting"
echo '{"type":"system","subtype":"init","session_id":"sess-1234-abcd","model":"claude-test","mcp_servers":[{"name":"github","status":"connected"}]}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pnpm test"}}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"total_cost_usd":0.12,"result":"Summary: added greeting"}'`);

const project = {
  id: "p1",
  name: "Demo",
  enabled: true,
  repoPath: repo,
  baseBranch: "main",
  remote: "origin",
  jql: "project = DEMO",
  jiraSearchCommand: 'acli jira workitem search --jql {jql} --json',
  jiraCommentCommand: "acli jira workitem comment create --key {issue_key} --body {body}",
  mcpJson: '{"mcpServers":{"github":{"type":"http","url":"https://example.invalid/mcp"}}}',
  agents: [
    { id: "a1", name: "Grok", command: "fakegrok {prompt}", enabled: true, exhaustionPatterns: ["rate.?limit"] },
    { id: "a2", name: "Claude Code", command: "fakeclaude -p {prompt_file} --mcp-config {mcp_file}", enabled: true, exhaustionPatterns: ["rate.?limit"] },
  ],
  promptExtra: "Be nice.",
  draftPr: true,
};
fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ version: 1, settings: { pollIntervalMin: 60, prPollIntervalMin: 60, maxParallel: 1, agentTimeoutMin: 5, paused: false, notifications: true, launchAtLogin: false }, projects: [project] }));

const port = 48000 + Math.floor(Math.random() * 1000);
const token = "test-token";
const engine = spawn(process.execPath, [path.resolve("engine/dist/handsfree-engine.mjs")], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HF_DATA: data, HF_PORT: String(port), HF_TOKEN: token, HF_SKIP_LOGIN_PATH: "1", HF_OPEN_CMD: "fakeopen" },
  stdio: ["pipe", "inherit", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
const api = async (p, method = "GET", body) => {
  const r = await fetch(base + p, { method, headers: { "x-handsfree-token": token, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timeout waiting for: ${label}`);
}
// pr-<n>.json drives the fake `gh pr view` for PR <n>; default = open draft, no checks.
const prJson = (n, over = {}) =>
  fs.writeFileSync(
    path.join(root, `pr-${n}.json`),
    JSON.stringify({ number: n, url: `https://github.com/acme/repo/pull/${n}`, state: "OPEN", isDraft: true, headRefOid: "aaa111", mergedAt: null, reviewDecision: "", latestReviews: [], statusCheckRollup: [], ...over }),
  );
const checkPrs = () => api("/api/check-prs-now", "POST");
const ticket = async (k) => (await api("/api/state")).tickets[k];

try {
  await waitFor(() => fetch(base + "/api/health").then((r) => r.ok).catch(() => false), "engine up");
  assert.equal((await fetch(base + "/api/state")).status, 401, "auth required");

  const tj = await api("/api/test-jira", "POST", { project });
  assert.deepEqual(tj.issues.map((i) => i.key), ["DEMO-1", "DEMO-2"]);
  assert.equal(tj.issues[0].description, "Say hi in README");

  const info = await api("/api/repo-info", "POST", { path: repo });
  assert.equal(info.ok, true);

  // first poll happens ~3s after start
  const s1 = await waitFor(async () => {
    const s = await api("/api/state");
    return s.tickets["DEMO-1"]?.status === "pr_draft" && s;
  }, "DEMO-1 pr_open");
  const t1 = s1.tickets["DEMO-1"];
  assert.deepEqual(t1.attempts.map((a) => [a.agentName, a.outcome]), [["Grok", "exhausted"], ["Claude Code", "success"]]);
  assert.equal(t1.prUrl, "https://github.com/acme/repo/pull/101");
  assert.equal(t1.jiraCommented, true);
  assert.match(fs.readFileSync(path.join(root, "prs.log"), "utf8"), /--draft/);
  assert.match(fs.readFileSync(path.join(root, "comments.log"), "utf8"), /DEMO-1 .*pull\/101/);
  assert.match(sh(`git log --oneline main..handsfree/DEMO-1`, remote), /DEMO-1/, "branch pushed to remote");
  const wt = path.join(repo, ".worktrees", "DEMO-1");
  assert.ok(fs.existsSync(path.join(wt, ".handsfree", "mcp.json")), "mcp.json written");
  const prBodyText = fs.readFileSync(path.join(wt, ".handsfree", "pr-body.md"), "utf8");
  assert.match(prBodyText, /```\nSummary: added greeting\n```/, "PR body uses Claude's final summary");
  assert.equal(sh("git status --porcelain", repo), "", "main checkout untouched (.worktrees excluded)");
  const log = (await api("/api/tickets/DEMO-1/log")).log;
  assert.match(log, /Falling back to Agent 2\/2/);
  assert.match(log, /saw previous attempt/);
  assert.match(log, /· session started · claude-test · MCP: github/, "stream-json init formatted");
  assert.match(log, /→ Bash pnpm test/, "stream-json tool use formatted");
  assert.match(log, /■ done · success · 3 turns · \$0\.12\n\nSummary: added greeting/, "stream-json result formatted");
  assert.doesNotMatch(log, /"type":"assistant"/, "raw JSON hidden");
  assert.match(fs.readFileSync(path.join(root, "prs.log"), "utf8"), /--draft/);

  // Claude's session id is recorded, and "Open" resumes exactly that session
  assert.equal(t1.attempts[1].sessionId, "sess-1234-abcd");
  const term = await api("/api/tickets/DEMO-1/open", "POST", {});
  const mcpAbs = path.join(wt, ".handsfree", "mcp.json");
  assert.equal(term.command, `claude --resume 'sess-1234-abcd' --mcp-config '${mcpAbs}'`);
  const launcher = fs.readFileSync(path.join(root, "opened.command"), "utf8");
  assert.match(launcher, new RegExp(`cd '${wt}'`));
  assert.ok(launcher.includes(`\nclaude --resume 'sess-1234-abcd' --mcp-config '${mcpAbs}'\n`));
  assert.match(launcher, /git status --short/);
  assert.equal((await api("/api/state")).tickets["DEMO-1"].status, "pr_draft", "opening a PR'd ticket doesn't take it over");

  // maxParallel=1 → DEMO-2 runs after DEMO-1
  await waitFor(async () => (await api("/api/state")).tickets["DEMO-2"]?.status === "pr_draft", "DEMO-2 pr_open");

  // a ticket that is already known is not picked up again
  await api("/api/poll-now", "POST");
  await sleep(1500);
  assert.equal(Object.keys((await api("/api/state")).tickets).length, 2);

  // ---- PR check: draft PR gets its PrInfo; merge → worktree removed, Jira told, status merged
  await checkPrs();
  const checked = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.pr?.headSha === "aaa111" && t;
  }, "DEMO-1 PrInfo after first check");
  assert.equal(checked.status, "pr_draft");
  assert.equal(checked.pr.ci, "none");

  // TASK 5 INSERTS THE FIX SCENARIOS HERE

  prJson(101, { state: "MERGED", isDraft: false, headRefOid: "ddd444", mergedAt: "2026-10-15T10:00:00Z" });
  await checkPrs();
  const mergedT = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "merged" && t;
  }, "DEMO-1 merged");
  assert.ok(!fs.existsSync(wt), "worktree removed after merge");
  assert.equal(mergedT.pr.mergedAt, "2026-10-15T10:00:00Z");
  assert.match(fs.readFileSync(path.join(root, "comments.log"), "utf8"), /DEMO-1 .*Merged.*pull\/101/, "merge commented on Jira");
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /🔔 Merged/);

  // failing chain → failed, then retry
  // DEMO-2 is re-picked as fresh work: drop its worktree and the pushed branch so nothing is "continued".
  await api("/api/tickets/DEMO-2/cleanup", "POST");
  assert.equal((await ticket("DEMO-2")).status, "pr_draft", "cleanup keeps tracking an open PR");
  sh("git branch -D handsfree/DEMO-2", remote);
  project.agents = [{ id: "x", name: "Broken", command: "false", enabled: true, exhaustionPatterns: [] }];
  const cfg = await api("/api/config");
  await api("/api/config", "PUT", { ...cfg, projects: [project] });
  await api("/api/tickets/DEMO-2/forget", "POST");
  await api("/api/poll-now", "POST");
  await waitFor(async () => (await api("/api/state")).tickets["DEMO-2"]?.status === "failed", "DEMO-2 failed");

  // ---- Watch live + take over, with a non-Claude agent (any tool works) ----
  project.agents = [
    { id: "s", name: "Sleepy", command: "fakeslow", enabled: true, exhaustionPatterns: [], resumeCommand: "fakeslow --resume {session_id}", sessionIdPattern: "SESSION: ([\\w-]+)" },
  ];
  const cfg2 = await api("/api/config");
  await api("/api/config", "PUT", { ...cfg2, settings: { ...cfg2.settings, slowAfterMin: 0 }, projects: [project] });
  await api("/api/tickets/DEMO-2/forget", "POST");
  await api("/api/poll-now", "POST");
  const running = await waitFor(async () => {
    const t = (await api("/api/state")).tickets["DEMO-2"];
    return t?.status === "running" && t.attempts[0]?.sessionId && t;
  }, "DEMO-2 running with a session id");
  assert.equal(running.attempts[0].sessionId, "abc-12345678", "session id found with the agent's own pattern");

  // slow flag (slowAfterMin = 0 → first heartbeat)
  await waitFor(async () => (await api("/api/state")).tickets["DEMO-2"].slow === true, "slow flag", 20000);

  // Open while running → live view whose Enter key calls back to take over
  const live = await api("/api/tickets/DEMO-2/open", "POST", {});
  assert.match(live.command, /live view/);
  const liveScript = fs.readFileSync(path.join(root, "opened.command"), "utf8");
  assert.match(liveScript, /tail -n 200 -f /);
  assert.match(liveScript, /read -r _/);
  assert.ok(liveScript.includes(`/api/tickets/DEMO-2/takeover?text=1`) && liveScript.includes(`x-handsfree-token: ${token}`));
  assert.equal((await api("/api/state")).tickets["DEMO-2"].status, "running", "watching doesn't interrupt");

  // Pressing Enter → takeover returns the agent's own resume command as text
  const tr = await fetch(`${base}/api/tickets/DEMO-2/takeover?text=1`, { method: "POST", headers: { "x-handsfree-token": token } });
  assert.equal(await tr.text(), "fakeslow --resume 'abc-12345678'");
  const taken = (await api("/api/state")).tickets["DEMO-2"];
  assert.equal(taken.status, "manual");
  assert.equal(taken.attempts[0].outcome, "taken_over");
  assert.ok(!taken.slow);

  // Nothing changed yet → "Open PR with my changes" explains why it can't
  const noChanges = await api("/api/tickets/DEMO-2/handback", "POST", { mode: "pr" });
  assert.match(noChanges.error, /no changes/);

  // You edit in the worktree, then hand back with a PR (agents are not re-run)
  const wt2 = path.join(repo, ".worktrees", "DEMO-2");
  fs.writeFileSync(path.join(wt2, "fix.txt"), "done by hand\n");
  await api("/api/tickets/DEMO-2/handback", "POST", { mode: "pr" });
  const handed = await waitFor(async () => {
    const t = (await api("/api/state")).tickets["DEMO-2"];
    return t.status === "pr_draft" && t;
  }, "DEMO-2 pr_open after hand back");
  assert.deepEqual(handed.attempts.map((a) => [a.agentName, a.outcome]), [["Sleepy", "taken_over"], ["You", "success"]]);
  assert.match(sh(`git log --oneline main..handsfree/DEMO-2`, remote), /DEMO-2/, "your change was committed and pushed");

  const doc = await api("/api/doctor");
  assert.ok(doc.find((d) => d.name === "gh").ok);

  console.log("\n✅ e2e passed");
} catch (e) {
  console.error("\n❌ e2e failed:", e.stack || e.message);
  for (const k of ["DEMO-1", "DEMO-2"]) {
    try {
      console.error(`--- log ${k} ---\n` + fs.readFileSync(path.join(data, "logs", `${k}.log`), "utf8"));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  engine.kill("SIGTERM");
}
