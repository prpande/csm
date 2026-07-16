# Plan — #83 Observability: surface preload/scan failures instead of failing silently

**Tier:** Standard (main-process handler dep + a renderer status state + e2e depth).
Touches `src/ipc.ts`, `src/main.ts`, `src/renderer/hooks/useSessionScan.ts`,
`src/renderer/components/FolderTree.tsx`, `e2e/app.smoke.spec.ts`, `TESTING.md`,
plus `test/main/ipc.test.ts`, `test/renderer/useSessionScan.test.tsx`,
`test/renderer/FolderBrowser.test.tsx`.

## Goal

The #81 crash ("Couldn't load sessions") was completely silent: nothing in
`.dev-run/run-desktop.log`, and the UI text was the same whether the preload
bridge never loaded (a **build/packaging** bug) or the scan itself threw (a
**runtime/data** problem). Diagnosing it needed a foreground Electron re-run with
`ELECTRON_ENABLE_LOGGING=1`. This slice makes that failure class self-evident
from the logs, the UI, and the e2e gate.

Closes the three acceptance criteria on #83. Gap 2 in the issue body
("preload-load failures don't reach the launcher log") is addressed by its
documented option — a `TESTING.md` note — not by a main-process handshake probe;
see [Deliberately out of scope](#deliberately-out-of-scope).

## Approach

### 1. Scan failures log the real error in main (AC 1)

`src/ipc.ts`'s scan handler ends in a bare `catch { post(CH.sessionsError, …) }`
— the `err` is discarded, so a throw inside `store.scan` leaves no trace anywhere.

Add a **`logError(context, err)` dep** to `IpcHandlerDeps` rather than calling
`console.error` inline. Every effectful dependency in this module is already
injected (the module's stated invariant: handlers stay unit-testable with a fake
`ipcMain`, no Electron runtime). An inline `console.error` would break that
convention and force tests to spy on the global console.

```ts
catch (err) {
  logError("sessions:scan", err);   // real error → main-process log
  post(CH.sessionsError, { scanId }); // renderer still gets code only
}
```

`main.ts` wires the real sink: `` (context, err) => console.error(`[csm] ${context} failed:`, err) ``.

**The no-message-leak invariant is preserved**: the renderer payload is still
`{ scanId }` and nothing else. `err` goes only to the main-process log, which is
already a trusted local sink (it is the process's own stdout/stderr). This is the
whole point — the detail belongs in the log, never on the wire.

### 2. Renderer distinguishes bridge-unavailable from scan-failed (AC 2)

`useSessionScan` currently maps two unrelated failures to one `"error"` status:

- `!bridge?.listSessions` (line 64) — **no IPC bridge**: preload never loaded, or
  a plain-browser/unit-test render. A build/packaging bug.
- `onError` (line 82) — **scan failed**: main threw mid-scan. A runtime/data problem.

Widen the union to `ScanStatus = "scanning" | "done" | "error" | "unavailable"`
and set `"unavailable"` on the bridge-missing branch. `FolderTree` then renders a
distinct notice per state:

| status        | notice                                       | means                        |
| ------------- | -------------------------------------------- | ---------------------------- |
| `error`       | "Couldn't load sessions" (unchanged)         | the scan threw               |
| `unavailable` | "Session bridge unavailable — reinstall CSM" | the preload bridge is absent |

The remedies differ, so the copy must too. A scan error is transient, so a
refresh may genuinely help. A missing bridge is not: the preload path is a static
`__dirname` join resolved from the installed files on every launch, so restarting
re-runs the identical broken build. Since there is no auto-update (`TESTING.md`),
a reinstall is the only remedy that changes the outcome — telling the user to
restart would loop them forever.

`FolderBrowser` only reads `status === "scanning"`, so the new member is additive
for every other consumer.

**No renderer `console.error` on the unavailable branch.** Rendering without a
bridge is the *normal* case for the jsdom unit suite, so logging there would spam
every renderer test with a false alarm. The distinct UI text is the renderer-side
signal; `ELECTRON_ENABLE_LOGGING=1` (below) is how a real preload failure gets
into a log.

### 3. e2e smoke asserts the bridge loaded and sessions render (AC 3)

`e2e/app.smoke.spec.ts` only asserts the heading renders — a dead preload passes
it, which is exactly why #81 shipped. Extend it to:

1. `evaluate(() => typeof window.csm)` → assert the bridge object exists.
2. Wait for the scan to settle and assert the tree reached a **healthy terminal
   state**: either real folder rows or the "No Claude sessions found" empty state.
3. Assert **neither** failure notice is present.

Point 3 is what gives the test teeth. Points 1–2 alone would pass on a machine
with no sessions even if the scan were broken; asserting the absence of both
failure notices is what makes a broken preload or a throwing scan fail the gate.

The assertion accepts populated-or-empty because the run reads the developer's
real `~/.claude/projects`. Per `docs/` CI conventions the `_electron` e2e is
local/manual, not a CI job, so it must not assume a seeded corpus.

**Falsification (done, not assumed).** The deepened test was verified to actually
catch the #81 scenario: with `dist/preload.js` replaced by a throwing stub, it
fails on `present: false, listSessions: "undefined"`. The pre-#83 test passed
that same broken build. That is the whole point of the slice.

### 3a. Restore the app's `<h1>` — found by running the e2e (deviation)

Running the e2e revealed **it was already failing on `main`**, on its own
pre-existing first assertion (`getByRole("heading")`) — verified by running
`main`'s unmodified spec against the app. Cause: the React scaffold (`75d1d42`)
shipped an `<h1>`; the sidebar/folder-view shell (`7c9e37b`, #65) dropped it, and
the later title bar (#86) rendered the app name as a `<span>`. So the app has had
**no top-level heading at all** since #65, and the smoke test has been red ever
since — unnoticed precisely because this e2e is local/manual and not a CI job.

Fixed here rather than deferred: it is a one-line `<span>`→`<h1>` (plus a
`margin: 0` reset so the title bar keeps identical metrics), it is real a11y
correctness, and #83's AC 3 cannot be met with a red e2e. This follows the
"fold a small unblocking fix into the PR" rule rather than opening a branch for
scope purity.

**The regression guard goes in the unit suite, not the e2e.** `TitleBar.test.tsx`
now asserts the `level: 1` heading. The e2e can't be the guard for this — it does
not run in CI, which is exactly how the app lost its heading for four slices
without anyone noticing. The existing `getByText(/Claude Session Manager/i)`
assertion could never have caught it: it passes on a `<span>`.

### 4. `ELECTRON_ENABLE_LOGGING=1` documented (issue gap 2)

`TESTING.md`'s "Running from source" section already points at
`.dev-run/run-desktop.log` when the window never appears. Add the next step: the
launcher log does **not** capture Electron's renderer/preload console (that is
where "Unable to load preload script" goes), so a foreground re-run with
`ELECTRON_ENABLE_LOGGING=1` is the way to see it.

## Test list

**`test/main/ipc.test.ts`** (fake `ipcMain`, existing harness)

- scan handler: when `store.scan` rejects → `logError` is called once with the
  context and the **actual thrown error**.
- scan handler: when `store.scan` rejects → the renderer payload is still exactly
  `{ scanId }` (no message leak — guards the invariant the new dep could break).
- scan handler: on success → `logError` is never called.

**`test/renderer/useSessionScan.test.tsx`**

- no bridge → `status === "unavailable"` (was `"error"`).
- bridge present, `onError` fires → `status === "error"` (the pre-existing test —
  it is what holds the other half of the distinction).

Those two are the whole guard. A third test asserting `status` is `"error"` *and*
`not.toBe("unavailable")` was written and then removed: it is a tautology (a
string cannot equal two literals) that stays green with the fix reverted.

**`test/renderer/FolderBrowser.test.tsx`**

- `unavailable` → renders the bridge notice, not "Couldn't load sessions".
- `error` → renders "Couldn't load sessions", not the bridge notice.

**`test/renderer/TitleBar.test.tsx`**

- the app name renders as the `level: 1` heading (see §3a — the CI-visible copy of
  the guard the e2e cannot provide).

**`e2e/app.smoke.spec.ts`** — as described in §3 (local/manual gate).

## Deliberately out of scope

- **A main-process bridge/handshake probe** (issue gap 2's other option). It
  would mean main waiting on a renderer ping and logging on timeout — new
  lifecycle state and a timer to tune, for a signal `ELECTRON_ENABLE_LOGGING=1`
  already gives for free. Not an AC; the doc note is the issue's own alternative.
- **Logging the reopen handler's swallowed error.** `reopenSession`'s catch maps
  the throw to a stable `code` the renderer surfaces as a toast, so unlike scan it
  is not silent to the user — but the underlying `err` detail is still dropped. Same
  observability class, different handler, not in #83's ACs → filed as a follow-up
  issue rather than widening this PR (per CLAUDE.md: file follow-ups, don't
  scope-creep).
