import type { Api, DemoOptions } from "./api";
import {
  AGENT_PRESETS,
  DEFAULT_JIRA_COMMENT,
  DEFAULT_JIRA_SEARCH,
  type Config,
  type EngineEvent,
  type EngineState,
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
      maxParallel: 3,
      agentTimeoutMin: 90,
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
              jql: 'project = CSW AND assignee = currentUser() AND status = "To Do" ORDER BY priority DESC',
              jiraSearchCommand: DEFAULT_JIRA_SEARCH,
              jiraCommentCommand: DEFAULT_JIRA_COMMENT,
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
            },
            {
              id: "p2",
              name: "Setmore API",
              enabled: true,
              repoPath: "/Users/yogesh/code/setmore-api",
              baseBranch: "develop",
              remote: "origin",
              jql: "project = SET AND assignee = currentUser() AND labels = handsfree",
              jiraSearchCommand: DEFAULT_JIRA_SEARCH,
              jiraCommentCommand: DEFAULT_JIRA_COMMENT,
              mcpJson: '{\n  "mcpServers": {}\n}',
              agents: agents(["Grok", "Claude Code"]),
              promptExtra: "",
              draftPr: true,
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

function demoState(scenario: DemoOptions["scenario"]): EngineState {
  if (scenario === "empty") return { tickets: {}, pollErrors: {} };
  const list: Ticket[] = [
    t({
      key: "CSW-1421",
      projectId: "p1",
      summary: "Add typing indicator to the visitor chat widget",
      status: "running",
      currentAgent: "Claude Code",
      attempts: [{ agentName: "Claude Code", startedAt: ago(12) }],
      createdAt: ago(13),
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
      status: "pr_open",
      prUrl: "https://github.com/anywhere/chatsupport-web/pull/2211",
      jiraCommented: true,
      attempts: [{ agentName: "Claude Code", startedAt: ago(190), endedAt: ago(151), exitCode: 0, outcome: "success" }],
      createdAt: ago(191),
      updatedAt: ago(150),
    }),
    t({
      key: "SET-975",
      projectId: "p2",
      summary: "Add pagination to GET /v2/customers",
      status: "pr_open",
      prUrl: "https://github.com/anywhere/setmore-api/pull/877",
      jiraCommented: true,
      attempts: [{ agentName: "Grok", startedAt: ago(260), endedAt: ago(232), exitCode: 0, outcome: "success" }],
      createdAt: ago(261),
      updatedAt: ago(231),
    }),
    t({
      key: "CSW-1390",
      projectId: "p1",
      summary: "Migrate transcript export to the new PDF service",
      status: "failed",
      error: "All agents failed",
      attempts: [
        { agentName: "Claude Code", startedAt: ago(320), endedAt: ago(300), exitCode: 0, outcome: "no_changes", note: "Exited without changes" },
        { agentName: "Grok", startedAt: ago(300), endedAt: ago(270), exitCode: 2, outcome: "failed" },
      ],
      createdAt: ago(321),
      updatedAt: ago(270),
    }),
    t({
      key: "CSW-1377",
      projectId: "p1",
      summary: "Sanitize HTML in agent notes",
      status: "done",
      prUrl: "https://github.com/anywhere/chatsupport-web/pull/2190",
      jiraCommented: true,
      attempts: [{ agentName: "Claude Code", startedAt: ago(1500), endedAt: ago(1460), exitCode: 0, outcome: "success" }],
      createdAt: ago(1501),
      updatedAt: ago(400),
    }),
  ];
  return {
    tickets: Object.fromEntries(list.map((x) => [x.key, x])),
    lastPollAt: ago(6),
    nextPollAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    pollErrors: {},
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
    retry: ok,
    stop: ok,
    cleanup: ok,
    forget: async (k) => {
      const { [k]: _, ...rest } = state.tickets;
      state = { ...state, tickets: rest };
      emit({ type: "state", state });
    },
    getLog: async () => DEMO_LOG,
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
