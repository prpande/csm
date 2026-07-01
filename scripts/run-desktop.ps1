#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build-and-run the CSM desktop (Electron) app on Windows, detached.
.DESCRIPTION
    One command for testers and contributors: preflight (Node + npm with remediation),
    build the app (`npm run build` -> dist/main.js, dist/preload.js, dist/renderer/**),
    then launch `electron .` DETACHED via a WMI wrapper so the calling terminal is freed.
    Closing the window stops the app.

    Runs under the built-in Windows PowerShell (5.1) as well as PowerShell 7+ — no
    `#requires -Version 7`, no `$IsWindows` (a 6+ automatic var), and the detached wrapper
    is spawned via the SAME host that launched this script, so PowerShell 7 is not needed.
    A tester can paste `scripts\run-desktop.ps1` straight into a default Windows PowerShell
    prompt.

    CSM has no sidecar and no secrets in its data dir, so there is no -Clean flag (unlike
    PRism's launcher this was adapted from). The launcher's own log + pidfile live in the
    repo-local, gitignored .dev-run\ directory.
.PARAMETER SkipBuild
    Skip the build step and launch against the current dist\ output. For fast re-launches
    once a build is current.
.EXAMPLE
    scripts\run-desktop.ps1
.EXAMPLE
    scripts\run-desktop.ps1 -SkipBuild
#>
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Pure, dot-sourceable helpers below. The main-guard at the bottom keeps them
# importable (dot-sourced) for isolated testing without executing the launch.
# ---------------------------------------------------------------------------

function Get-NodeRemediation {
    return @'
Node.js / npm was not found on PATH.
  Windows: winget install OpenJS.NodeJS.LTS
  (or download from https://nodejs.org/ — CI builds on Node 24, the recommended version)
After installing, open a new terminal so PATH refreshes, then re-run this script.
'@
}

function Test-OnWindows {
    # True when running on Windows, across BOTH Windows PowerShell 5.1 and PowerShell 7+.
    # `$IsWindows` is a 6+ automatic variable — under 5.1 it is undefined ($null). `$env:OS`
    # is 'Windows_NT' on every Windows host regardless of PowerShell edition, and unset on
    # macOS/Linux, so it is the edition-agnostic signal. Injectable for testing.
    param([string]$OsEnv = $env:OS)
    return $OsEnv -eq 'Windows_NT'
}

function Get-PowerShellHostPath {
    # Full path to the PowerShell host that should run the detached wrapper. Prefer the host
    # running THIS launcher, so a tester on Windows PowerShell 5.1 spawns powershell.exe and a
    # pwsh user spawns pwsh.exe — the wrapper is edition-agnostic (only cd's and runs electron
    # with *>>), so either host works and PowerShell 7 is NOT required. Falls back to
    # powershell.exe (always present on Windows). Injectable for tests.
    param([string]$CurrentHostPath = (Get-Process -Id $PID -ErrorAction SilentlyContinue).Path)
    if ($CurrentHostPath -and (Test-Path -LiteralPath $CurrentHostPath)) { return $CurrentHostPath }
    $fallback = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
    if ($fallback) { return $fallback.Source }
    return 'powershell.exe'
}

function New-DesktopLauncherWrapper {
    # Build the disposable wrapper .ps1 launched via WMI. A Win32_Process.Create command line
    # carries NO redirection operators, so the wrapper owns its own *>> redirection: it cd's to
    # the repo root and runs `electron .` with output redirected to the log. Single-quote every
    # interpolated path (doubling embedded quotes) so a space/quote in a path cannot break the
    # script.
    param(
        [string]$ElectronExe,
        [string]$RepoRoot,
        [string]$Log,
        [string]$StartedUtc
    )
    $qLog      = "'" + ($Log -replace "'", "''") + "'"
    $qRepo     = "'" + ($RepoRoot -replace "'", "''") + "'"
    $qElectron = "'" + ($ElectronExe -replace "'", "''") + "'"
    return @"
# run-desktop.wrapper.ps1 -- AUTHORED AT RUNTIME, disposable, overwritten each launch.
# Owns its own redirection so the WMI command line carries none.
`$ErrorActionPreference = 'Stop'
`$log = $qLog
"=== run-desktop launch @ $StartedUtc ===" *>> `$log
Set-Location $qRepo
& $qElectron . *>> `$log
"@
}

function Get-LauncherPidfilePath {
    param([string]$RunDir)
    return (Join-Path $RunDir 'run-desktop.pid')
}

function Write-LauncherPidfile {
    param([string]$PidfilePath, [int]$ProcessId)
    [System.IO.File]::WriteAllText($PidfilePath, "$ProcessId", [System.Text.UTF8Encoding]::new($false))
}

function Test-LauncherAlreadyRunning {
    # True only if the pidfile names a LIVE process whose name is in $ExpectedNames. A 32-bit
    # PID recycles fast, so a stale pidfile PID may now be an unrelated app — the name check
    # guards that. The wrapper host stays alive as electron's parent, so that host is the live
    # owner: 'pwsh' when launched from PowerShell 7, 'powershell' from the built-in 5.1 (see
    # Get-PowerShellHostPath). 'electron' is included defensively.
    param([string]$PidfilePath, [string[]]$ExpectedNames = @('pwsh', 'powershell', 'electron'))
    if (-not (Test-Path -LiteralPath $PidfilePath)) { return $false }
    $raw = Get-Content -LiteralPath $PidfilePath -Raw -ErrorAction SilentlyContinue
    if (-not ($raw -match '^\s*(\d+)\s*$')) { return $false }
    $procId = [int]$Matches[1]
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    return $ExpectedNames -contains $p.Name
}

function Assert-Platform {
    if (-not (Test-OnWindows)) {
        throw "run-desktop.ps1 is the Windows launcher. On macOS run scripts/run-desktop.sh instead."
    }
    # The detached launch spawns via WMI (Win32_Process.Create). A locked-down sandbox or
    # container may lack WMI; probe cheaply and fail HERE (before the multi-minute build) with a
    # clear message rather than deep inside the launch with a cryptic Invoke-CimMethod error.
    try {
        $null = Get-CimClass -ClassName Win32_Process -ErrorAction Stop
    } catch {
        throw "WMI (Win32_Process) is not reachable in this environment, so the detached launch cannot spawn. Underlying error: $($_.Exception.Message)"
    }
}

function Assert-CommandPresent {
    param([string]$Name, [string]$Remediation)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host $Remediation -ForegroundColor Yellow
        throw "Preflight failed: '$Name' not found on PATH."
    }
}

function Invoke-Preflight {
    # CSM builds with Node + npm only (no .NET sidecar). On a miss, print remediation and throw.
    Assert-CommandPresent -Name 'node' -Remediation (Get-NodeRemediation)
    Assert-CommandPresent -Name 'npm'  -Remediation (Get-NodeRemediation)
}

function Invoke-Main {
    param([switch]$SkipBuild)
    Assert-Platform
    $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $runDir   = Join-Path $repoRoot '.dev-run'
    $log      = Join-Path $runDir 'run-desktop.log'
    $pidfile  = Get-LauncherPidfilePath -RunDir $runDir

    # Single-instance short-circuit: a re-run while the app is up would rebuild (minutes) only
    # to hit Electron's own single-instance lock and quit. Bail early instead.
    if (Test-LauncherAlreadyRunning -PidfilePath $pidfile) {
        Write-Host "CSM desktop is already running (pidfile $pidfile). Close the window first; a re-run would just refocus it. Nothing rebuilt. If it is NOT running, delete that pidfile and retry." -ForegroundColor Yellow
        return
    }

    New-Item -ItemType Directory -Force $runDir | Out-Null

    Invoke-Preflight

    if (-not $SkipBuild) {
        Push-Location $repoRoot
        try {
            npm ci;        if ($LASTEXITCODE -ne 0) { throw "npm ci failed ($LASTEXITCODE)." }
            npm run build; if ($LASTEXITCODE -ne 0) { throw "npm run build failed ($LASTEXITCODE)." }
        } finally { Pop-Location }
    }

    $electron = Join-Path $repoRoot 'node_modules\.bin\electron.cmd'
    if (-not (Test-Path -LiteralPath $electron)) {
        throw "Electron not found at $electron. Run without -SkipBuild so 'npm ci' installs it."
    }

    # Author the wrapper (owns the log redirection), spawn it detached via WMI.
    $startedUtc  = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    $wrapperPath = Join-Path $runDir 'run-desktop.wrapper.ps1'
    $wrapper     = New-DesktopLauncherWrapper -ElectronExe $electron -RepoRoot $repoRoot -Log $log -StartedUtc $startedUtc
    [System.IO.File]::WriteAllText($wrapperPath, $wrapper, [System.Text.UTF8Encoding]::new($false))

    # Spawn with the SAME PowerShell host running this launcher, so a 5.1 tester needs no PS 7.
    # $hostExe is a full path that may contain spaces (e.g. C:\Program Files\...), so quote it.
    # $wrapperPath is under .dev-run\ — a repo-derived path that never contains a double-quote,
    # so wrapping it in `"..."` is safe (the wrapper's own internal paths use single-quote
    # doubling for defense in depth).
    $hostExe = Get-PowerShellHostPath
    $cmd = "`"$hostExe`" -NoProfile -ExecutionPolicy Bypass -File `"$wrapperPath`""
    # Hide the wrapper host's console window. WMI's provider host (WmiPrvSE) has no console, so a
    # console app spawned via Win32_Process.Create gets a FRESH, visible terminal that lingers
    # for the wrapper's whole life. The wrapper needs no console (output is redirected), so
    # SW_HIDE (ShowWindow=0) suppresses the stray window. (CreateFlags=CREATE_NO_WINDOW is
    # rejected by the WMI provider with ReturnValue=21, so ShowWindow is the usable lever.)
    $startupInfo = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly `
        -Property @{ ShowWindow = [uint16]0 }
    $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
        -Arguments @{ CommandLine = $cmd; CurrentDirectory = $repoRoot; ProcessStartupInformation = $startupInfo }
    if ($res.ReturnValue -ne 0) {
        throw "WMI Win32_Process.Create refused to spawn the wrapper (ReturnValue=$($res.ReturnValue))."
    }
    Write-LauncherPidfile -PidfilePath $pidfile -ProcessId ([int]$res.ProcessId)

    Write-Host "CSM desktop launching (detached). The window should appear shortly." -ForegroundColor Green
    Write-Host "  If it stays blank or never appears, inspect: $log" -ForegroundColor DarkGray
    Write-Host "  Close the window to stop." -ForegroundColor DarkGray
}

# --- main (skipped when dot-sourced for isolated testing) ---
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-Main -SkipBuild:$SkipBuild
}
