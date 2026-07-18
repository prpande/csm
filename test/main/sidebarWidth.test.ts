import { describe, it, expect } from "vitest";
import {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_KEY_STEP,
  maxSidebarWidth,
  clampSidebarWidth,
  restoreSidebarWidth,
  splitterKeyWidth,
} from "../../src/sidebarWidth";

// Pure sidebar-width math (#164): clamping, localStorage restore parsing, and
// the splitter's keyboard map. No DOM — the component only wires these up.

describe("maxSidebarWidth", () => {
  it("caps the sidebar at 60% of the window", () => {
    expect(maxSidebarWidth(1000)).toBe(600);
  });

  it("never drops below the minimum on a tiny window", () => {
    // 60% of 200 is 120 < min; the sidebar pins at min rather than inverting
    // the min/max order (clamp would otherwise oscillate).
    expect(maxSidebarWidth(200)).toBe(SIDEBAR_MIN_WIDTH);
  });
});

describe("clampSidebarWidth", () => {
  it("passes a width inside the range through, rounded to a whole pixel", () => {
    expect(clampSidebarWidth(300, 1000)).toBe(300);
    expect(clampSidebarWidth(300.6, 1000)).toBe(301);
  });

  it("clamps below-min and above-max widths", () => {
    expect(clampSidebarWidth(40, 1000)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900, 1000)).toBe(600);
  });

  it("falls back to the default (then clamps it) on a non-finite width", () => {
    expect(clampSidebarWidth(Number.NaN, 1000)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Infinity, 1000)).toBe(SIDEBAR_DEFAULT_WIDTH);
    // Tiny window: even the default is clamped down to what fits.
    expect(clampSidebarWidth(Number.NaN, 200)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("clamps the default itself when the window is too small for it", () => {
    expect(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, 200)).toBe(
      SIDEBAR_MIN_WIDTH,
    );
  });
});

describe("restoreSidebarWidth", () => {
  it("uses the default when nothing is stored", () => {
    expect(restoreSidebarWidth(null, 1000)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("parses a stored numeric width and clamps it to the current window", () => {
    expect(restoreSidebarWidth("320", 1000)).toBe(320);
    expect(restoreSidebarWidth("5000", 1000)).toBe(600);
    expect(restoreSidebarWidth("-1", 1000)).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("falls back to the default on corrupt stored values", () => {
    // "" is explicit: Number("") is 0, which would silently pin the sidebar at
    // min instead of surfacing the corruption as "back to default".
    expect(restoreSidebarWidth("", 1000)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(restoreSidebarWidth("   ", 1000)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(restoreSidebarWidth("garbage", 1000)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(restoreSidebarWidth("Infinity", 1000)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("splitterKeyWidth", () => {
  it("ArrowLeft/ArrowRight step the width, clamped at the edges", () => {
    expect(splitterKeyWidth("ArrowLeft", 300, 1000)).toBe(
      300 - SIDEBAR_KEY_STEP,
    );
    expect(splitterKeyWidth("ArrowRight", 300, 1000)).toBe(
      300 + SIDEBAR_KEY_STEP,
    );
    expect(splitterKeyWidth("ArrowLeft", SIDEBAR_MIN_WIDTH, 1000)).toBe(
      SIDEBAR_MIN_WIDTH,
    );
    expect(splitterKeyWidth("ArrowRight", 600, 1000)).toBe(600);
  });

  it("Home/End jump to min/max", () => {
    expect(splitterKeyWidth("Home", 300, 1000)).toBe(SIDEBAR_MIN_WIDTH);
    expect(splitterKeyWidth("End", 300, 1000)).toBe(600);
  });

  it("Enter restores the (clamped) default — the keyboard reset", () => {
    expect(splitterKeyWidth("Enter", 500, 1000)).toBe(SIDEBAR_DEFAULT_WIDTH);
    // A window too small for the default clamps it, same as every other path.
    expect(splitterKeyWidth("Enter", 200, 300)).toBe(maxSidebarWidth(300));
  });

  it("returns null for keys the splitter does not own", () => {
    expect(splitterKeyWidth("ArrowUp", 300, 1000)).toBe(null);
    expect(splitterKeyWidth("a", 300, 1000)).toBe(null);
  });
});
