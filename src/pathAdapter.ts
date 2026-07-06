// OS seam for spec §5's "OS-aware path handling": resolving the Claude projects
// root AND classifying a session's cwd for the §10 hide filter.
// Sessions live at <root>/<encoded-cwd>/<sessionId>.jsonl where <root> defaults
// to ~/.claude/projects. `os.homedir()` absorbs the Windows/macOS home
// difference and the relative .claude/projects structure is identical on both
// OSes, so no per-OS branch is needed. Pure: imports only node:os/node:path and
// does no I/O — the path is returned/classified, not verified to exist (a missing
// root is sessionStore's concern; §12 surfaces it as the "No Claude sessions
// found" empty state). The path-classification half (isTempPath/isWorktreePath,
// #49) completes the charter below; the root-resolution half shipped in #48.

import { homedir, platform as osPlatform, tmpdir as osTmpdir } from "node:os";
import { join, win32, posix } from "node:path";

/**
 * Resolve the default Claude projects root, `<home>/.claude/projects`.
 *
 * @param home - home directory to resolve against; defaults to `os.homedir()`.
 *   Injectable so tests can assert per-OS resolution without mocking `os`.
 */
export function defaultProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

// --- §10 hide-filter classification (temp / worktree path predicates).
//
// Both predicates take a platform-injected options bag so BOTH per-OS matrices
// are provable on any runner (a Windows temp-root case must pass on a Linux
// host); the real caller lets platform/tmpdir/env default to the host. Pure:
// string/path logic only, no I/O — the cwd is classified, never stat'd.

/** Injectable host context; each field defaults to the real host value. */
export interface PathClassOpts {
  /** OS whose path semantics to apply; defaults to `os.platform()`. */
  platform?: NodeJS.Platform;
  /** System temp dir (primary root); defaults to `os.tmpdir()`. */
  tmpdir?: string;
  /** Environment for the OS-specific extra temp roots; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

// A path module + case-folding, chosen from the target platform so parsing is
// host-independent. Windows paths fold case and use `\`; POSIX is exact with `/`.
function semantics(platform: NodeJS.Platform) {
  const isWin = platform === "win32";
  const P = isWin ? win32 : posix;
  const fold = isWin ? (s: string) => s.toLowerCase() : (s: string) => s;
  return { P, fold };
}

// Normalize a path to its comparable canonical form: collapse `.`/`..` and
// separators, drop a trailing separator, and fold case on Windows.
function canon(
  P: typeof win32 | typeof posix,
  fold: (s: string) => string,
  raw: string,
): string {
  let n = P.normalize(raw);
  if (n.length > 1 && n.endsWith(P.sep)) n = n.slice(0, -1);
  return fold(n);
}

/**
 * True when `cwd` is under (or equal to) a system temp dir — the §10 filter
 * hides such throwaway sessions by default. OS-aware: Windows uses `os.tmpdir()`,
 * `%TEMP%`/`%TMP%`, `%LOCALAPPDATA%\Temp`, and `C:\Windows\Temp`; POSIX uses
 * `os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, `/var/folders`, and
 * `/private/var/folders` (the `/private/*` forms are macOS's canonical symlink
 * targets). Blank/unset roots are dropped so they can't match every path.
 */
/**
 * The system temp roots for the target platform, resolved to raw paths (blank/
 * unset entries dropped, not canonicalized). `isTempPath` matches against these,
 * and the `csm:getTempRoots` IPC ships them to the renderer so it can apply the
 * §10 hide filter without re-implementing root DISCOVERY (which needs `os`) —
 * the renderer only does pure prefix matching (#69).
 */
export function tempRoots(opts: PathClassOpts = {}): string[] {
  const platform = opts.platform ?? osPlatform();
  const tmp = opts.tmpdir ?? osTmpdir();
  const env = opts.env ?? process.env;
  const { P } = semantics(platform);

  const raw =
    platform === "win32"
      ? [
          tmp,
          env.TEMP,
          env.TMP,
          env.LOCALAPPDATA && P.join(env.LOCALAPPDATA, "Temp"),
          "C:\\Windows\\Temp",
        ]
      : [
          tmp,
          env.TMPDIR,
          "/tmp",
          "/private/tmp",
          "/var/folders",
          "/private/var/folders",
        ];
  return raw.filter((r): r is string => typeof r === "string" && r.trim() !== "");
}

export function isTempPath(cwd: string, opts: PathClassOpts = {}): boolean {
  const platform = opts.platform ?? osPlatform();
  const { P, fold } = semantics(platform);
  const cwdN = canon(P, fold, cwd);
  return tempRoots(opts)
    .map((r) => canon(P, fold, r))
    .some((root) => cwdN === root || cwdN.startsWith(root + P.sep));
}

/**
 * True when `cwd` lives inside a `.../.claude/worktrees/<name>` path — the
 * disposable git worktrees the §10 filter hides. Pure, so it recognizes only the
 * path *convention* (consecutive `.claude` → `worktrees` segments with a worktree
 * dir after them); detecting an arbitrary git worktree needs reading its `.git`
 * file (I/O) and is out of scope.
 */
export function isWorktreePath(cwd: string, opts: PathClassOpts = {}): boolean {
  const platform = opts.platform ?? osPlatform();
  const { P, fold } = semantics(platform);
  const segs = P.normalize(cwd).split(P.sep).filter(Boolean).map(fold);
  // Require a segment AFTER "worktrees" (the worktree dir itself): `i + 2` must
  // be a valid index, so `.../.claude/worktrees` with nothing after is not a hit.
  for (let i = 0; i + 2 < segs.length; i++) {
    if (segs[i] === ".claude" && segs[i + 1] === "worktrees") return true;
  }
  return false;
}
