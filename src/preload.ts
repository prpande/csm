import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CH } from "./ipcChannels";
import type {
  ReopenRequestDto,
  ReopenResult,
  SessionsBatchMessage,
  SessionsListener,
  SessionsSignalMessage,
} from "./ipcTypes";

// Preload for the hardened CSM renderer. This is the ONLY bridge between the
// sandboxed renderer and the main process — the renderer has no direct disk or
// process access (contextIsolation: true, nodeIntegration: false, sandbox: true).
//
// Keep this surface narrow and namespaced under a single `csm` global. Only
// channel-name constants (ipcChannels) and type-only imports (ipcTypes) are
// pulled in — never the main-side handler module, so node:fs / node:child_process
// stay out of the preload bundle.
const platform = process.platform;

// Monotonic per-scan correlation id. A plain counter (no Math.random, which is
// unavailable in some harnesses) is enough — it only has to be unique within this
// preload's lifetime so a stale scan's pushed events can be filtered out.
let scanSeq = 0;

contextBridge.exposeInMainWorld("csm", {
  isDesktop: true,
  platform,
  // Open an external link in the OS browser. Main enforces https-only and the
  // sender guard; a `false` return means the URL was rejected or the OS open
  // threw — surfaced here so a stray caller is observable.
  openExternal: async (url: string): Promise<boolean> => {
    const ok: boolean = await ipcRenderer.invoke(CH.shellOpenExternal, url);
    if (!ok) console.warn("csm.openExternal: rejected", url);
    return ok;
  },

  // Streaming session scan. Main pushes a batch per tier then a single done (or an
  // error). Events for a *different* scanId (a scan started after this one) are
  // dropped. Returns an unsubscribe; done/error also auto-detach the listeners.
  listSessions(listener: SessionsListener): () => void {
    const scanId = `scan-${++scanSeq}`;
    const onBatch = (_e: IpcRendererEvent, msg: SessionsBatchMessage): void => {
      if (msg.scanId === scanId) listener.onBatch(msg.sessions);
    };
    const onDone = (_e: IpcRendererEvent, msg: SessionsSignalMessage): void => {
      if (msg.scanId !== scanId) return;
      cleanup();
      listener.onDone();
    };
    const onError = (
      _e: IpcRendererEvent,
      msg: SessionsSignalMessage,
    ): void => {
      if (msg.scanId !== scanId) return;
      cleanup();
      listener.onError();
    };
    const cleanup = (): void => {
      ipcRenderer.off(CH.sessionsBatch, onBatch);
      ipcRenderer.off(CH.sessionsDone, onDone);
      ipcRenderer.off(CH.sessionsError, onError);
    };
    ipcRenderer.on(CH.sessionsBatch, onBatch);
    ipcRenderer.on(CH.sessionsDone, onDone);
    ipcRenderer.on(CH.sessionsError, onError);
    // A rejected invoke (main threw before streaming) surfaces as an error too.
    void ipcRenderer.invoke(CH.sessionsScan, scanId).catch(() => {
      cleanup();
      listener.onError();
    });
    return cleanup;
  },

  reopenSession: (req: ReopenRequestDto): Promise<ReopenResult> =>
    ipcRenderer.invoke(CH.sessionReopen, req),

  getClaudePath: (): Promise<string> => ipcRenderer.invoke(CH.settingsGet),

  setClaudePath: (value: string): Promise<void> =>
    ipcRenderer.invoke(CH.settingsSet, value),
});
