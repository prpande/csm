import { describe, it, expect } from "vitest";
import { isRecord, isNonEmptyString } from "../../src/typeGuards";

// The shared guards (#61) replace four inline copies across sessionParser,
// sessionIndex, settingsStore, and pathAdapter. Every input below is one the
// real callers actually see: JSON.parse output (any type, including null and
// arrays) and hand-edited settings values.

describe("isRecord", () => {
  it("accepts a plain object", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects null — typeof null is 'object', the whole reason this guard exists", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("rejects an array — a top-level JSON array line is not a record", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
  });

  it("rejects primitives", () => {
    for (const v of ["s", 1, 0, true, false, undefined]) {
      expect(isRecord(v)).toBe(false);
    }
  });

  it("accepts objects from other realms of the object family", () => {
    // Not arrays and not null, so they pass — callers only ever property-read
    // the result, which is safe on any of these.
    expect(isRecord(Object.create(null) as unknown)).toBe(true);
    expect(isRecord(new Date())).toBe(true);
  });

  it("narrows to a property-readable type", () => {
    const v: unknown = { claudePath: "x" };
    if (!isRecord(v)) throw new Error("expected a record");
    expect(v.claudePath).toBe("x"); // compiles only if narrowed
  });
});

describe("isNonEmptyString", () => {
  it("accepts a string with content", () => {
    expect(isNonEmptyString("claude")).toBe(true);
    expect(isNonEmptyString("  padded  ")).toBe(true); // blank-ness, not padding
  });

  it("rejects empty and whitespace-only strings", () => {
    for (const v of ["", " ", "   ", "\t", "\n", " \t\n "]) {
      expect(isNonEmptyString(v)).toBe(false);
    }
  });

  it("rejects non-strings", () => {
    for (const v of [undefined, null, 0, 1, true, false, {}, [], ["s"]]) {
      expect(isNonEmptyString(v)).toBe(false);
    }
  });

  it("narrows an optional-string array to string[] under filter", () => {
    const raw: (string | undefined)[] = ["a", undefined, "", "  ", "b"];
    const out: string[] = raw.filter(isNonEmptyString); // compiles only if it narrows
    expect(out).toEqual(["a", "b"]);
  });

  it("does NOT trim — the predicate tests blankness, callers own the value", () => {
    // Load-bearing: settingsStore trims its return (the value reaches spawn),
    // sessionParser does not (it is rendered as-is). A guard that returned a
    // trimmed value would silently change parser output.
    const v: unknown = "  claude  ";
    expect(isNonEmptyString(v) ? v : undefined).toBe("  claude  ");
  });
});
