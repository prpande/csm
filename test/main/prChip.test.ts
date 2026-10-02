import { describe, expect, test } from "vitest";
import type { SessionPrLink } from "../../src/ipcTypes";
import {
  orderedPrs,
  primaryPr,
  prLinkSummary,
  prStateLabel,
  prTooltip,
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

test("prTooltip lists every link, primary first", () => {
  expect(
    prTooltip([
      pr({ number: 7, state: "MERGED", title: "Old" }),
      pr({ createdHere: true }),
    ]),
  ).toBe("o/r#12 · open · Fix the parser\no/r#7 · merged · Old");
});
