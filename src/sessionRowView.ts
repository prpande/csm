// Pure presentational helpers for a session row (spec §9). No DOM — unit-tested
// in test/main. The row component is a thin shell over these.

/** Risk-coded chip variants (spec §9). Any unrecognized/absent mode is `default`
 *  so the row never crashes on an unexpected value (AC 3). */
export type ChipVariant = "bypass" | "info" | "plan" | "default";

const CHIP_VARIANTS: Record<string, ChipVariant> = {
  bypassPermissions: "bypass",
  acceptEdits: "info",
  auto: "info",
  plan: "plan",
  default: "default",
};

export function chipVariant(mode: string): ChipVariant {
  return CHIP_VARIANTS[mode] ?? "default";
}

/** The first 8 chars of the session id (spec §9). */
export function shortSessionId(id: string): string {
  return id.slice(0, 8);
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
