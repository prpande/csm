import { test, expect } from "vitest";
import { applicationMenuTemplate } from "../../src/menu";

// menu.ts is a pure policy fn (electron is a type-only import), so it runs here
// with no Electron runtime.

test("no application menu off macOS → the menu bar is suppressed", () => {
  expect(applicationMenuTemplate("win32")).toBeNull();
  expect(applicationMenuTemplate("linux")).toBeNull();
});

test("macOS keeps a role-based menu so ⌘C/⌘V/⌘X/⌘A/⌘Q keep working in inputs", () => {
  const template = applicationMenuTemplate("darwin");
  expect(template).not.toBeNull();
  const roles = (template ?? []).map((item) => item.role);
  // editMenu is the load-bearing one (cut/copy/paste/selectAll accelerators);
  // appMenu carries Quit, windowMenu the standard window items.
  expect(roles).toContain("appMenu");
  expect(roles).toContain("editMenu");
  expect(roles).toContain("windowMenu");
});
