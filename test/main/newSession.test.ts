import { test, expect, describe, vi } from "vitest";
import {
  InvalidArgsError,
  buildNewSessionCmdArgs,
  launchNewSession,
  openTerminalHere,
} from "../../src/newSession";
import type { SpawnedChild, SpawnFn } from "../../src/reopenSession";

// newSession.ts is the impure #165 launcher: it shares reopenSession's spawn
// machinery (wt→cmd fallback, hang guard, typed errors) and adds the free-form
// argument pipeline — tokenize, then on Windows gate every token by charset
// (cmd.exe /k re-parses; escaping is not an option). Both effectful seams are
// injected, so these tests spawn nothing real.

const CWD = "C:\\work\\proj";
const CLAUDE = "claude";

function okChild(): SpawnedChild {
  const child: SpawnedChild = {
    once(event, cb) {
      if (event === "spawn") queueMicrotask(() => cb(undefined));
      return child;
    },
    unref() {},
  };
  return child;
}

function errChild(err: Error): SpawnedChild {
  const child: SpawnedChild = {
    once(event, cb) {
      if (event === "error") queueMicrotask(() => cb(err));
      return child;
    },
    unref() {},
    kill() {},
  };
  return child;
}

interface Recorded {
  file: string;
  args: readonly string[];
  cwd: unknown;
}

/** A spawn that succeeds for every file except those listed in `failing`. */
function fakeSpawn(failing: string[] = []) {
  const calls: Recorded[] = [];
  const spawn: SpawnFn = (file, args, opts) => {
    calls.push({ file, args, cwd: opts.cwd });
    return failing.includes(file)
      ? errChild(new Error(`ENOENT: ${file}`))
      : okChild();
  };
  return { spawn, calls };
}

const exists = vi.fn(async () => true);
const missing = vi.fn(async () => false);

