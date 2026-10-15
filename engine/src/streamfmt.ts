// Turns Claude Code's `--output-format stream-json --verbose` lines into readable log lines.
// Anything that isn't a stream-json line passes through unchanged, so other agents are unaffected.

const short = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

function describeTool(name: string, input: Record<string, any> = {}) {
  const arg =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? "";
  return `→ ${name}${arg ? ` ${short(String(arg), 140)}` : ""}`;
}

export function formatStreamLine(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("{")) return line;
  let e: any;
  try {
    e = JSON.parse(t);
  } catch {
    return line;
  }
  if (!e || typeof e.type !== "string") return line;

  switch (e.type) {
    case "system": {
      if (e.subtype !== "init") return null;
      const servers: { name: string; status: string }[] = e.mcp_servers || [];
      const mcp = servers.length ? ` · MCP: ${servers.map((s) => `${s.name}${s.status === "connected" ? "" : ` (${s.status})`}`).join(", ")}` : "";
      return `· session started${e.model ? ` · ${e.model}` : ""}${mcp}`;
    }
    case "assistant": {
      const out: string[] = [];
      for (const c of e.message?.content || []) {
        if (c.type === "text" && c.text?.trim()) out.push(c.text.trim());
        if (c.type === "tool_use") out.push(describeTool(c.name, c.input));
      }
      return out.length ? out.join("\n") : null;
    }
    case "user": {
      // Tool results are noisy; only surface errors.
      const errs = (e.message?.content || []).filter((c: any) => c.type === "tool_result" && c.is_error);
      return errs.length
        ? errs.map((c: any) => `  ✖ ${short(typeof c.content === "string" ? c.content : JSON.stringify(c.content), 200)}`).join("\n")
        : null;
    }
    case "result": {
      const meta = [
        e.subtype,
        e.num_turns ? `${e.num_turns} turns` : "",
        e.duration_ms ? `${Math.round(e.duration_ms / 60000)} min` : "",
        typeof e.total_cost_usd === "number" ? `$${e.total_cost_usd.toFixed(2)}` : "",
      ].filter(Boolean);
      return `■ ${e.is_error ? "error" : "done"} · ${meta.join(" · ")}${e.result ? `\n\n${String(e.result).trim()}` : ""}`;
    }
    default:
      return null;
  }
}

/** Pull a Claude session id out of a stream-json line, if it has one. */
export function sessionIdOf(line: string): string | undefined {
  const t = line.trim();
  if (!t.startsWith("{") || !t.includes("session_id")) return;
  try {
    const id = JSON.parse(t).session_id;
    return typeof id === "string" && /^[A-Za-z0-9-]{8,}$/.test(id) ? id : undefined;
  } catch {
    return;
  }
}

/** True for a stream-json `result` line: the turn is over (with --input-format stream-json the process then waits for more input). */
export function isResultLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("{") || !t.includes('"result"')) return false;
  try {
    return JSON.parse(t).type === "result";
  } catch {
    return false;
  }
}

/** Line-buffered transformer: feed raw chunks, get formatted text back. */
export function createStreamFormatter(onSession?: (id: string) => void, onResult?: () => void) {
  let buf = "";
  let seen: string | undefined;
  const fmt = (lines: string[]) =>
    lines
      .map((l) => {
        const id = onSession && sessionIdOf(l);
        if (id && id !== seen) {
          seen = id;
          onSession!(id);
        }
        if (onResult && isResultLine(l)) onResult();
        return formatStreamLine(l);
      })
      .filter((l): l is string => l !== null)
      .map((l) => `${l}\n`)
      .join("");
  return {
    push(chunk: string) {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      return fmt(parts);
    },
    flush() {
      const rest = buf;
      buf = "";
      return rest ? fmt([rest]) : "";
    },
  };
}
