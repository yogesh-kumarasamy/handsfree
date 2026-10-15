// Sends collab messages for PR events and on demand; owns the Setmore login (loopback OAuth) and records every send.
import type { AccountStatus, Config, EngineEvent, EngineState, MessageKind, MessageRecord, PrEvent, ProjectConfig, Ticket } from "../types";
import type { MessagingAdapter } from "./adapter";
import { adapterFor as realAdapterFor, type AdapterDeps } from "./index";
import { LoopbackLogin } from "../oauthlogin";
import type { TokenStore } from "./oauth";
import { SetmoreAdapter } from "./setmore";
import { bulkList, fillTemplate, ticketVars } from "./templates";

export interface ServiceDeps {
  config: () => Config;
  state: () => EngineState;
  log: (key: string, chunk: string) => void;
  notify: (title: string, body: string) => void;
  persist: () => void;
  emit: (e: EngineEvent) => void;
  tokens: TokenStore;
  fetchImpl?: typeof fetch;
  /** Test seam. */
  adapterFor?: (p: ProjectConfig, settings: Config["settings"], deps: AdapterDeps) => MessagingAdapter | undefined;
}

const now = () => new Date().toISOString();

export class MessagingService {
  private adapterDeps: AdapterDeps;
  private login: LoopbackLogin;

  constructor(public deps: ServiceDeps) {
    this.adapterDeps = { tokens: deps.tokens, fetchImpl: deps.fetchImpl, onStatus: (s) => this.setStatus(s) };
    const cfg = () => this.deps.config().settings.accounts.setmore;
    this.login = new LoopbackLogin({
      name: "setmore",
      issuer: () => cfg().issuer,
      resource: () => cfg().mcpUrl,
      scopes: () => cfg().scopes,
      redirectPort: () => cfg().redirectPort,
      clientId: async () => {
        if (!cfg().clientId.trim()) throw new Error("Enter the Setmore client id first (from the auth team).");
        return { clientId: cfg().clientId };
      },
      tokens: deps.tokens,
      onStatus: (s) => this.setStatus(s),
      status: (e) => this.setmore().status(e),
      fetchImpl: deps.fetchImpl,
    });
  }

  // ---------- status ----------
  private accountKey() {
    return JSON.stringify(this.deps.config().settings.accounts.setmore);
  }
  private setmore(): SetmoreAdapter {
    if (!this.adapterDeps.setmore) {
      this.adapterDeps.setmore = new SetmoreAdapter(this.deps.config().settings.accounts.setmore, this.deps.tokens, this.adapterDeps.onStatus, this.deps.fetchImpl);
      this.lastAccountKey = this.accountKey();
    }
    return this.adapterDeps.setmore;
  }
  status(): AccountStatus {
    return { ...this.setmore().status(), loginPending: this.login.pending };
  }
  private setStatus(s: AccountStatus) {
    const status = { ...s, loginPending: this.login.pending };
    this.deps.state().accounts.setmore = status;
    this.deps.persist();
    this.deps.emit({ type: "account", name: "setmore", status });
  }
  /** Called once at engine start to reflect the token file. */
  init() {
    this.setStatus(this.setmore().status());
  }
  private lastAccountKey?: string;
  /**
   * Config saved. Only when the account settings (client id, URLs) differ from the ones the cached adapter was
   * built with is it dropped — an unrelated save must not interrupt an in-flight token refresh.
   */
  settingsChanged() {
    if (this.adapterDeps.setmore && this.accountKey() !== this.lastAccountKey) this.adapterDeps.setmore = undefined;
  }

  // ---------- resolving ----------
  private adapter(p: ProjectConfig) {
    return (this.deps.adapterFor || realAdapterFor)(p, this.deps.config().settings, this.adapterDeps);
  }
  private resolve(t: Ticket): { p: ProjectConfig; adapter: MessagingAdapter } {
    const p = this.deps.config().projects.find((x) => x.id === t.projectId);
    if (!p) throw new Error("Its project was deleted.");
    const adapter = this.adapter(p);
    if (!adapter) throw new Error(`No messaging platform is set for “${p.name}” (project → Messaging).`);
    if (!p.messaging.channelId) throw new Error(`Choose a channel in the Messaging step of “${p.name}”.`);
    return { p, adapter };
  }

  // ---------- sending ----------
  private record(t: Ticket, rec: MessageRecord) {
    (t.messages ||= []).push(rec);
    if (t.messages.length > 50) t.messages.splice(0, t.messages.length - 50);
    t.updatedAt = now();
    this.deps.persist();
  }

  /** Send `text` for one ticket; records the outcome on the ticket and throws on failure (after recording). */
  async sendForTicket(t: Ticket, kind: MessageKind, text: string): Promise<MessageRecord> {
    const { p, adapter } = this.resolve(t);
    const base = { kind, at: now(), platform: adapter.platform, channelId: p.messaging.channelId, channelName: p.messaging.channelName, text };
    const idempotencyKey = `${t.key}:${kind}:${t.pr?.headSha || ""}:${base.at.slice(0, 16)}`;
    try {
      const { id } = await adapter.send(p.messaging.channelId, text, idempotencyKey);
      const rec: MessageRecord = { ...base, ok: true, id };
      this.record(t, rec);
      this.deps.log(t.key, `\n💬 Sent to ${p.messaging.channelName || p.messaging.channelId} (${kind})\n`);
      return rec;
    } catch (e) {
      const error = String((e as Error).message || e).slice(0, 400);
      const rec: MessageRecord = { ...base, ok: false, error };
      this.record(t, rec);
      this.deps.log(t.key, `\n! Message to ${p.messaging.channelName || p.messaging.channelId} failed: ${error}\n`);
      this.deps.notify(`${t.key}: message not sent`, error);
      throw e;
    }
  }

