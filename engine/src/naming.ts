// Per-project naming conventions for branches, commit subjects and PR titles.
// A rule is a template (how HandsFree builds the name) plus a regex (what the team's checks accept).
// Templates know {key} {summary} {slug} {type} {type_cc}; see `renderName`.

export interface NamingRule {
  /** e.g. "{key}/{type}/{slug}". */
  template: string;
  /** JavaScript regex source the rendered name must match. Empty = no check. */
  pattern: string;
}

export interface NamingConfig {
  branch: NamingRule;
  /** Commit subjects: HandsFree's own commits are rendered from it; agent commits that fail the pattern are reworded to it. */
  commit: NamingRule;
  prTitle: NamingRule;
}

export interface NameVars {
  key: string;
  summary: string;
  /** Branch type keyword (bug, feature, …); see `issueTypeOf`. Missing = feature. */
  type?: string;
}

/** What HandsFree always did: no checks. */
export const DEFAULT_NAMING: NamingConfig = {
  branch: { template: "handsfree/{key}", pattern: "" },
  commit: { template: "{key}: {summary}", pattern: "" },
  prTitle: { template: "{key}: {summary}", pattern: "" },
};

/** The rules Anywhere's `conventionsbot` check enforces on GitHub (branch and commit regexes copied from its check output). */
export const ANYWHERE_NAMING: NamingConfig = {
  branch: {
    template: "{key}/{type}/{slug}",
    pattern: "^dependabot|changeset|([A-Za-z]{1,10}-\\d+(\\/)(release|feature|hotfix|config|bug|spike|refactor|improvement)(\\/.*))|staging|main|release(\\/.*)|hotfix(\\/.*)|rc(\\/.*)",
  },
  commit: {
    template: "{type_cc}: {key} {summary}",
    pattern:
      "Bump|^((build|chore|ci|docs|feat|fix|perf|refactor|revert|Revert|style|test|change|security|hotfix|deprecate){1}(\\([\\w\\-\\.]+\\))?(!)?:([\\w ])+([\\s\\S]*[A-Za-z]{1,10}-\\d+))|Merge Pull Request|Merge branch| Merge branches|Merge remote-tracking branch|Merge pull request|Merge origin|Revert",
  },
  prTitle: { template: "{key}: {summary}", pattern: "[A-Za-z]{1,10}-\\d+" },
};

/** Branch type keywords, and the conventional-commit type each maps to. */
const TYPE_CC: Record<string, string> = {
  bug: "fix",
  hotfix: "fix",
  feature: "feat",
  improvement: "feat",
  refactor: "refactor",
  config: "chore",
  spike: "chore",
  release: "chore",
};

/** kebab-case, ASCII only, cut at the limit (on a word boundary when one is near). Never empty. */
export function slugify(s: string, max = 48): string {
  let out = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (out.length > max) {
    let cut = out.slice(0, max);
    if (out[max] !== "-") {
      // Cut lands mid-word: back up to the previous dash unless that loses more than half.
      const dash = cut.lastIndexOf("-");
      if (dash > max / 2) cut = cut.slice(0, dash);
    }
    out = cut.replace(/-+$/, "");
  }
  return out || "change";
}

/**
 * The ticket's folder name under `.worktrees/`: the key with anything outside `[A-Za-z0-9._-]` turned into `-`.
 * GitHub keys look like `repo#12`; a `#` in the path breaks Vite/esbuild (they read it as a URL fragment and the
 * build hangs or can't resolve imports), and `%`, `?`, spaces and the like upset other tools. Never empty.
 */
export function worktreeDirName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ticket";
}

/** Label names out of a tracker's label list: ["bug"], [{name:"bug"}] or {nodes:[{name}]} (Linear). */
export function labelNames(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { nodes?: unknown[] })?.nodes) ? (raw as { nodes: unknown[] }).nodes : [];
  return list
    .map((l) => (typeof l === "string" ? l : typeof (l as { name?: unknown })?.name === "string" ? (l as { name: string }).name : ""))
    .filter(Boolean);
}

/** Tracker issue type (Jira "Bug", "Story"…) or label list (GitHub, Linear) → branch type keyword. */
export function issueTypeOf(raw: string | string[] | undefined): string {
  const names = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((x) => String(x).toLowerCase());
  const has = (re: RegExp) => names.some((n) => re.test(n));
  if (has(/hotfix/)) return "hotfix";
  if (has(/bug|defect|incident|fix/)) return "bug";
  if (has(/spike|research|investigat/)) return "spike";
  if (has(/refactor|tech.?debt/)) return "refactor";
  if (has(/improve|enhance/)) return "improvement";
  if (has(/config|chore/)) return "config";
  return "feature";
}

export function renderName(template: string, v: NameVars): string {
  const type = (v.type || "feature").toLowerCase();
  const vars: Record<string, string> = {
    key: v.key,
    summary: v.summary,
    slug: slugify(v.summary),
    type,
    type_cc: TYPE_CC[type] || "feat",
  };
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

function compile(pattern: string): RegExp | string {
  try {
    return new RegExp(pattern);
  } catch (e) {
    return `Invalid regex: ${(e as Error).message}`;
  }
}

export type NameCheck = { value: string; ok: true } | { value: string; ok: false; error: string };

/** Render the template and test it against the pattern. */
export function checkName(rule: NamingRule, v: NameVars): NameCheck {
  const value = renderName(rule.template, v).trim();
  if (!rule.pattern.trim()) return { value, ok: true };
  const re = compile(rule.pattern);
  if (typeof re === "string") return { value, ok: false, error: re };
  return re.test(value) ? { value, ok: true } : { value, ok: false, error: `“${value}” doesn't match the pattern /${rule.pattern}/` };
}

/** The commit-message instruction for an agent prompt: the pattern with a rendered example, or `classic` when there is no pattern. */
export function commitRule(rule: NamingRule, v: NameVars, classic: string): string {
  if (!rule.pattern.trim()) return classic;
  const example = renderName(rule.template, { ...v, summary: "what this commit changes" });
  return `Commit your work with clear messages. Every commit subject MUST match this regex: /${rule.pattern}/ — for example "${example}". HandsFree rewords subjects that don't match before pushing.`;
}

/**
 * A commit subject the agent (or a person) wrote: kept when it already matches, else rewritten with the commit
 * template using the subject as the summary (a leading "KEY:" or "KEY -" is dropped so the key isn't doubled).
 */
export function conformSubject(rule: NamingRule, v: NameVars, subject: string): string {
  if (!rule.pattern.trim()) return subject;
  const re = compile(rule.pattern);
  if (typeof re === "string" || re.test(subject)) return subject;
  const keyRe = new RegExp(`^\\s*${v.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-–]?\\s*`, "i");
  const summary = subject.replace(keyRe, "").trim() || v.summary;
  return renderName(rule.template, { ...v, summary });
}
