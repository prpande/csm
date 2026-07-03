# Plan — #48 `pathAdapter`: resolve default `~/.claude/projects` root

**Tier:** Standard (new main-process module). Small, pure, no I/O.

## Goal

Provide the OS seam that resolves the default Claude projects root
(`~/.claude/projects`) so `sessionStore` (which already takes an injected
`rootDir`) can be wired to it later, composing into a real end-to-end scan.
Spec §5 module table (`pathAdapter` — deps `os`, `path`), §11 test
("projects-dir resolution per OS").

## Approach

`src/pathAdapter.ts` exports one pure function:

```ts
defaultProjectsRoot(home: string = homedir()): string
  => join(home, ".claude", "projects")
```

- `os.homedir()` already absorbs the Windows/macOS home-directory difference,
  and the relative `.claude/projects` structure is identical on both OSes, so
  **no per-OS branch is needed** — "OS-aware" is satisfied by delegating to
  `os.homedir()` + `path.join` (platform separators).
- `home` is **injectable** (default `os.homedir`) so per-OS resolution is
  unit-testable deterministically without mocking `os`.
- **Pure**: imports only `node:os` / `node:path`, does no I/O. The path is
  returned, not verified to exist — a missing root is `sessionStore`'s concern
  (it yields an empty result, surfaced later as the §12 "No Claude sessions
  found" empty state).

## Scope decision (why minimal — Approach 1)

The module's stated responsibility is "OS-aware path handling," which could also
cover the temp/worktree path predicates the §10 default-on hide-temp/worktree
filter needs. Those are **deferred**: they are the filter feature's foundation,
have no consumer in this slice, and the genuinely OS-specific temp-dir detection
(Windows `%TEMP%`/`%LOCALAPPDATA%\Temp` vs macOS `/tmp`, `/var/folders/…`)
deserves its own careful test matrix and issue when the filter is built. Keeping
this slice to root resolution matches the B-plan's small-foundational-units
approach and unblocks the end-to-end scan now.

## Tests (`test/main/pathAdapter.test.ts`, node-context per the tsconfig seam)

1. Appends `.claude/projects` under an injected platform-native home (exact
   `path.join` contract, correct separators).
2. Appends **exactly** the `.claude` then `projects` segments — asserted
   structurally via `path.relative` + platform `sep` (deterministic on all 3 CI
   OSes; a POSIX literal would be mangled by Windows `join` normalization).
3. Defaults to `os.homedir()` when no argument is given.
4. Pure resolution — returns a path for a non-existent home without throwing /
   touching disk.

## Out of scope / follow-ons

- Temp/worktree path predicates for the §10 filter (own issue with the filter).
- Configurable projects root (spec makes only the `claude` **binary** path
  configurable).
- IPC wiring `pathAdapter` → `sessionStore` in main bootstrap (`ipc` slice).
