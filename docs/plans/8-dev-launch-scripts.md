# Plan — Dev launch scripts + TESTING.md (#8)

## What / why

Give testers and contributors a **single command** that builds and launches the CSM
Electron app **detached** (the calling terminal is freed) on Windows and macOS, plus a
`TESTING.md` that walks a non-developer through running the **unsigned** preview builds
past SmartScreen / Gatekeeper.

Adapted from PRism's `scripts/run-desktop.{ps1,sh}`, **stripped of everything CSM
doesn't have**: no .NET sidecar, no `frontend`/`desktop` split, no publish RID. CSM is a
single root package — build = `npm run build` (tsc main/preload + Vite renderer), launch =
`electron .`.

## Scope decision: `-Clean` dropped

PRism's `-Clean` recursively wipes its data dir to clear the **DPAPI/Keychain auth token**
for a true first-run. CSM stores **no secrets** in `userData` (only favorites/labels/config/
window-state), so `-Clean` would be the lowest-value + highest-risk element (an `rm -rf` of a
computed path in a dev script). Neither acceptance criterion needs it. **Dropped** per
maintainer decision; deferral tracked in a follow-up issue. This removes the destructive
delete and its safe-target guard entirely.

## Files

- `scripts/run-desktop.ps1` — Windows launcher (WMI-detached).
- `scripts/run-desktop.sh` — macOS launcher (`nohup` + `disown`).
- `TESTING.md` — unsigned-install guidance + data/log locations.
- `.gitignore` — add `.dev-run/` (launcher log + pidfile live there).
- `README.md` — one-line pointer to the scripts + TESTING.md (optional, if it reads well).

## Behavior (both scripts)

1. **Preflight** — `node` + `npm` on PATH; on a miss, print copy/paste remediation
   (`winget install OpenJS.NodeJS.LTS` / `brew install node`; note CI builds on Node 24)
   and exit non-zero. No `dotnet` check (no sidecar).
2. **Single-instance short-circuit** — read a pidfile in `<repo>/.dev-run/`; if it names a
   live process, print "already running, nothing rebuilt" and exit 0 (avoids a multi-minute
   rebuild that would just hit Electron's own single-instance lock and quit). Non-destructive.
3. **Build** — unless `-SkipBuild` / `--skip-build`: `npm ci` then `npm run build`.
4. **Resolve** — the local `electron` binary (`node_modules/.bin/electron[.cmd]`); error with
   "run without -SkipBuild" if absent.
5. **Launch detached** —
   - **Windows:** author a disposable wrapper `.ps1` (owns the `*>>` log redirection, since a
     WMI `Win32_Process.Create` command line carries none), spawn it via WMI with the **same
     PowerShell host** that ran the launcher (so PS 5.1 testers need no PS 7), `ShowWindow=0`
     to suppress the stray console. Single-quote-double every interpolated path.
   - **macOS:** `nohup electron . >>log 2>&1 &` then `disown` (best-effort). `nohup` is the
     load-bearing detach.
6. Write the spawned pid to `<repo>/.dev-run/run-desktop.pid`; print where the log is and how
   to stop (close the window).

Launcher log + pidfile go in a repo-local, gitignored `.dev-run/` — decoupled from Electron's
`userData` (no fragile per-OS `userData` path computation needed in shell, and no `-Clean` to
couple them). `userData` is documented in TESTING.md for the tester's benefit only.

## Security invariants (from CLAUDE.md)

- **No shell string interpolation into the spawn.** Windows: the WMI wrapper is authored with
  single-quote-doubled paths; the WMI command line is `"host" -File "wrapper"` (system-derived
  paths, no user input). macOS: `electron` invoked as an argv, not a concatenated string.
- No untrusted input reaches these scripts (paths are repo-derived); still, quote defensively.

## Test list

- Pure helpers verified **in isolation** by dot-sourcing (no full-script run):
  - arg parsing (`-SkipBuild` / `--skip-build`; unknown flag rejected).
  - pid liveness (rejects empty / 0 / negative / non-numeric; accepts a live PID).
  - remediation text present.
- `npm run build` succeeds in the worktree (real).
- Windows: a real detached launch brings up the window and frees the terminal (real, on this
  machine); then re-run to confirm the single-instance short-circuit.
- macOS `.sh`: `bash -n` syntax check + shellcheck if available (can't run a mac GUI here);
  logic mirrors the verified Windows path.
- No Pester/bats harness shipped — CI runs only the Vitest matrix, and wiring a shell/PS test
  runner is out of scope for this p3 task (no destructive code remains to guard). Noted here as
  a deliberate omission.

## Deferrals (tracked in #38)

- `-Clean` first-run reset (dropped above).
- Formal Pester/bats test harness for the launchers in CI.