  async onPrEvent(e: PrEvent) {
    if (e.kind !== "review_ready" && e.kind !== "merge_nudge") return;
    const t = this.deps.state().tickets[e.key];
    const p = t && this.deps.config().projects.find((x) => x.id === t.projectId);
    if (!t || !p) return;
    if (p.messaging.platform === "none") return;
    const tpl = e.kind === "review_ready" ? p.messaging.templates.reviewReady : p.messaging.templates.mergeNudge;
    if (!tpl.trim()) return this.deps.log(t.key, `· messaging: the ${e.kind} template is empty, nothing sent\n`);
    if (!p.messaging.channelId) return this.deps.log(t.key, "· messaging: no channel configured, nothing sent\n");
    await this.sendForTicket(t, e.kind, fillTemplate(tpl, ticketVars(p, t))).catch(() => undefined);
  }

  async sendManual(key: string, text?: string) {
    const t = this.deps.state().tickets[key];
    if (!t) throw new Error("Unknown ticket");
    const { p } = this.resolve(t);
    return this.sendForTicket(t, "manual", text?.trim() || fillTemplate(p.messaging.templates.manual, ticketVars(p, t)));
  }

  async sendBulk(keys: string[], text?: string): Promise<{ sent: MessageRecord[]; failed: { key: string; error: string }[] }> {
    const sent: MessageRecord[] = [];
    const failed: { key: string; error: string }[] = [];
    const groups = new Map<string, Ticket[]>();
    for (const key of keys) {
      const t = this.deps.state().tickets[key];
      if (!t) {
        failed.push({ key, error: "Unknown ticket" });
        continue;
      }
      if (!groups.has(t.projectId)) groups.set(t.projectId, []);
      groups.get(t.projectId)!.push(t);
    }
    // Each project has its own channel: a selection spanning projects must keep {list} so every channel
    // only sees its own PRs. A fully expanded text would post everyone's PRs everywhere.
    if (groups.size > 1 && text?.trim() && !text.includes("{list}")) {
      const error = `This selection spans ${groups.size} projects (different channels). Keep {list} in the text so each channel gets only its own PRs.`;
      for (const tickets of groups.values()) for (const t of tickets) failed.push({ key: t.key, error });
      return { sent, failed };
    }
    for (const [projectId, tickets] of groups) {
      const p = this.deps.config().projects.find((x) => x.id === projectId);
      let adapter: MessagingAdapter | undefined;
      try {
        adapter = p && this.adapter(p);
        if (!p || !adapter) throw new Error(`No messaging platform is set for “${p?.name || projectId}”.`);
        if (!p.messaging.channelId) throw new Error(`Choose a channel in the Messaging step of “${p.name}”.`);
      } catch (e) {
        for (const t of tickets) failed.push({ key: t.key, error: (e as Error).message });
        continue;
      }
      const list = bulkList(tickets.map((t) => ({ p, t })));
      const body = fillTemplate(text?.trim() || p.messaging.templates.bulk, { ...ticketVars(p, tickets[0]), list });
      const at = now();
      const base = { kind: "bulk" as const, at, platform: adapter.platform, channelId: p.messaging.channelId, channelName: p.messaging.channelName, text: body };
      try {
        const { id } = await adapter.send(p.messaging.channelId, body, `bulk:${tickets.map((t) => t.key).join(",")}:${at.slice(0, 16)}`);
        for (const t of tickets) {
          const rec = { ...base, ok: true, id };
          this.record(t, rec);
          sent.push(rec);
          this.deps.log(t.key, `\n💬 Sent to ${p.messaging.channelName || p.messaging.channelId} (bulk, ${tickets.length} tickets)\n`);
        }
      } catch (e) {
        const error = String((e as Error).message || e).slice(0, 400);
        for (const t of tickets) {
          this.record(t, { ...base, ok: false, error });
          failed.push({ key: t.key, error });
        }
        this.deps.notify("Bulk message not sent", error);
      }
    }
    return { sent, failed };
  }

  async sendTest(p: ProjectConfig): Promise<{ ok: boolean; error?: string }> {
    try {
      const adapter = this.adapter(p);
      if (!adapter) return { ok: false, error: "Pick a platform first." };
      if (!p.messaging.channelId) return { ok: false, error: "Pick a channel first." };
      await adapter.send(p.messaging.channelId, `HandsFree test message from “${p.name || "a project"}” at ${new Date().toLocaleString()}`, `test:${Date.now()}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e as Error).message || e).slice(0, 400) };
    }
  }

  async listChannels(p: ProjectConfig, query?: string) {
    const adapter = this.adapter(p);
    if (!adapter) throw new Error("Pick a platform first.");
    return adapter.listChannels(query);
  }

  // ---------- Setmore login ----------
  loginUrl(): Promise<string> {
    return this.login.loginUrl();
  }

  async logout() {
    await this.login.logout();
  }

  shutdown() {
    this.login.shutdown();
  }
}
