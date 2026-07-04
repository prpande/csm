// Pure windowing core for the virtualized right-pane session list (spec §6/§11).
// No DOM, no node deps — unit-tested in test/main. Given the scroll offset and a
// fixed row height it returns the [startIndex, endIndex) slice of rows to mount,
// so a folder with thousands of sessions never mounts every row at once.

/** Fixed row height in px. Fixed height is what makes the window pure math. */
export const ROW_HEIGHT = 56;

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
