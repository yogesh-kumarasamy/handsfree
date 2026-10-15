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

/** Line-buffered transformer: feed raw chunks, get formatted text back. */
export function createStreamFormatter() {
  let buf = "";
  const fmt = (lines: string[]) =>
    lines
      .map(formatStreamLine)
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
