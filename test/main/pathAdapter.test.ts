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
// (#69/#113) — so this list IS the filter's input, and a wrong entry either hides
// real sessions or leaks temp ones.
//
// These assert `tempRoots` DIRECTLY. Until #114 its per-OS matrix was only
// covered transitively, through the `isTempPath` tests that were deleted with the
// predicate; every consumer test (ipc, FolderBrowser) mocks it. The options bag
// is platform-injected so both matrices are provable on any runner — a Windows
// case must pass on a Linux host.

describe("tempRoots — win32", () => {
  const WIN = (tmpdir: string, env: NodeJS.ProcessEnv = {}) =>
    ({ platform: "win32", tmpdir, env }) as const;

  test("includes the injected tmpdir", () => {
    const t = "C:\\Users\\me\\AppData\\Local\\Temp";
    expect(tempRoots(WIN(t))).toContain(t);
  });

  test("includes %TEMP% and %TMP%", () => {
    const roots = tempRoots(WIN("", { TEMP: "D:\\t", TMP: "D:\\u" }));
    expect(roots).toContain("D:\\t");
    expect(roots).toContain("D:\\u");
  });

  test("derives %LOCALAPPDATA%\\Temp", () => {
    const roots = tempRoots(
      WIN("", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }),
    );
    expect(roots).toContain("C:\\Users\\me\\AppData\\Local\\Temp");
  });

  test("always includes C:\\Windows\\Temp, with no env at all", () => {
    expect(tempRoots(WIN(""))).toContain("C:\\Windows\\Temp");
  });

  test("drops blank and unset entries", () => {
    // Load-bearing: the renderer prefix-matches these, and "" is a prefix of
    // EVERY path — one blank root would hide the entire tree. A whitespace-only
    // tmpdir must be dropped too, not merely an empty one.
    expect(tempRoots(WIN("   ", { TEMP: "", TMP: "  " }))).toEqual([
      "C:\\Windows\\Temp",
    ]);
  });

  test("omits the LOCALAPPDATA-derived root when LOCALAPPDATA is unset", () => {
    expect(tempRoots(WIN("", {}))).toEqual(["C:\\Windows\\Temp"]);
  });
});

describe("tempRoots — posix", () => {
  const POSIX = (tmpdir: string, env: NodeJS.ProcessEnv = {}) =>
    ({ platform: "darwin", tmpdir, env }) as const;

  test("includes the injected tmpdir and $TMPDIR", () => {
    const roots = tempRoots(
      POSIX("/var/folders/ab/xyz/T", { TMPDIR: "/custom/tmp" }),
    );
    expect(roots).toContain("/var/folders/ab/xyz/T");
    expect(roots).toContain("/custom/tmp");
  });

  test("always includes the standard roots, including the macOS /private forms", () => {
    // /private/tmp and /private/var/folders are macOS's canonical symlink
    // targets — a session's cwd can surface either form.
    const roots = tempRoots(POSIX(""));
    for (const r of [
      "/tmp",
      "/private/tmp",
      "/var/folders",
      "/private/var/folders",
    ]) {
      expect(roots).toContain(r);
    }
  });

  test("drops blank and unset entries", () => {
    expect(tempRoots(POSIX("  ", { TMPDIR: "" }))).toEqual([
      "/tmp",
      "/private/tmp",
      "/var/folders",
      "/private/var/folders",
    ]);
  });

  test("never emits Windows roots", () => {
    expect(tempRoots(POSIX(""))).not.toContain("C:\\Windows\\Temp");
  });
});
