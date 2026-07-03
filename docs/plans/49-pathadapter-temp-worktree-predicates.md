# Plan — pathAdapter temp/worktree path predicates (#49)

## What & why

The §10 default-on **"hide temp / worktree folders"** filter needs to classify a
session's `cwd` as hidden-by-default when it is under a system temp dir or inside
a `.../.claude/worktrees/` path. Spec §5 assigns "OS-aware path handling" to
`pathAdapter`; the root-resolution half shipped in #48, and this issue adds the
classification half (deferred there because it has no consumer until the filter
lands and warrants its own per-OS test matrix).

Two pure predicates, no I/O, consistent with `defaultProjectsRoot`.

## Approach (chosen: platform-injected options bag)

Both predicates take an options bag whose fields default to host values but are
injectable so the per-OS matrices are deterministic **on any runner** (CI is
3-OS, but a Windows temp-root case must still be provable on a Linux host):

```ts
interface PathClassOpts {
  platform?: NodeJS.Platform; // default process.platform
  tmpdir?: string;            // default os.tmpdir()
  env?: NodeJS.ProcessEnv;    // default process.env
}
export function isTempPath(cwd: string, opts?: PathClassOpts): boolean
export function isWorktreePath(cwd: string, opts?: PathClassOpts): boolean
```

Internally each selects `path.win32` vs `path.posix` semantics from `platform`
(separator + case-folding), so the logic is host-independent.

### `isTempPath`

Collect the OS-specific temp roots, then return true iff `cwd` equals or is
nested under any root (boundary-safe: `cwd === root || cwd` starts with
`root + sep`, so `/tmpfoo` is NOT under `/tmp`).

- **win32 roots:** `tmpdir`, `env.TEMP`, `env.TMP`, `env.LOCALAPPDATA + \Temp`,
  `C:\Windows\Temp`. Compared case-insensitively (lowercased) — Windows paths are
  case-insensitive and `%TEMP%` casing varies (`AppData\Local\Temp`).
- **posix roots:** `tmpdir`, `env.TMPDIR`, `/tmp`, `/private/tmp`,
  `/var/folders`, `/private/var/folders`. Case-sensitive. (`/private/*` are the
  macOS canonical forms of the `/tmp` and `/var/folders` symlinks.)

Normalize each root and `cwd` with the platform's `path.normalize`, strip a
trailing separator, and (win32 only) lowercase before comparing. Empty/blank
roots (unset env var) are skipped so they can't match everything.

### `isWorktreePath`

A pure function can only recognize the path **convention**
`.../.claude/worktrees/<name>` — detecting an arbitrary git worktree needs
reading its `.git` file (I/O), which is out of scope. Match the consecutive
segments `.claude` → `worktrees` (platform-split on the separator), requiring at
least one segment after `worktrees` (the worktree dir itself). Generic
git-worktree detection is explicitly deferred (would live in an I/O layer if ever
needed).

## Test list (`test/main/pathAdapter.test.ts`, extends existing)

`isTempPath`:
- win32: path under injected `tmpdir`, under `%LOCALAPPDATA%\Temp`, under
  `%TEMP%`/`%TMP%`, under `C:\Windows\Temp` → true; case-insensitive match;
  `C:\Users\me\project` → false; `C:\tempfoo` when root `C:\temp` → false
  (boundary); unset env root doesn't match everything.
- posix: under injected `tmpdir`, `/tmp`, `/var/folders/xx/…`, `/private/tmp`,
  `$TMPDIR` → true; `/home/me/proj` → false; `/tmpfoo` → false (boundary);
  case-sensitivity (`/TMP/x` → false).
- root itself (`cwd === root`) → true.

`isWorktreePath`:
- win32 + posix path containing `.claude/worktrees/<name>` → true; nested deeper
  under it → true; `.claude/projects/…` → false; a dir literally named
  `worktrees` not under `.claude` → false; `.claude/worktrees` with nothing after
  → false.

## Out of scope

The §10 filter UI/wiring itself (separate issue), generic git-worktree detection
(needs I/O), and any consumer changes — cross-link the filter issue to #49 when
it lands.
