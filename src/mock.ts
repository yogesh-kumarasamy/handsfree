import type { Api, DemoOptions } from "./api";
import {
  AGENT_PRESETS,
  DEFAULT_AGENT_MESSAGE_COMMAND,
  DEFAULT_SETMORE_ACCOUNT,
  DEFAULT_LINEAR_ACCOUNT,
  DEFAULT_TEMPLATES,
  PR_STATUSES,
  DEFAULT_JIRA_COMMENT,
  DEFAULT_JIRA_SEARCH,
  type Config,
  type EngineEvent,
  type EngineState,
  type PrInfo,
  type Ticket,
} from "../engine/src/types";

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const agents = (names: string[]) =>
  names.map((n, i) => {
    const p = AGENT_PRESETS.find((a) => a.name === n)!;
    return { ...p, id: `a${i}${n}`, enabled: n === "Antigravity" ? false : true };
  });

function demoConfig(scenario: DemoOptions["scenario"]): Config {
  return {
    version: 1,
    settings: {
      pollIntervalMin: 15,
      prPollIntervalMin: 3,
      accounts: { setmore: { ...DEFAULT_SETMORE_ACCOUNT, clientId: "hf-demo" }, linear: { ...DEFAULT_LINEAR_ACCOUNT } },
      maxParallel: 3,
      agentTimeoutMin: 90,
      slowAfterMin: 30,
      paused: false,
      notifications: true,
      launchAtLogin: true,
    },
    projects:
      scenario === "empty"
        ? []
        : [
            {
              id: "p1",
              name: "ChatSupport Web",
              enabled: true,
              repoPath: "/Users/yogesh/code/chatsupport-web",
              baseBranch: "main",
              remote: "origin",
              tracker: { kind: "jira", query: 'project = CSW AND assignee = currentUser() AND status = "To Do" ORDER BY priority DESC', searchCommand: DEFAULT_JIRA_SEARCH, commentCommand: DEFAULT_JIRA_COMMENT, transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me" },
              mcpJson: JSON.stringify(
                {
                  mcpServers: {
                    github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
                    figma: { type: "http", url: "http://127.0.0.1:3845/mcp" },
                  },
                },
                null,
                2,
              ),
              agents: agents(["Claude Code", "Grok", "Antigravity"]),
              promptExtra: "Use pnpm. Run `pnpm test` and `pnpm lint` before committing.",
              draftPr: true,
              ciAutoFix: true,
              ciFixMaxRounds: 2,
              mergeNudgeAfterMin: 30,
              messaging: { platform: "setmore", channelId: "nN0pGzAWVcudEnhemVADfwCZi6iUlMiW", channelName: "ChatSupport Team Core", templates: { ...DEFAULT_TEMPLATES }, agentCommand: DEFAULT_AGENT_MESSAGE_COMMAND },
            },
            {
              id: "p2",
              name: "Setmore API",
              enabled: true,
              repoPath: "/Users/yogesh/code/setmore-api",
              baseBranch: "develop",
              remote: "origin",
              tracker: { kind: "jira", query: "project = SET AND assignee = currentUser() AND labels = handsfree", searchCommand: DEFAULT_JIRA_SEARCH, commentCommand: DEFAULT_JIRA_COMMENT, transitionCommand: "", doneStatus: "Done", repo: "", linearAssignee: "me" },
              mcpJson: '{\n  "mcpServers": {}\n}',
              agents: agents(["Grok", "Claude Code"]),
              promptExtra: "",
              draftPr: true,
              ciAutoFix: true,
              ciFixMaxRounds: 2,
              mergeNudgeAfterMin: 30,
              messaging: { platform: "none", channelId: "", channelName: "", templates: { ...DEFAULT_TEMPLATES }, agentCommand: DEFAULT_AGENT_MESSAGE_COMMAND },
            },
          ],
  };
}

function t(p: Partial<Ticket> & Pick<Ticket, "key" | "projectId" | "summary" | "status">): Ticket {
  const repo = p.projectId === "p1" ? "/Users/yogesh/code/chatsupport-web" : "/Users/yogesh/code/setmore-api";
  return {
    branch: `handsfree/${p.key}`,
    worktree: `${repo}/.worktrees/${p.key}`,
    agentIndex: 0,
    attempts: [],
    createdAt: ago(60),
    updatedAt: ago(1),
    ...p,
  };
}

const pr = (number: number, repo: string, over: Partial<PrInfo> = {}): PrInfo => ({
  url: `https://github.com/anywhere/${repo}/pull/${number}`,
  number,
  draft: false,
  state: "open",
  headSha: "9f3c2a1b7e",
  ci: "passing",
  failedChecks: [],
  reviewDecision: "",
  fixRounds: 0,
  checkedAt: ago(2),
  ...over,
});

function demoState(scenario: DemoOptions["scenario"]): EngineState {
  if (scenario === "empty") return { tickets: {}, pollErrors: {}, prCheckErrors: {}, accounts: { setmore: { loggedIn: false }, linear: { loggedIn: false } } };
  const list: Ticket[] = [
    t({
      key: "CSW-1421",
      projectId: "p1",
      summary: "Add typing indicator to the visitor chat widget",
      status: "running",
      currentAgent: "Claude Code",
      slow: true,
      attempts: [{ agentName: "Claude Code", startedAt: ago(47), sessionId: "9b1e44d0-7a2c-4f5e-8d13-6c0a9f2e7b45" }],
      createdAt: ago(48),
    }),
    t({
      key: "CSW-1402",
      projectId: "p1",
      summary: "Agent can't attach files larger than 10 MB",
      status: "manual",
      attempts: [
        { agentName: "Claude Code", startedAt: ago(95), endedAt: ago(70), exitCode: 1, outcome: "failed", note: "pnpm test failed", sessionId: "c2d7a9e3-1b4f-4e8a-a5d6-0f3b7c9e1a24" },
      ],
      createdAt: ago(96),
      updatedAt: ago(8),
    }),
    t({
      key: "SET-982",
      projectId: "p2",
      summary: "Return 409 when a booking slot is double-booked",
      status: "running",
      currentAgent: "Grok",
      agentIndex: 1,
      attempts: [
        { agentName: "Grok", startedAt: ago(41), endedAt: ago(19), exitCode: 1, outcome: "exhausted", note: "Matched “rate.?limit”" },
        { agentName: "Claude Code", startedAt: ago(19) },
      ],
      createdAt: ago(42),
    }),
    t({ key: "CSW-1425", projectId: "p1", summary: "Persist agent's last-used canned response", status: "queued", createdAt: ago(3) }),
    t({
      key: "CSW-1398",
      projectId: "p1",
      summary: "Fix unread badge not clearing on mobile Safari",
      status: "pr_draft",
      prUrl: "https://github.com/anywhere/chatsupport-web/pull/2211",
      pr: pr(2211, "chatsupport-web", { draft: true, ci: "pending" }),
      jiraCommented: true,
      attempts: [{ agentName: "Claude Code", startedAt: ago(190), endedAt: ago(151), exitCode: 0, outcome: "success" }],
      createdAt: ago(191),
      updatedAt: ago(150),
    }),
    t({
      key: "SET-975",
      projectId: "p2",
      summary: "Add pagination to GET /v2/customers",
      status: "pr_ci_failed",
      prUrl: "https://github.com/anywhere/setmore-api/pull/877",
      pr: pr(877, "setmore-api", { ci: "failing", fixRounds: 2, lastFixSha: "9f3c2a1b7e", failedChecks: [{ name: "unit tests", detailsUrl: "https://github.com/anywhere/setmore-api/actions/runs/771/job/1", runId: "771" }] }),
      error: "Every agent in the chain failed. Check the log, then Retry.",
      jiraCommented: true,
      attempts: [{ agentName: "Grok", startedAt: ago(260), endedAt: ago(232), exitCode: 0, outcome: "success" }],
      createdAt: ago(261),
      updatedAt: ago(231),
    }),
    t({
      key: "CSW-1411",
      projectId: "p1",
      summary: "Rate-limit the public widget endpoint",
      status: "running",
      currentAgent: "Claude Code",
      prUrl: "https://github.com/anywhere/chatsupport-web/pull/2204",
      jiraCommented: true,
      pr: pr(2204, "chatsupport-web", { ci: "failing", lastFixSha: "9f3c2a1b7e", failedChecks: [{ name: "lint", runId: "802" }] }),
      fix: { round: 1, headSha: "9f3c2a1b7e", failedChecks: [{ name: "lint", runId: "802" }], logs: "", requestedAt: ago(6) },
      attempts: [
        { agentName: "Claude Code", startedAt: ago(130), endedAt: ago(100), exitCode: 0, outcome: "success" },
        { agentName: "Claude Code", startedAt: ago(5) },
      ],
      createdAt: ago(131),
    }),
    t({
      key: "CSW-1385",
      projectId: "p1",
      summary: "Export conversations as CSV",
      status: "pr_approved",
      prUrl: "https://github.com/anywhere/chatsupport-web/pull/2199",
      jiraCommented: true,
      pr: pr(2199, "chatsupport-web", { reviewDecision: "APPROVED", approvedAt: ago(48), mergeNudgedAt: ago(18) }),
      attempts: [{ agentName: "Claude Code", startedAt: ago(400), endedAt: ago(360), exitCode: 0, outcome: "success" }],
      createdAt: ago(401),
      updatedAt: ago(48),
    }),
    t({
      key: "CSW-1390",
      projectId: "p1",
      summary: "Migrate transcript export to the new PDF service",
      status: "failed",
      error: "All agents failed",
      attempts: [
        { agentName: "Claude Code", startedAt: ago(320), endedAt: ago(300), exitCode: 0, outcome: "no_changes", note: "Exited without changes", sessionId: "3f9c2a71-5d0e-4b8a-9e61-2c7d4f0a8b13" },
        { agentName: "Grok", startedAt: ago(300), endedAt: ago(270), exitCode: 2, outcome: "failed" },
      ],
      createdAt: ago(321),
      updatedAt: ago(270),
    }),
    t({
      key: "CSW-1377",
      projectId: "p1",
      summary: "Sanitize HTML in agent notes",
      status: "merged",
      prUrl: "https://github.com/anywhere/chatsupport-web/pull/2190",
      pr: pr(2190, "chatsupport-web", { state: "merged", mergedAt: ago(400), reviewDecision: "APPROVED", approvedAt: ago(460) }),
      jiraCommented: true,
      attempts: [{ agentName: "Claude Code", startedAt: ago(1500), endedAt: ago(1460), exitCode: 0, outcome: "success" }],
      createdAt: ago(1501),
      updatedAt: ago(400),
    }),
  ];
  return {
    tickets: Object.fromEntries(list.map((x) => [x.key, x])),
    lastPollAt: ago(6),
    lastPrCheckAt: ago(2),
    nextPrCheckAt: new Date(Date.now() + 60_000).toISOString(),
    nextPollAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    pollErrors: {},
    prCheckErrors: {},
    accounts: { setmore: { loggedIn: true, user: "yogesh@anywhere.co" }, linear: { loggedIn: true, user: "yogesh@anywhere.co" } },
  };
}

const DEMO_LOG = `── HandsFree ▸ SET-982 ─────────────────────────────
worktree  /Users/yogesh/code/setmore-api/.worktrees/SET-982
branch    handsfree/SET-982  (from origin/develop)
mcp       .handsfree/mcp.json (0 servers)

▶ Agent 1/2 · Grok
$ grok --prompt '<prompt>'
Reading src/bookings/BookingService.java …
Planning: add SlotConflictException → 409 mapping
Editing src/bookings/BookingService.java
Error: 429 Too Many Requests — rate limit exceeded for model grok-4
✖ Grok exited with code 1 · matched exhaustion pattern “rate.?limit”

↪ Falling back to Agent 2/2 · Claude Code (continuing in the same worktree)
$ claude -p '<prompt>' --mcp-config .handsfree/mcp.json --dangerously-skip-permissions
Reviewing previous agent's uncommitted changes (2 files)
Adding SlotConflictException handler in ApiExceptionMapper
Writing BookingServiceConflictTest
Running ./gradlew test --tests '*Booking*'
  BookingServiceConflictTest > returns409WhenSlotTaken PASSED
  BookingServiceTest > createsBooking PASSED
`;

export function createMockApi(opts: DemoOptions): Api {
  let config = demoConfig(opts.scenario);
  let state = demoState(opts.scenario);
  const subs = new Set<(e: EngineEvent) => void>();
  const emit = (e: EngineEvent) => subs.forEach((s) => s(e));
  const ok = async () => {};
  return {
    getConfig: async () => config,
    saveConfig: async (c) => {
      config = c;
      emit({ type: "config", config });
      return config;
    },
    getState: async () => state,
    pause: async () => {
      config = { ...config, settings: { ...config.settings, paused: true } };
      emit({ type: "config", config });
    },
    resume: async () => {
      config = { ...config, settings: { ...config.settings, paused: false } };
      emit({ type: "config", config });
    },
    pollNow: ok,
    checkPrsNow: ok,
    sendMessage: async (k, text) => {
      const t = state.tickets[k];
      const rec = { kind: "manual" as const, at: new Date().toISOString(), platform: "setmore" as const, channelId: "nN0p", channelName: "ChatSupport Team Core", text: text || `${k} — ${t?.summary}: ${t?.prUrl}`, ok: true, id: "m-demo" };
      if (t) {
        state = { ...state, tickets: { ...state.tickets, [k]: { ...t, messages: [...(t.messages || []), rec] } } };
        emit({ type: "state", state });
      }
      return rec;
    },
    sendBulk: async (keys, text) => {
      const recs = keys.map(() => ({ kind: "bulk" as const, at: new Date().toISOString(), platform: "setmore" as const, channelId: "nN0p", channelName: "ChatSupport Team Core", text: text || `Hi team, these PRs need eyes:\n${keys.map((x) => `- ${x}`).join("\n")}`, ok: true, id: "m-demo" }));
      return { sent: recs, failed: [] };
    },
    testMessage: async () => ({ ok: true }),
    listChannels: async (_p, query) => ({
      channels: [
        { id: "nN0pGzAWVcudEnhemVADfwCZi6iUlMiW", name: "ChatSupport Team Core" },
        { id: "UN1xRascNHnbVXP99Pw2ztIQfgPTt7qF", name: "CBA: Core Team" },
      ].filter((c) => !query || c.name.toLowerCase().includes(query.toLowerCase())),
    }),
    setmoreStatus: async () => state.accounts.setmore,
    setmoreLogin: async () => {
      setTimeout(() => {
        state = { ...state, accounts: { ...state.accounts, setmore: { loggedIn: true, user: "yogesh@anywhere.co" } } };
        emit({ type: "account", name: "setmore", status: state.accounts.setmore });
      }, 1000);
      return { url: "https://auth.setmore.com/o/oauth2/auth?demo=1" };
    },
    setmoreLogout: async () => {
      state = { ...state, accounts: { setmore: { loggedIn: false }, linear: { loggedIn: false } } };
      emit({ type: "account", name: "setmore", status: state.accounts.setmore });
    },
    publish: async (k) => {
      const t = state.tickets[k];
      if (t?.pr) {
        state = { ...state, tickets: { ...state.tickets, [k]: { ...t, status: "pr_ready", pr: { ...t.pr, draft: false } } } };
        emit({ type: "state", state });
      }
    },
    fixCi: ok,
    retry: ok,
    stop: ok,
    cleanup: ok,
    forget: async (k) => {
      const { [k]: _, ...rest } = state.tickets;
      state = { ...state, tickets: rest };
      emit({ type: "state", state });
    },
    getLog: async () => DEMO_LOG,
    open: async (k) => {
      const t = state.tickets[k];
      if (t?.status === "running") return { command: "live view · press Enter in Terminal to take over" };
      if (t && !PR_STATUSES.includes(t.status) && t.status !== "merged" && t.status !== "done") {
        state = { ...state, tickets: { ...state.tickets, [k]: { ...t, status: "manual", slow: undefined, currentAgent: undefined } } };
        emit({ type: "state", state });
      }
      return { command: "claude --resume '3f9c2a71-5d0e-4b8a-9e61-2c7d4f0a8b13' --mcp-config .handsfree/mcp.json" };
    },
    handBack: async (k) => {
      const t = state.tickets[k];
      if (t) {
        state = { ...state, tickets: { ...state.tickets, [k]: { ...t, status: "queued" } } };
        emit({ type: "state", state });
      }
    },
    testJira: async () => ({
      issues: [
        { key: "CSW-1425", summary: "Persist agent's last-used canned response" },
        { key: "CSW-1431", summary: "Show 'agent is away' banner after 5 min idle" },
        { key: "CSW-1433", summary: "Keyboard shortcut to close a conversation" },
      ],
    }),
    repoInfo: async (path) => ({ ok: true, toplevel: path, defaultBranch: "main", remotes: ["origin"] }),
    doctor: async () => [
      { name: "git", ok: true, detail: "git version 2.46.0" },
      { name: "gh", ok: true, detail: "Logged in to github.com as yogesh-anywhere" },
      { name: "acli", ok: true, detail: "Authenticated · anywhere.atlassian.net" },
      { name: "claude", ok: true, detail: "2.3.1 (Claude Code)" },
      { name: "grok", ok: true, detail: "grok-cli 1.4.0" },
      { name: "antigravity", ok: false, detail: "Not found on PATH" },
    ],
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
