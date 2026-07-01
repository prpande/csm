#!/usr/bin/env bash
# Build-and-run the CSM desktop (Electron) app on macOS, detached.
# One command for testers and contributors: preflight (Node + npm with remediation),
# build the app (`npm run build` -> dist/main.js, dist/preload.js, dist/renderer/**), then
# launch `electron .` DETACHED via nohup+disown so the calling terminal is freed. Closing the
# window stops the app.
#
# CSM has no sidecar and no secrets in its data dir, so there is no --clean flag (unlike PRism's
# launcher this was adapted from). The launcher's own log + pidfile live in the repo-local,
# gitignored .dev-run/ directory.
#
# Usage:
#   ./scripts/run-desktop.sh              # build + launch
#   ./scripts/run-desktop.sh --skip-build # launch the current dist/ output

# ---- pure helpers (sourceable; no side effects at source time) ----

node_remediation() {
  cat >&2 <<'EOF'
Node.js / npm was not found on PATH.
  macOS: brew install node
  (or download from https://nodejs.org/ — CI builds on Node 24, the recommended version)
After installing, open a new terminal so PATH refreshes, then re-run this script.
EOF
}

# Pure, position-independent arg parser (testable). Echoes "skip=<0|1>" for the recognized flag
# set, or "error:<arg>" for the first unrecognized option — main() turns an "error:" result into
# a usage error + exit (rather than silently ignoring a typo'd flag and doing a full build).
resolve_args() {
  local a skip=0
  for a in "$@"; do
    case "$a" in
      --skip-build) skip=1 ;;
      *) echo "error:$a"; return 0 ;;
    esac
  done
  echo "skip=$skip"
}

# Liveness check for the single-instance pidfile. Returns 0 (live) only when $1 is a
# positive-integer PID of a running process. The format gate is load-bearing, not cosmetic:
# `kill -0 0` (signal to the caller's process group) and `kill -0 -1` (signal to every process)
# both SUCCEED, so a pidfile containing 0 or a negative value would otherwise read as "running"
# and wrongly block a relaunch.
pid_is_live() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1        # reject empty / 0 / negative / non-numeric
  kill -0 "$pid" 2>/dev/null
}

main() {
  set -euo pipefail

  # --skip-build is position-independent (parity with the Windows -SkipBuild switch); unknown
  # flags are rejected, not silently ignored.
  local parsed
  parsed="$(resolve_args "$@")"
  if [[ "$parsed" == error:* ]]; then
    echo "Unknown option: ${parsed#error:}" >&2
    echo "Usage: run-desktop.sh [--skip-build]" >&2
    exit 1
  fi
  local skip_build=0 kv
  for kv in $parsed; do
    case "$kv" in
      skip=*) skip_build="${kv#skip=}" ;;
    esac
  done

  local repo_root run_dir log pidfile
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  run_dir="$repo_root/.dev-run"
  log="$run_dir/run-desktop.log"
  pidfile="$run_dir/run-desktop.pid"

  # --- single-instance short-circuit BEFORE any work, so a re-run while the app is up exits
  #     fast instead of rebuilding (minutes) only to hit Electron's own single-instance lock. ---
  if [[ -f "$pidfile" ]]; then
    local existing_pid
    existing_pid="$(cat "$pidfile" 2>/dev/null || true)"
    # kill -0 is a liveness check. No process-name recycle guard here (parity with PRism's
    # macOS launcher): Electron's own single-instance lock is the backstop, and the message
    # prints the pidfile path so a recycled-PID false positive is self-recoverable.
    if pid_is_live "$existing_pid"; then
      echo "CSM desktop is already running (pid $existing_pid, pidfile $pidfile). Close the window first; a re-run would just refocus it. Nothing rebuilt. If it is NOT running, delete that pidfile and retry." >&2
      exit 0
    fi
  fi

  mkdir -p "$run_dir"

  # --- preflight: Node + npm presence (CSM builds with Node only; no .NET sidecar) ---
  command -v node >/dev/null 2>&1 || { node_remediation; exit 1; }
  command -v npm  >/dev/null 2>&1 || { node_remediation; exit 1; }

  if [[ "$skip_build" -eq 0 ]]; then
    # npm install (not npm ci): a dev launcher is run repeatedly, and install is a near-no-op
    # when the lockfile and node_modules already agree — no nuke-and-repave each run. CI uses
    # npm ci for bit-exact reproducibility; a local launcher optimizes for fast iteration.
    ( cd "$repo_root" && npm install && npm run build )
  fi

  local electron
  electron="$repo_root/node_modules/.bin/electron"
  [[ -x "$electron" ]] || { echo "Electron not found at $electron. Run without --skip-build so 'npm install' installs it." >&2; exit 1; }

  # --- Launch detached. nohup is the load-bearing detach (Electron ignores SIGHUP); disown
  #     additionally drops the job from the shell's table. disown is best-effort: in a
  #     non-interactive shell with job control disabled it can return non-zero, which under
  #     `set -e` would fail this subshell and make the launcher report an error even though
  #     nohup already started Electron — so `|| true` keeps it non-fatal. ---
  echo "=== run-desktop launch @ $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >>"$log"
  (
    cd "$repo_root"
    nohup "$electron" . >>"$log" 2>&1 &
    echo $! >"$pidfile"
    disown 2>/dev/null || true
  )

  echo "CSM desktop launching (detached). The window should appear shortly."
  echo "  If the window never appears, see: $log"
  echo "  Close the window to stop."
  echo "  Gatekeeper note: if macOS blocks Electron on first run, right-click the app and choose Open,"
  echo "  or run: xattr -dr com.apple.quarantine \"$repo_root/node_modules/electron\""
}

# Run main only when executed directly, not when sourced by a test harness.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
