// Pure windowing core for the virtualized right-pane session list (spec §6/§11).
// No DOM, no node deps — unit-tested in test/main. Given the scroll offset and a
// fixed row height it returns the [startIndex, endIndex) slice of rows to mount,
// so a folder with thousands of sessions never mounts every row at once.

/** Fixed row height in px. Fixed height is what makes the window pure math. */
export const ROW_HEIGHT = 76;

/** Extra rows mounted above/below the viewport to avoid blank flashes on scroll. */
export const OVERSCAN = 6;

export interface RowWindow {
  /** First row index to mount (inclusive). */
  startIndex: number;
  /** One past the last row to mount (exclusive). */
  endIndex: number;
}

/**
 * Compute the slice of rows to mount for a windowed list.
 *
 * @param scrollTop      current scroll offset (px); negatives clamp to 0
 * @param viewportHeight visible height (px); 0 (e.g. jsdom, unmeasured) still
 *                       yields a bounded overscan-only window
 * @param rowHeight      fixed row height (px); non-positive yields an empty window
 * @param itemCount      total number of rows
 * @param overscan       extra rows to mount on each side of the viewport
 */
export function computeWindow(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  itemCount: number,
  overscan: number,
): RowWindow {
  if (itemCount <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0 };
  }
  const clampedScroll = Math.max(0, scrollTop);
  const firstVisible = Math.floor(clampedScroll / rowHeight);
  const visibleCount = Math.ceil(Math.max(0, viewportHeight) / rowHeight);

  const startIndex = Math.min(itemCount, Math.max(0, firstVisible - overscan));
  const endIndex = Math.min(itemCount, firstVisible + visibleCount + overscan);

  return { startIndex, endIndex: Math.max(startIndex, endIndex) };
}

/**
 * Compute the scrollTop that brings row `index` fully into the viewport (#70).
 *
 * Keyboard navigation can move the active option to a row outside the mounted
 * `[startIndex, endIndex)` window; scrolling to this offset mounts the row (via
 * computeWindow) so aria-activedescendant can point at a real element. Uses the
 * minimal scroll: a row above the fold aligns to the top, one below aligns to the
 * bottom, and an already-visible row is left where it is (returns `scrollTop`).
 *
 * Overscan is intentionally absent from the signature. For a real viewport (at
 * least one row tall), a row made fully VISIBLE by this offset is the first or
 * last visible row, so it lands inside computeWindow's `[startIndex, endIndex)`
 * on its own. Only in a degenerate zero/sub-row viewport (jsdom, unmeasured) does
 * the bottom-align put `firstVisible` one row past the target — there the mount
 * is covered by overscan (>=1). Either way the revealed row is mounted; the
 * parameter would not change that.
 *
 * @param index          target row index
 * @param scrollTop      current scroll offset (px)
 * @param viewportHeight visible height (px)
 * @param rowHeight      fixed row height (px); non-positive leaves scroll as-is
 * @returns the new scroll offset (px), never negative
 */
export function scrollTopToReveal(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number {
  if (rowHeight <= 0) return scrollTop;
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < scrollTop) return Math.max(0, rowTop);
  if (rowBottom > scrollTop + viewportHeight) {
    return Math.max(0, rowBottom - viewportHeight);
  }
  return scrollTop;
}

/** A keyboard navigation intent from the listbox key map. */
export type ListKeyAction =
  { type: "focus"; index: number } | { type: "open"; index: number };

/**
 * Pure key map for the virtualized session listbox (#70).
 *
 * Given the pressed key, the currently-focused index (`-1` = nothing focused
 * yet) and the item count, returns the navigation intent, or `null` to let the
 * event through untouched (e.g. Tab, so focus can leave the pane).
 *
 * Arrow/Home/End clamp to the ends and still return a `focus` action at the
 * boundary (never null) so the handler can `preventDefault` — arrow keys belong
 * to the listbox and must not also scroll the page. Enter opens the focused row.
 */
export function listKeyAction(
  key: string,
  focusedIndex: number,
  itemCount: number,
): ListKeyAction | null {
  if (itemCount <= 0) return null;
  const last = itemCount - 1;
  const clamp = (i: number): number => Math.min(last, Math.max(0, i));
  switch (key) {
    case "ArrowDown":
      // From -1 (unseeded), +1 lands on 0 — the first row.
      return { type: "focus", index: clamp(focusedIndex + 1) };
    case "ArrowUp":
      return { type: "focus", index: clamp(focusedIndex - 1) };
    case "Home":
      return { type: "focus", index: 0 };
    case "End":
      return { type: "focus", index: last };
    case "Enter":
      // Only a real, in-range focused row can be opened.
      return focusedIndex >= 0 && focusedIndex <= last
        ? { type: "open", index: focusedIndex }
        : null;
    default:
      return null;
  }
}
