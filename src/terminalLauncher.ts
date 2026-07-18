// Pure core of terminalLauncher (spec docs/specs/2026-07-03-launch-spec-builder.md,
// parent design §5/§7). Given (os, cwd, sessionId, mode, claudePath) it builds the
// OS-specific argv to open a new terminal window cd'd into `cwd` running
//   <claudePath> --resume <sessionId> --permission-mode <mode>
//
// This module is where ALL command-injection escaping/validation is proven. It is
// PURE: no child_process/fs/os/electron, no I/O — the actual spawn, `wt.exe`
// detection, the Windows cmd.exe fallback, and the stat-cwd-before-launch live in
// the impure terminalLauncher slice (#52). `cwd`/`sessionId`/`claudePath` are
// untrusted (read from on-disk session content / user settings) and must never be
// concatenated into a shell command string — hence discrete argv (Windows) and the
// strictly-ordered two-layer escaping (macOS).

import { KNOWN_PERMISSION_MODES, type PermissionMode } from "./sessionParser";

export interface LaunchSpec {
  /** Executable to spawn — the `file` arg of child_process.spawn. Never interpolated. */
  file: string;
  /** Discrete argv elements — never a single interpolated string. */
  args: readonly string[];
}

export type LaunchOS = "win32" | "darwin";

// Strict RFC-4122 UUID, SINGLE-LINE (no `m` flag): under `m`, ^/$ match line
// boundaries and a `<uuid>\n<payload>` string would pass the anchors. A match is
// confined to [0-9a-f-] and so cannot carry a shell/AppleScript metacharacter.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Boolean form of the UUID gate for callers that validate without throwing (e.g.
// the getFacts IPC path). Reuses the SAME regex as assertLaunchInputs so the two
// can never drift.
export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

// Control + exotic separators: C0 (U+0000–U+001F), DEL + C1 (U+007F–U+009F, which
// includes NEL U+0085), and the Unicode line/paragraph separators (U+2028/U+2029).
// A C0 newline cannot live inside a macOS AppleScript double-quoted literal at all;
// the rest are inert in every container but carry no meaning in a real launchable
// path, so rejecting them yields a clear "invalid" error instead of a silently
// non-existent cd target. No real cwd/claudePath contains any of these.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

// Exported so the impure spawn layer (reopenSession, #52) reuses the exact same
// UUID / mode-allowlist / empty / control-char validation instead of
// re-implementing it — the issue's "do not re-implement escaping/validation".
export function assertLaunchInputs(
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): void {
  if (!UUID_RE.test(sessionId)) {
    throw new Error("Invalid sessionId: expected a UUID");
  }
  assertModeAndPaths(cwd, mode, claudePath);
}

// The mode-allowlist + cwd/claudePath checks shared by the reopen and
// new-session validators. Factored out so the two entry points genuinely cannot
// drift (the same body, not a copy): reopen adds the UUID gate on top, the new
// session flow uses this alone.
function assertModeAndPaths(
  cwd: string,
  mode: string,
  claudePath: string,
): void {
  // Reuse the parser's canonical set (it produces `mode`) so the two can't drift.
  // `mode` is typed `string` because it can arrive un-parsed via the bypass-modal
  // downgrade IPC path — the cast only satisfies Set.has; membership is the gate.
  if (!KNOWN_PERMISSION_MODES.has(mode as PermissionMode)) {
    throw new Error(`Invalid permissionMode: ${mode}`);
  }
  assertPathish(cwd, "cwd");
  assertPathish(claudePath, "claudePath");
}

// Exported for the new-session flow (#165): openTerminalHere validates a bare
// cwd with no sessionId/mode/claudePath in play.
export function assertPathish(value: string, name: string): void {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  if (CONTROL_CHARS.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
}

// New-session inputs (#165, spec docs/specs/2026-07-18-new-session-launcher.md):
// no session exists yet, so the UUID invariant of assertLaunchInputs does not
// apply — everything else (mode allowlist, pathish checks) is the same shared
// pieces, so the two asserts cannot drift.
export function assertNewSessionInputs(
  cwd: string,
  mode: string,
  claudePath: string,
): void {
  assertModeAndPaths(cwd, mode, claudePath);
}

// Tokenizer for the new-session modal's free-form CLI arguments (#165). Splits
// on whitespace; a double-quoted span forms ONE token with the quotes removed
// (no escape sequences inside quotes — this is a convenience for macOS, where
// each token is later single-quote-wrapped; on Windows any token that still
// contains whitespace is rejected by the per-token cmd gate). Throws on a
// control character or an unbalanced quote; the impure layer maps the throw to
// the INVALID_ARGS code.
export function tokenizeArgs(raw: string): string[] {
  // Tab is technically C0 but is honest whitespace in a pasted argument string —
  // treat it as a splitter, not contraband. Everything else in the class stays
  // rejected (a newline could smuggle a second command into the macOS line).
  if (CONTROL_CHARS.test(raw.replace(/\t/g, " "))) {
    throw new Error("arguments must not contain control characters");
  }
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  // Distinguishes an explicit empty token (`""`) from no token at all.
  let sawQuote = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      sawQuote = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0 || sawQuote) tokens.push(current);
      current = "";
      sawQuote = false;
      continue;
    }
    current += ch;
  }
  if (inQuotes) throw new Error("unbalanced quote in arguments");
  if (current.length > 0 || sawQuote) tokens.push(current);
  return tokens;
}

