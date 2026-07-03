import { test, expect, describe } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProjectsRoot,
  isTempPath,
  isWorktreePath,
} from "../../src/pathAdapter";

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

// isTempPath / isWorktreePath classify a session's cwd for the §10 hide filter.
// They take a platform-injected options bag so BOTH per-OS matrices are provable
// on any runner (a Windows temp-root case must pass on a Linux host) — the real
// caller lets platform/tmpdir/env default to the host. Pure: string/path logic
// only, no I/O.

describe("isTempPath — win32", () => {
  // env empty so injected tmpdir / the always-on C:\Windows\Temp are the roots.
  const WIN = (tmpdir: string, env: NodeJS.ProcessEnv = {}) =>
    ({ platform: "win32", tmpdir, env }) as const;

  test("true under the injected tmpdir", () => {
    const t = "C:\\Users\\me\\AppData\\Local\\Temp";
    expect(isTempPath(`${t}\\claude-xyz\\proj`, WIN(t))).toBe(true);
  });

  test("true when cwd equals the temp root itself", () => {
    const t = "C:\\Users\\me\\AppData\\Local\\Temp";
    expect(isTempPath(t, WIN(t))).toBe(true);
  });

  test("true under %LOCALAPPDATA%\\Temp (derived root)", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    expect(
      isTempPath("C:\\Users\\me\\AppData\\Local\\Temp\\foo", WIN("", env)),
    ).toBe(true);
  });

  test("true under %TEMP% and %TMP%", () => {
    expect(isTempPath("D:\\t\\x", WIN("", { TEMP: "D:\\t" }))).toBe(true);
    expect(isTempPath("D:\\u\\x", WIN("", { TMP: "D:\\u" }))).toBe(true);
  });

  test("true under the always-on C:\\Windows\\Temp", () => {
    expect(isTempPath("C:\\Windows\\Temp\\svc\\proj", WIN(""))).toBe(true);
  });

  test("case-insensitive match (Windows paths fold case)", () => {
    const t = "C:\\Users\\me\\AppData\\Local\\Temp";
    expect(isTempPath("C:\\USERS\\ME\\APPDATA\\LOCAL\\TEMP\\x", WIN(t))).toBe(
      true,
    );
  });

  test("false for a normal project path", () => {
    const t = "C:\\Users\\me\\AppData\\Local\\Temp";
    expect(isTempPath("C:\\Users\\me\\project", WIN(t))).toBe(false);
  });

  test("boundary: C:\\Tempfoo is not under C:\\Temp", () => {
    expect(isTempPath("C:\\Tempfoo\\x", WIN("C:\\Temp"))).toBe(false);
  });

  test("blank/unset roots never match everything", () => {
    // tmpdir '' + empty env → only C:\Windows\Temp is a real root; an unrelated
    // path must stay false (a blank root string prefix-matches all paths).
    expect(isTempPath("C:\\Users\\me\\project", WIN("", {}))).toBe(false);
  });
});

describe("isTempPath — posix", () => {
  const POSIX = (tmpdir: string, env: NodeJS.ProcessEnv = {}) =>
    ({ platform: "darwin", tmpdir, env }) as const;

  test("true under the injected tmpdir", () => {
    const t = "/var/folders/ab/xyz/T";
    expect(isTempPath(`${t}/proj`, POSIX(t))).toBe(true);
  });

  test("true under the always-on /tmp and /private/tmp", () => {
    expect(isTempPath("/tmp/proj", POSIX(""))).toBe(true);
    expect(isTempPath("/private/tmp/proj", POSIX(""))).toBe(true);
  });

  test("true under /var/folders and /private/var/folders", () => {
    expect(isTempPath("/var/folders/ab/xyz/T/p", POSIX(""))).toBe(true);
    expect(isTempPath("/private/var/folders/ab/xyz/T/p", POSIX(""))).toBe(true);
  });

  test("true under $TMPDIR", () => {
    expect(
      isTempPath("/custom/tmp/x", POSIX("", { TMPDIR: "/custom/tmp" })),
    ).toBe(true);
  });

  test("true when cwd equals the temp root itself", () => {
    expect(isTempPath("/tmp", POSIX(""))).toBe(true);
  });

  test("false for a normal project path", () => {
    expect(isTempPath("/home/me/proj", POSIX(""))).toBe(false);
  });

  test("boundary: /tmpfoo is not under /tmp", () => {
    expect(isTempPath("/tmpfoo/x", POSIX(""))).toBe(false);
  });

  test("case-sensitive: /TMP is not /tmp on posix", () => {
    expect(isTempPath("/TMP/x", POSIX(""))).toBe(false);
  });
});

describe("isWorktreePath", () => {
  test("posix: true inside .claude/worktrees/<name> and deeper", () => {
    const o = { platform: "darwin" } as const;
    expect(isWorktreePath("/home/me/csm/.claude/worktrees/49-foo", o)).toBe(
      true,
    );
    expect(
      isWorktreePath("/home/me/csm/.claude/worktrees/49-foo/src/x", o),
    ).toBe(true);
  });

  test("win32: true inside .claude\\worktrees\\<name>", () => {
    expect(
      isWorktreePath("C:\\src\\csm\\.claude\\worktrees\\49-foo", {
        platform: "win32",
      }),
    ).toBe(true);
  });

  test("false for .claude/projects (sibling, not worktrees)", () => {
    expect(
      isWorktreePath("/home/me/csm/.claude/projects/enc/x", {
        platform: "darwin",
      }),
    ).toBe(false);
  });

  test("false for a 'worktrees' dir not under .claude", () => {
    expect(isWorktreePath("/home/me/worktrees/x", { platform: "darwin" })).toBe(
      false,
    );
  });

  test("false when nothing follows .claude/worktrees (no worktree dir)", () => {
    expect(
      isWorktreePath("/home/me/csm/.claude/worktrees", { platform: "darwin" }),
    ).toBe(false);
  });
});
