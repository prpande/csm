# Plan — #58 `settingsStore`: persist `claudePath` in Electron `userData`

**Tier:** Standard (new main-process module). Small, fs-backed, no Electron in the unit.

## Goal

The reopen flow (§7) launches `<claudePath> --resume <id> --permission-mode <mode>`.
Per spec §5 (module table) and §8 (Settings), `claudePath` (default `"claude"`) is
owned by a `settingsStore` module that reads/writes `settings.json` in Electron
`app.getPath('userData')`. This module does not exist yet — it is the prerequisite
for the `session:reopen` IPC handler (#59) and the later settings modal. This slice
implements **only the persistence module**.

## Approach

`src/settingsStore.ts` exports a factory (matching the injection pattern already
used by `sessionStore`/`reopenSession`):

```ts
createSettingsStore(dir: string) => {
  getClaudePath(): Promise<string>;
  setClaudePath(value: string): Promise<void>;
}
```

- **Injected dir, not `electron`.** Main passes `app.getPath('userData')`; the unit
  imports only `node:fs/promises` + `node:path`, so it is testable against a real
  temp dir (no Electron runtime, no fs mocking) — same style as `sessionStore`'s
  tests. No `electron` import in the unit.
- **Read-through, no in-memory cache.** `getClaudePath()` reads + parses
  `settings.json` on each call. The file is tiny and read is cheap; reading fresh
  keeps external edits visible (spec §8 wants `settings.json` tampering to be
  detectable and the resolved path shown back) and avoids a whole class of
  stale-cache bugs. A per-reopen sub-KB read is negligible.
- **Fail-soft (§12).** A missing, empty, non-object, or unparseable `settings.json`
  → treated as `{}` → `getClaudePath()` returns the `"claude"` default. Never throws
  to the caller.
- **Default guard + trim-on-read.** `getClaudePath` honors `claudePath` only when
  it is a non-blank string and returns it **trimmed** — the value flows to spawn as
  the `file` argument, so surrounding whitespace from a hand-edited `settings.json`
  would otherwise fail to resolve as an executable (internal spaces, e.g.
  `C:\Program Files\claude.exe`, are preserved). `setClaudePath` stores the value
  as given; the getter normalizes on read. Absent / blank / non-string → default
  `"claude"` (so even a persisted `""` resolves to the default). _(Trim-on-read was
  added from a preflight adversarial-review finding.)_
- **Forward-compat write.** `setClaudePath` reads current settings, **spread-merges**
  `{ ...current, claudePath: value }`, and writes — so an unknown future key
  (terminal preference, Phase C) survives an MVP save rather than being clobbered.
  `mkdir(dir, { recursive: true })` before write (userData exists in Electron; this
  keeps the unit self-contained and robust).
- **Read-only on Claude's files.** The store references exactly one path,
  `join(dir, "settings.json")`; it can never touch `~/.claude`. Asserted in test
  (only `settings.json` appears under the injected dir after writes).

### Decisions deliberately deferred (not scope creep)

- **`isRecord` / non-blank-string guards duplicate 2-line helpers in
  `sessionParser`.** Reusing them would mean exporting parser internals into a
  settings module (bad coupling) or extracting a shared `typeGuards` util (a refactor
  touching `sessionParser`, beyond a settings issue). A local minimal guard is used;
  if `/simplify`'s reuse lens flags it, extract-shared-guards becomes a follow-up
  tech-debt issue (rule of three).
- **No atomic (temp+rename) write.** A torn write on crash just resets to defaults
  (fail-soft covers it); losing a custom `claudePath` on a mid-write crash is
  vanishingly rare and low-stakes for MVP. Can harden later if needed.

## Tests (`test/main/settingsStore.test.ts`, node-context per the tsconfig seam)

1. `getClaudePath()` → `"claude"` when `settings.json` is absent.
2. `setClaudePath(x)` then `getClaudePath()` → `x` (round-trips through disk).
3. Corrupt / non-JSON `settings.json` → default, no throw.
4. Non-object JSON (array, string, number, `null`) → default, no throw.
5. Blank / whitespace-only stored `claudePath` → default.
6. Unknown keys present in `settings.json` are preserved after a `setClaudePath` write.
7. After writes, the injected dir contains only `settings.json` (no path escapes
   the dir → structurally cannot touch `~/.claude`).
8. `setClaudePath` creates `settings.json` when the dir is initially empty.
9. Surrounding whitespace on a stored `claudePath` is trimmed on read (internal
   spaces preserved).

## Out of scope / follow-ons (#59 and later)

- IPC channels exposing settings get/set → **IPC bridge** #59.
- `claudePath` resolvability validation + resolved-absolute-path display + Save/
  Cancel settings modal → renderer (`area:settings`).
- Terminal preference / custom labels / folder-filter keys → Phase C.
