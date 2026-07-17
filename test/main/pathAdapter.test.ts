import { test, expect, describe } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectsRoot, tempRoots } from "../../src/pathAdapter";

// pathAdapter is the OS seam that resolves the Claude projects root that
// sessionStore scans. `home` is injectable so per-OS resolution is asserted
// deterministically without mocking `os`; pure resolution (no fs) means these
// run without a fixture dir. `join` uses the platform separator, so case 1 is
// itself the per-OS assertion.

test("resolves <home>/.claude/projects under the injected home", () => {
  const home = join(tmpdir(), "csm-fake-home");
  expect(defaultProjectsRoot(home)).toBe(join(home, ".claude", "projects"));
});

test("defaults to os.homedir() when no home is given", () => {
  expect(defaultProjectsRoot()).toBe(join(homedir(), ".claude", "projects"));
});

test("is pure resolution — does not verify the home exists (no I/O)", () => {
  // Guards the intentional contract: a missing root is sessionStore's concern,
  // not this unit's — resolution must never stat/throw.
  const missing = join(tmpdir(), "csm-does-not-exist-xyz");
  expect(() => defaultProjectsRoot(missing)).not.toThrow();
});

// tempRoots discovers the system temp roots for the §10 hide filter. main ships
// them over `paths:getTempRoots` and the renderer prefix-matches against them
// (#69/#113) — so this list IS the filter's input.
//
// These assert `tempRoots` DIRECTLY. Until #114 its per-OS matrix was only
// covered transitively, through the `isTempPath` tests that were deleted with the
// predicate; every consumer test (ipc, FolderBrowser) mocks it. The options bag
// is platform-injected so both matrices are provable on any runner — a Windows
// case must pass on a Linux host.
//
// Every case asserts the EXACT list, never just `toContain`. The output is an
// exhaustive prefix-match allowlist, so a WRONG root is as harmful as a missing
// one and only exact assertions catch it: emitting `%LOCALAPPDATA%` alongside
// `%LOCALAPPDATA%\Temp`, for instance, would hide every session under
// AppData\Local. Presence-only assertions pass that mutation happily.

describe("tempRoots — win32", () => {
  const WIN = (tmpdir: string, env: NodeJS.ProcessEnv = {}) =>
    ({ platform: "win32", tmpdir, env }) as const;
  // Always a root on Windows, with or without env — the tail of every case.
  const WINDOWS_TEMP = "C:\\Windows\\Temp";

  test("the injected tmpdir, and nothing else invented", () => {
    const t = "C:\\Users\\me\\AppData\\Local\\Temp";
    expect(tempRoots(WIN(t))).toEqual([t, WINDOWS_TEMP]);
  });

  test("%TEMP% and %TMP%, both honored", () => {
    expect(tempRoots(WIN("", { TEMP: "D:\\t", TMP: "D:\\u" }))).toEqual([
      "D:\\t",
      "D:\\u",
      WINDOWS_TEMP,
    ]);
  });

  test("derives %LOCALAPPDATA%\\Temp — the Temp subdir only, not the parent", () => {
    // Exact: emitting the bare %LOCALAPPDATA% here would silently hide every
    // session under AppData\Local, since these are matched as path prefixes.
    expect(
      tempRoots(WIN("", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })),
    ).toEqual(["C:\\Users\\me\\AppData\\Local\\Temp", WINDOWS_TEMP]);
  });

  test("C:\\Windows\\Temp is always a root, with no tmpdir and no env at all", () => {
    expect(tempRoots(WIN(""))).toEqual([WINDOWS_TEMP]);
  });

  test("drops blank and unset entries", () => {
    // Load-bearing: "" is a prefix of EVERY path, so a single blank root would
    // hide the entire tree. Whitespace-only must drop too, not merely empty —
    // this is what fails if the filter degrades to a truthiness check.
    expect(tempRoots(WIN("   ", { TEMP: "", TMP: "  " }))).toEqual([
      WINDOWS_TEMP,
    ]);
  });

  test("omits the LOCALAPPDATA-derived root when LOCALAPPDATA is unset", () => {
    expect(tempRoots(WIN("", {}))).toEqual([WINDOWS_TEMP]);
  });

  test("full env: every source contributes, in order, with no duplicates or extras", () => {
    expect(
      tempRoots(
        WIN("C:\\tmpdir", {
          TEMP: "D:\\t",
          TMP: "D:\\u",
          LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        }),
      ),
    ).toEqual([
      "C:\\tmpdir",
      "D:\\t",
      "D:\\u",
      "C:\\Users\\me\\AppData\\Local\\Temp",
      WINDOWS_TEMP,
    ]);
  });
});

describe("tempRoots — posix", () => {
  const POSIX = (tmpdir: string, env: NodeJS.ProcessEnv = {}) =>
    ({ platform: "darwin", tmpdir, env }) as const;
  // /private/tmp and /private/var/folders are macOS's canonical symlink targets
  // — a session's cwd can surface either form, so both are always roots.
  const STANDARD = [
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
  ];

  test("the injected tmpdir and $TMPDIR, ahead of the standard roots", () => {
    expect(
      tempRoots(POSIX("/var/folders/ab/xyz/T", { TMPDIR: "/custom/tmp" })),
    ).toEqual(["/var/folders/ab/xyz/T", "/custom/tmp", ...STANDARD]);
  });

  test("the standard roots are always present, with no tmpdir and no env", () => {
    expect(tempRoots(POSIX(""))).toEqual(STANDARD);
  });

  test("drops blank and unset entries", () => {
    expect(tempRoots(POSIX("  ", { TMPDIR: "" }))).toEqual(STANDARD);
  });

  test("never emits Windows roots", () => {
    expect(tempRoots(POSIX(""))).not.toContain("C:\\Windows\\Temp");
  });
});
