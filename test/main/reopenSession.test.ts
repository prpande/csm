import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reopenSession,
  buildPlainCmdArgs,
  buildWtWrappedArgs,
  assertNoCmdMetachars,
  cwdExists,
  UnsupportedOsError,
  FolderMissingError,
  UnsafePathError,
  SpawnFailedError,
  type ReopenRequest,
  type SpawnFn,
} from "../../src/reopenSession";
import { buildLaunchSpec } from "../../src/terminalLauncher";

// reopenSession is the IMPURE launcher: it validates (reusing the pure builder's
// assertLaunchInputs), stat's the cwd, and spawns a terminal — on Windows always
// through `cmd.exe /k`, optionally wrapped in `wt.exe new-tab` (try wt, fall back
// to plain cmd). The effectful seams (spawn, cwdExists) are injected so the
// decision/fallback logic is unit-tested with fakes on every OS; the real cmd
// re-parse is proven by the Windows-only integration block at the bottom.

const VALID_ID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";

function req(overrides: Partial<ReopenRequest> = {}): ReopenRequest {
  return {
    os: "win32",
    cwd: "C:\\work\\proj",
    sessionId: VALID_ID,
    mode: "default",
    claudePath: "claude",
    ...overrides,
  };
}

// A fake ChildProcess: emits its outcome asynchronously (after reopenSession has
// attached its once("spawn")/once("error") listeners), and records unref().
type Outcome = "spawn" | { errorCode: string };
function makeFakeChild(outcome: Outcome): EventEmitter & { unref: () => void } {
  const ee = new EventEmitter() as EventEmitter & { unref: () => void };
  ee.unref = vi.fn();
  queueMicrotask(() => {
    if (outcome === "spawn") {
      ee.emit("spawn");
    } else {
      const err = Object.assign(new Error("spawn failed"), {
        code: outcome.errorCode,
      });
      ee.emit("error", err);
    }
  });
  return ee;
}

type SpawnCall = {
  file: string;
  args: readonly string[];
  opts: Record<string, unknown>;
};

// Build an injected spawn that returns the given outcomes in call order and
// records every (file, args, opts) it was called with.
function fakeSpawn(outcomes: Outcome[]): {
  spawn: SpawnFn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  let i = 0;
  const spawn: SpawnFn = (file, args, opts) => {
    calls.push({ file, args, opts: opts as Record<string, unknown> });
    const outcome = outcomes[i] ?? "spawn";
    i += 1;
    return makeFakeChild(outcome);
  };
  return { spawn, calls };
}

const alwaysExists = () => Promise.resolve(true);

// ---------------------------------------------------------------------------
// Windows — happy path: wt present
// ---------------------------------------------------------------------------

test("win32: spawns wt.exe with the wt-wrapped argv and resolves", async () => {
  const { spawn, calls } = fakeSpawn(["spawn"]);
  await reopenSession(req(), { spawn, cwdExists: alwaysExists });

  expect(calls).toHaveLength(1);
  expect(calls[0].file).toBe("wt.exe");
  expect(calls[0].args).toEqual([
    "new-tab",
    "-d",
    "C:\\work\\proj",
    "cmd.exe",
    "/k",
    "claude",
    "--resume",
    VALID_ID,
    "--permission-mode",
    "default",
  ]);
  expect(calls[0].opts.shell).toBe(false);
  expect(calls[0].opts.detached).toBe(true);
  expect(calls[0].opts.stdio).toBe("ignore");
});

// ---------------------------------------------------------------------------
// Windows — fallback: wt absent → plain cmd.exe
// ---------------------------------------------------------------------------

test("win32: wt spawn error falls back to plain cmd.exe with cwd via option", async () => {
  const { spawn, calls } = fakeSpawn([{ errorCode: "ENOENT" }, "spawn"]);
  await reopenSession(req(), { spawn, cwdExists: alwaysExists });

  expect(calls).toHaveLength(2);
  expect(calls[0].file).toBe("wt.exe");
  expect(calls[1].file).toBe("cmd.exe");
  expect(calls[1].args).toEqual([
    "/k",
    "claude",
    "--resume",
    VALID_ID,
    "--permission-mode",
    "default",
  ]);
  // I2: cwd reaches cmd ONLY via the spawn option, never as an argv element.
  expect(calls[1].opts.cwd).toBe("C:\\work\\proj");
  expect(calls[1].args).not.toContain("C:\\work\\proj");
});

