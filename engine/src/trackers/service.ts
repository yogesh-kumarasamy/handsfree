// Picks the tracker adapter for a project and owns the Linear account (login, status, shared connection).
import { LoopbackLogin } from "../oauthlogin";
import { discover, registerClient, type ClientStore, type TokenStore } from "../messaging/oauth";
import { TRACKER_NOUN, type AccountStatus, type Config, type EngineEvent, type EngineState, type ProjectConfig } from "../types";
import type { TrackerAdapter, TrackerProject } from "./adapter";
import { GithubTracker } from "./github";
import { JiraTracker } from "./jira";
import { LinearConnection, LinearTracker } from "./linear";

export interface TrackerServiceDeps {
  config: () => Config;
  state: () => EngineState;
  persist: () => void;
  emit: (e: EngineEvent) => void;
  /** DATA_DIR/auth/linear.json */
  tokens: TokenStore;
  /** DATA_DIR/auth/linear-client.json */
  client: ClientStore;
  fetchImpl?: typeof fetch;
}

export class TrackerService {
  private login: LoopbackLogin;
  private conn?: LinearConnection;
  private connKey?: string;

  constructor(private deps: TrackerServiceDeps) {
    const cfg = () => this.deps.config().settings.accounts.linear;
    this.login = new LoopbackLogin({
      name: "linear",
      issuer: () => cfg().issuer,
      resource: () => cfg().mcpUrl,
      scopes: () => cfg().scopes,
      redirectPort: () => cfg().redirectPort,
      clientId: () => this.registeredClient(),
      tokens: deps.tokens,
      onStatus: (s) => this.setStatus(s),
      status: (e) => this.linear().keeper.status(e),
      fetchImpl: deps.fetchImpl,
    });
  }

  /** The stored registered client, or a fresh registration when there is none or it was made for another redirect URI/server. */
  private async registeredClient() {
    const s = this.deps.config().settings.accounts.linear;
    const redirectUri = `http://127.0.0.1:${s.redirectPort}/oauth/callback`;
    const cur = this.deps.client.load();
    if (cur && cur.redirectUri === redirectUri && (!cur.issuer || cur.issuer === s.issuer)) return { clientId: cur.clientId, clientSecret: cur.clientSecret };
    const meta = await discover(s.issuer, this.deps.fetchImpl);
    const r = await registerClient(meta, { redirectUri, clientName: "HandsFree" }, this.deps.fetchImpl);
    this.deps.client.save({ clientId: r.client_id, clientSecret: r.client_secret, redirectUri, issuer: s.issuer, registeredAt: new Date().toISOString() });
    return { clientId: r.client_id, clientSecret: r.client_secret };
  }

  // ---------- Linear account ----------
  private accountKey() {
    return JSON.stringify(this.deps.config().settings.accounts.linear);
  }
  private linear(): LinearConnection {
    if (!this.conn) {
      this.conn = new LinearConnection(this.deps.config().settings.accounts.linear, this.deps.tokens, this.deps.client, (s) => this.setStatus(s), this.deps.fetchImpl);
      this.connKey = this.accountKey();
    }
    return this.conn;
  }
  status(): AccountStatus {
    return { ...this.linear().keeper.status(), loginPending: this.login.pending };
  }
  private setStatus(s: AccountStatus) {
    const status = { ...s, loginPending: this.login.pending };
    this.deps.state().accounts.linear = status;
    this.deps.persist();
    this.deps.emit({ type: "account", name: "linear", status });
  }
  init() {
    this.setStatus(this.linear().keeper.status());
  }
  /** Config saved: rebuild the Linear connection only when its account settings changed. */
  settingsChanged() {
    if (this.conn && this.accountKey() !== this.connKey) this.conn = undefined;
  }
  loginUrl() {
    return this.login.loginUrl();
  }
  async logout() {
    await this.login.logout();
  }
  shutdown() {
    this.login.shutdown();
  }

  // ---------- adapters ----------
  trackerFor(p: TrackerProject): TrackerAdapter {
    switch (p.tracker.kind) {
      case "github":
        return new GithubTracker(p);
      case "linear":
        return new LinearTracker(p, this.deps.config().settings.accounts.linear, this.deps.tokens, this.deps.client, (s) => this.setStatus(s), this.deps.fetchImpl, this.linear());
      default:
        return new JiraTracker(p);
    }
  }

  noun(p: Pick<ProjectConfig, "tracker">) {
    return TRACKER_NOUN[p.tracker.kind];
  }
}
