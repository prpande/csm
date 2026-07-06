// The narrow IPC bridge the preload (#4) exposes on `window.csm`. Kept in the
// renderer types so components and tests share one contract. Mirrors
// `contextBridge.exposeInMainWorld("csm", …)` in src/preload.ts.

import type {
  ReopenRequestDto,
  ReopenResult,
  SessionsListener,
  SessionFactsResult,
  ThemePreference,
} from "../../ipcTypes";

export type { ThemePreference };

export type Platform = "darwin" | "win32" | "linux" | (string & {});

/** Custom frameless-shell window controls (#86). Absent in a plain browser / a
 * unit test without the preload, so every consumer must treat it as optional. */
export interface CsmWindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  /** Current maximized state, for seeding the maximize/restore glyph on mount. */
  isMaximized(): Promise<boolean>;
  /** Subscribe to maximize/unmaximize; returns an unsubscribe. */
  onMaximizedChange(cb: (maximized: boolean) => void): () => void;
}

/** Theme preference control (#86). Absent in a plain browser / a unit test without
 * the preload, so consumers must treat it as optional. set() drives main's
 * nativeTheme, which updates the renderer's prefers-color-scheme on its own. */
export interface CsmTheme {
  get(): Promise<ThemePreference>;
  set(value: ThemePreference): Promise<void>;
}

export interface CsmBridge {
  readonly isDesktop: boolean;
  readonly platform: Platform;
  openExternal(url: string): Promise<boolean>;
  /** Optional: only present under the desktop preload's frameless shell. */
  readonly windowControls?: CsmWindowControls;
  /** Optional: only present under the desktop preload. */
  readonly theme?: CsmTheme;
  /** Start a streaming session scan; returns an unsubscribe. done/error also
   * auto-detach. Batches/signals for a superseded scan are dropped. */
  listSessions(listener: SessionsListener): () => void;
  /** Reopen a closed session; resolves to a discriminated result (never throws
   * an untrusted error message across IPC). */
  reopenSession(req: ReopenRequestDto): Promise<ReopenResult>;
  /** Batch fact fetch for enriched rows (#115). Always wired under the preload,
   *  like listSessions/reopenSession. */
  getFacts(ids: string[]): Promise<SessionFactsResult>;
  getClaudePath(): Promise<string>;
  setClaudePath(value: string): Promise<void>;
  /** Resolved system temp roots, for the renderer's default-on hide filter
   *  (#69). The renderer prefix-matches session cwds against these. */
  getTempRoots(): Promise<string[]>;
}

declare global {
  interface Window {
    // Optional: undefined in a plain browser / unit test without the preload.
    csm?: CsmBridge;
  }
}
