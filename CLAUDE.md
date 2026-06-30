# CLAUDE.md — CSM (Claude Session Manager)

Guidance for AI agents working in this repository.

## What this is

A cross-platform (Windows + macOS) **Electron** desktop app to browse and reopen
**closed** Claude Code sessions, grouped by the folder they were launched from.
The authoritative design lives in
[`docs/specs/2026-06-30-csm-design.md`](docs/specs/2026-06-30-csm-design.md) —
read it before making implementation decisions. Specs go in `docs/specs/`.

**Status:** design complete; implementation not started.

## Data source (read-only — never mutate)

Sessions are JSONL files at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
CSM reads these **read-only and must never modify, move, or delete Claude's
session files** (CSM's own state lives in Electron `userData`). Group by the
authoritative `cwd` read from inside each file, not the encoded folder name.

## Non-negotiable constraints (from the design review)

- **No shell string interpolation.** Launch terminals with
  `child_process.spawn(file, argsArray, { cwd, shell: false })` — `cwd`,
  `sessionId`, and `claudePath` are untrusted and must never be concatenated into
  a shell/AppleScript command string. Escape any value embedded in an AppleScript
  `do script "…"` literal; validate `sessionId` as a UUID.
- **Render as text, never `innerHTML`.** Session titles can contain arbitrary
  user-prompt text — insert all metadata via `textContent`/text nodes.
- **Electron hardening:** `contextIsolation: true`, `nodeIntegration: false`;
  renderer talks to main only through the narrow preload IPC bridge.
- **Permission mode:** pass the parsed `permissionMode` through unchanged; fall
  back to `default` only when absent/unrecognized. The CLI accepts `acceptEdits`,
  `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`. Reopening a
  `bypassPermissions` session requires a confirmation modal.
- **Large lists must virtualize** — folders can hold thousands of sessions.
- Keep the pure units pure and tested: `sessionParser` and the launch-spec builder
  have no I/O so they can be unit-tested without Electron.

## Phasing

- **A (MVP):** scan + file tree + session list + reopen (with bypass confirm) +
  configurable `claude` path + default-on hide-temp/worktree filter.
- **B:** delete sessions; multi-select bulk reopen (recovery).
- **C:** search, favorites/pinning, custom labels.

## Conventions

- Default branch: `main`. Conventional Commit messages (`feat:`, `fix:`,
  `docs:`, `chore:`, `test:`).
- License: Apache-2.0. Don't commit secrets or `node_modules`.
- Match existing code style; keep modules small and single-purpose per the
  architecture in the spec.
