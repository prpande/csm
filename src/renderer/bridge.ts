import type { CsmBridge } from "./types/csm";

/** The optional preload IPC bridge exposed on `window.csm` — `undefined` in a
 * plain browser or a unit test without the preload. Shared by the renderer
 * hooks so they use one bridge-access convention and one injection seam for
 * tests (pass an explicit bridge to override this default). */
export const currentBridge = (): CsmBridge | undefined =>
  typeof window !== "undefined" ? window.csm : undefined;
