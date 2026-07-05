import { describe, it, expect } from "vitest";
import { truncatePathLabel } from "../../src/renderer/pathLabel";

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

  it("does not fabricate an ellipsis when only root and leaf exist", () => {
    // A long two-segment label has no middle segment to drop; leave it for the
    // CSS end-ellipsis rather than emit a misleading "root…leaf".
    const label = "D:\\a-single-very-long-leaf-folder-name-with-no-middle";
    expect(truncatePathLabel(label)).toBe(label);
  });
});
