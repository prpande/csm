import { describe, it, expect } from "vitest";
import {
  pathLabelBudget,
  truncatePathLabel,
} from "../../src/renderer/pathLabel";

// truncatePathLabel is a pure string transform (no DOM), so plain vitest matchers
// exercise it directly. It middle-truncates a #77 compacted folder label to keep
// the drive/root head and the leaf visible in the fixed-width sidebar.

describe("truncatePathLabel", () => {
  it("returns short labels unchanged", () => {
    expect(truncatePathLabel("D:\\src")).toBe("D:\\src");
    expect(truncatePathLabel("D:\\src\\csm")).toBe("D:\\src\\csm");
    expect(truncatePathLabel("csm")).toBe("csm");
    expect(truncatePathLabel("(unknown)")).toBe("(unknown)");
  });

  it("middle-truncates a long Windows chain, keeping head and leaf", () => {
    const label =
      "C:\\Users\\praty\\AppData\\Local\\Temp\\worktrees\\42-hotfix";
    const out = truncatePathLabel(label);
    expect(out.startsWith("C:\\Users")).toBe(true); // drive/root head kept
    expect(out.endsWith("\\42-hotfix")).toBe(true); // leaf kept
    expect(out).toContain("…"); // middle elided
    expect(out.length).toBeLessThan(label.length);
  });

  it("middle-truncates a long POSIX chain with '/'-joined segments", () => {
    const label = "/Users/praty/Library/Application Support/very/deep/proj";
    const out = truncatePathLabel(label);
    expect(out.startsWith("/Users")).toBe(true);
    expect(out.endsWith("/proj")).toBe(true);
    expect(out).toContain("…");
  });

  it("respects a custom budget", () => {
    const label = "D:\\a\\bbbb\\cccc\\dddd\\eeee\\leaf";
    expect(truncatePathLabel(label, 100)).toBe(label); // fits -> unchanged
    const tight = truncatePathLabel(label, 16);
    expect(tight.startsWith("D:\\a")).toBe(true);
    expect(tight.endsWith("\\leaf")).toBe(true);
    expect(tight).toContain("…");
  });

  it("preserves the leaf even when it alone exceeds the budget (CSS ellipsis backstops)", () => {
    // A leaf longer than the whole budget can't fit; truncation keeps the root
    // head + full leaf and lets the row's CSS end-ellipsis clip the overflow,
    // rather than dropping the one segment the user navigates to. The returned
    // string is intentionally allowed to exceed `max` here.
    const label = "D:\\a\\b\\this-leaf-name-is-longer-than-the-whole-budget";
    const out = truncatePathLabel(label, 20);
    expect(out.startsWith("D:")).toBe(true);
    expect(
      out.endsWith("\\this-leaf-name-is-longer-than-the-whole-budget"),
    ).toBe(true);
    expect(out).toContain("…");
  });

  it("does not fabricate an ellipsis when only root and leaf exist", () => {
    // A long two-segment label has no middle segment to drop; leave it for the
    // CSS end-ellipsis rather than emit a misleading "root…leaf".
    const label = "D:\\a-single-very-long-leaf-folder-name-with-no-middle";
    expect(truncatePathLabel(label)).toBe(label);
  });
});

// The budget scales with the resizable sidebar (#164): anchored at the tuned
// (260px → 36 chars) point, ~1 char per 7px, quantized to steps of 4.
describe("pathLabelBudget", () => {
  it("returns the tuned default at the default sidebar width", () => {
    expect(pathLabelBudget(260)).toBe(36);
  });

  it("shrinks at the minimum width and grows when widened", () => {
    expect(pathLabelBudget(160)).toBe(20);
    expect(pathLabelBudget(600)).toBe(84);
  });

  it("is quantized so tiny drags reuse the same budget", () => {
    // A few px either side of the default stays on the 36 plateau.
    expect(pathLabelBudget(255)).toBe(36);
    expect(pathLabelBudget(265)).toBe(36);
  });

  it("never drops below the floor", () => {
    expect(pathLabelBudget(0)).toBe(16);
  });
});
