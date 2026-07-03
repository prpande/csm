# Spec — impure `terminalLauncher` spawn layer (`reopenSession`)

**Date:** 2026-07-03
**Issue:** #52 · **Follow-on to:** #51 (pure `buildLaunchSpec`)
**Area:** `area:launcher` (security-sensitive) · **Tier:** High-risk
**Parent design:** `docs/specs/2026-06-30-csm-design.md` §7 (Reopen behavior)

## 1. Scope

The **impure** half of the launcher: consume the pure `buildLaunchSpec` output
(macOS) or build the Windows argv, then actually open a terminal. This is the
I/O + spawn layer that #51 carved out because its Windows safety can only be
proven with a real `cmd.exe` re-parse, not in a pure unit.

In scope (issue #52 acceptance criteria):

1. `spawn(file, args, { cwd, shell:false, detached, stdio })` of the launch.
2. Windows **`cmd.exe` launch + fallback** with metacharacter rejection,
   integration-tested on real Windows.
3. `.cmd` shim handling for a bare `claude` on PATH.
4. **`wt.exe` presence** handled gracefully (wt-vs-cmd decision).
5. **`stat` the `cwd` before launch** → specific "folder no longer exists" error.
6. **Spawn-failure** → typed error surface, no crash.

Out of scope (§6).

## 1.1 What the doc-review changed (read this first)

The four-lens high-risk doc-review (adversarial + feasibility + security + scope)
**empirically tested the original design on real Windows 11 / Node 24** and
invalidated its Windows mechanics. Verified facts (confidence 100 unless noted):

- **Node 24 refuses to `spawn` a `.cmd`/`.bat` with `shell:false`** (`EINVAL`,
  CVE-2024-27980 hardening); `.ps1` fails `EFTYPE`. Only `.exe` is directly
  spawnable. The default `claude` on PATH is `claude.cmd` → "resolve and spawn
  the shim directly" is a dead end.
- **`wt.exe` is a WindowsApps App Execution Alias** (0-byte reparse point):
  `fs.stat`/`access` return `ENOENT`, so stat-based presence detection reports
  it *absent when installed*; spawning its resolved absolute path also `ENOENT`s.
  Only spawning the **bare name** `wt.exe` works.
- **`cmd.exe /k <claude> …` is the one reliable Windows launch**: `cmd.exe`
  resolves the `.cmd` shim via PATHEXT and runs it, a spaced path survives Node's
  argv quoting, and `spawn('cmd.exe', …)` does **not** trip the EINVAL guard
  (only *direct* `.cmd` spawns do). `%VAR%` expansion through cmd is real (so `%`
  rejection is load-bearing); `()` are inert inside Node's quoting.

Design consequence — **the wt-vs-cmd split collapses**: every Windows launch runs
the claude invocation through `cmd.exe`, so there is **one** re-parse surface and
**one** metacharacter gate (not "wt is structurally safe, cmd needs a gate" — a
`.cmd` under wt is *also* a re-parse). `wt.exe` is an **optional outer wrapper**,
chosen by **try-wt-then-fall-back-to-cmd** (robust to the alias-stub edge where a
lingering disabled alias would fail stat-detection). This is **approach A2**,
selected by the maintainer after the review.

`detectExecutable` (PATH×PATHEXT resolution) is **removed** — we no longer resolve
`claude` (cmd does it) nor stat-detect `wt` (try/fallback does it). This also
drops the alias/EINVAL/EFTYPE traps and shrinks the injected-deps seam to two.

## 2. Public API

New module **`src/reopenSession.ts`** (impure). Rationale for a new file: the pure
`terminalLauncher.ts` is guarded by a purity test asserting it imports no
`child_process`/`fs`/`os`; the impure layer cannot live there. It sits alongside
`sessionStore.ts` (also `src/`, also `node:`-importing) — `tsconfig.json` compiles
`src/**` with all `@types/*` (incl. `@types/node`) available, so no build-config
change is needed.

```ts
export interface ReopenRequest {
  os: LaunchOS;          // "win32" | "darwin"; injectable, defaults to process.platform
  cwd: string;
  sessionId: string;
  mode: string;
  claudePath: string;    // user setting, default "claude"; untrusted
}

// Two effectful seams, injected so the decision/fallback logic is unit-testable
// without real spawning or a real filesystem. Production uses realDeps.
export interface LauncherDeps {
  spawn: SpawnFn;                          // node child_process.spawn shape
  cwdExists: (cwd: string) => Promise<boolean>;   // stat, is-directory?
}

export async function reopenSession(
  req: ReopenRequest,
  deps?: Partial<LauncherDeps>,
): Promise<void>;
```

Shared input validation is **reused, not re-implemented** (issue constraint): the
pure module exports `assertLaunchInputs(cwd, sessionId, mode, claudePath)`
(the existing internal validator, now exported) — UUID sessionId, mode allowlist,
empty/control-char `cwd`/`claudePath`. `reopenSession` calls it; `buildLaunchSpec`
still calls it internally.

`reopenSession` resolves once a child has **successfully spawned** (the `spawn`
event). It rejects with a typed error (§3.5) on a missing folder, an unsafe path,
or a terminal spawn failure.

## 3. Behavior

### 3.1 Order of operations (fail before spawning)

1. `os ∉ {win32, darwin}` → reject `UnsupportedOsError`.
2. `assertLaunchInputs(...)` — throws on bad UUID / mode / empty / control char
   (these propagate unchanged; they are upstream validation, not runtime faults).
3. `cwdExists(cwd)` false → reject `FolderMissingError` **before any spawn** (§3.2).
4. Build argv + spawn per OS (§3.3–3.4).

### 3.2 stat-cwd-before-launch

`cwdExists` stats `cwd`, true only for an existing **directory** (a file or
missing path → false → `FolderMissingError("folder no longer exists")`). Worktrees
and Temp dirs are deleted often; this is the common non-happy path. The IPC layer
(later issue) maps the code to a specific toast.

### 3.3 Windows: try wt.exe (wraps cmd.exe) → fall back to plain cmd.exe

The claude invocation **always** runs through `cmd.exe /k`. `wt.exe` is only an
outer wrapper for nicer tabs.

- **Metacharacter gate (once, both paths).** Reject a `claudePath` containing any
  cmd metacharacter — ``& | < > ^ % !`` — or a double-quote `"`. Rationale, per
  the review: `%…%` expands through cmd (proven), `& | < >` split/redirect, `^`
  escapes, `!` matters iff delayed-expansion is on (defensive), and `"` cannot
  round-trip through Node-quote → cmd-reparse. `claudePath` is the ONLY
  cmdline-injectable value: `sessionId` is UUID-validated, `mode` is allowlisted,
  and `cwd` never enters a cmdline (§3.3.1). Failure → `UnsafePathError`.
  - **`(` and `)` are deliberately NOT rejected** — `C:\Program Files (x86)\…` is
    a legal, common path; cmd treats `()` specially only in compound-command
    context, and Node's argv quoting confines them inside the quoted token. The
    §5 integration test proves an `(x86)`-style path launches without injection.
  - The denylist is scoped to **cmd.exe's** parser. `.ps1` is not in default
    PATHEXT and `cmd.exe` cannot execute it, so PowerShell metacharacters (`$`,
    backtick) are irrelevant here; a user-set `.ps1` `claudePath` fails at runtime
    (§3.6 M-limitation), true `.ps1` support is deferred (§6).

- **wt-wrapped argv** (attempt first):
  `wt.exe` + `["new-tab", "-d", <cwd>, "cmd.exe", "/k", <claudePath>, "--resume",
  <sessionId>, "--permission-mode", <mode>]`.
- **plain-cmd argv** (fallback):
  `cmd.exe` + `["/k", <claudePath>, "--resume", <sessionId>, "--permission-mode",
  <mode>]`, with `cwd` set via the spawn **option**.

Try/fallback: spawn `wt.exe` with the wt argv; if it emits `error` (any code —
`ENOENT` for absent, or a runtime failure for a lingering/disabled alias stub),
spawn the plain-cmd argv instead. A wt `error` fires before a window appears, so
the fallback is invisible. If the plain-cmd spawn also errors → `SpawnFailedError`.

Both `wt.exe` and `cmd.exe` are spawned by **bare name** (never a resolved
absolute path) so libuv/OS resolution handles the wt alias correctly.

#### 3.3.1 `cwd` never reaches a parser

- **plain cmd:** `cmd.exe` has no start-directory flag → `cwd` is passed **only**
  via the spawn `cwd` option (load-bearing; asserted, Invariant I2).
- **wt:** `cwd` is `wt`'s `-d` argument, which wt passes to the tab's shell as the
  start-directory **API parameter** (`lpCurrentDirectory`), not a re-parsed shell
  string — so cmd metacharacters in `cwd` are inert. Legal Windows folders may
  contain `& ^ %`, so `cwd` is NOT metachar-gated (only control chars, via
  `assertLaunchInputs`). The §5 integration test uses a `&`-containing `cwd` to
  confirm no execution.

### 3.4 macOS: osascript via the pure builder

Reuse `buildLaunchSpec("darwin", …)` unchanged — it validates and returns
`{ file: "osascript", args: ["-e", <script>] }` with the strictly-ordered
two-layer escaping proven in #51. `reopenSession` spawns that spec. The
`CONTROL_CHARS` guard in `assertLaunchInputs` rejecting `\n`/`\r` is **load-bearing
for this path**: a newline would survive single-quote wrapping and split
Terminal's `do script` into a second command — it is a security control here, not
a sanity check. Asserted by a regression test (§5).

> Note on `buildLaunchSpec("win32")`: its direct-`wt` output (claude launched
> without a `cmd.exe` wrapper) is retained as the validated form for a real `.exe`
> `claudePath`, but the launcher does not use it on the default path because the
> common `claude.cmd` shim cannot be launched that way (§1.1). A future
> optimization may detect a real `.exe` and use it; not built now.

### 3.5 Spawn options / new-window semantics

- Always `shell: false`, discrete argv.
- New window: `detached: true`, `stdio: "ignore"`, then `child.unref()` so CSM can
  exit without killing the terminal.
- `detached` governs console/window allocation only — **not** argv re-parsing
  (verified: `detached:false` reproduces the identical cmd re-parse). The §5
  integration test therefore runs **non-detached** to observe output; the visible
  new-console behavior of `detached:true` is verified manually, **not** claimed to
  be covered by the integration test (adversarial correction).
- **Hang guard.** A spawn resolves on the child's `spawn` event and rejects on
  `error`; a child that emits neither (e.g. a WindowsApps alias stub resolving at
  the OS layer) would wedge the promise and, on the wt attempt, starve the cmd
  fallback. A 10s timeout bounds each attempt so a hang becomes a rejection the
  caller recovers from (wt hang → cmd fallback; cmd hang → `SpawnFailedError`).
  `spawn` fires at process creation (ms), so the bound never false-trips a healthy
  launch; the timer clears the instant the attempt settles. The timeout branch
  also best-effort `kill()`s the child: a permanent hang has nothing to kill, but
  a merely-SLOW spawn (e.g. AV-scanning wt.exe) could fire `spawn` after the
  fallback already ran — the kill stops that late child opening a SECOND window.

### 3.6 Error surface (typed, no crash)

Reject with an `Error` subclass carrying a stable `code`:

| code | class | when |
| --- | --- | --- |
| `UNSUPPORTED_OS` | `UnsupportedOsError` | os ∉ {win32, darwin} |
| `FOLDER_MISSING` | `FolderMissingError` | `cwd` gone / not a dir |
| `UNSAFE_PATH` | `UnsafePathError` | cmd metachar in `claudePath` |
| `SPAWN_FAILED` | `SpawnFailedError` | final spawn emits `error` |

The IPC layer (later) maps **`code` → display string**; it must NOT feed
`error.message` (which may embed the raw untrusted path, for logs) into the
renderer, which renders via `textContent` only (parent design §9). `buildLaunchSpec`'s
own validation throws propagate unchanged.

**Accepted limitation (M):** `cmd.exe /k` succeeds as a spawn even if `claude`
then fails *inside* the window (bad id, missing binary) — the `/k` window stays
open showing the error, but `reopenSession` has resolved. There is no
"launched-but-claude-failed" code; the IPC success toast must not over-promise.

## 4. Invariants

- **I1 — never `shell:true`.** Every spawn passes `shell:false`.
- **I2 — `cwd` only via the option on the cmd path.** `cwd` never appears in a
  plain-cmd `args` element. (Test asserts no `args` element equals `cwd`.)
- **I3 — no spawn on a dead folder.** `cwdExists` false → `spawn` never called.
- **I4 — cmd metachar rejection precedes spawn.** A `claudePath` with ``&|<>^%!"``
  → `UnsafePathError`, no spawn.
- **I5 — real re-parse safety.** On real Windows, a benign special path (`(x86)`,
  space) launches correctly and a gated payload never executes. (Integration.)
- **I6 — mac argv reused, not re-escaped.** darwin calls `buildLaunchSpec`.
- **I7 — bare-name spawn.** `wt.exe`/`cmd.exe` spawned by name, never a resolved
  absolute path (alias correctness).

## 5. Test matrix

**Unit — `test/main/reopenSession.test.ts` (all OSes, injected deps):**

- win32 happy: wt attempt spawns `wt.exe` with wt-wrapped argv; on wt `spawn`
  event, resolves; `shell:false`, `detached:true`.
- win32 fallback: injected `wt.exe` spawn emits `error` → falls back to `cmd.exe`
  with plain argv; `cwd` option = req.cwd; `cwd` NOT in args (I2); resolves on
  cmd `spawn` event.
- win32 both fail: wt errors, cmd errors → `SpawnFailedError` (I: no throw escapes).
- win32 hang guard: a wt spawn that emits NEITHER `spawn` nor `error` times out
  and falls back to cmd; both hanging → `SpawnFailedError` (never a silent wedge).
  Uses fake timers so no real wait.
- win32 metachar `claudePath` (each of ``& | < > ^ % ! "``) → `UnsafePathError`,
  spawn never called (I4).
- win32 `(x86)`-style + spaced `claudePath` → allowed (not rejected), argv element
  intact.
- darwin: spawns `osascript`, args = `buildLaunchSpec("darwin")` output (I6).
- darwin newline `cwd`/`claudePath` → throws (control-char guard) before spawn.
- cwd missing / is-a-file → `FolderMissingError`, spawn never called (I3).
- unsupported os (`linux`) → `UnsupportedOsError`.
- default deps: `reopenSession` callable with no `deps` (realDeps wired), guarded
  so unit context does not actually spawn.

**Integration — Windows only (`process.platform === "win32"`, else skipped):**

Drive the **pure argv builder** (`buildPlainCmdArgs`, exported from the module)
then really `spawnSync("cmd.exe", args, { cwd, shell:false })` **non-detached with
captured output** against a temp stand-in `.cmd` that writes its args to a marker:

- **Spaced path** (`…\stand in.cmd`) → marker written, `--resume <id>` intact
  (Node quoting round-trips a space through cmd).
- **`(x86)`-style path** (`…\dir (x86)\stand in.cmd`) → marker written, and **no**
  `inject.txt` created (parens confined by quoting; proves we don't over-reject).
- **`&`-in-`cwd`** dir (`…\a & b\`) launched via the spawn `cwd` option (the same
  start-directory channel wt's `-d` uses) → the stand-in runs, no `inject.txt`
  (cwd is a start-dir param, not re-parsed). Real `wt.exe` is not driven in CI (it
  opens a window and may be absent on runners); the wt `-d` claim rests on this
  same OS start-directory semantics.
- **Gate proof:** a `claudePath` with `& echo PWNED> inject.txt` → `UnsafePathError`
  from the gate, no spawn, no `inject.txt` (I4 end-to-end; payload is
  independently-executable so the assertion is not vacuous — adversarial I3).

## 6. Out of scope

- `bypassPermissions` confirmation modal + downgrade (renderer/IPC slice).
- Bulk / multi-select reopen (Phase B, §10).
- IPC wiring (`reopen:session` handler, `code`→toast mapping) — next issue.
- iTerm on macOS (Terminal.app only); Linux (MVP is Win + mac).
- True PowerShell `.ps1` execution (`powershell -File` + ExecutionPolicy).
- A real-`.exe` fast-path using `buildLaunchSpec("win32")` directly (§3.4 note).

## 7. Doc-review disposition

Four-lens high-risk review run on the FIRST draft before coding; this revision
folds the results.

**Adopted (design-changing):**
- Collapse wt-vs-cmd into "always cmd, wt optional wrapper" with try/fallback;
  remove `detectExecutable`; spawn bare names (feasibility F1/F2, adversarial
  C1/C2/I1/I2). Approach A2, maintainer-selected.
- One metachar gate on `claudePath` covering both Windows paths (adversarial I1).
- Keep `()` OUT of the denylist (`Program Files (x86)`); prove via integration
  (scope F4, security).
- Document `CONTROL_CHARS` as load-bearing for the osascript newline break +
  regression test (security F3).
- `code`→display mapping rule; never `message`→renderer (security F4).
- Drop the "integration test validates the detached window" claim; run integration
  non-detached, verify the window manually (adversarial I5).
- Integration negative test uses an independently-executable payload (adversarial I3).
- Drop `EXECUTABLE_NOT_FOUND` from the taxonomy — cmd/OS resolves claude now;
  claude-missing is the accepted M-limitation (scope, adversarial M1).

**Adopted (no code change / confirmations):**
- tsconfig F4 was a false alarm — absent `"types"` includes all `@types`;
  `sessionStore.ts` already proves node imports typecheck in `src/`.
- cmd fallback shape + keeping it out of the pure builder: sound (adversarial,
  scope confirmed).

**Rejected / accepted-as-is:**
- Adding `()` to the denylist (would break `Program Files (x86)`).
- Symlink/junction `cwd` and PATH-hijack (security F5/F6): systemic, out of this
  layer; mitigated by the settings UI echoing the resolved path (design §8) and
  by `cwd` originating from the user's own session file. Accepted, noted.
- TOCTOU between `cwdExists` and spawn: millisecond window, consequence is a
  spawn failure not injection (`cwd` never re-parsed). Accepted.
