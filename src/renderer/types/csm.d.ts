// The narrow IPC bridge the preload (#4) exposes on `window.csm`. Kept in the
// renderer types so components and tests share one contract. Mirrors
// `contextBridge.exposeInMainWorld("csm", …)` in src/preload.ts.

import type {
  ReopenRequestDto,
  ReopenResult,
  SessionsListener,
} from "../../ipcTypes";

export type Platform = "darwin" | "win32" | "linux" | (string & {});

export interface CsmBridge {
  readonly isDesktop: boolean;
  readonly platform: Platform;
  openExternal(url: string): Promise<boolean>;
  /** Start a streaming session scan; returns an unsubscribe. done/error also
   * auto-detach. Batches/signals for a superseded scan are dropped. */
  listSessions(listener: SessionsListener): () => void;
  /** Reopen a closed session; resolves to a discriminated result (never throws
   * an untrusted error message across IPC). */
  reopenSession(req: ReopenRequestDto): Promise<ReopenResult>;
  getClaudePath(): Promise<string>;
  setClaudePath(value: string): Promise<void>;
}

declare global {
  interface Window {
    // Optional: undefined in a plain browser / unit test without the preload.
    csm?: CsmBridge;
  }
}
