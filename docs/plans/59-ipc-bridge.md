# Plan — #59 IPC bridge: wire listSessions / reopenSession / settings through `csm`

**Tier:** Standard (new main-process `ipc` module + preload surface + shared types).
Touches `src/ipc.ts` (new), `src/ipcChannels.ts` (new), `src/preload.ts`,
`src/main.ts`, `src/renderer/types/csm.d.ts`, `test/main/ipc.test.ts` (new).

## Goal

Turn the shipped units (`sessionStore`, `reopenSession`, `settingsStore`,
`pathAdapter`) into a working scan + reopen flow reachable from the sandboxed
renderer, exposed as three capability groups on the single `csm` preload global
(spec §3, §5 `ipc` module). No renderer UI in this slice — the tree/list and the
bypass-confirm modal are separate `area:tree-ui` / renderer issues; this wires
the plumbing and unit-tests the main-process handlers.

## Approach

### Module split (testability)

`main.ts` runs single-instance-lock / `app.whenReady` side effects on import, so
its handlers can't be exercised in a unit test. Extract a pure-ish
**`src/ipc.ts`** exporting `registerIpcHandlers(deps)` that takes every effectful
dependency injected (matching the factory-DI convention of `sessionStore` /
`reopenSession` / `settingsStore`):

```ts
registerIpcHandlers({
  ipcMain,                 // { handle(channel, listener) }
  isTrustedSender,         // (sender: unknown) => boolean  — the §sender guard
  createSessionStore,      // (rootDir) => { scan(opts) }
  settingsStore,           // { getClaudePath, setClaudePath }
  reopen,                  // (req: ReopenRequest) => Promise<void>
  projectsRoot,            // pathAdapter.defaultProjectsRoot()
  platform,                // process.platform
  now,                     // () => Date.now()
})
```

`main.ts` calls it once inside the `gotLock` block with real deps
(`settingsStore = createSettingsStore(app.getPath("userData"))`,
`isTrustedSender = (s) => mainWindow !== null && s === mainWindow.webContents`).
Tests call it with a fake `ipcMain` (records handlers in a Map), fake stores, and
fake events. Channel-name string constants live in a **dependency-free
`src/ipcChannels.ts`** so `preload.ts` can share them without pulling
`node:fs`/`node:child_process` (via `ipc.ts`) into the preload bundle.

### listSessions — streaming (Approach 1: static channels + `scanId` in payload)

`ipcMain.handle` is request/response; streaming needs main→renderer push. The
handler for `sessions:scan` (invoke, arg = renderer-minted `scanId` string):

1. Sender guard; ignore untrusted / non-string `scanId`.
2. `createSessionStore(projectsRoot).scan({ now: now(), onBatch })` where
   `onBatch(sessions)` does `event.sender.send("sessions:batch", { scanId, sessions })`.
3. On resolve → `send("sessions:done", { scanId })`.
4. On throw → `send("sessions:error", { scanId })`. (`scan` is fail-soft — a
   missing `~/.claude/projects` resolves to empty `folders`, so an empty scan
   yields **done with no batch**, never error.)

Preload `listSessions({onBatch,onDone,onError})` mints a monotonic `scanId`
(module counter — no `Math.random`), attaches static `ipcRenderer.on` listeners
that **filter by the active `scanId`** (dropping a concurrent scan's events),
invokes `sessions:scan`, and returns an unsubscribe that detaches them; done/error
auto-detach. One listener set, no per-scan channel churn.

**Hardening (from preflight review).** Two error paths were tightened after the
adversarial pass: (1) the main scan handler routes all three pushes through a
`post()` wrapper that swallows `sender.send` failures — when the WebContents is
destroyed mid-scan the send throws, and letting it escape (including the
`sessions:error` send in the catch) would reject the invoke as an unhandled
error; `post` contains it and keeps the catch meaning "scan failed", not "send
failed". (2) The preload holds a `settled` flag so `onDone`/`onError` (and
cleanup) fire **at most once**, deduping a pushed done/error against a rejected
invoke and any late-batch race.

### reopenSession — typed discriminated result

