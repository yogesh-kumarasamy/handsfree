import fs from "node:fs";
import path from "node:path";
import { dedupeChecks, PR_JSON_FIELDS, trimFailedLogs, type RawPr } from "./prstate";
import { exec } from "./shell";
import type { FailedCheck, ProjectConfig, Ticket } from "./types";

async function gh(cwd: string, args: string[]) {
  const r = await exec("gh", args, { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout.trim();
}

/** Open (or find the existing) PR for the ticket's branch. Returns its URL. */
export async function openPr(project: ProjectConfig, t: Ticket, title: string, body: string): Promise<string> {
  const existing = await gh(t.worktree, ["pr", "list", "--head", t.branch, "--state", "open", "--json", "url", "--jq", ".[0].url"]).catch(() => "");
  if (existing) return existing;
  const bodyFile = path.join(t.worktree, ".handsfree", "pr-body.md");
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(bodyFile, body);
  const args = ["pr", "create", "--base", project.baseBranch, "--head", t.branch, "--title", title.slice(0, 250), "--body-file", bodyFile];
  if (project.draftPr) args.push("--draft");
  const out = await gh(t.worktree, args);
  const url = out.split("\n").reverse().find((l) => /^https?:\/\//.test(l.trim()));
  if (!url) throw new Error(`gh pr create didn't return a URL: ${out.slice(0, 300)}`);
  return url.trim();
}

/** Everything the PR check needs, in one `gh` call. Throws when gh fails (not found, not logged in, deleted PR). */
export async function fetchPr(repoPath: string, url: string): Promise<RawPr> {
  const out = await gh(repoPath, ["pr", "view", url, "--json", PR_JSON_FIELDS]);
  return JSON.parse(out) as RawPr;
}

/** Mark a draft PR ready for review. */
export async function publishPr(repoPath: string, url: string) {
  await gh(repoPath, ["pr", "ready", url]);
}

/**
 * Failing-step logs for the fix prompt: `gh run view --log-failed` once per Actions run,
 * a link line for checks without a run. Never throws; fetch errors become text.
 */
export async function failedCheckLogs(repoPath: string, checks: FailedCheck[]): Promise<string> {
  const parts = await Promise.all(
    dedupeChecks(checks).map(async (c) => {
      if (!c.runId) return { name: c.name, detailsUrl: c.detailsUrl };
      const r = await exec("gh", ["run", "view", c.runId, "--log-failed"], { cwd: repoPath, timeoutMs: 120_000 });
      return r.code === 0
        ? { name: c.name, detailsUrl: c.detailsUrl, log: r.stdout }
        : { name: c.name, detailsUrl: c.detailsUrl, error: (r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}` };
    }),
  );
  return trimFailedLogs(parts);
}
