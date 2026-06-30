# CSM — Claude Session Manager — Design

**Date:** 2026-06-30
**Status:** Approved design, ready for implementation planning

## 1. Purpose

A cross-platform (Windows + macOS) desktop app that makes it easy to find and
reopen closed Claude Code sessions on the local machine. It lists sessions
grouped by the root folder they were launched from, shows each session's time,
description, and ID, and lets the user double-click a session to reopen it in a
new terminal window using the **same permission mode** the session was running
in.

## 2. Goals & non-goals

**Goals (MVP / phase A)**
- Discover all local Claude sessions and present them in a navigable file tree by
  root folder (`cwd`).
- For each session show: description (title), permission mode, time, session ID.
- Double-click a session → open a new terminal at the session's `cwd` running
  `claude --resume <id> --permission-mode <mode>`.
- Configurable path to the `claude` executable.
- Responsive load even with thousands of sessions (progressive, tiered scan).

**Non-goals (for now)**
- Editing or viewing session transcript contents in-app.
- Cloud / multi-machine sync.
- Managing running (live) sessions — this tool is for *closed* sessions.

## 3. Tech stack

- **Electron** (Node main process + HTML/CSS/JS renderer). Chosen to match the
  Slack / Claude-desktop look and to keep both the file-reading and
  terminal-spawning halves in a single language (JS). Tradeoff accepted: large
  bundle (~150 MB) for a small utility.
- `contextIsolation: true`, `nodeIntegration: false`. The renderer has no direct
  disk/process access; it talks to main over a narrow preload IPC bridge.

## 4. Data source

Sessions live at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.

- The folder name is the launch `cwd` with path separators flattened to `-`
  (e.g. `D--src` = `D:\src`, `-Users-praty-src` = `/Users/praty/src`). The
  encoded name is **not** parsed for grouping — the authoritative `cwd` is read
  from inside each file (handles drive letters and odd paths on both OSes).
- We scan only top-level `*.jsonl` files in each project dir. We skip the
  `sessionId`-named subdirectories and `memory/` folders (not sessions).

### 4.1 Fields extracted per session (`sessionParser`)

| Field | Source record | Fallback chain |
|---|---|---|
| `sessionId` | filename / `sessionId` field | — |
| `cwd` (root folder) | any record's `cwd` | `"(unknown)"` |
| `title` (description) | `ai-title` record → `aiTitle` | `summary` → first non-meta `user` prompt (truncated) → `"(untitled)"` |
| `permissionMode` | **last** `permission-mode` record → `permissionMode` | `"default"` |
| `lastActivity` (time) | last record `timestamp` | file mtime |
| `version`, `messageCount` | `system` / record fields | optional, shown subtly |

**Decisions / gotchas:**
- **Last** `permission-mode` wins. A session can change mode mid-run (observed up
  to 8 `permission-mode` records in one file); the mode it *ended* in best
  represents how it was operating. Revisitable.
- The prompt fallback for `title` must **skip meta / `<system-reminder>` /
  command-wrapper** user messages — otherwise titles leak injected text.
- Malformed JSONL lines are skipped, not fatal.

## 5. Architecture

Electron two-process split; main-process logic decomposed into small,
independently testable units.

| Module | Process | Responsibility | Depends on |
|---|---|---|---|
| `pathAdapter` | main | Resolve `~/.claude/projects`; OS-aware path handling | `os`, `path` |
| `sessionParser` | main | **Pure**: file lines → metadata object. No I/O. | — |
| `sessionStore` | main | Tiered scan, read files, call parser, cache by mtime | `fs`, `pathAdapter`, `sessionParser` |
| `terminalLauncher` | main | OS-aware: build launch command + spawn terminal at cwd | `child_process` (win/mac strategies behind one interface) |
| `settingsStore` | main | Read/write `settings.json` in Electron `userData` | `fs` |
| `ipc` (preload bridge) | preload | Expose `listSessions()` (streaming), `openSession(id)`, settings get/set (+ later `deleteSession`) | the above |
| `Sidebar` / tree | renderer | Expandable file tree of folders | IPC |
| `FolderHeader` + `SessionList` + `SessionRow` | renderer | Right-pane folder view | IPC |

Why this shape: `sessionParser` and the command-builder inside
`terminalLauncher` are pure → unit-testable with fixtures, no Electron runtime.
The two OS seams (path + terminal) are isolated so cross-platform differences
don't leak. Phases B/C extend `sessionStore` / `ipc` / renderer without
disturbing parsing or layout.

## 6. Progressive (tiered) scan

To stay responsive with thousands of sessions, `sessionStore` scans in two
phases:

1. **Stat pass (cheap):** `stat` every `.jsonl` for mtime only — no reads, no
   parsing. Bucket into age tiers.
2. **Parse pass (tiered, newest first):** parse and emit one tier before
   starting the next.

**Tiers (by mtime):** ≤ 1 day → ≤ 3 days → ≤ 7 days → ≤ 14 days → ≤ 30 days →
older than 30 days (final auto-loaded batch).

