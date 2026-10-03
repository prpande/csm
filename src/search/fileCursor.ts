export const HEAD_MAX = 4096;
export const ANCHOR_MAX = 256;

export interface CursorState {
  offset: number;
  headLen: number;
  headHash: string | null;
  anchorHash: string | null;
  extractVersion: number;
}

export type FilePlan =
  | { kind: "new" }
  | { kind: "unchanged" }
  | { kind: "verify" }
  | { kind: "rewrite"; reason: "stale" | "truncated" };

export interface Span {
  start: number;
  length: number;
}

export function classifyFile(
  row: CursorState | undefined,
  size: number,
  extractVersion: number,
): FilePlan {
  if (!row) return { kind: "new" };
  if (row.extractVersion !== extractVersion)
    return { kind: "rewrite", reason: "stale" };
  if (size < row.offset) return { kind: "rewrite", reason: "truncated" };
  if (size === row.offset) return { kind: "unchanged" };
  return { kind: "verify" };
}

export function headSpan(offset: number): Span {
  return { start: 0, length: Math.min(offset, HEAD_MAX) };
}

export function anchorSpan(offset: number): Span {
  const length = Math.min(offset, ANCHOR_MAX);
  return { start: offset - length, length };
}

// The head is re-hashed over the STORED length: a file ingested at 3000 bytes that
// has since grown past 4096 must compare its first 3000 bytes, not 4096.
export function verifySpans(row: CursorState): { head: Span; anchor: Span } {
  return {
    head: { start: 0, length: row.headLen },
    anchor: anchorSpan(row.offset),
  };
}

export function decideAppend(
  row: CursorState,
  headHashNow: string,
  anchorHashNow: string,
): "appended" | "rewritten" {
  return row.headHash !== null &&
    row.anchorHash !== null &&
    headHashNow === row.headHash &&
    anchorHashNow === row.anchorHash
    ? "appended"
    : "rewritten";
}
