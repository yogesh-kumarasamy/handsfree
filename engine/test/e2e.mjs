// End-to-end test of the engine with fake acli / gh / agents. Run: npm run test:engine
// Scenario: JQL finds 2 tickets. Agent 1 ("grok") hits a rate limit; agent 2 ("claude") commits.
// Expect: fallback, push to a bare remote, draft PR, Jira comment, then cleanup after "merge".
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { startFakeAuth } from "./fakes/auth-server.mjs";
import { startFakeMcp } from "./fakes/mcp-server.mjs";

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
if [ "$1 $2 $3" = "jira workitem transition" ]; then echo "$@" >> "${root}/transitions.log"; exit 0; fi
exit 1`);
script("gh", `
case "$1 $2" in
  "pr list") echo "" ;;
  "pr create") n=$(cat "${root}/prn" 2>/dev/null || echo 100); n=$((n+1)); echo $n > "${root}/prn"; echo "$@" >> "${root}/prs.log"; echo "https://github.com/acme/repo/pull/$n" ;;
  "pr view") n="\${3##*/}"; cat "${root}/pr-$n.json" 2>/dev/null || echo "{\\"number\\":$n,\\"url\\":\\"https://github.com/acme/repo/pull/$n\\",\\"state\\":\\"OPEN\\",\\"isDraft\\":true,\\"headRefOid\\":\\"aaa111\\",\\"mergedAt\\":null,\\"reviewDecision\\":\\"\\",\\"latestReviews\\":[],\\"statusCheckRollup\\":[]}" ;;
  "pr ready") echo "$@" >> "${root}/ready.log" ;;
  "run view") echo "$@" >> "${root}/runs.log"; echo "Run $3 ▸ job test"; echo "FAIL tests/greeting.test.js: expected hi, got hello" ;;
  "auth status") echo "Logged in to github.com as tester"; exit 0 ;;
  "issue list") echo '[{"number":5,"title":"Add farewell","body":"Say bye","url":"https://github.com/acme/repo/issues/5"}]' ;;
  "issue comment") echo "$@" >> "${root}/ghcomments.log" ;;
  "issue close") echo "$@" >> "${root}/ghclose.log" ;;
esac`);
// stand-in for macOS `open`: keep a copy of the Terminal launcher so the test can read it
script("fakeopen", `cp "$1" "${root}/opened.command"`);
// a non-Claude agent that prints its session id and keeps working (for watch / take over)
script("fakeslow", `echo "SESSION: abc-12345678"; echo "thinking…"; sleep 60`);
// messaging agent fake: prints Claude's JSON envelope and records the prompt
script("fakemsg", `echo "$@" >> "${root}/msg.log"; echo '{"type":"result","is_error":false,"result":"ok\\n{\\"sent\\": true, \\"id\\": \\"agent-1\\"}"}'`);
// routine agent fake: records its prompt, optionally slow, prints Claude's JSON envelope with a known report
script("fakeroutine", `echo "$@" >> "${root}/routine.log"; if [ -f "${root}/ROUTINE_SLOW" ]; then sleep 3; fi; echo '{"type":"result","is_error":false,"result":"Open PRs: 2 — 1 awaiting review, 1 draft"}'`);
// a Claude-style agent with stream-json input: the prompt is the first stdin line, later lines are your messages
script("fakechat", `
read -r first
echo "$first" | grep -q '"type":"user"' || exit 7
echo "$first" | grep -q 'DEMO-2' || exit 6
echo "prompt received"
while read -r line; do
  text=$(echo "$line" | sed -E 's/.*"content":"([^"]*)".*/\\1/')
  echo "agent heard: $text"
  echo '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"Summary: nothing to change"}'
done
exit 0`);
// naming agent: commits with a subject that breaks the project's commit pattern and leaves a file uncommitted
script("fakenamer", `[ "$1" = "--version" ] && { echo "fakenamer 1.0"; exit 0; }
echo thing > thing.txt; git add -A; git commit -qm "$HANDSFREE_ISSUE: do the thing"; echo left > left.txt`);
// agent 1: edits a file, then dies on a rate limit
script("fakegrok", `echo "working on $HANDSFREE_ISSUE"; echo "partial" > partial.txt; echo "Error: 429 rate limit exceeded" >&2; exit 1`);
// agent 2: sees the previous work, commits
script("fakeclaude", `test -f "$2" || exit 9; grep -q "Previous attempts" "$2" && echo "saw previous attempt"; grep -q "expected hi, got hello" "$2" && echo "saw ci logs"; test -f "$4" || exit 8; echo "hi" >> README.md; git add -A; git commit -qm "$HANDSFREE_ISSUE: greeting"
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
  tracker: { kind: "jira", query: "project = DEMO", searchCommand: 'acli jira workitem search --jql {jql} --json', commentCommand: "acli jira workitem comment create --key {issue_key} --body {body}", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me" },
  mcpJson: '{"mcpServers":{"github":{"type":"http","url":"https://example.invalid/mcp"}}}',
  agents: [
    { id: "a1", name: "Grok", command: "fakegrok {prompt}", enabled: true, exhaustionPatterns: ["rate.?limit"] },
    { id: "a2", name: "Claude Code", command: "fakeclaude -p {prompt_file} --mcp-config {mcp_file}", enabled: true, exhaustionPatterns: ["rate.?limit"] },
  ],
  promptExtra: "Be nice.",
  draftPr: true,
};
fs.writeFileSync(path.join(data, "config.json"), JSON.stringify({ version: 1, settings: { pollIntervalMin: 60, prPollIntervalMin: 60, maxParallel: 1, agentTimeoutMin: 5, paused: false, notifications: true, launchAtLogin: false }, projects: [project] }));