test("win32: any wt error (not just ENOENT) falls back to cmd", async () => {
  const { spawn, calls } = fakeSpawn([{ errorCode: "EACCES" }, "spawn"]);
  await reopenSession(req(), { spawn, cwdExists: alwaysExists });
  expect(calls.map((c) => c.file)).toEqual(["wt.exe", "cmd.exe"]);
});

test("win32: wt and cmd both fail → SpawnFailedError, no throw escapes", async () => {
  const { spawn, calls } = fakeSpawn([
    { errorCode: "ENOENT" },
    { errorCode: "ENOENT" },
  ]);
  await expect(
    reopenSession(req(), { spawn, cwdExists: alwaysExists }),
  ).rejects.toBeInstanceOf(SpawnFailedError);
  expect(calls).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// Windows — metacharacter gate (I4)
// ---------------------------------------------------------------------------

for (const meta of ["&", "|", "<", ">", "^", "%", "!", '"']) {
  test(`win32: cmd metacharacter ${JSON.stringify(meta)} in claudePath → UnsafePathError, no spawn`, async () => {
    const { spawn, calls } = fakeSpawn(["spawn"]);
    await expect(
      reopenSession(req({ claudePath: `C:\\a${meta}b\\claude.cmd` }), {
        spawn,
        cwdExists: alwaysExists,
      }),
    ).rejects.toBeInstanceOf(UnsafePathError);
    expect(calls).toHaveLength(0);
  });
}

test("win32: parentheses and spaces in claudePath are allowed (Program Files (x86))", async () => {
  const { spawn, calls } = fakeSpawn(["spawn"]);
  const claudePath = "C:\\Program Files (x86)\\Claude\\claude.cmd";
  await reopenSession(req({ claudePath }), { spawn, cwdExists: alwaysExists });
  expect(calls).toHaveLength(1);
  expect(calls[0].args).toContain(claudePath);
});

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

test("darwin: spawns osascript with buildLaunchSpec('darwin') argv", async () => {
  const { spawn, calls } = fakeSpawn(["spawn"]);
  const r = req({ os: "darwin", cwd: "/Users/x/proj", claudePath: "claude" });
  await reopenSession(r, { spawn, cwdExists: alwaysExists });

  const expected = buildLaunchSpec(
    "darwin",
    r.cwd,
    r.sessionId,
    r.mode,
    r.claudePath,
  );
  expect(calls).toHaveLength(1);
  expect(calls[0].file).toBe("osascript");
  expect(calls[0].args).toEqual(expected.args);
  expect(calls[0].opts.shell).toBe(false);
});

test("darwin: a newline in cwd is rejected before any spawn (osascript guard)", async () => {
  const { spawn, calls } = fakeSpawn(["spawn"]);
  await expect(
    reopenSession(req({ os: "darwin", cwd: "/Users/x/proj\nrm -rf ~" }), {
      spawn,
      cwdExists: alwaysExists,
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Cross-cutting: cwd existence, unsupported OS, validation, default deps
// ---------------------------------------------------------------------------

test("cwd missing → FolderMissingError, spawn never called (I3)", async () => {
  const { spawn, calls } = fakeSpawn(["spawn"]);
  await expect(
    reopenSession(req(), { spawn, cwdExists: () => Promise.resolve(false) }),
  ).rejects.toBeInstanceOf(FolderMissingError);
  expect(calls).toHaveLength(0);
});

test("unsupported os → UnsupportedOsError, spawn never called", async () => {
  const { spawn, calls } = fakeSpawn(["spawn"]);
  await expect(
    reopenSession(req({ os: "linux" as ReopenRequest["os"] }), {
      spawn,
      cwdExists: alwaysExists,
    }),
  ).rejects.toBeInstanceOf(UnsupportedOsError);
  expect(calls).toHaveLength(0);
});

test("invalid sessionId (non-UUID) is rejected before spawn", async () => {
  const { spawn, calls } = fakeSpawn(["spawn"]);
  await expect(
    reopenSession(req({ sessionId: "not-a-uuid" }), {
      spawn,
      cwdExists: alwaysExists,
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});

test("default deps are wired: a missing cwd rejects FolderMissingError without spawning", async () => {
  // Exercises realDeps.cwdExists (real fs) against a guaranteed-absent path,
  // proving the default deps object is wired without launching a terminal.
  const ghost = join(tmpdir(), "csm-does-not-exist-3b9f1c2a", "nope");
  await expect(
    reopenSession(
      req({ os: process.platform as ReopenRequest["os"], cwd: ghost }),
    ),
  ).rejects.toBeInstanceOf(FolderMissingError);
});

// ---------------------------------------------------------------------------
// Pure helpers (used by the integration block and by callers)
// ---------------------------------------------------------------------------

test("buildPlainCmdArgs / buildWtWrappedArgs shapes", () => {
  expect(buildPlainCmdArgs(VALID_ID, "plan", "claude")).toEqual([
    "/k",
    "claude",
    "--resume",
    VALID_ID,
    "--permission-mode",
    "plan",
  ]);
  expect(buildWtWrappedArgs("C:\\w", VALID_ID, "plan", "claude")).toEqual([
    "new-tab",
    "-d",
    "C:\\w",
    "cmd.exe",
    "/k",
    "claude",
    "--resume",
    VALID_ID,
    "--permission-mode",
    "plan",
  ]);
});

test("assertNoCmdMetachars throws UnsafePathError only on metacharacters", () => {
  expect(() =>
    assertNoCmdMetachars("C:\\Program Files (x86)\\claude.cmd"),
  ).not.toThrow();
  for (const m of ["&", "|", "<", ">", "^", "%", "!", '"']) {
    expect(() => assertNoCmdMetachars(`x${m}y`)).toThrow(UnsafePathError);
  }
});

// ---------------------------------------------------------------------------
// cwdExists (real fs) — dir vs file vs missing
// ---------------------------------------------------------------------------

let fixRoot: string;
beforeEach(() => {
  fixRoot = mkdtempSync(join(tmpdir(), "csm-reopen-"));
});
afterEach(() => {
  rmSync(fixRoot, { recursive: true, force: true });
});

test("cwdExists: true for a directory, false for a file, false for missing", async () => {
  const dir = join(fixRoot, "adir");
  mkdirSync(dir);
  const file = join(fixRoot, "afile.txt");
  writeFileSync(file, "x");
  expect(await cwdExists(dir)).toBe(true);
  expect(await cwdExists(file)).toBe(false);
  expect(await cwdExists(join(fixRoot, "missing"))).toBe(false);
});

// ---------------------------------------------------------------------------
// Integration — Windows only: real cmd.exe re-parse of the plain-cmd argv.
// Proves I5 (spaced/paren paths quote safely; the gate blocks a real payload).
// Runs cmd with the production /k argv against a SELF-EXITING stand-in .cmd so
// spawnSync does not hang, non-detached so output/marker is observable.
// ---------------------------------------------------------------------------

const winTest = process.platform === "win32" ? test : test.skip;

// Stand-in that writes its args next to itself then exits cmd (so /k returns).
const STANDIN = '@echo off\r\n> "%~dp0marker.txt" echo %*\r\nexit\r\n';

function runCmdReparse(standinDir: string): {
  marker: string;
  injected: boolean;
} {
  mkdirSync(standinDir, { recursive: true });
  const standin = join(standinDir, "stand in.cmd");
  writeFileSync(standin, STANDIN);
  const args = buildPlainCmdArgs(VALID_ID, "default", standin);
  spawnSync("cmd.exe", args as string[], {
    cwd: standinDir,
    shell: false,
    windowsHide: true,
  });
  const markerPath = join(standinDir, "marker.txt");
  const marker = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : "";
  return { marker, injected: existsSync(join(standinDir, "inject.txt")) };
}

winTest(
  "integration: spaced stand-in path launches and passes --resume intact",
  () => {
    const { marker, injected } = runCmdReparse(join(fixRoot, "plain"));
    expect(marker).toContain("--resume");
    expect(marker).toContain(VALID_ID);
    expect(injected).toBe(false);
  },
);

winTest("integration: a (x86)-style path launches with no injection", () => {
  const { marker, injected } = runCmdReparse(join(fixRoot, "dir (x86)"));
  expect(marker).toContain("--resume");
  expect(injected).toBe(false);
});

winTest(
  "integration: the metachar gate blocks a payload cmd WOULD otherwise execute",
  () => {
    // 1. The gate rejects the injection payload before any spawn.
    expect(() => assertNoCmdMetachars(`claude & echo PWNED`)).toThrow(
      UnsafePathError,
    );

    // 2. Non-vacuousness: an unescaped `&` reaching cmd.exe really does separate
    //    commands (runs a SECOND one) — exactly what the gate prevents when `&`
    //    hides in claudePath. Path-independent so no quoting subtlety intrudes.
    const out = spawnSync(
      "cmd.exe",
      ["/c", "echo", "first", "&", "echo", "SECOND"],
      {
        shell: false,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    expect(out.stdout).toContain("SECOND");
  },
);
