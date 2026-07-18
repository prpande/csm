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
// Exported for the new-session flow (#165), whose per-token argument gate must
// use the SAME charset so the two cannot drift.
export const CMD_METACHARS = /[&|<>^%!"]/;

// wt.exe's OWN parser is a SEPARATE hazard from cmd.exe's. Windows Terminal
// re-parses its flat command line and treats `;` as a COMMAND delimiter: a `;`
// anywhere in the wt argv — even inside one Node-discrete element, since libuv
// joins argv into a single string for the Win32 API — starts a second wt
// command (e.g. a new tab running an arbitrary program). CMD_METACHARS does not
// cover this. Every value that reaches the wt argv (cwd via `-d`, claudePath,
// each user arg) is gated against this; `;` has no legitimate use in a path or a
// claude arg that must survive to the shell intact.
export const WT_METACHARS = /;/;

/** Reject a claudePath that would perturb cmd.exe's re-parse (§3.3). */
export function assertNoCmdMetachars(claudePath: string): void {
  if (CMD_METACHARS.test(claudePath)) {
    throw new UnsafePathError(
      `claudePath contains a cmd.exe metacharacter: ${claudePath}`,
    );
  }
}

/** Reject a value that would inject a second wt.exe command via a bare/embedded
 * `;`. Applied to everything landing in the wt argv, for both flows (#165). */
export function assertNoWtMetachars(value: string, name: string): void {
  if (WT_METACHARS.test(value)) {
    throw new UnsafePathError(
      `${name} contains a wt.exe command separator ';': ${value}`,
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

// The wt.exe wrapper argv: a new tab started in `cwd` running `cmd.exe
// <cmdTail…>`. Pure so the exact shape stays unit-tested on the LIVE path
// (spawnWindowsTerminal calls this). `new-tab` MUST lead, else wt parses the
// trailing cmdTail as its own options. `-d <cwd>` is wt's start-directory API
// parameter (not a re-parsed string), so the `cwd` here is inert to cmd.exe —
// but NOT to wt's own `;` splitter, which spawnWindowsTerminal gates.
export function buildWtArgs(cwd: string, cmdTail: readonly string[]): string[] {
  return ["new-tab", "-d", cwd, "cmd.exe", ...cmdTail];
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

// trySpawn, wrapping any spawn failure as the typed SpawnFailedError. Exported
// for the new-session flow (#165) — the macOS spawn path is identical there.
export async function spawnOrFail(
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

// The shared Windows launch shape (#165 lifted this out of reopenWindows): the
// cmd.exe invocation `cmd.exe <cmdTail…>` is what actually runs; wt.exe is an
// optional outer wrapper tried first for nicer tabs. ANY wt failure — ENOENT
// when absent, a runtime error from a lingering/disabled alias stub, or the
// hang-guard timeout — falls through to a plain cmd window. A wt spawn error
// fires before a window appears.
export async function spawnWindowsTerminal(
  spawn: SpawnFn,
  cwd: string,
  cmdTail: readonly string[],
): Promise<void> {
  // Backstop for BOTH flows at the single chokepoint where the wt argv is built:
  // nothing reaching it may carry wt's `;` command separator. The wt attempt is
  // the default success path, so this must run before either spawn — and because
  // the fallback dynamically picks wt OR cmd, we gate for the stricter (wt) case
  // regardless. cmd.exe's own re-parse is gated separately by CMD_METACHARS /
  // the per-token arg gate at the call sites.
  assertNoWtMetachars(cwd, "cwd");
  for (const part of cmdTail) assertNoWtMetachars(part, "argument");
  try {
    await trySpawn(spawn, "wt.exe", buildWtArgs(cwd, cmdTail), cwd);
    return;
  } catch {
    // fall through to the plain cmd.exe window
  }
  await spawnOrFail(spawn, "cmd.exe", cmdTail, cwd);
}

async function reopenWindows(
  spawn: SpawnFn,
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): Promise<void> {
  assertNoCmdMetachars(claudePath);
  await spawnWindowsTerminal(
    spawn,
    cwd,
    buildPlainCmdArgs(sessionId, mode, claudePath),
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
