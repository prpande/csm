// Impure launcher: consume the pure buildLaunchSpec (macOS) or build the Windows
// argv, then actually spawn a terminal to reopen a closed Claude Code session.
// This is the I/O + spawn slice #51 carved out (spec docs/specs/2026-07-03-
// terminal-spawn-layer.md) because the Windows cmd.exe re-parse can only be
// proven with a real spawn, not in a pure unit.
//
// Windows strategy (approach A2): the claude invocation ALWAYS runs through
// `cmd.exe /k` (cmd.exe reliably resolves + runs the common `claude.cmd` npm
// shim, which Node 24 refuses to spawn directly with shell:false). `wt.exe` is an
// optional OUTER wrapper for nicer tabs, chosen by try-wt-then-fall-back-to-cmd —
// robust to the WindowsApps execution-alias stub that defeats stat-based
// detection. One metacharacter gate on `claudePath` covers both paths.
//
// The two effectful seams (spawn, cwdExists) are injected so the decision/
// fallback logic is unit-testable without real spawning or a real filesystem.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  buildLaunchSpec,
  assertLaunchInputs,
  type LaunchOS,
} from "./terminalLauncher";

export interface ReopenRequest {
  os: LaunchOS;
  cwd: string;
  sessionId: string;
  mode: string;
  claudePath: string;
}

/** Minimal ChildProcess surface reopenSession needs (spawn/error events, unref, kill). */
export interface SpawnedChild {
  once(event: string, listener: (arg: unknown) => void): unknown;
  unref(): void;
  kill?(): void;
}
export type SpawnFn = (
  file: string,
  args: readonly string[],
  opts: SpawnOptions,
) => SpawnedChild;

export interface LauncherDeps {
  spawn: SpawnFn;
  cwdExists: (cwd: string) => Promise<boolean>;
}

// --- typed error surface (§3.6): stable `code` for the IPC layer to switch on.
// error.message may embed the raw untrusted path (for logs); the IPC layer maps
// `code` → display string and must never feed `message` to renderer innerHTML.

export class UnsupportedOsError extends Error {
  readonly code = "UNSUPPORTED_OS";
  constructor(os: string) {
    super(`Unsupported OS: ${os}`);
    this.name = "UnsupportedOsError";
  }
}
export class FolderMissingError extends Error {
  readonly code = "FOLDER_MISSING";
  constructor(cwd: string) {
    super(`folder no longer exists: ${cwd}`);
    this.name = "FolderMissingError";
  }
}
export class UnsafePathError extends Error {
  readonly code = "UNSAFE_PATH";
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}
export class SpawnFailedError extends Error {
  readonly code = "SPAWN_FAILED";
  constructor(cause: unknown) {
    super("failed to launch terminal", { cause });
    this.name = "SpawnFailedError";
  }
}

