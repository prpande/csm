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
    // The `string[]` annotation is the real assertion and `tsc` is what enforces
    // it (vitest erases types) — pathAdapter.tempRoots relies on this narrowing
    // to drop its hand-written `(r): r is string` annotation. tsconfig.node.json
    // includes test/main, and CI typechecks separately from the test run.
    const raw: (string | undefined)[] = ["a", undefined, "", "  ", "b"];
    const out: string[] = raw.filter(isNonEmptyString);
    expect(out).toEqual(["a", "b"]);
  });
});