/**
 * Build the launch spec for the OS. Throws on an invalid sessionId (non-UUID), an
 * out-of-set mode, an empty/control-char cwd or claudePath, or an unsupported os.
 */
export function buildLaunchSpec(
  os: LaunchOS,
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): LaunchSpec {
  assertLaunchInputs(cwd, sessionId, mode, claudePath);
  switch (os) {
    case "win32":
      return buildWindowsTerminalSpec(cwd, sessionId, mode, claudePath);
    case "darwin":
      return buildOsascriptSpec(cwd, sessionId, mode, claudePath);
    default:
      throw new Error(`Unsupported OS: ${os}`);
  }
}

// Windows Terminal. `new-tab` is required as args[0]: without a subcommand wt parses
// the trailing `--resume`/`--permission-mode` as its own (unknown) options. `-d`
// sets the start dir in the new tab (the parent spawn's cwd option would not reach
// it). Structurally injection-safe — wt parses discrete argv; a metacharacter inside
// one element cannot re-split (wt's `;` delimiter acts on its own arg string).
function buildWindowsTerminalSpec(
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): LaunchSpec {
  return {
    file: "wt.exe",
    args: [
      "new-tab",
      "-d",
      cwd,
      claudePath,
      "--resume",
      sessionId,
      "--permission-mode",
      mode,
    ],
  };
}

// macOS Terminal.app via osascript. The ONLY place safety rests on string escaping
// (Terminal's `do script` takes a shell string), so the two layers are applied in a
// strict, security-critical order (spec §3.5): (1) single-quote-wrap the RAW values
// for the inner shell, then (2) AppleScript-escape the whole line for the outer
// literal — because osascript de-escapes the literal before Terminal's shell sees it.
function buildOsascriptSpec(
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): LaunchSpec {
  const shellLine = `cd ${shellSingleQuote(cwd)} && ${shellSingleQuote(
    claudePath,
  )} --resume ${sessionId} --permission-mode ${mode}`;
  const script = `tell application "Terminal" to do script "${appleScriptEscape(
    shellLine,
  )}"`;
  return { file: "osascript", args: ["-e", script] };
}

// New-session macOS spec (#165): same strict two-layer escaping as the reopen
// builder above. `mode` is embedded raw — it is allowlist-validated to a pure
// alphanumeric token; every user-supplied piece (cwd, claudePath, each extra
// arg) is single-quote-wrapped for the inner shell before the whole line is
// AppleScript-escaped.
export function buildNewSessionOsascriptSpec(
  cwd: string,
  mode: string,
  claudePath: string,
  extraArgs: readonly string[],
): LaunchSpec {
  assertNewSessionInputs(cwd, mode, claudePath);
  const extras = extraArgs.map((t) => ` ${shellSingleQuote(t)}`).join("");
  const shellLine = `cd ${shellSingleQuote(cwd)} && ${shellSingleQuote(
    claudePath,
  )} --permission-mode ${mode}${extras}`;
  const script = `tell application "Terminal" to do script "${appleScriptEscape(
    shellLine,
  )}"`;
  return { file: "osascript", args: ["-e", script] };
}

// The "Open terminal here" escape hatch (#165): a plain Terminal window cd'd
// into `cwd`, running nothing — no claudePath in play at all.
export function buildOpenHereOsascriptSpec(cwd: string): LaunchSpec {
  assertPathish(cwd, "cwd");
  const script = `tell application "Terminal" to do script "${appleScriptEscape(
    `cd ${shellSingleQuote(cwd)}`,
  )}"`;
  return { file: "osascript", args: ["-e", script] };
}

// POSIX single-quote wrap: nothing inside '…' is interpreted by the shell. An
// embedded ' is closed, escaped as \', and reopened -> the 4-char sequence '\''.
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Escape for an AppleScript double-quoted literal: backslash FIRST, then quote, so a
// `"` becomes \" and not \\" (order matters).
function appleScriptEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
