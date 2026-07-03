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

export interface LaunchSpec {
  /** Executable to spawn — the `file` arg of child_process.spawn. Never interpolated. */
  file: string;
  /** Discrete argv elements — never a single interpolated string. */
  args: readonly string[];
}

export type LaunchOS = "win32" | "darwin";

/** The six CLI permission modes; the parser (§4.1) never emits anything else. */
const PERMISSION_MODES: ReadonlySet<string> = new Set([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
]);

// Strict RFC-4122 UUID, SINGLE-LINE (no `m` flag): under `m`, ^/$ match line
// boundaries and a `<uuid>\n<payload>` string would pass the anchors. A match is
// confined to [0-9a-f-] and so cannot carry a shell/AppleScript metacharacter.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// U+0000–U+001F. A control char (esp. newline) cannot live inside a macOS
// AppleScript double-quoted literal, and no real launchable path contains one.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/;

function assertValidInputs(
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): void {
  if (!UUID_RE.test(sessionId)) {
    throw new Error("Invalid sessionId: expected a UUID");
  }
  if (!PERMISSION_MODES.has(mode)) {
    throw new Error(`Invalid permissionMode: ${mode}`);
  }
  assertPathish(cwd, "cwd");
  assertPathish(claudePath, "claudePath");
}

function assertPathish(value: string, name: string): void {
  if (value.length === 0) throw new Error(`${name} must not be empty`);
  if (CONTROL_CHARS.test(value)) {
    throw new Error(`${name} must not contain control characters`);
  }
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
  assertValidInputs(cwd, sessionId, mode, claudePath);
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
