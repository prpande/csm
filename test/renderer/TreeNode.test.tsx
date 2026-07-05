import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TreeNode } from "../../src/renderer/components/TreeNode";
import type { FolderNode } from "../../src/sessionTree";

// The expand/collapse affordance is an SVG chevron (issue #96 — the old unicode
// triangle read too small). Assertions use plain vitest matchers (no jest-dom)
// so they run locally too. Class-name rotation is a visual detail left to CSS;
// tests key on the accessible control and its behavior, not hashed class names.

const leaf = (name: string, path: string): FolderNode => ({
  name,
  path,
  sessions: [],
  children: [],
  ownCount: 1,
  totalCount: 1,
});

const branch = (): FolderNode => ({
  name: "src",
  path: "D:\\src",
  sessions: [],
  children: [leaf("csm", "D:\\src\\csm")],
  ownCount: 0,
  totalCount: 1,
});

const noop = () => {};

// TreeNode renders an <li>; wrap it so the DOM nesting is valid.
const renderNode = (props: Partial<Parameters<typeof TreeNode>[0]> = {}) =>
  render(
    <ul>
      <TreeNode
        node={branch()}
        depth={0}
        expandedPaths={new Set()}
        selectedPath={null}
        onToggle={noop}
        onSelect={noop}
        {...props}
      />
    </ul>,
  );

test("renders the expand control as a button carrying an svg chevron, not a text glyph", () => {
  renderNode();
  const btn = screen.getByRole("button", { name: /expand folder/i });
  expect(btn.querySelector("svg")).toBeTruthy();
  // No leftover unicode triangle glyphs.
  expect(btn.textContent ?? "").not.toContain("▸");
  expect(btn.textContent ?? "").not.toContain("▾");
});

test("an expanded node exposes a collapse control (chevron rotates via CSS)", () => {
  renderNode({ expandedPaths: new Set(["D:\\src"]) });
  const btn = screen.getByRole("button", { name: /collapse folder/i });
  expect(btn.querySelector("svg")).toBeTruthy();
});

test("clicking the chevron toggles without selecting (stopPropagation)", () => {
  const onToggle = vi.fn();
  const onSelect = vi.fn();
  // A selectable folder that also has children: a bare row click would select,
  // so this proves the chevron's stopPropagation keeps it a pure toggle.
  const selectableBranch: FolderNode = {
    ...leaf("csm", "D:\\src\\csm"),
    children: [leaf("x", "D:\\src\\csm\\x")],
  };
  render(
    <ul>
      <TreeNode
        node={selectableBranch}
        depth={0}
        expandedPaths={new Set()}
        selectedPath={null}
        onToggle={onToggle}
        onSelect={onSelect}
      />
    </ul>,
  );
  fireEvent.click(screen.getByRole("button", { name: /expand folder/i }));
  expect(onToggle).toHaveBeenCalledWith("D:\\src\\csm");
  expect(onSelect).not.toHaveBeenCalled();
});