// Fake Setmore: an OAuth server and an MCP server, in this process; the engine reaches them through its settings.
const validTokens = new Set();
const auth = await startFakeAuth({ validTokens });
const mcp = await startFakeMcp({ validTokens });
const cbPort = 49000 + Math.floor(Math.random() * 500);

const port = 48000 + Math.floor(Math.random() * 1000);
const token = "test-token";
const engine = spawn(process.execPath, [path.resolve("engine/dist/handsfree-engine.mjs")], {
  env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HF_DATA: data, HF_PORT: String(port), HF_TOKEN: token, HF_SKIP_LOGIN_PATH: "1", HF_OPEN_CMD: "fakeopen", HF_TEST: "1" },
  stdio: ["pipe", "inherit", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
const api = async (p, method = "GET", body) => {
  const r = await fetch(base + p, { method, headers: { "x-handsfree-token": token, "content-type": "application/json" }, body: body && JSON.stringify(body) });
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 60000) {
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

  const tj = await api("/api/test-tracker", "POST", { project });
  assert.deepEqual(tj.issues.map((i) => i.key), ["DEMO-1", "DEMO-2"]);
  assert.equal(tj.issues[0].description, "Say hi in README");

  const info = await api("/api/repo-info", "POST", { path: repo });
  assert.equal(info.ok, true);

  // first poll happens ~3s after start
  const s1 = await waitFor(async () => {
    const s = await api("/api/state");
    return s.tickets["DEMO-1"]?.status === "pr_draft" && s.tickets["DEMO-1"].jiraCommented && s;
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

  const failing = (sha, runId) => ({
    isDraft: false, headRefOid: sha,
    statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `https://github.com/acme/repo/actions/runs/${runId}/job/9` }],
  });
  const commitsOnRemote = () => sh(`git rev-list --count main..handsfree/DEMO-1`, remote);

  // ---- Publish: gh pr ready + immediate re-check
  prJson(101, { isDraft: false });
  await api("/api/tickets/DEMO-1/publish", "POST", {});
  assert.match(fs.readFileSync(path.join(root, "ready.log"), "utf8"), /pull\/101/);
  assert.equal((await ticket("DEMO-1")).status, "pr_ready");

  // ---- Messaging: configure Setmore + log in through the fake auth server
  const cfgM = await api("/api/config");
  project.messaging = {
    platform: "setmore",
    channelId: "ch-core",
    channelName: "ChatSupport Team Core",
    templates: { reviewReady: "Hey team, please review {key} — {summary}: {pr_url}", mergeNudge: "Hi team, {key} is approved and waiting {approved_ago}: {pr_url}", manual: "{key}: {pr_url}", bulk: "Eyes please:\n{list}" },
    agentCommand: "",
  };
  await api("/api/config", "PUT", { ...cfgM, settings: { ...cfgM.settings, accounts: { setmore: { clientId: "hf-test", redirectPort: cbPort, mcpUrl: mcp.url, issuer: auth.issuer, scopes: "openid offline_access" } } }, projects: [project] });
  assert.equal((await api("/api/accounts/setmore")).loggedIn, false);
  // a send without a login is recorded as failed and reported, never thrown away
  const noLogin = await api("/api/tickets/DEMO-1/message", "POST", { text: "early" });
  assert.match(noLogin.error, /Not logged in/);
  assert.equal((await ticket("DEMO-1")).messages.at(-1).ok, false);

  const login = await api("/api/accounts/setmore/login", "POST", {});
  assert.match(login.url, new RegExp(`^${auth.issuer}/oauth2/auth\\?`));
  assert.equal((await api("/api/accounts/setmore")).loginPending, true);
  // a second click returns the same URL
  assert.equal((await api("/api/accounts/setmore/login", "POST", {})).url, login.url);
  const authorize = await fetch(login.url, { redirect: "manual" });
  const callback = authorize.headers.get("location");
  assert.match(callback, new RegExp(`^http://127\\.0\\.0\\.1:${cbPort}/oauth/callback\\?code=`));
  // wrong state is rejected and the login stays pending
  const bad = await fetch(callback.replace(/state=[^&]*/, "state=forged"));
  assert.equal(bad.status, 400);
  assert.equal((await api("/api/accounts/setmore")).loginPending, true);
  const done = await fetch(callback);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Signed in/);
  const acct = await waitFor(async () => {
    const a = await api("/api/accounts/setmore");
    return a.loggedIn && !a.loginPending && a;
  }, "setmore logged in");
  assert.equal(acct.user, "t@t.t");
  assert.equal(auth.tokenCalls[0].resource, mcp.url, "resource indicator sent");

  // port in use → clear error, not a hang
  await api("/api/accounts/setmore/logout", "POST");
  const blocker = http.createServer(() => {});
  await new Promise((r) => blocker.listen(cbPort, "127.0.0.1", r));
  assert.match((await api("/api/accounts/setmore/login", "POST", {})).error, new RegExp(`Port ${cbPort} is in use`));
  await new Promise((r) => blocker.close(r));
  // log in again for the rest of the run
  const login2 = await api("/api/accounts/setmore/login", "POST", {});
  await fetch((await fetch(login2.url, { redirect: "manual" })).headers.get("location"));
  await waitFor(async () => (await api("/api/accounts/setmore")).loggedIn, "logged in again");

  // ---- Routines: Run now posts the agent's report to the channel; test-only tick runs a due routine; no overlap
  const REPORT = "Open PRs: 2 — 1 awaiting review, 1 draft";
  // A schedule that never fires during the run: the 30 s engine tick must not add runs of its own.
  project.routines = [{ id: "rt1", name: "PR check", enabled: true, schedule: "0 0 1 1 *", prompt: "Report {project} {repo} {last_run}", agentCommand: "fakeroutine {prompt}", postToChannel: true, timeoutMin: 1 }];
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });
  const rtNext = (await api("/api/state")).routines.rt1.nextRunAt;
  assert.ok(rtNext, "routine scheduled");
  const sentBefore = mcp.received.length;
  assert.deepEqual(await api("/api/routines/rt1/run", "POST", {}), {});
  const rtLast = await waitFor(async () => {
    const st = (await api("/api/state")).routines.rt1;
    return st && !st.running && st.last?.endedAt && st.last;
  }, "routine run finished");
  assert.equal(rtLast.ok, true, rtLast.output);
  assert.equal(rtLast.output, REPORT);
  assert.equal(rtLast.posted, true, rtLast.postError);
  assert.equal(mcp.received.length, sentBefore + 1);
  assert.equal(mcp.received.at(-1).text, REPORT);
  assert.equal(mcp.received.at(-1).channelId, "ch-core");
  assert.equal(mcp.received.at(-1).idempotencyKey, `routine:rt1:${rtLast.startedAt}`);
  const rtPrompts = () => fs.readFileSync(path.join(root, "routine.log"), "utf8").trim().split("\n");
  assert.match(rtPrompts()[0], /^Report Demo .+ the beginning$/);
  assert.match((await api("/api/routines/rt1/log")).log, /✓ PR check finished/);
  assert.match((await api("/api/routines/nope/run", "POST", {})).error, /Unknown routine/);
  // the scheduled slot comes due: the test-only tick at that instant runs it once
  assert.deepEqual(await api("/api/routines/tick", "POST", { now: rtNext }), {});
  await waitFor(async () => mcp.received.length === sentBefore + 2, "scheduled routine posted");
  assert.equal(rtPrompts().length, 2);
  assert.doesNotMatch(rtPrompts()[1], /the beginning/, "{last_run} is the previous successful run");
  const rtAfter = (await api("/api/state")).routines.rt1;
  assert.ok(Date.parse(rtAfter.nextRunAt) > Date.parse(rtNext), "rescheduled after the slot");
  // a second Run now while one is running is refused
  fs.writeFileSync(path.join(root, "ROUTINE_SLOW"), "");
  assert.deepEqual(await api("/api/routines/rt1/run", "POST", {}), {});
  assert.match((await api("/api/routines/rt1/run", "POST", {})).error, /already running/);
  await waitFor(async () => mcp.received.length === sentBefore + 3, "slow routine posted");
  fs.rmSync(path.join(root, "ROUTINE_SLOW"));
  await waitFor(async () => !(await api("/api/state")).routines.rt1.running, "slow routine finished");

  // ---- Paused: CI failure is recorded, no fix queued, and nothing marks the SHA as handled
  await api("/api/pause", "POST");
  prJson(101, failing("aaa111", 555));
  await checkPrs();
  const pausedT = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ci_failed" && t;
  }, "pr_ci_failed while paused");
  assert.equal(pausedT.fix, undefined);
  assert.equal(pausedT.pr.lastFixSha, undefined);
  await api("/api/resume", "POST");

  // ---- Fix round 1: logs fetched, agent chain runs in the same worktree, fix pushed
  await checkPrs();
  const fixed1 = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ready" && t.pr?.fixRounds === 1 && t;
  }, "fix round 1 pushed", 60000);
  assert.equal(fixed1.fix, undefined);
  assert.equal(fixed1.pr.lastFixSha, "aaa111");
  assert.equal(fixed1.pr.ci, "pending");
  assert.match(fs.readFileSync(path.join(root, "runs.log"), "utf8"), /run view 555 --log-failed/);
  const fixLog = (await api("/api/tickets/DEMO-1/log")).log;
  assert.match(fixLog, /queuing fix round 1\/2/);
  assert.match(fixLog, /saw ci logs/);
  assert.match(fixLog, /⇡ Pushed fix round 1/);
  assert.equal(commitsOnRemote(), "2", "fix commit pushed on top of the feature commit");
  assert.equal(fs.readFileSync(path.join(wt, ".handsfree", "prompt.md"), "utf8").includes("CI failed on https://github.com/acme/repo/pull/101"), true);

  // ---- GitHub still reports the old failing SHA → shown as failing, but not fixed twice
  await checkPrs();
  const stale = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ci_failed" && t;
  }, "stale failure shown");
  assert.equal(stale.pr.fixRounds, 1, "same SHA not fixed twice");
  assert.equal(stale.fix, undefined);
  // ---- GitHub sees the pushed fix: new head, checks pending → back to ready
  prJson(101, { isDraft: false, headRefOid: "fix1", statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }] });
  await checkPrs();
  await waitFor(async () => (await ticket("DEMO-1")).status === "pr_ready", "pending CI on the fixed head");

  // ---- Worktree cleaned up, then CI fails on the new head → worktree recreated from the remote branch
  await api("/api/tickets/DEMO-1/cleanup", "POST");
  assert.ok(!fs.existsSync(wt), "worktree removed by cleanup");
  assert.equal((await ticket("DEMO-1")).status, "pr_ready", "cleanup keeps tracking an open PR");
  prJson(101, failing("bbb222", 556));
  await checkPrs();
  const fixed2 = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.pr?.fixRounds === 2 && t.status === "pr_ready" && t;
  }, "fix round 2 pushed", 60000);
  assert.ok(fixed2);
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /recreated worktree from origin\/handsfree\/DEMO-1/);
  assert.equal(commitsOnRemote(), "3", "round 2 continues the pushed branch instead of restarting from main");

  // ---- Rounds exhausted (max 2) → pr_ci_failed + one "needs you" event; manual Fix CI still works
  prJson(101, failing("ccc333", 557));
  await checkPrs();
  const exhausted = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ci_failed" && t;
  }, "rounds exhausted");
  assert.equal(exhausted.fix, undefined);
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /🔔 CI still failing/);
  // Someone pushed to the PR branch meanwhile (GitHub "Update branch", a suggestion, another machine):
  // the fix must build on top of it, never overwrite it. Two Fix CI clicks at once queue one round.
  const clone = path.join(root, "clone");
  sh(`git clone -q ${remote} ${clone}`);
  sh(`git config user.email t@t.t && git config user.name T && git checkout -q handsfree/DEMO-1 && echo ext > ext.txt && git add -A && git commit -qm "external: reviewer suggestion" && git push -q origin handsfree/DEMO-1`, clone);
  const [fixA, fixB] = await Promise.all([api("/api/tickets/DEMO-1/fix-ci", "POST", {}), api("/api/tickets/DEMO-1/fix-ci", "POST", {})]);
  assert.ok([fixA, fixB].filter((r) => r.error).length === 1, "second concurrent Fix CI is refused");
  await waitFor(async () => (await ticket("DEMO-1")).pr?.fixRounds === 3, "manual fix round 3", 60000);
  assert.equal((await ticket("DEMO-1")).status, "pr_ready");
  assert.match(sh(`git log --oneline main..handsfree/DEMO-1`, remote), /external: reviewer suggestion/, "the external commit survived the fix push");
  assert.equal(commitsOnRemote(), "5", "external commit + fix commit on top of the 3 earlier ones");
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /synced with origin\/handsfree\/DEMO-1/);

  // ---- A fix agent that changes nothing is not a fix: falls through the chain, round still counted
  const realAgents = project.agents;
  project.agents = [{ id: "n", name: "Noop", command: "true", enabled: true, exhaustionPatterns: [] }];
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });
  prJson(101, failing("ddd555", 560));
  await checkPrs();
  await waitFor(async () => (await ticket("DEMO-1")).status === "pr_ci_failed" && (await ticket("DEMO-1")).pr?.ci === "failing", "failing on ddd555");
  await api("/api/tickets/DEMO-1/fix-ci", "POST", {});
  const noop = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.pr?.fixRounds === 4 && t.status === "pr_ci_failed" && t;
  }, "no-op fix round counted", 60000);
  assert.match(noop.error, /Every agent in the chain failed/);
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /Noop finished but made no changes/);
  assert.equal(commitsOnRemote(), "5", "nothing pushed for a no-op round");

  // ---- Take over a running fix, then "Open PR with my changes": your commit is pushed, agents are not re-run
  project.agents = [{ id: "s0", name: "Sleepy", command: "fakeslow", enabled: true, exhaustionPatterns: [], resumeCommand: "fakeslow --resume {session_id}", sessionIdPattern: "SESSION: ([\\w-]+)" }];
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });
  prJson(101, failing("eee666", 561));
  await checkPrs();
  await waitFor(async () => (await ticket("DEMO-1")).status === "pr_ci_failed" && (await ticket("DEMO-1")).pr?.headSha === "eee666", "failing on eee666");
  await api("/api/tickets/DEMO-1/fix-ci", "POST", {});
  await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "running" && t.fix && t.attempts[t.attempts.length - 1]?.sessionId;
  }, "fix round 5 running", 30000);
  await api("/api/tickets/DEMO-1/takeover", "POST", {});
  assert.equal((await ticket("DEMO-1")).status, "manual");
  fs.writeFileSync(path.join(wt, "byhand.txt"), "fixed by hand\n");
  const attemptsBefore = (await ticket("DEMO-1")).attempts.length;
  await api("/api/tickets/DEMO-1/handback", "POST", { mode: "pr" });
  const handedFix = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_ready" && t.pr?.fixRounds === 5 && t;
  }, "hand-back after a fix take-over", 60000);
  assert.equal(handedFix.fix, undefined);
  assert.equal(handedFix.attempts.length, attemptsBefore + 1, "only the 'You' attempt was added; no agent re-run");
  assert.equal(handedFix.attempts[handedFix.attempts.length - 1].agentName, "You");
  assert.equal(commitsOnRemote(), "6", "your commit was pushed");
  project.agents = realAgents;
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });

  // ---- The remote branch diverged from the worktree: refuse to build on it, never overwrite
  sh(`git fetch -q origin && git reset -q --hard origin/handsfree/DEMO-1~1 && echo other > other.txt && git add -A && git commit -qm "diverged elsewhere" && git push -q --force origin handsfree/DEMO-1`, clone);
  prJson(101, failing("fff777", 562));
  await checkPrs();
  await waitFor(async () => (await ticket("DEMO-1")).pr?.headSha === "fff777", "failing on fff777");
  await api("/api/tickets/DEMO-1/fix-ci", "POST", {});
  const diverged = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.pr?.fixRounds === 6 && t.status === "pr_ci_failed" && t;
  }, "diverged fix refused", 60000);
  assert.match(diverged.error, /diverged/);
  assert.match(sh(`git log --oneline main..handsfree/DEMO-1`, remote), /diverged elsewhere/, "remote branch untouched");

  // ---- CI passes on a published PR → review_ready once
  prJson(101, { isDraft: false, headRefOid: "ddd444", statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] });
  await checkPrs();
  const ready = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.pr?.reviewRequestedAt && t;
  }, "review_ready");
  assert.equal(ready.status, "pr_ready");
  await checkPrs();
  await sleep(800);
  assert.equal(((await api("/api/tickets/DEMO-1/log")).log.match(/🔔 Ready for review/g) || []).length, 1, "review_ready fired once");
  const reviewMsg = await waitFor(async () => mcp.received.find((m) => /please review DEMO-1/.test(m.text)), "review message sent");
  assert.equal(reviewMsg.channelId, "ch-core");
  assert.match(reviewMsg.text, /pull\/101/);
  assert.equal((await ticket("DEMO-1")).messages.at(-1).kind, "review_ready");

  // ---- Approved 2 h ago → pr_approved and a merge nudge, once
  prJson(101, { isDraft: false, headRefOid: "ddd444", reviewDecision: "APPROVED", latestReviews: [{ state: "APPROVED", submittedAt: new Date(Date.now() - 2 * 3600_000).toISOString() }], statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }] });
  await checkPrs();
  const approved = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "pr_approved" && t.pr.mergeNudgedAt && t;
  }, "approved + nudge");
  assert.ok(approved.pr.approvedAt);
  await checkPrs();
  await sleep(800);
  assert.equal(((await api("/api/tickets/DEMO-1/log")).log.match(/🔔 Waiting to be merged/g) || []).length, 1, "nudge fired once");
  await waitFor(async () => mcp.received.find((m) => /approved and waiting/.test(m.text)), "nudge message sent");
  assert.equal(mcp.received.filter((m) => /DEMO-1/.test(m.text)).length, 2, "one review + one nudge message");

  // ---- Manual, bulk, 401→refresh, logout, agent adapter
  const manual = await api("/api/tickets/DEMO-1/message", "POST", { text: "custom hello" });
  assert.equal(manual.ok, true);
  assert.equal(mcp.received.at(-1).text, "custom hello");
  const bulk = await api("/api/messages/bulk", "POST", { keys: ["DEMO-1", "DEMO-2"] });
  assert.equal(bulk.failed.length, 0);
  assert.equal(bulk.sent.length, 2);
  assert.match(mcp.received.at(-1).text, /^Eyes please:\n- DEMO-1 — Add greeting: .*pull\/101\n- DEMO-2 — Second ticket: .*pull\/102$/);
  auth.rotate();
  const afterRotate = await api("/api/tickets/DEMO-1/message", "POST", {});
  assert.equal(afterRotate.ok, true, "401 → refresh → sent");
  assert.equal(afterRotate.text, "DEMO-1: https://github.com/acme/repo/pull/101");
  await api("/api/accounts/setmore/logout", "POST");
  assert.equal((await api("/api/accounts/setmore")).loggedIn, false);
  assert.match((await api("/api/tickets/DEMO-1/message", "POST", {})).error, /Not logged in/);
  // agent adapter
  project.messaging = { ...project.messaging, platform: "agent", agentCommand: "fakemsg {prompt}" };
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });
  const viaAgent = await api("/api/tickets/DEMO-1/message", "POST", { text: "via agent" });
  assert.equal(viaAgent.ok, true);
  assert.equal(viaAgent.id, "agent-1");
  assert.match(fs.readFileSync(path.join(root, "msg.log"), "utf8"), /via agent[\s\S]*confirmationToken/);
  project.messaging = { ...project.messaging, platform: "setmore" };
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });

  prJson(101, { state: "MERGED", isDraft: false, headRefOid: "ddd444", mergedAt: "2026-10-15T10:00:00Z" });
  await checkPrs();
  // The status flips to merged before the Jira comment and the event land, so wait for the whole sequence.
  const mergedT = await waitFor(async () => {
    const t = await ticket("DEMO-1");
    return t.status === "merged" && /🔔 Merged/.test((await api("/api/tickets/DEMO-1/log")).log) && t;
  }, "DEMO-1 merged");
  assert.ok(!fs.existsSync(wt), "worktree removed after merge");
  assert.equal(mergedT.pr.mergedAt, "2026-10-15T10:00:00Z");
  assert.match(fs.readFileSync(path.join(root, "comments.log"), "utf8"), /DEMO-1 .*Merged.*pull\/101/, "merge commented on Jira");
  // The done transition runs after the status flips to merged.
  await waitFor(async () => (await ticket("DEMO-1")).trackerDone === true, "DEMO-1 trackerDone");
  assert.match(fs.readFileSync(path.join(root, "transitions.log"), "utf8"), /--key DEMO-1 --status Done --yes/, "Jira ticket moved to Done on merge");
  assert.match((await api("/api/tickets/DEMO-1/log")).log, /✓ Moved the Jira ticket to “Done”/);

  // failing chain → failed, then retry
  // DEMO-2 is forgotten and re-picked as fresh work: even though its old branch is still on the remote,
  // a ticket without a PR starts from the base branch.
  await api("/api/tickets/DEMO-2/cleanup", "POST");
  assert.equal((await ticket("DEMO-2")).status, "pr_draft", "cleanup keeps tracking an open PR");
  project.agents = [{ id: "x", name: "Broken", command: "false", enabled: true, exhaustionPatterns: [] }];
  const cfg = await api("/api/config");
  await api("/api/config", "PUT", { ...cfg, projects: [project] });
  await api("/api/tickets/DEMO-2/forget", "POST");
  await api("/api/poll-now", "POST");
  await waitFor(async () => (await api("/api/state")).tickets["DEMO-2"]?.status === "failed", "DEMO-2 failed");

  // ---- Mid-run feedback: an agent with stream-json input gets the prompt and your messages on stdin ----
  const noRun = await api("/api/tickets/DEMO-2/feedback", "POST", { text: "hello?" });
  assert.match(noRun.error, /not running/i, "feedback needs a running agent");
  project.agents = [{ id: "fb", name: "Claude Code", command: "fakechat -p --input-format stream-json --mcp-config {mcp_file}", enabled: true, exhaustionPatterns: [] }];
  const cfgFb = await api("/api/config");
  await api("/api/config", "PUT", { ...cfgFb, projects: [project] });
  await api("/api/tickets/DEMO-2/forget", "POST");
  await api("/api/poll-now", "POST");
  const chatting = await waitFor(async () => {
    const t = (await api("/api/state")).tickets["DEMO-2"];
    return t?.status === "running" && /prompt received/.test((await api("/api/tickets/DEMO-2/log")).log) && t;
  }, "fakechat read the prompt from stdin");
  assert.equal(chatting.attempts[0].interactive, true, "attempt is flagged as taking messages");
  const fb = await api("/api/tickets/DEMO-2/feedback", "POST", { text: "also add bye" });
  assert.equal(fb.error, undefined, "feedback accepted");
  // The agent changes nothing, so the run ends "failed" (same state as before this section) once stdin is closed on its result.
  await waitFor(async () => (await api("/api/state")).tickets["DEMO-2"].status === "failed", "fakechat finished after feedback");
  const fbLog = (await api("/api/tickets/DEMO-2/log")).log;
  assert.match(fbLog, /💬 You: also add bye/, "your message is in the log");
  assert.match(fbLog, /agent heard: also add bye/, "the agent got it on stdin");
  assert.match(fbLog, /■ done · success · 2 turns/, "the run ended when the result arrived");
  const blank = await api("/api/tickets/DEMO-2/feedback", "POST", { text: "   " });
  assert.ok(blank.error, "blank feedback is rejected");

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
  assert.equal(sh(`git rev-list --count main..handsfree/DEMO-2`, remote), "1", "fresh pick-up started from main, not from the old pushed branch");

  // ---- A GitHub Issues project on the same repo: pick-up, PR, comment via gh, close on merge
  const fakeClaudeOnly = [{ id: "c1", name: "Claude Code", command: "fakeclaude -p {prompt_file} --mcp-config {mcp_file}", enabled: true, exhaustionPatterns: ["rate.?limit"] }];
  const ghProject = { ...project, id: "p2", name: "GH", messaging: undefined, tracker: { kind: "github", query: "label:hf", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "closed", repo: "acme/repo" }, agents: fakeClaudeOnly };
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project, ghProject] });
  await api("/api/poll-now", "POST");
  const ghT = await waitFor(async () => {
    const t = await ticket("repo#5");
    return t?.status === "pr_draft" && t.jiraCommented && t;
  }, "repo#5 pr_draft + commented");
  assert.equal(ghT.trackerId, "5");
  assert.equal(ghT.issueUrl, "https://github.com/acme/repo/issues/5");
  assert.equal(ghT.description, "Say bye");
  const ghPrN = Number(ghT.prUrl.split("/").pop());
  assert.match(fs.readFileSync(path.join(root, "ghcomments.log"), "utf8"), new RegExp(`issue comment 5 --repo acme/repo --body .*GitHub issue.*pull/${ghPrN}`));
  assert.equal(ghT.worktree, wt.replace("DEMO-1", "repo-5"), "the worktree folder has no # (Vite/esbuild read it as a URL fragment); the branch keeps the key");
  assert.equal(ghT.branch, "handsfree/repo#5");
  assert.match(fs.readFileSync(path.join(wt.replace("DEMO-1", "repo-5"), ".handsfree", "prompt.md"), "utf8"), /^You are working unattended on GitHub issue repo#5: Add farewell/);
  prJson(ghPrN, { state: "MERGED", isDraft: false, mergedAt: "2026-10-15T11:00:00Z" });
  await checkPrs();
  await waitFor(async () => (await ticket("repo#5")).trackerDone === true, "repo#5 trackerDone");
  assert.equal((await ticket("repo#5")).status, "merged");
  assert.match(fs.readFileSync(path.join(root, "ghclose.log"), "utf8"), /issue close 5 --repo acme\/repo --reason completed/);
  assert.match((await api(`/api/tickets/${encodeURIComponent("repo#5")}/log`)).log, /Moved the GitHub issue to “closed”/);

  // ---- A saved Linear project (tracker removed): loads disabled as Jira with a notice, isn't polled; the others keep polling
  const linProject = { ...ghProject, id: "p3", name: "Lin", tracker: { kind: "linear", query: "", searchCommand: "", commentCommand: "", transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me", linearState: "Todo" } };
  const cfgL = await api("/api/config");
  const savedL = await api("/api/config", "PUT", { ...cfgL, settings: { ...cfgL.settings, accounts: { ...cfgL.settings.accounts, linear: { mcpUrl: "https://mcp.linear.app/mcp" } } }, projects: [project, ghProject, linProject] });
  const linSaved = savedL.projects.find((x) => x.id === "p3");
  assert.equal(linSaved.enabled, false);
  assert.equal(linSaved.tracker.kind, "jira");
  assert.equal(linSaved.tracker.query, "");
  assert.equal(linSaved.trackerNotice, "Linear is no longer supported, pick Jira or GitHub");
  assert.equal("linear" in savedL.settings.accounts, false, "the old Linear account settings are dropped");
  assert.equal((await fetch(`${base}/api/accounts/linear`, { headers: { "x-handsfree-token": token } })).status, 404);
  const polledAt = (await api("/api/state")).lastPollAt;
  await api("/api/poll-now", "POST");
  await waitFor(async () => (await api("/api/state")).lastPollAt !== polledAt, "poll after the Linear project loaded");
  const afterL = await api("/api/state");
  assert.equal(afterL.pollErrors?.p3, undefined, "the disabled Linear project is not polled");
  assert.equal(afterL.pollErrors?.p2, undefined, "the GitHub project keeps polling");

  // ---- Naming conventions: branch, commit subjects and PR title come from the project's templates and must match its patterns
  const BRANCH_RE = "^dependabot|changeset|([A-Za-z]{1,10}-\\d+(\\/)(release|feature|hotfix|config|bug|spike|refactor|improvement)(\\/.*))|staging|main";
  const COMMIT_RE = "^((build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\\([\\w\\-\\.]+\\))?(!)?:([\\w ])+([\\s\\S]*[A-Za-z]{1,10}-\\d+))|Merge branch|Revert";
  project.agents = [{ id: "nm", name: "Namer", command: "fakenamer", enabled: true, exhaustionPatterns: [] }];
  project.naming = {
    branch: { template: "{key}/{type}/{slug}", pattern: BRANCH_RE },
    commit: { template: "{type_cc}: {key} {summary}", pattern: COMMIT_RE },
    prTitle: { template: "{key} {summary}", pattern: "^[A-Za-z]{1,10}-\\d+ " },
  };
  const cfgNm = await api("/api/config");
  await api("/api/config", "PUT", { ...cfgNm, projects: [project] });
  await api("/api/tickets/DEMO-2/forget", "POST");
  await api("/api/poll-now", "POST");
  const named = await waitFor(async () => {
    const t = (await api("/api/state")).tickets["DEMO-2"];
    return t?.status === "pr_draft" && t;
  }, "DEMO-2 PR under the naming rules");
  assert.equal(named.branch, "DEMO-2/feature/second-ticket", "branch rendered from the template (no issue type → feature)");
  assert.deepEqual(
    sh(`git log --format=%s main..DEMO-2/feature/second-ticket`, remote).split("\n"),
    ["feat: DEMO-2 Second ticket", "feat: DEMO-2 do the thing"],
    "HandsFree's own commit uses the template; the agent's non-matching subject was reworded before the push",
  );
  assert.match(fs.readFileSync(path.join(root, "prs.log"), "utf8").trim().split("\n").pop(), /--title DEMO-2 Second ticket --body-file/, "PR title from the template");
  assert.match((await api("/api/tickets/DEMO-2/log")).log, /✎ Reworded 1 commit/);

  // A branch template that can't satisfy its own pattern stops the ticket before any agent runs
  project.naming = { ...project.naming, branch: { template: "handsfree/{key}", pattern: BRANCH_RE } };
  await api("/api/config", "PUT", { ...(await api("/api/config")), projects: [project] });
  await api("/api/tickets/DEMO-2/forget", "POST");
  await api("/api/poll-now", "POST");
  const rejected = await waitFor(async () => {
    const t = (await api("/api/state")).tickets["DEMO-2"];
    return t?.status === "failed" && t;
  }, "DEMO-2 rejected by the branch pattern");
  assert.match(rejected.error, /handsfree\/DEMO-2.*doesn't match/);
  assert.doesNotMatch((await api("/api/tickets/DEMO-2/log")).log, /▶ Agent/, "no agent ran");

  const doc = await api("/api/doctor");
  assert.ok(doc.find((d) => d.name === "gh").ok);

  console.log("\n✅ e2e passed");
} catch (e) {
  console.error("\n❌ e2e failed:", e.stack || e.message);
  for (const k of ["DEMO-1", "DEMO-2", "repo#5", "routine-rt1"]) {
    try {
      console.error(`--- log ${k} ---\n` + fs.readFileSync(path.join(data, "logs", `${k.replace(/[^A-Za-z0-9_-]/g, "_")}.log`), "utf8"));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  await auth.close();
  await mcp.close();
  engine.kill("SIGTERM");
}
