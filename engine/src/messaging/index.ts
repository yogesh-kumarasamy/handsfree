import type { AccountStatus, ProjectConfig, Settings } from "../types";
import type { MessagingAdapter } from "./adapter";
import { AgentAdapter } from "./agent";
import type { TokenStore } from "./oauth";
import { SetmoreAdapter } from "./setmore";

export interface AdapterDeps {
  tokens: TokenStore;
  onStatus: (s: AccountStatus) => void;
  /** One Setmore adapter per process, so token refreshes are shared. */
  setmore?: SetmoreAdapter;
  fetchImpl?: typeof fetch;
}

export function adapterFor(p: Pick<ProjectConfig, "messaging" | "repoPath">, settings: Settings, deps: AdapterDeps): MessagingAdapter | undefined {
  switch (p.messaging.platform) {
    case "setmore":
      deps.setmore ||= new SetmoreAdapter(settings.accounts.setmore, deps.tokens, deps.onStatus, deps.fetchImpl);
      return deps.setmore;
    case "agent":
      return new AgentAdapter(p.messaging.agentCommand, p.repoPath || undefined);
    default:
      return undefined;
  }
}
