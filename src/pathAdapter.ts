// OS seam for resolving the Claude projects root. Sessions live at
// <root>/<encoded-cwd>/<sessionId>.jsonl where <root> defaults to
// ~/.claude/projects. `os.homedir()` absorbs the Windows/macOS home-directory
// difference and the relative .claude/projects structure is identical on both
// OSes, so no per-OS branch is needed. `homedir` is injectable so per-OS
// resolution is unit-testable deterministically without mocking `os`. Pure:
// imports only node:os/node:path and does no I/O — the path is returned, not
// verified to exist (a missing root is sessionStore's concern; §12 surfaces it
// as the "No Claude sessions found" empty state). Design spec
// (docs/specs/2026-06-30-csm-design.md §5 module table).

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
