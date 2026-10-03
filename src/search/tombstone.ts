// A time floor rather than a pass count: two passes can run seconds apart at launch.
export const MISSING_GRACE_MS = 60_000;

export type ParentState = "readable" | "missing" | "error";
export type Presence = "present" | "absent";

export interface TombstoneState {
  missingSince: number | null;
  deletedAt: number | null;
}

export function presence(
  statErrorCode: string | undefined,
  parent: ParentState,
): Presence {
  if (statErrorCode === undefined) return "present";
  return statErrorCode === "ENOENT" && parent !== "error"
    ? "absent"
    : "present";
}

export function nextTombstone(
  prev: TombstoneState,
  p: Presence,
  now: number,
): TombstoneState {
  if (p === "present") return { missingSince: null, deletedAt: null };
  if (prev.deletedAt !== null) return prev;
  if (prev.missingSince === null) return { missingSince: now, deletedAt: null };
  return now - prev.missingSince >= MISSING_GRACE_MS
    ? { missingSince: prev.missingSince, deletedAt: now }
    : prev;
}
