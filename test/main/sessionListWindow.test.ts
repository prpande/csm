import { test, expect } from "vitest";
import {
  computeWindow,
  scrollTopToReveal,
  listKeyAction,
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

// scrollTopToReveal is the pure "scroll a row into view" core (#70). Keyboard
// nav can move focus to a row outside the mounted window; this computes the
// scrollTop that makes the target row fully visible, so the row mounts before
// we point aria-activedescendant at it. Overscan is deliberately NOT a param:
// a row made fully VISIBLE (viewport-based) is necessarily inside the mounted
// window, since computeWindow's firstVisible always falls in [start,end).

test("reveal: a fully-visible row does not scroll", () => {
  // 600px viewport / 60px rows => rows 0..9 visible at scrollTop 0; row 5 is in.
  expect(scrollTopToReveal(5, 0, 600, 60)).toBe(0);
});

test("reveal: a row above the viewport scrolls up so it sits at the top", () => {
  // Viewing rows 10.. (scrollTop 600); reveal row 3 => its top, 180.
  expect(scrollTopToReveal(3, 600, 600, 60)).toBe(180);
});

test("reveal: a row below the viewport scrolls down so it sits at the bottom", () => {
  // scrollTop 0, 600px/60 => rows 0..9 full. Reveal row 20: rowBottom 21*60=1260,
  // bottom-aligned => 1260 - 600 = 660.
  expect(scrollTopToReveal(20, 0, 600, 60)).toBe(660);
});

test("reveal: row 0 goes to the very top", () => {
  expect(scrollTopToReveal(0, 600, 600, 60)).toBe(0);
});

test("reveal: the last row bottom-aligns to the max scroll offset", () => {
  // 100 rows, reveal row 99: rowBottom 100*60=6000 => 6000 - 600 = 5400.
  expect(scrollTopToReveal(99, 0, 600, 60)).toBe(5400);
});

test("reveal: a row just past the fold scrolls only as far as needed", () => {
  // scrollTop 0, viewport 600 => row 10's top sits exactly at 600 (just below).
  // rowBottom 11*60=660 > 600 => 660 - 600 = 60. Minimal nudge, not a jump.
  expect(scrollTopToReveal(10, 0, 600, 60)).toBe(60);
});

test("reveal: never returns a negative scrollTop", () => {
  expect(scrollTopToReveal(0, 0, 600, 60)).toBe(0);
});

test("reveal: guards a non-positive row height (leaves scroll unchanged)", () => {
  expect(scrollTopToReveal(5, 100, 600, 0)).toBe(100);
});

// listKeyAction is the pure key map for the listbox (#70): given the pressed key,
// the currently-focused index (-1 = nothing focused yet) and the item count, it
// returns the navigation intent — {type:"focus"} to move the active option or
// {type:"open"} to reopen it — or null to let the event through (e.g. Tab).

test("listKeyAction: ArrowDown moves to the next row", () => {
  expect(listKeyAction("ArrowDown", 3, 100)).toEqual({
    type: "focus",
    index: 4,
  });
});

test("listKeyAction: ArrowUp moves to the previous row", () => {
  expect(listKeyAction("ArrowUp", 3, 100)).toEqual({ type: "focus", index: 2 });
});

test("listKeyAction: ArrowDown clamps at the last row (still owns the key)", () => {
  // Returns the (unchanged) index rather than null so the handler still
  // preventDefaults — arrows belong to the listbox, they must not scroll the page.
  expect(listKeyAction("ArrowDown", 99, 100)).toEqual({
    type: "focus",
    index: 99,
  });
});

test("listKeyAction: ArrowUp clamps at the first row", () => {
  expect(listKeyAction("ArrowUp", 0, 100)).toEqual({ type: "focus", index: 0 });
});

test("listKeyAction: from nothing-focused, either arrow lands on the first row", () => {
  expect(listKeyAction("ArrowDown", -1, 100)).toEqual({
    type: "focus",
    index: 0,
  });
  expect(listKeyAction("ArrowUp", -1, 100)).toEqual({
    type: "focus",
    index: 0,
  });
});

test("listKeyAction: Home jumps to the first row, End to the last", () => {
  expect(listKeyAction("Home", 50, 100)).toEqual({ type: "focus", index: 0 });
  expect(listKeyAction("End", 50, 100)).toEqual({ type: "focus", index: 99 });
});

test("listKeyAction: Enter opens the focused row", () => {
  expect(listKeyAction("Enter", 7, 100)).toEqual({ type: "open", index: 7 });
});

test("listKeyAction: Enter with nothing focused does nothing", () => {
  expect(listKeyAction("Enter", -1, 100)).toBeNull();
});

test("listKeyAction: an unrelated key is not handled (event passes through)", () => {
  expect(listKeyAction("Tab", 3, 100)).toBeNull();
  expect(listKeyAction("a", 3, 100)).toBeNull();
});

test("listKeyAction: an empty list handles nothing", () => {
  expect(listKeyAction("ArrowDown", -1, 0)).toBeNull();
  expect(listKeyAction("End", -1, 0)).toBeNull();
  expect(listKeyAction("Enter", -1, 0)).toBeNull();
});
