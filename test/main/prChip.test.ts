import { describe, expect, test } from "vitest";
import type { SessionPrLink } from "../../src/ipcTypes";
import {
  orderedPrs,
  popoverPlacement,
  prButtonLabel,
  primaryPr,
  prLinkSummary,
  prPopoverKey,
  prStateLabel,
} from "../../src/prChip";

const pr = (over: Partial<SessionPrLink> = {}): SessionPrLink => ({
  repo: "o/r",
  number: 12,
  url: "https://github.com/o/r/pull/12",
  title: "Fix the parser",
  state: "OPEN",
  isDraft: false,
  createdHere: false,
  firstSeen: 10,
  lastSeen: 20,
  ...over,
});

describe("primaryPr", () => {
  test("none for no links", () => {
    expect(primaryPr([])).toBeUndefined();
  });

  test("a PR the session created beats a more recently mentioned one", () => {
    const created = pr({ number: 3, createdHere: true, lastSeen: null });
    expect(primaryPr([pr({ number: 9, lastSeen: 99 }), created])).toBe(created);
  });

  test("among created PRs, the latest created wins", () => {
    const a = pr({ number: 3, createdHere: true, firstSeen: 5 });
    const b = pr({ number: 4, createdHere: true, firstSeen: 50 });
    expect(primaryPr([b, a])).toBe(b);
  });

  test("otherwise the most recently mentioned wins; ties go to the higher number", () => {
    const a = pr({ number: 3, lastSeen: 30 });
    const b = pr({ number: 4, lastSeen: 30 });
    const c = pr({ number: 5, lastSeen: null });
    expect(primaryPr([a, c, b])).toBe(b);
  });
});

test.each([
  [pr(), "open"],
  [pr({ isDraft: true }), "draft"],
  [pr({ state: "MERGED" }), "merged"],
  [pr({ state: "CLOSED" }), "closed"],
  [pr({ state: null }), undefined],
])("prStateLabel %#", (link, label) => {
  expect(prStateLabel(link)).toBe(label);
});

test("orderedPrs puts the primary first, then the rest by number descending", () => {
  const created = pr({ number: 2, createdHere: true });
  const links = [pr({ number: 5 }), created, pr({ number: 9 })];
  expect(orderedPrs(links).map((l) => l.number)).toEqual([2, 9, 5]);
});

test("prLinkSummary omits missing parts", () => {
  expect(prLinkSummary(pr())).toBe("o/r#12 · open · Fix the parser");
  expect(prLinkSummary(pr({ state: null, title: null }))).toBe("o/r#12");
});

describe("popoverPlacement", () => {
  const anchor = { top: 400, bottom: 424 };

  test("below when it fits exactly", () => {
    expect(popoverPlacement(anchor, 176, 600, 0)).toBe("below");
    expect(popoverPlacement(anchor, 170, 600, 6)).toBe("below");
  });

  test("above when one pixel short below and there is more room above", () => {
    expect(popoverPlacement(anchor, 177, 600, 0)).toBe("above");
  });

  test("below when too tall for either side but below has more room", () => {
    expect(popoverPlacement({ top: 100, bottom: 124 }, 900, 600, 6)).toBe(
      "below",
    );
  });

  test("below when too tall for either side and room is equal", () => {
    expect(popoverPlacement({ top: 288, bottom: 312 }, 900, 600, 0)).toBe(
      "below",
    );
  });

  test("above when too tall below but above has more room", () => {
    expect(popoverPlacement({ top: 500, bottom: 524 }, 900, 600, 6)).toBe(
      "above",
    );
  });
});

describe("prPopoverKey", () => {
  test("ArrowDown and ArrowUp move and clamp at the ends", () => {
    expect(prPopoverKey("ArrowDown", 0, 3)).toEqual({ type: "move", index: 1 });
    expect(prPopoverKey("ArrowDown", 2, 3)).toEqual({ type: "move", index: 2 });
    expect(prPopoverKey("ArrowUp", 2, 3)).toEqual({ type: "move", index: 1 });
    expect(prPopoverKey("ArrowUp", 0, 3)).toEqual({ type: "move", index: 0 });
  });

  test("Home and End jump to the ends", () => {
    expect(prPopoverKey("Home", 2, 3)).toEqual({ type: "move", index: 0 });
    expect(prPopoverKey("End", 0, 3)).toEqual({ type: "move", index: 2 });
  });

  test("a single item stays put", () => {
    expect(prPopoverKey("ArrowDown", 0, 1)).toEqual({ type: "move", index: 0 });
    expect(prPopoverKey("End", 0, 1)).toEqual({ type: "move", index: 0 });
  });

  test("Enter opens the current item and Escape closes", () => {
    expect(prPopoverKey("Enter", 1, 3)).toEqual({ type: "open", index: 1 });
    expect(prPopoverKey("Escape", 1, 3)).toEqual({ type: "close" });
  });

  test("any other key is null", () => {
    expect(prPopoverKey("a", 0, 3)).toBeNull();
    expect(prPopoverKey("Tab", 0, 3)).toBeNull();
  });
});

describe("prButtonLabel", () => {
  test("none for no links", () => {
    expect(prButtonLabel([])).toBeUndefined();
  });

  test("one link: its number and state, no more, not multiple", () => {
    expect(prButtonLabel([pr({ number: 7, isDraft: true })])).toEqual({
      number: 7,
      state: "draft",
      more: 0,
      multiple: false,
    });
  });

  test("many links: the primary's number, the others counted", () => {
    const links = [
      pr({ number: 5 }),
      pr({ number: 2, createdHere: true, state: "MERGED" }),
      pr({ number: 9 }),
    ];
    expect(prButtonLabel(links)).toEqual({
      number: 2,
      state: "merged",
      more: 2,
      multiple: true,
    });
  });

  test("an unfetched primary has no state", () => {
    expect(prButtonLabel([pr({ state: null })])?.state).toBeUndefined();
  });
});
