// Pure sidebar-width math for the resizable folder sidebar (#164). The renderer
// splitter (FolderBrowser) only wires these to pointer/keyboard events and
// localStorage — every clamp/parse/keyboard decision lives here so it can be
// unit-tested without a DOM, like sessionListWindow/sessionTree.

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_DEFAULT_WIDTH = 260;
/** Pixels per ArrowLeft/ArrowRight press on the focused splitter. */
export const SIDEBAR_KEY_STEP = 16;
/** localStorage key. View state only — deliberately NOT in settingsStore: the
 * width is per-machine renderer chrome, not a setting worth an IPC round-trip. */
export const SIDEBAR_WIDTH_KEY = "csm.sidebar-width";

/** Widest the sidebar may grow: 60% of the window, so the session pane always
 * keeps a usable share. Floors at the minimum so min <= max always holds and a
 * tiny window pins the sidebar at min instead of inverting the clamp range. */
export function maxSidebarWidth(windowWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.round(windowWidth * 0.6));
}

/** Clamp a candidate width into [min, max(window)], whole pixels. A non-finite
 * candidate (corrupt storage, arithmetic gone wrong) falls back to the default —
 * which is itself clamped, so a tiny window still gets a legal width. */
export function clampSidebarWidth(width: number, windowWidth: number): number {
  const candidate = Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    maxSidebarWidth(windowWidth),
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(candidate)),
  );
}

/** Parse a stored width (localStorage string or null) into a legal width.
 * Blank is treated as corrupt, not as Number("") === 0 — zero would silently
 * pin the sidebar at min instead of recovering to the default. */
export function restoreSidebarWidth(
  stored: string | null,
  windowWidth: number,
): number {
  if (stored === null || stored.trim() === "") {
    return clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, windowWidth);
  }
  return clampSidebarWidth(Number(stored), windowWidth);
}

/** Keyboard map for the focused splitter (APG window-splitter pattern): arrows
 * step, Home/End jump to the extremes, Enter restores the default — the
 * keyboard twin of the double-click reset. Null = not the splitter's key, so
 * the caller lets the event through (e.g. Tab). Left/Right only — the splitter
 * is vertical, so Up/Down have no spatial meaning here. */
export function splitterKeyWidth(
  key: string,
  width: number,
  windowWidth: number,
): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampSidebarWidth(width - SIDEBAR_KEY_STEP, windowWidth);
    case "ArrowRight":
      return clampSidebarWidth(width + SIDEBAR_KEY_STEP, windowWidth);
    case "Home":
      return SIDEBAR_MIN_WIDTH;
    case "End":
      return maxSidebarWidth(windowWidth);
    case "Enter":
      return clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, windowWidth);
    default:
      return null;
  }
}
