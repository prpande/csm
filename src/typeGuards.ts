// Shared runtime type guards for untrusted input (#61). Every consumer here
// narrows a value that came from outside the program — `JSON.parse` output (any
// type, including `null` and arrays) or a hand-edited settings.json — so the
// guards must be total, not optimistic. Pure: no imports, no I/O, no DOM and no
// node runtime deps, so this is importable from the main process AND the
// DOM-only renderer.
//
// Extracted at the rule-of-three threshold: `isRecord` had drifted into four
// byte-identical copies (sessionParser, sessionIndex, settingsStore) and the
// non-blank-string test into three (sessionParser, settingsStore, pathAdapter).

/**
 * True for a plain property-readable object.
 *
 * Excludes `null` (whose `typeof` is `"object"` — the reason this guard exists
 * at all) and arrays (a top-level JSON array is not a record: every named-field
 * read against it would be `undefined`, so callers drop it rather than accept a
 * shape whose fields all silently vanish).
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * True for a string with at least one non-whitespace character.
 *
 * Tests blankness only — it deliberately does NOT trim, because callers disagree
 * on the value and both are right: `settingsStore.getClaudePath` returns the
 * value trimmed (it reaches `spawn` as the `file` argument, where stray
 * whitespace fails to resolve), while `sessionParser` returns it verbatim (it is
 * session metadata, rendered as-is). Narrowing the predicate out of the value
 * handling is what lets one guard serve both.
 *
 * Typed as a guard rather than a boolean so `arr.filter(isNonEmptyString)`
 * narrows `(string | undefined)[]` to `string[]`.
 */
export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}
