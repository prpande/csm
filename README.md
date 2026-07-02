# CSM — Claude Session Manager

A cross-platform (Windows + macOS) desktop app that makes it easy to find and
reopen **closed Claude Code sessions** on your machine. CSM lists every session
grouped by the root folder it was launched from — with its time, description, and
ID — and lets you double-click any session to reopen it in a new terminal,
**using the same permission mode** the session was running in.

> **Status:** Phase A (MVP), in progress. The architecture and behavior are
> specified in
> [`docs/specs/2026-06-30-csm-design.md`](docs/specs/2026-06-30-csm-design.md).
> The Electron shell, preload IPC bridge, React renderer scaffold, 3-OS CI, and
> packaging (installer + publish) are in place; the core session scan, file tree,
> session list, and reopen flow are being built out.

## Why CSM?

Claude Code already ships `claude --resume`, but it doesn't solve
discoverability and recovery across directories:

- The built-in picker is **directory-scoped** — to find a session elsewhere you
  have to `cd` into each directory and resume one at a time. There's no
  cross-directory "all my sessions" view.
- Resuming **doesn't restore the permission mode** the session ended in.

CSM adds:

1. A single **cross-directory** view of all local sessions, as an expandable file
   tree.
2. **One-click reopen** that launches each session in its correct working
   directory.
3. **Permission-mode preservation** — re-applies the mode the session was using.
4. **Crash / shutdown recovery** — when many sessions across many directories are
   lost at once, reopening them individually is tiresome; CSM is built for that.

## How it works

Claude Code stores session transcripts as JSONL files under
`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. CSM reads these read-only,
extracts each session's working directory, title, permission mode, and timestamp,
and presents them in a desktop UI. Reopening spawns a terminal that runs
`claude --resume <id> --permission-mode <mode>` in the session's directory.

CSM never modifies Claude's session files.

## Roadmap

- **Phase A (MVP):** progressive tiered scan, file-tree navigation, session list,
  double-click reopen with preserved permission mode (with a confirmation guard
  for `bypassPermissions`), configurable `claude` path, and a default-on
  hide-temp/worktree filter.
- **Phase B:** delete sessions, and multi-select **bulk reopen** for recovery.
- **Phase C:** global search, favorites/pinning, and custom labels.

## Tech

Electron (Node main process + HTML/CSS/JS renderer). Security is a first-class
concern: terminal launches use argv arrays (never interpolated shell strings),
session metadata is rendered as text (never `innerHTML`), and the renderer runs
with `contextIsolation` on and `nodeIntegration` off.

## Building from source

Requires Node (see [`.nvmrc`](.nvmrc)). Install dependencies with `npm install`,
then:

- **Build:** `npm run build` — compiles the main/preload processes and the
  renderer into `dist/`.
- **Run detached (dev):** `scripts/run-desktop.ps1` (Windows) or
  `scripts/run-desktop.sh` (macOS) builds and launches the app in the background,
  freeing your terminal. Pass `-SkipBuild` / `--skip-build` to launch without
  rebuilding.

For installing and running the unsigned preview builds (SmartScreen / Gatekeeper
steps, data locations), see [`TESTING.md`](TESTING.md).

## License

[Apache-2.0](LICENSE)
