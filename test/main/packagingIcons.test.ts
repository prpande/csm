import { test, expect, describe } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Packaging-icon wiring guard (issue #36). electron-builder falls back to the
// default Electron icon unless the config points at real icon files. This guard
// asserts every `icon:` path in electron-builder.yml resolves to a non-empty file
// on disk, so moving or renaming the assets (e.g. assets/icons/*) can't silently
// revert packaged builds to the default icon. Node-context test (reads files via
// fs) → test/main/.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const builderYml = join(repoRoot, "electron-builder.yml");

// Capture the value of every `icon:` key, at any nesting depth. Values may be
// quoted; strip a single layer of surrounding quotes. Comments (`# ...`) are
// blanked first so a `# icon: foo` note can't masquerade as a real reference.
const COMMENT = /#.*$/gm;
const ICON_LINE = /^\s*icon:\s*(.+?)\s*$/gm;

function referencedIcons(): string[] {
  const yml = readFileSync(builderYml, "utf8").replace(COMMENT, "");
  const paths: string[] = [];
  for (const m of yml.matchAll(ICON_LINE)) {
    paths.push(m[1].replace(/^["']|["']$/g, ""));
  }
  return paths;
}

describe("packaging icons", () => {
  test("electron-builder.yml references Windows and macOS icons", () => {
    const icons = referencedIcons();
    // Non-vacuous: a config with no icon: keys would pass an existence loop
    // trivially, so require both platform icons to be wired.
    expect(icons.some((p) => p.endsWith(".ico"))).toBe(true);
    expect(icons.some((p) => p.endsWith(".icns"))).toBe(true);
  });

  test("every referenced icon path resolves to a non-empty file", () => {
    const icons = referencedIcons();
    expect(icons.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const rel of icons) {
      const abs = join(repoRoot, rel);
      try {
        if (statSync(abs).size === 0) missing.push(`${rel} (empty)`);
      } catch {
        missing.push(`${rel} (not found)`);
      }
    }
    expect(missing).toEqual([]);
  });
});
