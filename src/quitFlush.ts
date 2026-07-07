// The before-quit flush handshake (spec §7.5, §9). Electron does NOT delay quit
// for a fire-and-forget async task, so a dirty index must preventDefault, await
// the async atomic flush, then re-invoke quit. The `quitting` guard makes the
// re-quit pass through cleanly. Extracted from main.ts so it is unit-testable
// without an Electron runtime — main.ts only wires the real callbacks in.

export interface QuitFlushDeps {
  /** True when the index has unpersisted changes or a write is in flight. */
  isDirty: () => boolean;
  /** Single-writer atomic flush; cancels its own debounce internally. */
  flush: () => Promise<void>;
  /** Re-invoke the quit that this handler intercepted (e.g. app.quit). */
  quit: () => void;
}

export function createBeforeQuitHandler(
  deps: QuitFlushDeps,
): (event: { preventDefault: () => void }) => void {
  let quitting = false;
  return (event) => {
    // Second pass (our own re-quit) or a clean index → let quit proceed.
    if (quitting || !deps.isDirty()) return;
    event.preventDefault();
    quitting = true;
    // Flush, then quit regardless of flush success — never hang the app on an
    // index-write error (§11). The re-quit fires before-quit again; `quitting`
    // is now true so it falls through to a real quit.
    void deps.flush().finally(deps.quit);
  };
}
