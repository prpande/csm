// The narrow IPC bridge the preload (#4) exposes on `window.csm`. Kept in the
// renderer types so components and tests share one contract. Mirrors
// `contextBridge.exposeInMainWorld("csm", …)` in src/preload.ts.

export type Platform = "darwin" | "win32" | "linux" | (string & {});

export interface CsmBridge {
  readonly isDesktop: boolean;
  readonly platform: Platform;
  openExternal(url: string): Promise<boolean>;
}

declare global {
  interface Window {
    // Optional: undefined in a plain browser / unit test without the preload.
    csm?: CsmBridge;
  }
}