**Streaming IPC contract:** `listSessions()` is not a single return. Main emits a
`sessions:batch` event per tier (that tier's parsed sessions), then a final
`sessions:done`. The renderer appends each batch, builds/extends the tree,
sorts sessions **most-recent-first within each folder**, and shows a
"loading older sessions…" indicator until `done`.

**Caching:** parsed metadata is cached keyed by `filepath + mtime`. On refresh,
unchanged files resolve instantly; only new/modified files are re-parsed.

## 7. Reopen behavior

On double-click, `terminalLauncher` opens a new terminal window, `cd`'d into the
session's `cwd`, running:

```
<claudePath> --resume <sessionId> --permission-mode <mode>
```

- `<claudePath>` comes from `settingsStore` (default `"claude"`, resolved via
  PATH).
- `<mode>` maps directly to the CLI values: `default`, `acceptEdits`,
  `bypassPermissions`, `plan`.

**OS seam (`terminalLauncher`):**
- **Windows:** prefer Windows Terminal —
  `wt.exe -d "<cwd>" cmd /k <claudePath> --resume <id> --permission-mode <mode>`.
  Fallback when `wt` is absent:
  `cmd.exe /c start "" cmd /k "cd /d <cwd> && <claudePath> --resume <id> --permission-mode <mode>"`.
- **macOS:** AppleScript via `osascript` —
  `tell application "Terminal" to do script "cd <cwd> && <claudePath> --resume <id> --permission-mode <mode>"`.
  (iTerm support can come later; Terminal.app is the default.)

**Decisions / gotchas:**
- The command-string builder is a **pure function**
  `buildLaunchCommand(os, cwd, sessionId, mode, claudePath)`, separate from the
  actual spawn → unit-testable without launching anything.
- Per-OS quoting/escaping handled in the builder for **spaces + standard
  Win/Mac paths**. UNC paths (`\\server\share`) and non-ASCII paths are
  handled best-effort and **marked untested**.
- Spawn failure (`claude` not found, terminal missing) surfaces an error toast.

## 8. Settings

- `settingsStore` reads/writes `settings.json` in Electron `app.getPath('userData')`.
- MVP key: `claudePath` (default `"claude"`).
- Minimal in-app settings panel exposes the `claude` path field.
- Extensible in C (terminal preference, custom-label store, folder filters).

## 9. UI / layout

Slack / Claude-desktop aesthetic; OS-following light & dark themes.

```
┌─────────────────────────────────────────────────────────────┐
│ C  CSM · Claude Session Manager   [ search (C) ]   ⟳  ⚙  ◐   │  full-width title bar
├──────────────────────┬──────────────────────────────────────┤
│ Folders              │  D:\src\CSM                     ⟳     │  folder header (below title bar)
│ ▾ D:\                │  3 sessions · most recent first        │
│   ▾ src              ├──────────────────────────────────────┤
│       CSM        3   │  Plan Claude session manager app       │
│     ▸ PRism    174   │  [bypassPermissions] · just now · 877… │
│       …              │  ───────────────────────────────────  │
│ ▾ C:\               │  Recover Claude sessions from past day │
│   ▾ Users           │  [plan] · 2 hours ago · 1c9395ed       │
│     ▾ praty      9   │  …                                     │
│       …Temp   2508   │                                        │
│ ⟳ loading older…    │                                        │
└──────────────────────┴──────────────────────────────────────┘
```

- **Full-width app title bar** across the top: brand, global search (greyed,
  phase C), refresh, settings, theme toggle.
- **Left = expandable file tree**: drives → folders → subfolders with chevrons.
  Folders with sessions show a count and load their session list when clicked.
  **Intermediate folders with no sessions of their own** (e.g. `src`, `Users`)
  are pure navigation nodes — clicking expands rather than showing a list;
  sessions attach only to the actual `cwd` leaf. A "loading older sessions…"
  line shows while lower tiers stream in.
- **Right (below the title bar)**: a folder header (path + session count +
  per-folder refresh), then the session list. Each row: **description**, then
  **permission-mode chip · relative time · short session ID**. Hover highlight;
  **double-click → reopen**. Row-hover actions (Delete in B, ★ favorite in C)
  appear greyed as placeholders.

## 10. Phasing

- **A — MVP:** tiered progressive scan → file tree → folder header + session
  list (title · mode · time · short ID) → double-click reopen with same
  permission mode → configurable `claude` path → manual refresh.
- **B:** per-row **Delete** (deletes the `.jsonl`, with confirmation). Optional
  `fs.watch` auto-refresh.
- **C (end goal):** global **search**, **favorites / pinning**, **custom rename /
  labels** (stored in CSM's own `userData`, never mutating Claude's files), and a
  **hide temp / worktree folders** filter.

## 11. Testing

- `sessionParser` — fixture `.jsonl` → assert extracted fields & fallback chain
  (missing aiTitle, skip `<system-reminder>` meta, malformed lines,
  last-permissionMode wins).
- `buildLaunchCommand(...)` — assert exact command strings for Windows (wt +
  cmd fallback) and macOS (osascript), including space quoting. **No spawning.**
- `pathAdapter` — projects-dir resolution per OS.
- Lighter integration tests for `sessionStore` (tiering / caching) and IPC.

## 12. Error handling (fail soft)

- Malformed JSONL line → skip, continue parsing.
- Missing `cwd` → group under "(unknown)"; missing title → fallback → "(untitled)";
  missing mode → `default`.
- Spawn failure (`claude` not found / no terminal) → error toast, not silent.
- `~/.claude/projects` absent → friendly empty state ("No Claude sessions found").
- UNC / non-ASCII paths → best-effort, marked untested.

## 13. Open items / future

- Confirm exact `--permission-mode` value accepted by the installed Claude CLI
  version (`default` vs `normal`) during implementation.
- iTerm support on macOS (C+).
- "Hide temp / worktree folders" filter — the local machine has 2,500+ throwaway
  Temp sessions; this filter (C) keeps the tree usable.