`session:reopen` (invoke, arg = `{ cwd, sessionId, mode }`): sender guard → read
`claudePath` from `settingsStore` → `reopen({ os: platform, cwd, sessionId, mode,
claudePath })`. Returns `{ ok: true }` on resolve; on a thrown typed error returns
`{ ok: false, code }` using **only** the stable `.code` (allowlist derived from
the single-source `REOPEN_ERROR_CODES` array; any unexpected throw → `SPAWN_FAILED`).
`error.message` (which may embed an untrusted path) never crosses IPC. `os: platform`
is passed through unchanged — `reopenSession` itself raises `UNSUPPORTED_OS` for a
non win32/darwin host, which is the intended path. `permissionMode`/`mode` passed
through untouched. The **entire** body after the sender guard (including the `req`
destructuring and the `settingsStore.getClaudePath()` await) runs inside the
try/catch, so a malformed `req` (null/undefined from a buggy renderer) or a
settings-read failure resolves to `{ ok: false, code: "SPAWN_FAILED" }` rather than
rejecting the invoke. The untrusted-sender return is the same opaque
`SPAWN_FAILED` — deliberately no distinct auth code (unreachable in a single-window
app; an IPC-auth result has no place in a reopen-domain enum).

### settings get/set

`settings:getClaudePath` → `settingsStore.getClaudePath()` (untrusted → benign
`"claude"` default, no disclosure). `settings:setClaudePath` (arg = string) →
`settingsStore.setClaudePath(value)` (untrusted or non-string → no-op).

### Types & preload surface

Extend the shared `src/renderer/types/csm.d.ts` `CsmBridge` with
`listSessions`, `reopenSession`, `getClaudePath`, `setClaudePath` (+ `ReopenResult`
/ `ReopenErrorCode` / listener types), reusing `SessionMetadata` from the pure
`sessionParser` (no node imports — renderer-safe). `preload.ts` stays a single
`contextBridge.exposeInMainWorld("csm", {…})`; no `ipcRenderer`/Node leak.

## Tests (`test/main/ipc.test.ts`, node-context per the tsconfig seam)

Fake `ipcMain` records handlers; invoke them with a fake event
(`{ sender: { send: spy } }`).

1. `sessions:scan` trusted → one `sessions:batch {scanId, sessions}` per `onBatch`,
   then `sessions:done {scanId}`.
2. Empty scan (no `onBatch`) → `sessions:done` only, no batch.
3. Scan throws → `sessions:error {scanId}`, no done.
4. `sessions:scan` untrusted sender → scan not run, nothing sent.
5. `sessions:scan` passes `now()` into `scan` opts and `projectsRoot` into
   `createSessionStore`.
6. Non-string `scanId` → ignored (no scan, no send).
7. `session:reopen` success → `{ ok: true }`; `reopen` called with
   `os=platform`, injected `claudePath`, and req's cwd/sessionId/mode.
8. Each typed error (`UNSUPPORTED_OS`/`FOLDER_MISSING`/`UNSAFE_PATH`/`SPAWN_FAILED`)
   → `{ ok: false, code }`; result has no `message` key.
9. Unexpected (untyped) throw → `{ ok: false, code: "SPAWN_FAILED" }`, no message.
10. `session:reopen` untrusted → `reopen` not called, `{ ok: false }`.
11. `session:reopen` malformed `req` (null/undefined) from a trusted sender
    resolves to `{ ok: false, code: "SPAWN_FAILED" }` (never rejects). _(Added
    from preflight review.)_
12. `settings:getClaudePath` trusted → store value; untrusted → `"claude"`,
    store not read.
13. `settings:setClaudePath` trusted → delegates value; untrusted / non-string →
    `setClaudePath` not called.

## Out of scope (separate issues)

- Renderer tree / session list / folder view (`area:tree-ui`).
- `bypassPermissions` confirmation modal + error toast (renderer).
- Settings modal UI + `claudePath` resolvability validation (`area:settings`).
- Preload unit test — no electron-mock harness exists yet (parity with the
  untested scaffold preload); the surface is covered structurally + by CI.
