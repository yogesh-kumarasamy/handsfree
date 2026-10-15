// Agent-driven adapter: a configured agent command (default: claude -p with the user's Setmore connector) does the send.
import { fill, sh, type RunOpts, type RunResult } from "../shell";
import type { MessagingAdapter } from "./adapter";

type Runner = (cmd: string, opts?: RunOpts) => Promise<RunResult>;

/** The last JSON object/array in a string: whole string, a ```json fence, or the last `{`/`[` that parses. */
export function lastJson(s: string): any {
  const t = s.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* keep looking */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let last: any;
  while ((m = fence.exec(t))) {
    try {
      last = JSON.parse(m[1]);
    } catch {
      /* not JSON */
    }
  }
  if (last !== undefined) return last;
  for (let i = t.length - 1; i >= 0; i--) {
    if (t[i] !== "{" && t[i] !== "[") continue;
    for (let j = t.length; j > i; j--) {
      const ch = t[j - 1];
      if (ch !== "}" && ch !== "]") continue;
      try {
        return JSON.parse(t.slice(i, j));
      } catch {
        /* shrink */
      }
    }
  }
  return undefined;
}

export class AgentAdapter implements MessagingAdapter {
  readonly platform = "agent" as const;
  constructor(
    private cmdTemplate: string,
    private cwd?: string,
    private run: Runner = sh,
  ) {}

  private async ask(prompt: string): Promise<{ value: any; raw: string }> {
    const r = await this.run(fill(this.cmdTemplate, { prompt }), { cwd: this.cwd, timeoutMs: 180_000, env: { HANDSFREE: "1" } });
    if (r.timedOut) throw new Error("The messaging agent timed out after 3 min.");
    const raw = (r.stdout || "").trim();
    if (r.code !== 0) throw new Error(`The messaging agent exited with exit ${r.code}: ${(r.stderr || raw).trim().slice(-300)}`);
    const outer = lastJson(raw);
    // Claude's --output-format json envelope: { type: "result", is_error, result: "<text>" }
    if (outer && typeof outer === "object" && "result" in outer) {
      if (outer.is_error) throw new Error(`The messaging agent failed: ${String(outer.result).slice(-300)}`);
      const inner = typeof outer.result === "string" ? lastJson(outer.result) : outer.result;
      return { value: inner, raw: String(outer.result) };
    }
    return { value: outer, raw };
  }

  async listChannels(query?: string) {
    const prompt = [
      `Using the list_channels tool${query ? ` with query ${JSON.stringify(query)}` : ""}, list the channels.`,
      'Print only a JSON array of objects with keys "id" (the channelId) and "name". No prose.',
    ].join("\n");
    const { value, raw } = await this.ask(prompt);
    if (!Array.isArray(value)) throw new Error(`The messaging agent did not return a channel list: ${raw.slice(-300)}`);
    return value.map((c: any) => ({ id: String(c.id ?? c.channelId ?? ""), name: String(c.name ?? "") })).filter((c) => c.id);
  }

  async send(channelId: string, text: string, idempotencyKey: string) {
    const prompt = [
      `Send the following message to the channel with id ${channelId} using the send_message tool (conversationType "channel", conversationId ${JSON.stringify(channelId)}, idempotencyKey ${JSON.stringify(idempotencyKey)}).`,
      "Send the text exactly as written between the markers, with no additions or rewording:",
      "<<<MESSAGE",
      text,
      "MESSAGE>>>",
      "You have the user's explicit consent to send this: call send_message once to get the confirmationToken, then call it again with the same arguments plus that confirmationToken.",
      'When done, print only one line of JSON: {"sent": true, "id": "<message id, or empty string>"} — or, if it could not be sent, {"sent": false, "error": "<why>"}.',
    ].join("\n");
    const { value, raw } = await this.ask(prompt);
    if (value && value.sent === true) return { id: value.id ? String(value.id) : undefined };
    if (value && value.sent === false) throw new Error(`The messaging agent could not send it: ${value.error || "no reason given"}`);
    throw new Error(`The messaging agent did not confirm the send: ${raw.slice(-300)}`);
  }
}
