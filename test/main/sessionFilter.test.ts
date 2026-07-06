import { test, expect, describe } from "vitest";
import {
  isUnderAnyRoot,
  filterOutTemp,
} from "../../src/sessionFilter";
import type { SessionMetadata } from "../../src/sessionParser";

// Pure temp-root prefix matcher (#69) — no os/node:path, so it runs in the node
// tsconfig with plain strings. The real caller feeds main-resolved temp roots.

const WIN_TEMP = "C:\\Users\\p\\AppData\\Local\\Temp";

describe("isUnderAnyRoot", () => {
  test("matches a cwd under a Windows temp root, case-insensitively", () => {
    expect(isUnderAnyRoot("C:\\Users\\p\\AppData\\Local\\Temp\\abc", [WIN_TEMP])).toBe(true);
    // Case folds on Windows.
    expect(isUnderAnyRoot("c:\\users\\P\\appdata\\local\\temp\\abc", [WIN_TEMP])).toBe(true);
  });

  test("matches the root exactly, and tolerates a trailing separator on the root", () => {
    expect(isUnderAnyRoot(WIN_TEMP, [WIN_TEMP])).toBe(true);
    expect(isUnderAnyRoot("C:\\x\\Temp\\s", ["C:\\x\\Temp\\"])).toBe(true);
  });

  test("does not match a shared-prefix sibling (path-boundary check)", () => {
    // /tmpfoo must NOT count as under /tmp.
    expect(isUnderAnyRoot("/tmpfoo/x", ["/tmp"])).toBe(false);
    expect(isUnderAnyRoot("C:\\Temp2\\x", ["C:\\Temp"])).toBe(false);
  });

  test("matches POSIX roots exactly at the boundary", () => {
    expect(isUnderAnyRoot("/var/folders/xy/session", ["/var/folders"])).toBe(true);
    expect(isUnderAnyRoot("/home/me/proj", ["/tmp", "/var/folders"])).toBe(false);
  });

  test("empty roots never match", () => {
    expect(isUnderAnyRoot(WIN_TEMP, [])).toBe(false);
  });
});

describe("filterOutTemp", () => {
  const s = (id: string, cwd: string): SessionMetadata => ({
    sessionId: id,
    cwd,
    title: id,
    permissionMode: "default",
    lastActivity: null,
    gitBranch: null,
  });

  test("drops temp-rooted sessions, keeps the rest", () => {
    const sessions = [
      s("keep", "D:\\src\\csm"),
      s("temp", WIN_TEMP + "\\junk"),
    ];
    expect(filterOutTemp(sessions, [WIN_TEMP]).map((x) => x.sessionId)).toEqual([
      "keep",
    ]);
  });

  test("empty roots is a no-op (returns a copy, nothing hidden)", () => {
    const sessions = [s("a", WIN_TEMP), s("b", "D:\\x")];
    const out = filterOutTemp(sessions, []);
    expect(out.map((x) => x.sessionId)).toEqual(["a", "b"]);
    expect(out).not.toBe(sessions); // a fresh array
  });
});
