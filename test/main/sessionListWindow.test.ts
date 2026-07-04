import { test, expect } from "vitest";
import {
  computeWindow,
  ROW_HEIGHT,
  OVERSCAN,
} from "../../src/sessionListWindow";

// computeWindow is the pure core of the virtualized list: given the scroll
// position, viewport height, fixed row height, item count and overscan it
// returns the [startIndex, endIndex) slice to mount. endIndex is EXCLUSIVE.

test("mounts the top window with no overscan", () => {
  // 600px viewport / 60px rows => 10 rows visible from the top.
  expect(computeWindow(0, 600, 60, 100, 0)).toEqual({
    startIndex: 0,
    endIndex: 10,
  });
});

test("adds overscan below the fold (clamped to 0 above)", () => {
  expect(computeWindow(0, 600, 60, 100, 3)).toEqual({
    startIndex: 0, // max(0, 0 - 3)
    endIndex: 13, // 0 + 10 + 3
  });
});

test("slides the window as the list scrolls", () => {
  // scrolled 600px => first visible row is index 10.
  expect(computeWindow(600, 600, 60, 100, 2)).toEqual({
    startIndex: 8, // 10 - 2
    endIndex: 22, // 10 + 10 + 2
  });
});

test("clamps a negative scrollTop to the top window", () => {
  expect(computeWindow(-500, 600, 60, 100, 2)).toEqual(
    computeWindow(0, 600, 60, 100, 2),
  );
});

test("keeps the mounted count bounded regardless of list size", () => {
  const small = computeWindow(0, 600, 60, 50, 6);
  const huge = computeWindow(0, 600, 60, 100000, 6);
  const span = (w: { startIndex: number; endIndex: number }) =>
    w.endIndex - w.startIndex;
  // Same viewport => same number of mounted rows whether 50 or 100k items.
  expect(span(huge)).toBe(span(small));
  expect(span(huge)).toBeLessThan(50);
});

test("a zero-height viewport still yields a bounded (overscan-only) window", () => {
  // jsdom has no layout, so the measured height is 0 — the window must stay
  // bounded rather than mounting every row.
  expect(computeWindow(0, 0, 60, 2500, 6)).toEqual({
    startIndex: 0,
    endIndex: 6,
  });
});

test("does not run past the end of a short list", () => {
  expect(computeWindow(0, 600, 60, 5, 2)).toEqual({
    startIndex: 0,
    endIndex: 5,
  });
});

test("an overrun scroll collapses to an empty window at the end", () => {
  expect(computeWindow(1_000_000, 600, 60, 100, 2)).toEqual({
    startIndex: 100,
    endIndex: 100,
  });
});

test("an empty list yields an empty window", () => {
  expect(computeWindow(0, 600, 60, 0, 6)).toEqual({
    startIndex: 0,
    endIndex: 0,
  });
});

test("guards against a non-positive row height", () => {
  expect(computeWindow(0, 600, 0, 100, 6)).toEqual({
    startIndex: 0,
    endIndex: 0,
  });
});

test("exposes sane layout constants", () => {
  expect(ROW_HEIGHT).toBeGreaterThan(0);
  expect(OVERSCAN).toBeGreaterThan(0);
});
