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

### 2.1 Why CSM (vs the built-in `claude --resume`)

The Claude CLI can already resume a conversation, but it does not solve the
problem CSM targets — **discoverability and recovery across directories**.
Verified against the installed CLI:

- The built-in picker is **directory-scoped**: `--continue` is explicitly the
  current directory, and the `--resume` picker surfaces the current project's
  sessions. To find a session elsewhere you must `cd` into each directory and
  resume one at a time. There is **no cross-directory "all my sessions" view**.
- Resuming does **not** restore the permission mode the session ended in — the
  caller must re-supply `--permission-mode`.

CSM's value is therefore: (1) a single **cross-directory** view of all sessions,
(2) launching each in its **correct `cwd`**, (3) re-applying the session's
**original permission mode**, and (4) **crash/shutdown recovery** — when many
sessions across many directories are lost at once, reopening them individually via
the built-in flow is tiresome. (4) motivates a **bulk/multi-select reopen**
capability — see §10.

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
| `title` (description) | **last** `custom-title` → `customTitle` (the /rename name), leading, composed with the descriptor below | descriptor = `ai-title` → `summary` → first non-meta `user` prompt (truncated); `name — descriptor` when both, either alone at the edges, `"(untitled)"` when neither |
| `permissionMode` | **last** `permission-mode` record → `permissionMode` | `"default"` |
| `lastActivity` (time) | last record `timestamp` | file mtime |
| `gitBranch` | **last** record `gitBranch` field | `null` when absent |
| `version`, `messageCount` | `system` / record fields | optional, shown subtly |

**Decisions / gotchas:**
- **Last** `permission-mode` wins. A session can change mode mid-run (observed up
  to 8 `permission-mode` records in one file); the mode it *ended* in best
  represents how it was operating. Revisitable.
- **`permissionMode` is its own dimension, distinct from the `mode` record.** The
  `permission-mode` record carries CLI-valid values; verified against real data
  the value set is `default`, `acceptEdits`, `bypassPermissions`, **`auto`** (and
  the CLI also accepts `dontAsk`). `auto` is common in real sessions (~100+
  occurrences observed) and **must not be dropped**. The separate
  `{"type":"mode","mode":"normal"|"plan"}` record is a *different* dimension and
  is **not** used for `--permission-mode`.
- **Pass the parsed `permissionMode` through unchanged** to the launcher (it is
  already CLI-valid). Fall back to `default` only when the field is absent or the
  value is not in the known CLI set — never silently coerce a recognized value.
- The prompt fallback for `title` must **skip meta / `<system-reminder>` /
  command-wrapper** user messages — otherwise titles leak injected text.
