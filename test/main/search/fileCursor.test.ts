// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  anchorSpan,
  classifyFile,
  decideAppend,
  headSpan,
  verifySpans,
  type CursorState,
} from "../../../src/search/fileCursor";

const row = (over: Partial<CursorState> = {}): CursorState => ({
  offset: 1000,
  headLen: 1000,
  headHash: "H",
  anchorHash: "A",
  extractVersion: 1,
  ...over,
});

describe("classifyFile", () => {
  test("no row is new", () => {
    expect(classifyFile(undefined, 10, 1)).toEqual({ kind: "new" });
  });
  test("same size as offset is unchanged", () => {
    expect(classifyFile(row(), 1000, 1)).toEqual({ kind: "unchanged" });
  });
  test("bigger needs verification", () => {
    expect(classifyFile(row(), 1500, 1)).toEqual({ kind: "verify" });
  });
  test("smaller is a truncation rewrite", () => {
    expect(classifyFile(row(), 900, 1)).toEqual({
      kind: "rewrite",
      reason: "truncated",
    });
  });
  test("an older extract version is stale even when unchanged", () => {
    expect(classifyFile(row({ extractVersion: 0 }), 1000, 1)).toEqual({
      kind: "rewrite",
      reason: "stale",
    });
  });
});

describe("spans", () => {
  test("head covers at most 4096 bytes, anchor at most 256 ending at offset", () => {
    expect(headSpan(100)).toEqual({ start: 0, length: 100 });
    expect(headSpan(10_000)).toEqual({ start: 0, length: 4096 });
    expect(anchorSpan(100)).toEqual({ start: 0, length: 100 });
    expect(anchorSpan(10_000)).toEqual({ start: 9744, length: 256 });
  });

  test("a file ingested below 4096 bytes is verified over its stored head length", () => {
    expect(verifySpans(row({ offset: 3000, headLen: 3000 }))).toEqual({
      head: { start: 0, length: 3000 },
      anchor: { start: 2744, length: 256 },
    });
  });
});

describe("decideAppend", () => {
  test("both hashes equal is an append", () => {
    expect(decideAppend(row(), "H", "A")).toBe("appended");
  });
  test("a changed head is a rewrite", () => {
    expect(decideAppend(row(), "X", "A")).toBe("rewritten");
  });
  test("a changed middle (anchor) is a rewrite", () => {
    expect(decideAppend(row(), "H", "X")).toBe("rewritten");
  });
  test("a row without stored hashes is a rewrite", () => {
    expect(decideAppend(row({ headHash: null }), "H", "A")).toBe("rewritten");
  });
});
