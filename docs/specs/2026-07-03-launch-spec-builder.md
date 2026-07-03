# Spec — `buildLaunchSpec`: pure OS-aware launch-spec builder

**Date:** 2026-07-03
**Issue:** #51 · **Follow-on:** #52 (impure spawn layer + cmd.exe fallback)
**Area:** `area:launcher` (security-sensitive) · **Tier:** High-risk
**Status:** Revised after `ce-doc-review` (adversarial · security · scope · feasibility)
**Parent design:** [`2026-06-30-csm-design.md`](2026-06-30-csm-design.md) §5, §7

## 1. Purpose & scope

`buildLaunchSpec` is the **pure** heart of `terminalLauncher` (parent design §7):
given the session's target OS, `cwd`, `sessionId`, `permissionMode`, and the
configured `claudePath`, it produces the OS-specific **argv** to open a new
terminal window `cd`'d into `cwd` running:

```
<claudePath> --resume <sessionId> --permission-mode <mode>
```

It is the last pure foundational unit before the `ipc` bridge and renderer, and —
per parent §7 — **the module where all command-injection escaping/validation tests
live**. It is deliberately pure so the security-critical boundary is provable by
unit tests with zero Electron/I/O.

**In scope:** the `win32` (Windows Terminal) and `darwin` (osascript/Terminal.app)
argv builders, `sessionId` UUID validation, `mode` allowlist validation,
`cwd`/`claudePath` sanity validation, and macOS AppleScript escaping.

