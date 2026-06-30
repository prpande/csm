import { contextBridge, ipcRenderer } from "electron";

// Preload for the hardened CSM renderer. This is the ONLY bridge between the
// sandboxed renderer and the main process — the renderer has no direct disk or
// process access (contextIsolation: true, nodeIntegration: false, sandbox: true).
//
// Keep this surface narrow and namespaced under a single `csm` global. Session
// scanning / launching / settings channels are added by later phases on top of
// this same object; the scaffold exposes only platform info and the https-only
// external-link egress.
const platform = process.platform;

contextBridge.exposeInMainWorld("csm", {
  isDesktop: true,
  platform,
  // Open an external link in the OS browser. Main enforces https-only and the
  // sender guard; a `false` return means the URL was rejected or the OS open
  // threw — surfaced here so a stray caller is observable.
  openExternal: async (url: string): Promise<boolean> => {
    const ok: boolean = await ipcRenderer.invoke("shell:open-external", url);
    if (!ok) console.warn("csm.openExternal: rejected", url);
    return ok;
  },
});
