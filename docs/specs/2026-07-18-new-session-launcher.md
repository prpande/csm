# New-session launcher (#165)

Start a **new** Claude Code session in any directory from CSM — without taking
away the CLI's customizability. Companion to the reopen flow (#67); answers
epic #89's "allowlist vs free text" question with a per-token gate plus an
escape hatch.

## User-facing shape

One modal (**NewSessionModal**), reachable from two entry points:

1. **Folder-pane header button** — prefilled with the selected folder's path.
2. **Title-bar button** — starts empty; **Browse…** opens the native directory
   picker (`dialog.showOpenDialog({ properties: ["openDirectory"] })` in main),
   so sessions can start in directories with no prior session history.

Modal contents:

- **Directory** field + Browse… button.
- **Permission mode** dropdown listing every CLI mode (`acceptEdits`, `auto`,
  `bypassPermissions`, `default`, `dontAsk`, `plan`), defaulting to `default`.
  Selecting `bypassPermissions` shows the same inline warning styling as the
  reopen bypass-confirm modal — the warning is part of the form, so no second
  modal is stacked.
- **Additional CLI arguments** (free text, optional) — tokenized and appended
  to the command line, for precise customization (`--model`, `--continue`, a
  prompt, etc.).
- **Open terminal here** — the escape hatch: opens a plain terminal cd'd into
  the directory, running nothing. Anything the argument gate rejects (see
  below) can be typed there with the shell's own quoting. This is what makes
  "full CLI customizability" an honest promise on Windows.

Launch command shape (all OSes):

```
<claudePath> --permission-mode <mode> [extraTokens…]
```

Extra tokens come **last**, so positional CLI arguments (e.g. a prompt) work.
A `--permission-mode` passed in the extra tokens therefore wins over the
dropdown (CLI last-wins); the modal documents this rather than rejecting it.

## Argument tokenization + the Windows gate

The renderer sends the **raw argument string**; all parsing and validation
happens in the main process's pure layer (`terminalLauncher.ts`):

- `tokenizeArgs(raw: string): string[]` — splits on whitespace; a
  double-quoted span (`"two words"`) forms one token with the quotes removed;
  there are no escape sequences inside quotes. An unbalanced quote is a
  validation error. Empty/whitespace-only raw → `[]`.
- Control characters (same class `assertLaunchInputs` rejects) anywhere in the
  raw string are a validation error.
- **Windows only**: every token is checked against `CMD_METACHARS`
  (`/[&|<>^%!"]/`, from `reopenSession.ts`) — the claude invocation runs
  through `cmd.exe /k`, which **re-parses** its argument string (the BatBadBut
  class), so escaping cannot be made reliable; the gate rejects instead.
  Rejection is **loud and specific**: the error names the offending token so
  the user can fix it or use *Open terminal here*. (The double-quote is a
  metacharacter on this list, so the "quoted span" tokenizer form is
  effectively a macOS/degenerate-input feature; a quoted token on Windows is
  rejected by the gate, not silently mangled.)
- **macOS**: tokens need no charset restriction beyond the control-char class —
  each token is independently `shellSingleQuote`d into the `do script` line,
  then the whole line is `appleScriptEscape`d (same strict two-layer order as
  the reopen path).

`mode` is validated against `KNOWN_PERMISSION_MODES`; `cwd`/`claudePath` get
the shared `assertPathish` checks; there is **no sessionId** in this flow, so
the UUID invariant of `assertLaunchInputs` does not apply — a parallel
`assertNewSessionInputs(cwd, mode, claudePath)` covers the rest, built from
the same exported pieces so the two cannot drift.

## Launch mechanics (reuse of the #51/#52 spawn layer)

`reopenSession.ts` already owns the hardened machinery: `trySpawn` with the
10s hang guard, the wt.exe → cmd.exe fallback, `cwdExists`, the typed error
surface, and injected deps for unit testing. PR 1 generalizes it minimally:

- The Windows arg builders take the claude argv tail as data:
  `buildPlainCmdArgs` / `buildWtWrappedArgs` gain a new-session sibling that
  emits `["/k", claudePath, "--permission-mode", mode, ...extra]` (cwd still
  travels ONLY via the spawn `cwd` option — invariant I2).
- The wt-then-cmd fallback and spawn/hang plumbing are exported (or lifted to
  a small shared internal function) and consumed by both flows — never
  re-implemented.
- `launchNewSession(req, deps)` (new `src/newSession.ts`): validates, checks
  `cwdExists`, gates tokens on win32, spawns. Rejects with the existing typed
  errors plus a new `InvalidArgsError` (`code: "INVALID_ARGS"`, message names
  the offending token or the unbalanced quote).
- `openTerminalHere(cwd, deps)`: Windows `wt.exe new-tab -d <cwd> cmd.exe /k`
  → fallback plain `cmd.exe /k` (with spawn-cwd); macOS osascript
  `do script "cd '<cwd>'"`. No claudePath involved at all.

## IPC surface (PR 1)

| Channel | Shape | Notes |
|---|---|---|
| `session:new` | invoke → discriminated result | `{ cwd, mode, rawArgs }` in; `{ ok: true }` or `{ ok: false, code }` where `code` ∈ existing `REOPEN_ERROR_CODES` ∪ `"INVALID_ARGS"`, plus a `detail` string for INVALID_ARGS (the offending token — rendered with `textContent` only) |
| `dialog:pickFolder` | invoke → `{ canceled: true } \| { canceled: false, path }` | Main-process native dialog; parented to the window |
| `terminal:openHere` | invoke → same discriminated result minus INVALID_ARGS | Escape hatch |

Preload/bridge: `csm.newSession(dto)`, `csm.pickFolder()`,
`csm.openTerminalHere(cwd)` — same narrow-invoke pattern as `session:reopen`;
no Node objects cross the bridge.

`claudePath` is read in main from settingsStore exactly as the reopen handler
does; the renderer never sends it.

## Security invariants (unchanged from the parent design, restated)

- **I1**: every spawn is `shell: false` with discrete argv.
- **I2**: `cwd` never appears inside a cmd.exe-re-parsed string; it travels as
  the spawn `cwd` option (and as wt's `-d`, an OS-API parameter).
- **I3**: cmd.exe re-parse safety is by **charset restriction** (per-token
  `CMD_METACHARS` gate), never by escaping.
- **I4**: macOS escaping order is fixed: per-value `shellSingleQuote` first,
  whole-line `appleScriptEscape` second.
- **I5**: all validation errors cross IPC as stable `code`s; raw
  paths/tokens surface only via fields the renderer inserts as text.

## Phasing

- **PR 1** (this spec lands with it): pure builders + tokenizer + gate,
  `launchNewSession` / `openTerminalHere`, IPC channels + handlers, preload +
  bridge, unit tests (pure: tokenizer/builders/gate; impure: fallback + error
  mapping with injected deps).
- **PR 2**: NewSessionModal (focus-trapped like the bypass modal), the two
  entry-point buttons, post-launch delayed rescan so the new session appears
  once its JSONL exists, renderer tests + live Playwright validation.

## Out of scope

- Remembering per-directory argument presets (future; epic #89 machinery).
- Linux launch support (parent design limits to win32/darwin).
- Editing `claudePath` here (Settings already owns it).
