// OS seam for spec §5's "OS-aware path handling": resolving the Claude projects
// root AND discovering the system temp roots the §10 hide filter matches against.
// Sessions live at <root>/<encoded-cwd>/<sessionId>.jsonl where <root> defaults
// to ~/.claude/projects. `os.homedir()` absorbs the Windows/macOS home
// difference and the relative .claude/projects structure is identical on both
// OSes, so no per-OS branch is needed. Pure: imports only node:os/node:path and
// does no I/O — the path is returned, not verified to exist (a missing root is
// sessionStore's concern; §12 surfaces it as the "No Claude sessions found"
// empty state).
//
// This module needs `os`, so it is main-process only. The §10 filter itself runs
// in the RENDERER: main ships these roots over `paths:getTempRoots` and
// `sessionFilter.ts` does the pure prefix-matching (#69/#113). That split is why
// the cwd-classifying predicates this module used to own (isTempPath /
// isWorktreePath, #49) were deleted in #114 — see docs/plans/61-114-shared-type-guards.md.

import { homedir, platform as osPlatform, tmpdir as osTmpdir } from "node:os";
import { join, win32, posix } from "node:path";
import { isNonEmptyString } from "./typeGuards";

/**
 * Resolve the default Claude projects root, `<home>/.claude/projects`.
 *
 * @param home - home directory to resolve against; defaults to `os.homedir()`.
 *   Injectable so tests can assert per-OS resolution without mocking `os`.
 */
export function defaultProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}

// --- §10 hide-filter support (temp-root discovery).
//
// Takes a platform-injected options bag so BOTH per-OS matrices are provable on
// any runner (a Windows temp-root case must pass on a Linux host); the real
// caller lets platform/tmpdir/env default to the host.

/** Injectable host context; each field defaults to the real host value. */
export interface PathClassOpts {
  /** OS whose path semantics to apply; defaults to `os.platform()`. */
  platform?: NodeJS.Platform;
  /** System temp dir (primary root); defaults to `os.tmpdir()`. */
  tmpdir?: string;
  /** Environment for the OS-specific extra temp roots; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

// The path module for the target platform, so root joining is host-independent.
function pathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/**
 * The system temp roots for the target platform, resolved to raw paths (blank/
 * unset entries dropped, not canonicalized). OS-aware: Windows uses `os.tmpdir()`,
 * `%TEMP%`/`%TMP%`, `%LOCALAPPDATA%\Temp`, and `C:\Windows\Temp`; POSIX uses
 * `os.tmpdir()`, `$TMPDIR`, `/tmp`, `/private/tmp`, `/var/folders`, and
 * `/private/var/folders` (the `/private/*` forms are macOS's canonical symlink
 * targets). The `paths:getTempRoots` IPC ships them to the renderer so it applies
 * the §10 hide filter without re-implementing root DISCOVERY (which needs `os`)
 * — the renderer only does pure prefix matching (#69).
 */
export function tempRoots(opts: PathClassOpts = {}): string[] {
  const platform = opts.platform ?? osPlatform();
  const tmp = opts.tmpdir ?? osTmpdir();
  const env = opts.env ?? process.env;
  const P = pathModule(platform);

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
  return raw.filter(isNonEmptyString);
}
