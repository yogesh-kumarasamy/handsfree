import type { ProjectConfig } from "../types";
import type { MessagingAdapter } from "./adapter";
import { AgentAdapter } from "./agent";

export function adapterFor(p: Pick<ProjectConfig, "messaging">): MessagingAdapter | undefined {
  if (p.messaging.platform !== "agent") return undefined;
  // Deliberately not the project repo: its CLAUDE.md, hooks and .mcp.json must not shape a message send.
  return new AgentAdapter(p.messaging.agentCommand);
}
