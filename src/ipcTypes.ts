// Wire-shape types shared across the IPC boundary: consumed by the main-process
// bridge (src/ipc.ts) and the renderer contract (src/renderer/types/csm.d.ts).
// Dependency-free at runtime (type-only) — it references only SessionMetadata
// from the pure sessionParser, so it is safe to import from the DOM-only renderer
// tsconfig as well as the node main tsconfig.

import type { SessionMetadata } from "./sessionParser";

/** Stable reopen failure codes (§3.6). The renderer maps these to display text;
 * `error.message` (which may embed an untrusted path) never crosses IPC. */
export type ReopenErrorCode =
  "UNSUPPORTED_OS" | "FOLDER_MISSING" | "UNSAFE_PATH" | "SPAWN_FAILED";

/** Discriminated result of a reopen attempt — plain, structured-clone safe. */
export type ReopenResult = { ok: true } | { ok: false; code: ReopenErrorCode };

/** What the renderer supplies to reopen; the OS and claudePath are filled in by
 * main (from process.platform / settingsStore), never trusted from the renderer. */
export interface ReopenRequestDto {
  cwd: string;
  sessionId: string;
  mode: string;
}

/** One streamed tier of a scan. `scanId` correlates a batch to its scan so the
 * preload can discard a concurrent (stale) scan's events. */
export interface SessionsBatchMessage {
  scanId: string;
  sessions: SessionMetadata[];
}

/** The terminating done / error signal for a scan. */
export interface SessionsSignalMessage {
  scanId: string;
}

/** Renderer-side subscription callbacks for a streaming scan. */
export interface SessionsListener {
  onBatch: (sessions: SessionMetadata[]) => void;
  onDone: () => void;
  onError: () => void;
}