- **A session rename (`/rename`) writes a `custom-title` record; it LEADS the
  title** (#176). Read **last**-wins — a rename repeats and can change value
  mid-session (unlike `ai-title`/`summary`, which never do, so those stay
  first-wins). The user-assigned name and the derived descriptor are composed
  (`name — descriptor`) rather than the name replacing the descriptor: names are
  reused as topic tags, so on a real corpus ~44% of named sessions share a name
  with another in the same folder, and keeping the descriptor is what tells them
  apart. The name leads and always survives the shared `TITLE_MAX_LENGTH` budget;
  the descriptor absorbs any truncation.
- **`gitBranch`** is the branch the session ran on, captured in-file per record;
  **last non-null wins** (a session can switch branches mid-run), `null` when no
  record carries it. Historical and available even when the folder was later
  deleted, so it is the correct source for a worktree's branch label — better
  than reading live `git HEAD` (which fails for removed worktrees). Powers the
  worktree roll-up label (§9) and the row-branch / repo-marker features (#110,
  #111).
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
| `ipc` (preload bridge) | preload | Expose `listSessions(listener)` (streaming), `reopenSession(req: { cwd, sessionId, mode })` → `{ ok: true } \| { ok: false, code }`, settings get/set (+ later `deleteSession`) | the above |
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

**Render virtualization (required):** tiered scanning controls *load order*, not
the number of DOM nodes. A folder can hold thousands of sessions (the local
machine has a Temp folder with 2,500+), so the right-pane `SessionList` MUST use
a **windowed/virtualized list** (fixed row height, only visible rows mounted).
Without it, selecting a large folder mounts every row at once and freezes the
renderer — defeating the responsiveness goal. The tree sidebar should likewise
avoid mounting collapsed subtrees.

**Live-session note:** a `.jsonl` with a very recent mtime may belong to a
*running* session (this tool targets closed sessions — §2). MVP does not hard-block
this, but resuming a live session can produce two processes appending the same
file; flagging/guarding likely-live sessions is tracked as a follow-up.

## 7. Reopen behavior

On double-click, `terminalLauncher` opens a new terminal window, `cd`'d into the
session's `cwd`, running:

```
<claudePath> --resume <sessionId> --permission-mode <mode>
```

- `<claudePath>` comes from `settingsStore` (default `"claude"`, resolved via
  PATH).
- `<mode>` is the parsed `permissionMode`, passed through unchanged (see §4.1).

**Security — no shell string interpolation (required).** `cwd`, `sessionId`, and
`claudePath` are read from on-disk content / user settings and are **untrusted**;
they MUST NOT be concatenated into a shell command string. A crafted `cwd` such
as `/x" & (do shell script "rm -rf ~") & "` would otherwise execute arbitrary
code on double-click. Rules:
- Spawn via `child_process.spawn(file, argsArray, { cwd, shell: false })` —
  arguments are discrete array elements, never a single interpolated string. Use
  the `cwd` *option* to set the working directory rather than a `cd …` prefix.
  `claudePath` is the `file` argument, never embedded in a string.
- Validate `sessionId` against a strict UUID pattern before use; reject otherwise.
- For the macOS `osascript` path, the AppleScript text is built in JS and passed
  as `spawn('osascript', ['-e', script])`; any value embedded in a `do script
  "…"` literal must have `\` → `\\` and `"` → `\"` escaped first.

**OS seam (`terminalLauncher`)** — each strategy assembles an **argv array**, not
a string:
- **Windows:** prefer Windows Terminal — `wt.exe` with `-d <cwd>` then the
  `claudePath --resume <id> --permission-mode <mode>` argv. Fallback when `wt` is
  absent: launch a `cmd.exe` window with the same argv and `cwd` set via the spawn
  option.
- **macOS:** `osascript -e <script>` where `<script>` is `tell application
  "Terminal" to do script "…"` with the cwd-change and `claude` invocation built
  from **escaped** values. (iTerm later; Terminal.app is the default.)

**Decisions / gotchas:**
- The argv/script builder is a **pure function**
  `buildLaunchSpec(os, cwd, sessionId, mode, claudePath)` returning
  `{ file, args }` (and the escaped AppleScript for macOS), separate from the
  actual spawn → unit-testable, and the **escaping/injection tests live here**
  (quotes, `&`, `$`, backticks, spaces, UNC, non-ASCII).
- **`bypassPermissions` safeguard:** when the session's mode is
  `bypassPermissions`, interpose a **confirmation modal** before spawning — it
  names the consequence (all tool calls auto-approved) and offers a one-click
  **downgrade to `acceptEdits`/`default`**. All other modes reopen directly. This
  guards against an accidental double-click launching an unsupervised agent
  (`bypassPermissions` is the dominant stored mode). Bulk reopen (§10) applies the
  same gate once for any bypass sessions in the batch. **Button treatment:** the
  safe downgrade is the dominant full-width accent primary and keeps initial
  focus; the risky bypass and Cancel share a compact second row, with bypass a
  red **outline that only fills on hover** (never the resting look) and Cancel a
  quiet ghost. Escape still cancels.
- **Stale / missing `cwd`:** `stat` the session's `cwd` before launching. If it no
  longer exists (worktrees and Temp dirs are frequently deleted), surface a
  specific "folder no longer exists" error instead of attempting the spawn.
- Spawn failure (`claude` not found, terminal missing) surfaces an error toast.
- UNC (`\\server\share`) and non-ASCII paths: covered by argv-array passing (no
  shell parsing), but still **marked lower-confidence / explicitly tested**.

## 8. Settings

- `settingsStore` reads/writes `settings.json` in Electron `app.getPath('userData')`.
- MVP key: `claudePath` (default `"claude"`).
- **Settings surface:** a **modal dialog** opened by the title-bar gear, with a
  labeled text input for the `claude` path, **Save** / **Cancel**, an inline
  validation error when the path can't be resolved, and the resolved absolute
  path shown back (so tampering with `settings.json` is detectable). A brief toast
  confirms a successful save.
- `claudePath` is always passed as the discrete `file` argument to `spawn` (§7) —
  never interpolated into a command string.
- Extensible in C (terminal preference, custom-label store, folder filters).

## 9. UI / layout

Warm **Clay** palette — a burnt-terracotta lean that keeps CSM visibly related
to Claude without copying its coral (adopted in #78); OS-following light & dark
themes. Every colour routes through semantic tokens in `styles/global.css`, so a
palette swap is a one-file value edit.

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
  phase C), refresh, settings, theme toggle. The bar carries a **brand-orange
  tint** (`--bg-titlebar`, warm per theme) plus a solid `--accent` bottom-border
  so it reads as branded and stays distinct from the pane surfaces, while the
  child controls keep their own surfaces and stay contrast-safe.
- **Left = expandable file tree**: drives → folders → subfolders with chevrons.
  Folders with sessions show a count and load their session list when clicked.
  **Intermediate folders with no sessions of their own** (e.g. `src`, `Users`)
  are pure navigation nodes — clicking expands rather than showing a list;
  sessions attach only to the actual `cwd` leaf. A "loading older sessions…"
  line shows while lower tiers stream in.
- **Right (below the title bar)**: a folder header (path + session count +
  per-folder refresh) — the path carries a small **"Folder" eyebrow** and sits
  on an elevated surface so it reads distinctly from the rows below — then the
  (virtualized — §6) session list. Each row: **description**, then
  **permission-mode chip · relative time · short session ID** (`sessionId` shown
  as the first 8 chars), and a trailing **"Open" button** that makes the reopen
  action discoverable (it routes through the same reopen path as double-click,
  including the `bypassPermissions` confirmation). **Single-click selects** a row
  (persistent highlight, distinct from hover, themed for both modes);
  **double-click → reopen**. No B/C placeholder actions in the MVP — the Delete
  (B) and ★ favorite (C) controls are added with the features that back them.
- **Permission-mode chips are colour-coded by risk**, not uniform:
  `bypassPermissions` = red/danger (held clear of the warm accent),
  `acceptEdits`/`auto` = teal/info, `plan` = violet, `default` = grey. Tokens
  defined for both themes. (The risk colouring
  pairs with the bypass-reopen safeguard — see §7 follow-ups.)
- **Empty / non-leaf states:** on launch (nothing selected) the right pane shows a
  centered "Select a folder to view its sessions" prompt and **no** folder header.
  Clicking an intermediate navigation node (e.g. `src`, `Users`) expands it and
  leaves the same empty state — it does not aggregate descendant sessions.
- **Worktree roll-up + declutter toggle** (#101/#69, see
  `2026-07-06-worktree-rollup-and-filter.md`): by default the tree hides
  temp-rooted folders and `.../.claude/worktrees/<name>` nodes, and folds each
  worktree session into its **owning project** node (the path before `.claude`),
  where the folder pane shows it alongside the project's own sessions with a
  branch/name chip (from `gitBranch`). A single global toggle switches to the raw
  structure (temp + worktree nodes shown, roll-up suppressed). This worktree fold
  is the one deliberate exception to "does not aggregate descendant sessions" —
  scoped to worktrees, never generic recursion.
- **The `(unknown)` folder group is pinned to the bottom** of the tree, after all
  named entries, so it never interrupts drive-based navigation.
- **Keyboard navigation:** Up/Down move within the focused pane (tree nodes or
  list rows); Right/Left (or Space) expand/collapse a tree node or move to parent;
  Tab/Shift-Tab move focus between tree and list; **Enter opens the focused
  session** (keyboard equivalent of double-click). Focus lands on the tree on
  launch; rows and nodes show a visible focus ring.
- **Per-folder refresh** (folder-header ⟳) is **disabled while that folder's tier
  is still streaming**; once its tier completes it re-stats/re-parses only that
  folder, without disturbing other in-progress tiers. The title-bar ⟳ refreshes
  everything.
- **Rendering safety:** all session metadata (title, cwd, ID, mode label) is
  inserted via `textContent` / text nodes — **never `innerHTML`** — since titles
  can fall back to arbitrary user-prompt text (prevents renderer XSS).

## 10. Phasing

- **A — MVP:** tiered progressive scan → file tree → folder header + session
  list (title · mode · time · short ID) → double-click reopen with same
  permission mode (with the `bypassPermissions` confirmation, §7) → configurable
  `claude` path → manual refresh → **default-on "hide temp / worktree folders"
  filter** (sessions whose `cwd` is under a system temp dir or inside a
  `.../.claude/worktrees/` or git-worktree path are hidden, with a toggle to show
  them). The filter ships in the MVP because the tree is otherwise dominated by
  thousands of throwaway sessions on day one. Co-designed with the worktree
  roll-up as one declutter/raw toggle — see §9 and
  `2026-07-06-worktree-rollup-and-filter.md`. This slice covers the
  `.claude/worktrees` convention purely; generic (I/O-probed) worktrees are
  deferred to #56/#91.
- **B:** per-row **Delete** (deletes the `.jsonl`, with confirmation). The
  main-process `deleteSession` handler MUST resolve the target path and verify it
  stays within `~/.claude/projects/` before `fs.unlink` (no path traversal).
  **Multi-select + bulk reopen** ("recovery") — select multiple sessions (e.g. all
  recent in a folder) and reopen them in one action, applying the
  `bypassPermissions` gate once for the batch; this is the primary answer to the
  crash/shutdown recovery motivation (§2.1). Optional `fs.watch` auto-refresh.
- **C (end goal):** global **search**, **favorites / pinning**, and **custom
  rename / labels** (stored in CSM's own `userData`, never mutating Claude's
  files). (The hide-temp/worktree filter moved to the MVP.)

## 11. Testing

- `sessionParser` — fixture `.jsonl` → assert extracted fields & fallback chain
  (missing aiTitle, skip `<system-reminder>` meta, malformed lines,
  last-permissionMode wins, `auto`/`dontAsk` passed through, unknown value →
  `default`).
- `buildLaunchSpec(...)` — assert the exact `{ file, args }` argv (and escaped
  AppleScript) for Windows (wt + cmd fallback) and macOS. **Injection/escaping is
  the core case set**: quotes, `&`, `$`, backticks, spaces, UNC, non-ASCII; assert
  no shell metacharacter ever lands in an interpreted position. `sessionId` UUID
  validation rejects malformed IDs. **No spawning.**
- `pathAdapter` — projects-dir resolution per OS.
- Lighter integration tests for `sessionStore` (tiering / caching) and IPC; smoke
  test that the `SessionList` virtualizes (bounded mounted-row count) on a large
  fixture.

## 12. Error handling (fail soft)

- Malformed JSONL line → skip, continue parsing.
- Missing `cwd` → group under "(unknown)" (pinned to tree bottom, §9); missing
  title → fallback → "(untitled)"; missing or unrecognized mode → `default`.
- Session `cwd` no longer exists on disk → on reopen, "folder no longer exists"
  error (stat before spawn, §7); the row still lists normally.
- Spawn failure (`claude` not found / no terminal) → error toast, not silent.
- `~/.claude/projects` absent → friendly empty state ("No Claude sessions found").
- UNC / non-ASCII paths → passed as argv (no shell parsing); explicitly tested.

## 13. Open items / future

- **Resolved (verified against installed CLI):** `--permission-mode` accepts
  `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`. The
  value is `default` (not `normal`); `normal` belongs to the unrelated `mode`
  record and is never used for `--permission-mode`. `--resume <id>`,
  `--permission-mode`, and `-d` are all confirmed to exist.
- **Resolved — `bypassPermissions` reopen safeguard:** confirmation modal with
  downgrade option, MVP scope (§7, §9).
- **Resolved — temp/worktree filter timing:** default-on filter moved into the
  MVP (§10).
- **Resolved — value vs built-in `claude --resume`:** the built-in is
  directory-scoped and does not restore the original permission mode; CSM adds
  cross-directory discovery, correct-cwd launch, mode preservation, and bulk
  recovery (§2.1). GUI/Electron form factor retained.
- CLI **version drift**: the per-session `version` is stored but unused; a future
  guard could warn when a session's CLI version diverges from the installed one.
- iTerm support on macOS (C+).