**Out of scope — deferred to the impure spawn slice (#52):**

- The **Windows `cmd.exe` fallback** for when `wt.exe` is absent. Deferred because
  `cmd.exe /k <cmdline>` is itself a **shell that re-parses** its argument — argv-
  array passing does *not* neutralize space-splitting or `&`-injection there (unlike
  `wt.exe`, which is structurally argv-safe). Its safe construction depends on Node's
  argv→command-line quoting interacting with cmd's re-parse, which a pure unit test
  **cannot** validate (a pure test greens while the real launch fails/injects — see
  §7 review note) and is entangled with `.cmd`-shim resolution and `wt` detection,
  both of which are I/O that lives in the spawn layer. Building the cmd argv there,
  next to the real `spawn`, is the correct altitude.
- The impure `terminalLauncher`: real `child_process.spawn`, `wt` presence
  detection, `stat`-cwd-before-launch ("folder no longer exists"), new-window flags,
  spawn-failure surface.
- The `bypassPermissions` confirmation modal (renderer slice).

## 2. Module & signature

New file `src/terminalLauncher.ts` (node-context; tested under `test/main/`).

```ts
export interface LaunchSpec {
  /** Executable to spawn — the `file` arg of child_process.spawn. Never interpolated. */
  file: string;
  /** Discrete argv elements — never a single interpolated string. */
  args: readonly string[];
}

export type LaunchOS = "win32" | "darwin";

/**
 * Build the launch spec for the OS:
 *  - win32  → Windows Terminal (`wt.exe new-tab …`)
 *  - darwin → `osascript` driving Terminal.app
 * Throws on an invalid `sessionId` (non-UUID), an out-of-set `mode`, an empty or
 * control-char-bearing `cwd`/`claudePath`, or an unsupported `os`.
 */
export function buildLaunchSpec(
  os: LaunchOS,
  cwd: string,
  sessionId: string,
  mode: string,
  claudePath: string,
): LaunchSpec;
```

A single exported function returning `{ file, args }` — faithful to parent §7. The
Windows fallback that would have justified a second export is deferred to #52, so
there is no second entry point here. All validation lives in one private
`assertValidInputs(cwd, sessionId, mode, claudePath)` that both OS branches call,
so the gate cannot drift between strategies.

## 3. Behavior

### 3.1 `sessionId` validation (security gate)

`sessionId` originates from the session **filename** (`sessionStore.sessionIdOf`)
and is unvalidated anywhere upstream — this is the first and only gate before the
value reaches `spawn`. Validate **before building any argv**:

- Accept only a strict RFC-4122 UUID. The regex is **single-line, no `m` flag**:
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`.
  Real Claude session filenames are v4 UUIDs; `[1-5]`/`[89ab]` accepts any RFC-4122
  version without over-fitting to v4.
  - The `m` flag is **prohibited**: under `m`, `^`/`$` match line boundaries, so
    `"<valid-uuid>\n; rm -rf ~"` would pass the anchors while smuggling a payload.
    (JS `$` without `m` matches only the absolute string end — it does *not* allow a
    trailing `\n` — so a single-line regex rejects the newline-suffixed input.)
- On mismatch, **throw** `Error("Invalid sessionId: expected a UUID")`. The value is
  never placed into argv on the failure path.
- The security property is structural: a string matching this pattern contains only
  `[0-9a-f-]` and therefore cannot carry a shell/AppleScript metacharacter.

### 3.2 `mode` validation (closed allowlist)

`mode` must be one of the six CLI modes — `acceptEdits`, `auto`, `bypassPermissions`,
`default`, `dontAsk`, `plan`. The parser (parent §4.1) already resolves `default`
for absent/unrecognized modes, so by this layer `mode` should *always* be in the
set. `buildLaunchSpec` nevertheless **re-checks** and throws
`Error("Invalid permissionMode")` on anything else. This is the last pure gate
before spawn, and the `bypassPermissions` **downgrade** path (the confirmation
modal offers a one-click downgrade to `acceptEdits`/`default`) will feed a mode
string through IPC that never passed through the parser — a closed allowlist here
closes that bypass at trivial cost (a `Set` lookup). The accepted value is emitted
**verbatim** as the `--permission-mode` argv element (no transformation).

### 3.3 `cwd` / `claudePath` validation

Both are untrusted-ish (`cwd` from on-disk session content, `claudePath` from user
settings). Validate before building argv:

- **Non-empty:** throw `Error("cwd must not be empty")` / `Error("claudePath must
  not be empty")` on `""`. (A legitimate `cwd` is at minimum the `"(unknown)"`
  fallback — never empty.)
- **No control characters** (U+0000–U+001F): throw. A path containing a raw newline
  cannot be represented inside a macOS AppleScript double-quoted literal at all (it
  is a compile error, not a graceful failure), and no real launchable directory
  contains a control character. Rejecting up front is simpler and safer than
  encoding, and keeps the AppleScript builder total.

These values are only ever emitted as **discrete argv elements** (Windows) or
**escaped/quoted AppleScript literals** (macOS) — never concatenated into a shell
command string.

### 3.4 Windows — `wt.exe` (Windows Terminal)

```
file: "wt.exe"
args: ["new-tab", "-d", cwd,
       claudePath, "--resume", sessionId, "--permission-mode", mode]
```

- **`new-tab` is required** as `args[0]`. Without a subcommand, `wt.exe` parses the
  trailing tokens in its own option context and treats `--resume` / `--permission-
  mode` (which are *not* wt options) as unexpected wt arguments → error or an empty
  terminal. `new-tab` establishes the command context so everything after the
  executable positional is forwarded to `claude` as its command line. (wt grammar is
  mildly version-sensitive; `new-tab` is the documented, strictly-safer form.)
- `-d <cwd>` sets Windows Terminal's start directory (WT spawns the child in its own
  process, so the parent spawn's `cwd` option would not reach the new tab). `-d
  <cwd>` and `<claudePath>` are **discrete argv elements**, not interpolation.
- Structurally injection-safe: wt parses its argv array; wt's `;` tab-delimiter
  operates on wt's own argument string, not on an already-separated argv element, so
  a metacharacter inside one element cannot re-split. No shell, no quoting needed
  (the impure layer spawns with `shell: false`).

### 3.5 macOS — `osascript` / Terminal.app

```
file: "osascript"
args: ["-e", script]
```

`script` is built in JS, in this **exact, security-critical order**:

1. **Inner shell layer first — single-quote-wrap the raw values.** Build the
   Terminal command line from the *raw* `cwd`/`claudePath`:
   ```
   cd <SQ(cwd)> && <SQ(claudePath)> --resume <sessionId> --permission-mode <mode>
   ```
   where `SQ(x)` = wrap `x` in single quotes, encoding each embedded `'` as `'\''`
   (`x.replace(/'/g, "'\\''")` then bracket with `'`). POSIX single-quoting is
   absolute — nothing inside `'…'` is interpreted by the shell — which neutralizes
   `$()`, `` ` ``, `;`, `&`, `|`, spaces, and `"`. `sessionId` (UUID-validated) and
   `mode` (allowlisted) need no wrapping.
2. **Outer AppleScript layer second — escape the whole line for the literal.**
   ```
   script = 'tell application "Terminal" to do script "' + ESC(shellLine) + '"'
   ```
   where `ESC(s)` = `s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')` — backslash
   **first**, then double-quote.

**The order is load-bearing and is a security invariant (§4.3).** `osascript` parses
the `-e` string as AppleScript *first*, de-escaping the `"…"` literal, and hands the
*de-escaped* result to Terminal.app's shell. So the shell must see the single-quoted
line, which means single-quote wrapping happens on the raw value and `ESC` is applied
to the already-wrapped token. Reversing the order (ESC first, then wrap) leaves the
backslash of a `'\''` sequence un-doubled, so AppleScript mis-decodes it and the
token boundaries shift — a potential breakout. Control characters are already
rejected (§3.3), so no newline reaches the literal.

There is no structurally cleaner mechanism: Terminal.app's `do script` accepts only a
shell string, so escaping is unavoidable on macOS (unlike Windows' `-d` option). This
is therefore the **highest-risk surface in the design** and gets the densest tests.

### 3.6 Unsupported OS

`buildLaunchSpec` with `os` other than `win32`/`darwin` (e.g. `linux`) throws
`Error("Unsupported OS: <os>")`. CSM targets Windows + macOS only (parent design).

## 4. Security invariants (must hold — parent §7 / CLAUDE.md)

1. **Windows — structural.** No shell is involved; `cwd`/`claudePath`/`sessionId`/
   `mode` are discrete argv elements. Injection-safety rests on the OS argv boundary
   (and the impure layer's `shell: false`), not on string escaping.
2. **macOS — escaping-correctness.** `cwd` and `claudePath` sit inside the
   `do script` line; safety rests on §3.5's two-layer construction being exactly
   correct. This is the only place safety depends on string escaping rather than an
   OS structural boundary — hence the highest-risk surface.
3. **macOS composition order is fixed:** single-quote-wrap the raw value first, then
   `ESC` the wrapped token. The order is security-critical (§3.5).
4. `sessionId` is UUID-validated (single-line regex) before any argv is built;
   invalid input throws and yields no spec.
5. `mode` is allowlist-validated (closed set of six) before use; emitted verbatim.
6. `cwd`/`claudePath` are non-empty and control-char-free; otherwise throw.
7. Pure: no `child_process`, `fs`, `os`, or Electron import; deterministic.

## 5. Test matrix (`test/main/terminalLauncher.test.ts`)

Node-context unit tests (tsconfig `test/main` seam), fixtures only, no I/O.

**Happy path**
1. win32 → exact `{ file:"wt.exe", args:["new-tab","-d",cwd,claudePath,"--resume",
   id,"--permission-mode",mode] }` for a normal cwd/id/mode.
2. darwin → `file:"osascript"`, `args[0]==="-e"`, and `args[1]` contains the
   escaped/quoted `cd '…' && '…' --resume <id> --permission-mode <mode>` line.
3. `permissionMode` pass-through: each of the six accepted modes appears verbatim as
   the `--permission-mode` value (parametrized), on both OSes.

**UUID gate**
4. Non-UUID `sessionId` (`"../../etc"`, `"a; rm -rf ~"`, `""`, `"not-a-uuid"`,
   uppercase-with-bad-variant, and a **valid-UUID-with-trailing-newline**
   `"<uuid>\n; rm -rf ~"`) → throws; no partial spec. (parametrized)
5. A valid v4 UUID and a valid non-v4 RFC-4122 UUID are both accepted.

**mode gate**
6. `mode` not in the six (`"root"`, `"auto; calc"`, `""`) → throws. (parametrized)

**cwd / claudePath gate**
7. Empty `cwd` / empty `claudePath` → throws.
8. `cwd` or `claudePath` containing a control char (`\n`, `\r`, `\t`, `\x00`) →
   throws. (parametrized)

**Injection / escaping — macOS (the core of this slice)**
9. Adversarial `cwd` values — `/x" & (do shell script "rm -rf ~") & "`, a path with a
   literal `"`, `\`, `` ` ``, `$`, `;`, `|`, `&`, a space, a single quote `'`, a
   value containing **both `"` and `'`** (`/Users/it's a "project"/src`), UNC
   `\\server\share`, and non-ASCII (`/Users/josé/项目`) — assert the produced
   AppleScript keeps the value inside the quoted/escaped literal so it cannot break
   out of the `do script` string. The combined `"`+`'` fixture must show `'\''` with
   a **doubled backslash** in the emitted `-e` string (proves the composition order).
   (parametrized, one assertion per hazard)
10. `claudePath` with a space (`/opt/my claude/claude`) and with a metacharacter →
    single-quoted token in the macOS script.

**Injection / no-op — Windows**
11. The same adversarial `cwd`/`claudePath` on win32: assert each appears as
    **exactly one** argv element, unmodified, no splitting on spaces/metacharacters
    (argv-array guarantee locked in).

**Purity**
12. Static: the module imports none of `child_process`/`fs`/`os`/`electron` (grep-
    style assertion over the source, mirroring pathAdapter's no-I/O guard).

## 6. Out of scope / follow-ons

- Impure `terminalLauncher` (spawn + `wt` detection + `cmd.exe` fallback +
  `stat`-cwd + new-window flags + error surface) — **#52**.
- `bypassPermissions` confirmation modal — renderer slice.
- iTerm support on macOS (parent §7 "iTerm later").

## 7. Doc-review disposition (this revision)

Adopted from the four-lens review: `wt.exe new-tab` fix (feasibility F1); macOS
ESC↔single-quote **composition order** pinned as an invariant (adversarial F3 /
security F1); **reject control chars** to close the AppleScript-newline gap
(adversarial F2); single-line **UUID regex, no `m` flag** + trailing-newline test
(adversarial F5); **`mode` allowlist** gate (security F2); empty-`claudePath` guard
(security F4); single private `assertValidInputs` core so the gate can't drift
(adversarial F6); split §4 invariant Windows-structural vs macOS-escaping + name the
highest-risk surface (adversarial F4); combined `"`+`'` macOS fixture (scope F3).

**Cmd.exe fallback deferred to #52** rather than kept in scope (overriding scope-
guardian F2) on feasibility's new evidence: `cmd.exe /k` re-parses its argument as a
shell, so the fallback's injection-safety *and* functional correctness both depend on
Node/cmd quoting that a pure unit test cannot validate and that is entangled with
`.cmd`-shim resolution — it belongs next to the real `spawn`. `wt.exe` stays because
it is structurally argv-safe and its shape is a genuine testable contract.