// cmd.exe first-parser metacharacters: & | < > ^ % ! plus " (cannot round-trip a
// Node-quoted token through cmd's re-parse). `(` `)` are deliberately absent —
// `C:\Program Files (x86)\…` is legal and Node's quoting confines them. Scoped to
// cmd.exe: PowerShell specials ($, `) are irrelevant (cmd can't exec .ps1).
const CMD_METACHARS = /[&|<>^%!"]/;

/** Reject a claudePath that would perturb cmd.exe's re-parse (§3.3). */
export function assertNoCmdMetachars(claudePath: string): void {
  if (CMD_METACHARS.test(claudePath)) {
    throw new UnsafePathError(
      `claudePath contains a cmd.exe metacharacter: ${claudePath}`,
    );
  }
}

// `cwd` is deliberately absent from the argv: cmd.exe has no start-directory
// flag, so it is passed only via the spawn `cwd` option (Invariant I2).
export function buildPlainCmdArgs(
  sessionId: string,
  mode: string,
  claudePath: string,
): string[] {
  return ["/k", claudePath, "--resume", sessionId, "--permission-mode", mode];
}

// wt wraps the SAME cmd.exe invocation; `-d <cwd>` is wt's start-directory (an OS
// API parameter to the tab's shell, not a re-parsed string — cwd metachars inert).
export function buildWtWrappedArgs(
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): string[] {
  return [
    "new-tab",
    "-d",
    cwd,
    "cmd.exe",
    ...buildPlainCmdArgs(sessionId, mode, claudePath),
  ];
}

/** True only when `cwd` exists AND is a directory (a file/missing path → false). */
export async function cwdExists(cwd: string): Promise<boolean> {
  try {
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}

export const realDeps: LauncherDeps = {
  spawn: (file, args, opts) => nodeSpawn(file, args, opts),
  cwdExists,
};

// A spawn that neither succeeds ('spawn') nor fails ('error') — e.g. a
// WindowsApps alias stub that resolves at the OS layer without libuv firing an
// event — would otherwise wedge this promise forever, and on the wt attempt would
// starve the cmd fallback. Bound it so a hang becomes a rejection the caller can
// recover from (wt hang → cmd fallback; cmd hang → SpawnFailedError). 'spawn'
// fires at process creation (ms), so 10s is far above real spawn latency and
// never false-trips a healthy launch; the timer is cleared the instant we settle.
const SPAWN_TIMEOUT_MS = 10_000;

// Spawn a new detached terminal; resolve on the `spawn` event, reject on `error`
// (or on the hang-guard timeout). Always shell:false + discrete argv (I1);
// detached+ignore+unref so CSM can exit without killing the terminal and the
// child gets its own console.
function trySpawn(
  spawn: SpawnFn,
  file: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(file, args, {
      cwd,
      shell: false,
      detached: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // A permanent hang (alias stub) never spawns, so there is nothing to kill.
      // But if the spawn was merely SLOW (e.g. AV-scanning wt.exe on first launch)
      // it could still fire 'spawn' after we've fallen back to cmd.exe — best-effort
      // kill so a late-arriving child can't open a SECOND window.
      child.kill?.();
      reject(new Error(`spawn timed out: ${file}`));
    }, SPAWN_TIMEOUT_MS);
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolve();
    });
  });
}

// trySpawn, wrapping any spawn failure as the typed SpawnFailedError.
async function spawnOrFail(
  spawn: SpawnFn,
  file: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  try {
    await trySpawn(spawn, file, args, cwd);
  } catch (err) {
    throw new SpawnFailedError(err);
  }
}

async function reopenWindows(
  spawn: SpawnFn,
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): Promise<void> {
  assertNoCmdMetachars(claudePath);
  // Try Windows Terminal first (nicer tabs). ANY wt failure — ENOENT when absent,
  // or a runtime error from a lingering/disabled alias stub — falls through to a
  // plain cmd window. A wt spawn error fires before a window appears.
  try {
    await trySpawn(
      spawn,
      "wt.exe",
      buildWtWrappedArgs(cwd, sessionId, mode, claudePath),
      cwd,
    );
    return;
  } catch {
    // fall through to the plain cmd.exe window
  }
  await spawnOrFail(
    spawn,
    "cmd.exe",
    buildPlainCmdArgs(sessionId, mode, claudePath),
    cwd,
  );
}

async function reopenMac(
  spawn: SpawnFn,
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): Promise<void> {
  const spec = buildLaunchSpec("darwin", cwd, sessionId, mode, claudePath);
  await spawnOrFail(spawn, spec.file, spec.args, cwd);
}

/**
 * Open a terminal that reopens the given closed session. Rejects with a typed
 * error (§3.6) on unsupported OS, invalid inputs, a vanished cwd, an unsafe
 * claudePath, or a terminal that fails to spawn. Resolves once a child spawns.
 */
export async function reopenSession(
  req: ReopenRequest,
  deps: Partial<LauncherDeps> = {},
): Promise<void> {
  const spawn = deps.spawn ?? realDeps.spawn;
  const exists = deps.cwdExists ?? realDeps.cwdExists;
  const { os, cwd, sessionId, mode, claudePath } = req;

  if (os !== "win32" && os !== "darwin") {
    throw new UnsupportedOsError(os);
  }
  // Shared validation (UUID / mode allowlist / empty / control char), reused from
  // the pure builder — the control-char guard is load-bearing for the osascript
  // path (a newline would break Terminal's `do script`).
  assertLaunchInputs(cwd, sessionId, mode, claudePath);
  if (!(await exists(cwd))) {
    throw new FolderMissingError(cwd);
  }
  if (os === "win32") {
    await reopenWindows(spawn, cwd, sessionId, mode, claudePath);
  } else {
    await reopenMac(spawn, cwd, sessionId, mode, claudePath);
  }
}
