// Impure new-session launcher (#165, spec docs/specs/2026-07-18-new-session-
// launcher.md): start a NEW Claude session in an arbitrary directory, plus the
// "Open terminal here" escape hatch. Shares the reopen flow's hardened spawn
// machinery (wt→cmd fallback, hang guard, typed errors, injected deps) instead
// of re-implementing it. What's new here is the free-form CLI argument string:
// tokenized in the pure layer, and on Windows gated PER TOKEN by charset —
// cmd.exe /k re-parses its argument string (the BatBadBut class), so escaping
// cannot be made reliable and rejection is the only sound answer (invariant
// I3). Rejections are loud and name the offending token; the escape hatch is
// what keeps full CLI customizability honest.

import {
  assertNewSessionInputs,
  assertPathish,
  buildNewSessionOsascriptSpec,
  buildOpenHereOsascriptSpec,
  tokenizeArgs,
  type LaunchOS,
} from "./terminalLauncher";
import {
  CMD_METACHARS,
  FolderMissingError,
  UnsupportedOsError,
  assertNoCmdMetachars,
  realDeps,
  spawnOrFail,
  spawnWindowsTerminal,
  type LauncherDeps,
} from "./reopenSession";

export interface NewSessionRequest {
  os: LaunchOS;
  cwd: string;
  mode: string;
  /** The modal's raw argument string — tokenized and validated HERE, never in
   * the renderer. */
  rawArgs: string;
  claudePath: string;
}

export class InvalidArgsError extends Error {
  readonly code = "INVALID_ARGS";
  /** Display-safe reason (the offending token / unbalanced quote). The
   * renderer must insert it via textContent only (invariant I5). */
  readonly detail: string;
  constructor(detail: string) {
    super(`invalid arguments: ${detail}`);
    this.name = "InvalidArgsError";
    this.detail = detail;
  }
}

// `cwd` is deliberately absent (invariant I2): it travels only via the spawn
// `cwd` option / wt's `-d`, never inside the cmd.exe-re-parsed string.
export function buildNewSessionCmdArgs(
  mode: string,
  claudePath: string,
  extra: readonly string[],
): string[] {
  return ["/k", claudePath, "--permission-mode", mode, ...extra];
}

function tokenizeOrThrow(rawArgs: string): string[] {
  try {
    return tokenizeArgs(rawArgs);
  } catch (err) {
    throw new InvalidArgsError(
      err instanceof Error ? err.message : "invalid arguments",
    );
  }
}

// A surviving token must never force Node's argv quoting (whitespace — only
// reachable via a quoted span) nor carry a cmd.exe first-parser metacharacter:
// either would hand cmd's re-parse something we cannot reason about. Charset
// restriction, never escaping.
function assertTokensSafeForCmd(tokens: readonly string[]): void {
  for (const token of tokens) {
    if (/\s/.test(token)) {
      throw new InvalidArgsError(
        `quoted arguments are not supported on Windows: "${token}"`,
      );
    }
    if (CMD_METACHARS.test(token)) {
      throw new InvalidArgsError(
        `argument contains a cmd.exe metacharacter: ${token}`,
      );
    }
  }
}

/**
 * Launch a new Claude session:
 *   <claudePath> --permission-mode <mode> [extraTokens…]
 * in a new terminal at `cwd`. Rejects with the reopen flow's typed errors plus
 * InvalidArgsError (INVALID_ARGS) for a bad argument string.
 */
export async function launchNewSession(
  req: NewSessionRequest,
  deps: Partial<LauncherDeps> = {},
): Promise<void> {
  const spawn = deps.spawn ?? realDeps.spawn;
  const exists = deps.cwdExists ?? realDeps.cwdExists;
  const { os, cwd, mode, rawArgs, claudePath } = req;

  if (os !== "win32" && os !== "darwin") {
    throw new UnsupportedOsError(os);
  }
  assertNewSessionInputs(cwd, mode, claudePath);
  const extra = tokenizeOrThrow(rawArgs);
  if (!(await exists(cwd))) {
    throw new FolderMissingError(cwd);
  }
  if (os === "win32") {
    assertNoCmdMetachars(claudePath);
    assertTokensSafeForCmd(extra);
    await spawnWindowsTerminal(
      spawn,
      cwd,
      buildNewSessionCmdArgs(mode, claudePath, extra),
    );
  } else {
    const spec = buildNewSessionOsascriptSpec(cwd, mode, claudePath, extra);
    await spawnOrFail(spawn, spec.file, spec.args, cwd);
  }
}

export interface OpenTerminalRequest {
  os: LaunchOS;
  cwd: string;
}

/**
 * The escape hatch: open a plain terminal cd'd into `cwd`, running nothing —
 * anything the argument gate rejects can be typed there with the shell's own
 * quoting. No claudePath is involved at all.
 */
export async function openTerminalHere(
  req: OpenTerminalRequest,
  deps: Partial<LauncherDeps> = {},
): Promise<void> {
  const spawn = deps.spawn ?? realDeps.spawn;
  const exists = deps.cwdExists ?? realDeps.cwdExists;
  const { os, cwd } = req;

  if (os !== "win32" && os !== "darwin") {
    throw new UnsupportedOsError(os);
  }
  assertPathish(cwd, "cwd");
  if (!(await exists(cwd))) {
    throw new FolderMissingError(cwd);
  }
  if (os === "win32") {
    // Bare `/k` opens an interactive prompt at the spawn cwd.
    await spawnWindowsTerminal(spawn, cwd, ["/k"]);
  } else {
    const spec = buildOpenHereOsascriptSpec(cwd);
    await spawnOrFail(spawn, spec.file, spec.args, cwd);
  }
}
