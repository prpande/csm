import { test, expect, describe } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Packaging-icon wiring guard (issue #36). electron-builder falls back to the
// default Electron icon unless the config points at real icon files. This guard
// asserts every `icon:` path in electron-builder.yml resolves to a non-empty file
// on disk, so moving or renaming the assets (e.g. assets/icons/*) is caught before
// packaged builds silently fall back to the default icon. It does NOT validate
// icon format or resolution — a present-but-corrupt .ico would pass this check but
// still trip electron-builder's fallback (out of scope; the packaged build in
// publish-desktop.yml is the backstop for that). Node-context test → test/main/.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const builderYml = join(repoRoot, "electron-builder.yml");

// Capture the value of every `icon:` key, at any nesting depth. Values may be
// quoted; strip a single layer of surrounding quotes. Comments are blanked first
// so a `# icon: foo` note can't masquerade as a real reference. A YAML inline
// comment must be preceded by whitespace (or start the line), so the leading
// `(^|\s)` keeps a literal `#` inside a value from being mistaken for a comment.
const COMMENT = /(^|\s)#.*$/gm;
const ICON_LINE = /^\s*icon:\s*(.+?)\s*$/gm;

function referencedIcons(): string[] {
  const yml = readFileSync(builderYml, "utf8").replace(COMMENT, "$1");
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
