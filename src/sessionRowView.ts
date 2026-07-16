// Pure presentational helpers for a session row (spec §9). No DOM — unit-tested
// in test/main. The row component is a thin shell over these.

import type { SessionFacts } from "./sessionParser";

/** Risk-coded chip variants (spec §9). Any unrecognized/absent mode is `default`
 *  so the row never crashes on an unexpected value (AC 3). */
export type ChipVariant = "bypass" | "info" | "plan" | "default";

// `default` (and any unrecognized/absent mode) falls through the `?? "default"`
// below, so it needs no explicit entry here.
const CHIP_VARIANTS: Record<string, ChipVariant> = {
  bypassPermissions: "bypass",
  acceptEdits: "info",
  auto: "info",
  plan: "plan",
};

export function chipVariant(mode: string): ChipVariant {
  return CHIP_VARIANTS[mode] ?? "default";
}

/** The first 8 chars of the session id (spec §9). */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

// Branch names treated as "the repo default" for the row's noise rule (#110).
// Exact, case-sensitive matches: git branch names ARE case-sensitive, so `Main`
// is a genuinely different branch from `main` and must still show. Erring toward
// showing is the safe direction — a spurious chip is noise, a suppressed chip is
// a lie. (Resolving the repo's actually-configured default would need a git
// invocation; CSM shells out to git nowhere today. See docs/plans/110-*.md.)
const DEFAULT_BRANCH_NAMES: ReadonlySet<string> = new Set(["main", "master"]);

/** Whether a session's own branch is worth a row chip (#110): present, and not
 *  the repo default — an all-`main` folder would otherwise be a wall of
 *  identical chips, and a chip that is always there carries no information. */
export function shouldShowGitBranch(branch: string | null): branch is string {
  return branch !== null && !DEFAULT_BRANCH_NAMES.has(branch);
}

// Relative-time buckets (seconds) → formatter. Ordered coarsest-last; the first
// bucket whose limit the age is under wins.
const SEC = 1;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

const plural = (n: number, unit: string) =>
  `${n} ${unit}${n === 1 ? "" : "s"} ago`;

/**
 * Human relative time from an ISO timestamp. `null` or an unparseable value
 * yields "unknown"; a future timestamp (clock skew) reads "just now".
 */
export function formatRelativeTime(iso: string | null, nowMs: number): string {
  if (iso === null) return "unknown";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "unknown";

  const sec = Math.max(0, (nowMs - t) / 1000);
  if (sec < 45) return "just now";
  if (sec < 45 * MIN) return plural(Math.round(sec / MIN), "minute");
  if (sec < 22 * HOUR) return plural(Math.round(sec / HOUR), "hour");
  if (sec < 26 * DAY) return plural(Math.round(sec / DAY), "day");
  if (sec < 320 * DAY) return plural(Math.round(sec / MONTH), "month");
  return plural(Math.round(sec / YEAR), "year");
}

// Friendly names for known model ids; an unknown id is stripped of its "claude-"
// prefix and capped so a future id still renders legibly on the row.
const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-fable-5": "Fable 5",
};
const MODEL_MAX = 20;

export function formatModel(
  firstModel: string | null,
  distinctModelCount: number,
): string | null {
  if (firstModel === null) return null;
  let name = MODEL_NAMES[firstModel];
  if (!name) {
    const stripped = firstModel.replace(/^claude-/, "");
    name =
      stripped.length > MODEL_MAX
        ? stripped.slice(0, MODEL_MAX) + "…"
        : stripped;
  }
  return distinctModelCount > 1 ? `${name} +${distinctModelCount - 1}` : name;
}

export function formatTokens(n: number): string {
  let body: string;
  if (n >= 1_000_000) body = `${(n / 1_000_000).toFixed(1)}M`;
  else if (n >= 1_000) body = `${Math.floor(n / 1_000)}k`;
  else body = String(n);
  return `${body} tok`;
}

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

// Wall-clock span first..last, prefixed "span " and capped at >24h so a session
// reopened across days is not read as effort. Omitted (null) when there is no
// second timestamp to measure against.
export function formatSpan(
  firstActivity: string | null,
  lastActivity: string | null,
): string | null {
  if (!firstActivity || !lastActivity) return null;
  const a = Date.parse(firstActivity);
  const b = Date.parse(lastActivity);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const ms = b - a;
  if (ms <= 0) return null;
  if (ms >= DAY_MS) return "span >24h";
  if (ms < MIN_MS) return "span <1m";
  const mins = Math.round(ms / MIN_MS);
  // Rounding a span just under 24h (e.g. 23h59m45s) can push mins to 1440, which
  // would render "24h 0m"; treat that as the >24h cap so the boundary is airtight.
  if (mins >= 24 * 60) return "span >24h";
  if (mins >= 60) return `span ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `span ${mins}m`;
}

export function formatEdited(editedFileCount: number): string {
  return editedFileCount === 0 ? "read-only" : `${editedFileCount} edited`;
}

export function formatMessages(messageCount: number): string {
  return `${messageCount} msgs`;
}

// Ordered, ready-to-render segments: msgs · span · edited · model · tokens.
// span and model are dropped when null so the row never shows a dangling "·".
export function factSegments(facts: SessionFacts): string[] {
  const span = formatSpan(facts.firstActivity, facts.lastActivity);
  const model = formatModel(facts.firstModel, facts.distinctModelCount);
  return [
    formatMessages(facts.messageCount),
    ...(span ? [span] : []),
    formatEdited(facts.editedFileCount),
    ...(model ? [model] : []),
    formatTokens(facts.outputTokens),
  ];
}
