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
  // Custom window-control chrome (#86 frameless shell). minimize/toggle/close are
  // fire-and-forget (ipcMain.on); is-maximized is request/response (handle); main
  // pushes maximized-changed on the window's maximize/unmaximize events so the
  // renderer's maximize button can swap to a restore glyph.
  windowMinimize: "window:minimize",
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  windowIsMaximized: "window:is-maximized",
  windowMaximizedChanged: "window:maximized-changed",
} as const;
