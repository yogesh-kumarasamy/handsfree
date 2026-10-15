import fs from "node:fs";
import path from "node:path";
import { exec } from "./shell";
import type { ProjectConfig, Ticket } from "./types";

async function gh(cwd: string, args: string[]) {
  const r = await exec("gh", args, { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout.trim();
}

/** Open (or find the existing) PR for the ticket's branch. Returns its URL. */
export async function openPr(project: ProjectConfig, t: Ticket, body: string): Promise<string> {
  const existing = await gh(t.worktree, ["pr", "list", "--head", t.branch, "--state", "open", "--json", "url", "--jq", ".[0].url"]).catch(() => "");
  if (existing) return existing;
  const bodyFile = path.join(t.worktree, ".handsfree", "pr-body.md");
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(bodyFile, body);
  const args = ["pr", "create", "--base", project.baseBranch, "--head", t.branch, "--title", `${t.key}: ${t.summary}`.slice(0, 250), "--body-file", bodyFile];
  if (project.draftPr) args.push("--draft");
  const out = await gh(t.worktree, args);
  const url = out.split("\n").reverse().find((l) => /^https?:\/\//.test(l.trim()));
  if (!url) throw new Error(`gh pr create didn't return a URL: ${out.slice(0, 300)}`);
  return url.trim();
}

/** "OPEN" | "MERGED" | "CLOSED" | undefined (unknown / gh failed). */
export async function prState(repoPath: string, url: string) {
  const s = await gh(repoPath, ["pr", "view", url, "--json", "state", "--jq", ".state"]).catch(() => "");
  return s || undefined;
}
