# Testing CSM (desktop preview builds)

CSM's desktop builds are **unsigned** preview binaries for hands-on testing. Your OS will warn
you the first time you run one — that's expected for an unsigned app, not a sign that anything
is wrong. The steps below get you past it.

There is **no auto-update**. To update, download the latest build and reinstall.

CSM reads your closed Claude Code sessions **read-only** — it never modifies, moves, or deletes
Claude's session files. Its own state (see [Where is my data?](#where-is-my-data)) is separate.

## Windows

The release has two Windows builds — use whichever you prefer:

- **Portable** — `CSM <version>.exe`. Download and double-click; nothing is installed.
- **Installer** — `CSM Setup <version>.exe`. Runs a normal (per-user) install with a Start-menu
  entry and uninstaller.

Either way, Windows SmartScreen shows **"Windows protected your PC"** on first run:

1. Click **More info**.
2. Click **Run anyway**.
3. CSM opens and lists your closed sessions grouped by folder.

If your machine is managed by your employer (Intune/MDM) and "Run anyway" is missing or blocked,
your IT policy is blocking unsigned apps — ask the maintainer for a signed build.

## macOS (Apple Silicon)

> Intel (x86) Macs are **not supported** by this preview build — it's an Apple Silicon (arm64)
> binary only. On an Intel Mac, ask the maintainer for an x64 build.

1. Download `CSM-<version>-arm64.dmg`, open it, and drag **CSM** to Applications.
2. First launch: macOS says *"Apple could not verify 'CSM' is free of malware."*
   - **macOS Sonoma (14) or earlier:** Control-click the app → **Open** → **Open**.
   - **macOS Sequoia (15) or later:** **System Settings → Privacy & Security →** scroll to the
     CSM prompt → **Open Anyway** → authenticate.
3. If you instead see *"CSM is damaged and can't be opened"*, clear the quarantine flag in
   Terminal, then reopen:
   ```
   xattr -dr com.apple.quarantine /Applications/CSM.app
   ```
4. CSM opens and lists your closed sessions grouped by folder.

## Where is my data?

CSM stores its own state (config, and later favorites/labels) in your OS application-data
folder — the Electron default for this app:

- **Windows:** `%APPDATA%\csm` (e.g. `C:\Users\<you>\AppData\Roaming\csm`)
- **macOS:** `~/Library/Application Support/CSM`

Deleting that folder resets CSM to a first-run state. It does **not** touch your Claude sessions,
which CSM only ever reads from `~/.claude/projects/`.

## Running from source (contributors)

To build and launch a dev copy detached from your terminal:

- **Windows:** `scripts\run-desktop.ps1` (add `-SkipBuild` to re-launch without rebuilding)
- **macOS:** `./scripts/run-desktop.sh` (add `--skip-build` to re-launch without rebuilding)

Both preflight Node + npm, build, then launch the app detached. The launcher writes its own log
and pidfile to the repo-local `.dev-run/` folder; if the window never appears, check
`.dev-run/run-desktop.log`.
