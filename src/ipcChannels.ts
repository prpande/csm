// IPC channel names shared by the main-process bridge (src/ipc.ts), the preload
// (src/preload.ts), and the handler tests. Kept in a DEPENDENCY-FREE module: the
// preload bundle imports these but must never transitively pull node:fs /
// node:child_process (which ipc.ts uses) into the sandboxed renderer's preload.

export const CH = {
  // listSessions streaming: renderer invokes `scan` with a scanId; main pushes
  // batch* per tier then done (or error). All payloads carry the scanId so the
  // preload can drop a concurrent scan's events.
  sessionsScan: "sessions:scan",
  sessionsBatch: "sessions:batch",
  sessionsDone: "sessions:done",
  sessionsError: "sessions:error",
  // reopen (invoke → discriminated result) and settings get/set (invoke).
  sessionReopen: "session:reopen",
  settingsGet: "settings:getClaudePath",
  settingsSet: "settings:setClaudePath",
  // https-only external-link egress (shipped in the scaffold).
  shellOpenExternal: "shell:open-external",
} as const;