describe("launchNewSession — win32", () => {
  const REQ = {
    os: "win32" as const,
    cwd: CWD,
    mode: "plan",
    rawArgs: "--model opus",
    claudePath: CLAUDE,
  };

  test("launches wt.exe wrapping cmd.exe /k with mode + extra tokens", async () => {
    const { spawn, calls } = fakeSpawn();
    await launchNewSession(REQ, { spawn, cwdExists: exists });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file: "wt.exe",
      args: [
        "new-tab",
        "-d",
        CWD,
        "cmd.exe",
        "/k",
        CLAUDE,
        "--permission-mode",
        "plan",
        "--model",
        "opus",
      ],
      cwd: CWD,
    });
  });

  test("falls back to a plain cmd.exe window when wt fails", async () => {
    const { spawn, calls } = fakeSpawn(["wt.exe"]);
    await launchNewSession(REQ, { spawn, cwdExists: exists });
    expect(calls.map((c) => c.file)).toEqual(["wt.exe", "cmd.exe"]);
    expect(calls[1].args).toEqual(
      buildNewSessionCmdArgs("plan", CLAUDE, ["--model", "opus"]),
    );
    // cwd travels via the spawn option, never inside the argv (invariant I2).
    expect(calls[1].args).not.toContain(CWD);
    expect(calls[1].cwd).toBe(CWD);
  });

  test("rejects a token with a cmd metacharacter, naming it, spawning nothing", async () => {
    const { spawn, calls } = fakeSpawn();
    const bad = { ...REQ, rawArgs: "--model opus&calc" };
    const err = await launchNewSession(bad, {
      spawn,
      cwdExists: exists,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidArgsError);
    expect((err as InvalidArgsError).code).toBe("INVALID_ARGS");
    expect((err as InvalidArgsError).detail).toContain("opus&calc");
    expect(calls).toHaveLength(0);
  });

  test.each(["|", "<", ">", "^", "%", "!"])(
    "gates every cmd metacharacter (%s) per token",
    async (ch) => {
      const { spawn } = fakeSpawn();
      await expect(
        launchNewSession(
          { ...REQ, rawArgs: `ok a${ch}b` },
          { spawn, cwdExists: exists },
        ),
      ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    },
  );

  test("gates ';' in an arg token — wt.exe would run it as a second command", async () => {
    const { spawn, calls } = fakeSpawn();
    const err = await launchNewSession(
      { ...REQ, rawArgs: "foo ; calc" },
      { spawn, cwdExists: exists },
    ).catch((e: unknown) => e);
    expect((err as InvalidArgsError).code).toBe("INVALID_ARGS");
    expect((err as InvalidArgsError).detail).toContain(";");
    expect(calls).toHaveLength(0);
  });

  test("gates ';' in the claudePath at the wt chokepoint (UNSAFE_PATH)", async () => {
    // ';' is not a CMD_METACHAR, so it slips past assertNoCmdMetachars — the
    // spawnWindowsTerminal backstop catches it before the wt argv is built.
    const { spawn, calls } = fakeSpawn();
    await expect(
      launchNewSession(
        { ...REQ, claudePath: "C:\\a;calc\\claude.cmd" },
        { spawn, cwdExists: exists },
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(calls).toHaveLength(0);
  });

  test("gates ';' in the cwd (UNSAFE_PATH), spawning nothing", async () => {
    const { spawn, calls } = fakeSpawn();
    await expect(
      launchNewSession(
        { ...REQ, cwd: "C:\\work;calc" },
        { spawn, cwdExists: exists },
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(calls).toHaveLength(0);
  });

  test("rejects a quoted (whitespace-carrying) token on Windows", async () => {
    const { spawn, calls } = fakeSpawn();
    await expect(
      launchNewSession(
        { ...REQ, rawArgs: '--append-system-prompt "be brief"' },
        { spawn, cwdExists: exists },
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGS" });
    expect(calls).toHaveLength(0);
  });

  test("rejects an unbalanced quote as INVALID_ARGS", async () => {
    const { spawn } = fakeSpawn();
    await expect(
      launchNewSession(
        { ...REQ, rawArgs: '--prompt "unterminated' },
        { spawn, cwdExists: exists },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
      detail: expect.stringMatching(/unbalanced quote/) as unknown,
    });
  });

  test("rejects a claudePath with a cmd metacharacter as UNSAFE_PATH", async () => {
    const { spawn, calls } = fakeSpawn();
    await expect(
      launchNewSession(
        { ...REQ, claudePath: "C:\\a&b\\claude.cmd" },
        { spawn, cwdExists: exists },
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(calls).toHaveLength(0);
  });

  test("empty rawArgs launches with just the mode", async () => {
    const { spawn, calls } = fakeSpawn();
    await launchNewSession(
      { ...REQ, rawArgs: "  " },
      { spawn, cwdExists: exists },
    );
    expect(calls[0].args.slice(4)).toEqual([
      "/k",
      CLAUDE,
      "--permission-mode",
      "plan",
    ]);
  });
});

describe("launchNewSession — darwin", () => {
  const REQ = {
    os: "darwin" as const,
    cwd: "/Users/me/proj",
    mode: "default",
    rawArgs: '--append-system-prompt "be brief"',
    claudePath: CLAUDE,
  };

  test("spawns osascript with each extra token single-quoted (quotes allowed here)", async () => {
    const { spawn, calls } = fakeSpawn();
    await launchNewSession(REQ, { spawn, cwdExists: exists });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("osascript");
    expect(calls[0].args[0]).toBe("-e");
    expect(calls[0].args[1]).toContain("--permission-mode default");
    expect(calls[0].args[1]).toContain("'be brief'");
  });

  test("allows ';' in a macOS arg — single-quoting keeps it literal (no wt here)", async () => {
    const { spawn, calls } = fakeSpawn();
    await launchNewSession(
      { ...REQ, rawArgs: "--prompt echo;ls" },
      { spawn, cwdExists: exists },
    );
    expect(calls[0].args[1]).toContain("'echo;ls'");
  });
});

describe("launchNewSession — shared gates", () => {
  const REQ = {
    os: "win32" as const,
    cwd: CWD,
    mode: "default",
    rawArgs: "",
    claudePath: CLAUDE,
  };

  test("FOLDER_MISSING when the cwd is gone; nothing spawns", async () => {
    const { spawn, calls } = fakeSpawn();
    await expect(
      launchNewSession(REQ, { spawn, cwdExists: missing }),
    ).rejects.toMatchObject({ code: "FOLDER_MISSING" });
    expect(calls).toHaveLength(0);
  });

  test("UNSUPPORTED_OS for a non win32/darwin host", async () => {
    await expect(
      launchNewSession({ ...REQ, os: "linux" as never }, fakeSpawn()),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OS" });
  });

  test("an out-of-set mode throws before any I/O", async () => {
    const { spawn, calls } = fakeSpawn();
    const exists2 = vi.fn(async () => true);
    await expect(
      launchNewSession({ ...REQ, mode: "yolo" }, { spawn, cwdExists: exists2 }),
    ).rejects.toThrow(/permissionMode/);
    expect(exists2).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe("openTerminalHere", () => {
  test("win32: wt wraps a bare cmd.exe /k; falls back to plain cmd", async () => {
    const ok = fakeSpawn();
    await openTerminalHere(
      { os: "win32", cwd: CWD },
      { spawn: ok.spawn, cwdExists: exists },
    );
    expect(ok.calls).toEqual([
      {
        file: "wt.exe",
        args: ["new-tab", "-d", CWD, "cmd.exe", "/k"],
        cwd: CWD,
      },
    ]);

    const fb = fakeSpawn(["wt.exe"]);
    await openTerminalHere(
      { os: "win32", cwd: CWD },
      { spawn: fb.spawn, cwdExists: exists },
    );
    expect(fb.calls.map((c) => c.file)).toEqual(["wt.exe", "cmd.exe"]);
    expect(fb.calls[1].args).toEqual(["/k"]);
  });

  test("darwin: a cd-only do script with the cwd single-quoted", async () => {
    const { spawn, calls } = fakeSpawn();
    await openTerminalHere(
      { os: "darwin", cwd: "/tmp/a b" },
      { spawn, cwdExists: exists },
    );
    expect(calls[0].file).toBe("osascript");
    expect(calls[0].args[1]).toContain("cd '/tmp/a b'");
  });

  test("FOLDER_MISSING and empty-cwd rejection, spawning nothing", async () => {
    const { spawn, calls } = fakeSpawn();
    await expect(
      openTerminalHere(
        { os: "win32", cwd: CWD },
        { spawn, cwdExists: missing },
      ),
    ).rejects.toMatchObject({ code: "FOLDER_MISSING" });
    await expect(
      openTerminalHere({ os: "win32", cwd: "" }, { spawn, cwdExists: exists }),
    ).rejects.toThrow(/cwd/);
    expect(calls).toHaveLength(0);
  });
});
