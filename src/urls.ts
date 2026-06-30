// Pure URL-safety predicates for the renderer↔main security seams. Kept in their
// own module with NO Electron imports so they are unit-testable under
// `node --test` without booting the app. `shell.openExternal` hands the string to
// the OS, so we allow ONLY https: — rejecting file:, javascript:, data:, smb:,
// mailto:, http:, etc.
export function isOpenableUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// Decision for the main window's setWindowOpenHandler. Any target="_blank" /
// window.open from the renderer is ALWAYS denied as an in-app BrowserWindow —
// under sandbox:true Electron would otherwise silently drop the open — and
// rerouted to the OS browser only when the URL is https. `action` is always
// "deny"; `open` gates the shell.openExternal call. Electron-free so the
// always-deny invariant is unit-testable.
export function windowOpenDecision(url: string): {
  action: "deny";
  open: boolean;
} {
  return { action: "deny", open: isOpenableUrl(url) };
}

// Decision for the main window's `will-navigate` guard. A plain in-window anchor
// click is a top-frame NAVIGATION, not a window.open, so it bypasses
// setWindowOpenHandler entirely — without this the BrowserWindow would navigate
// away from the app to the external page, leaving a chromeless trap. CSM's UI is
// a static local page loaded via loadFile (the initial programmatic load does NOT
// fire will-navigate), so a will-navigate event is always either a same-origin
// in-app hop or a real escaping navigation. Same-origin is allowed; anything else
// is prevented, and routed to the OS browser ONLY when https. Electron-free so the
// decision is unit-testable under `node --test`.
export function navigationDecision(
  targetUrl: string,
  appOrigin: string,
): { prevent: boolean; open: boolean } {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return { prevent: true, open: false }; // unparseable → block, never open
  }
  if (target.origin === appOrigin) return { prevent: false, open: false };
  return { prevent: true, open: isOpenableUrl(targetUrl) };
}
