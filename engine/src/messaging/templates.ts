// Message templates: plain {placeholder} substitution, no shell quoting (unlike shell.fill).
import type { ProjectConfig, Ticket } from "../types";

export function fillTemplate(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

/** "47 min", "3 h 10 min", "1 d 2 h". */
export function humanDuration(fromIso: string, nowMs = Date.now()) {
  const min = Math.max(0, Math.round((nowMs - Date.parse(fromIso)) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export function ticketVars(p: Pick<ProjectConfig, "name">, t: Pick<Ticket, "key" | "summary" | "branch" | "prUrl" | "pr">, nowMs = Date.now()) {
  return {
    key: t.key,
    summary: t.summary,
    pr_url: t.prUrl || "",
    pr_number: t.pr?.number !== undefined ? String(t.pr.number) : "",
    project: p.name,
    branch: t.branch,
    approved_ago: t.pr?.approvedAt ? humanDuration(t.pr.approvedAt, nowMs) : "",
  };
}

export function bulkList(items: { p: Pick<ProjectConfig, "name">; t: Pick<Ticket, "key" | "summary" | "prUrl"> }[]) {
  return items.map(({ t }) => `- ${t.key} — ${t.summary}: ${t.prUrl || "(no PR yet)"}`).join("\n");
}
