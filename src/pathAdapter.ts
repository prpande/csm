// OS seam for resolving the Claude projects root (spec §5 module table).
// Sessions live at <root>/<encoded-cwd>/<sessionId>.jsonl where <root> defaults
// to ~/.claude/projects. `os.homedir()` absorbs the Windows/macOS home
// difference and the relative .claude/projects structure is identical on both
// OSes, so no per-OS branch is needed. Pure: imports only node:os/node:path and
// does no I/O — the path is returned, not verified to exist (a missing root is
// sessionStore's concern; §12 surfaces it as the "No Claude sessions found"
// empty state). The broader §5 "OS-aware path handling" charter (temp/worktree
// path predicates for the §10 hide filter) is deliberately deferred to #49.

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the default Claude projects root, `<home>/.claude/projects`.
 *
 * @param home - home directory to resolve against; defaults to `os.homedir()`.
 *   Injectable so tests can assert per-OS resolution without mocking `os`.
 */
export function defaultProjectsRoot(home: string = homedir()): string {
  return join(home, ".claude", "projects");
}
