// Renderer-safe temp-session filter (#69). The main process discovers the system
// temp roots (`pathAdapter.tempRoots`, which needs `os`) and ships them over the
// `paths:getTempRoots` IPC; this module — pure string logic, no `os`/`node:path`,
// so it is safe in the DOM-only renderer and unit-testable in the node tsconfig —
// prefix-matches a session's cwd against them to drop throwaway temp sessions
// from the default (declutter) view. The toggle simply skips this filter.

import type { SessionMetadata } from "./sessionParser";

// A path is Windows-shaped if it uses backslashes or opens with a drive letter;
// such paths fold case and use "\\", POSIX is exact with "/". Same-OS sessions
// and roots agree, but detecting per-path keeps a stray forward-slashed Windows
// root (from an env var) matching correctly.
const isWindowsPath = (p: string): boolean =>
  p.includes("\\") || /^[A-Za-z]:/.test(p);

// Canonical comparable form: unify+collapse separators, drop a trailing one, and
// fold case on Windows. Deliberately string-only (no node:path) so the renderer
// needs no node runtime — that constraint is why this filter lives here rather
// than in pathAdapter, which needs `os` and is main-process only.
function canonPath(p: string): { path: string; sep: string } {
  const win = isWindowsPath(p);
  const sep = win ? "\\" : "/";
  let s = p.replace(/[\\/]+/g, sep);
  if (s.length > 1 && s.endsWith(sep)) s = s.slice(0, -1);
  return { path: win ? s.toLowerCase() : s, sep };
}

// Match a cwd against roots that are ALREADY canonicalized — the shared core so
// the roots are canonicalized once per batch, not once per session. The `+ sep`
// boundary keeps a shared-prefix sibling (`/tmpfoo` vs root `/tmp`) from matching.
function isUnderCanonRoots(
  cwd: string,
  canonRoots: readonly { path: string; sep: string }[],
): boolean {
  const c = canonPath(cwd).path;
  return canonRoots.some(
    ({ path: root, sep }) => c === root || c.startsWith(root + sep),
  );
}

/** True when `cwd` is at or under any of `roots`. */
export function isUnderAnyRoot(cwd: string, roots: readonly string[]): boolean {
  return isUnderCanonRoots(cwd, roots.map(canonPath));
}

/** Drop sessions whose cwd lives under a temp root; empty `roots` is a no-op
 *  (nothing hidden), matching the "roots not yet loaded" and toggle-off cases. */
export function filterOutTemp(
  sessions: readonly SessionMetadata[],
  roots: readonly string[],
): SessionMetadata[] {
  if (roots.length === 0) return [...sessions];
  const canonRoots = roots.map(canonPath);
  return sessions.filter((s) => !isUnderCanonRoots(s.cwd, canonRoots));
}
