import { test, expect, describe } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Design-token centralization guard (issue #78). CSM routes every color through
// the semantic tokens in `styles/global.css`; every OTHER CSS file under
// src/renderer must carry zero hardcoded color literals so a palette swap stays
// a one-file value edit. Node-context test (reads files via fs) → test/main/.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rendererDir = join(repoRoot, "src", "renderer");
const globalCss = join(rendererDir, "styles", "global.css");

// The single sanctioned token home; every other CSS file must use var(--*).
const TOKEN_HOME = join("styles", "global.css");

const HEX_CLASS = "[0-9a-fA-F]{3,8}";
const HEX = new RegExp(`#${HEX_CLASS}\\b`);
const ON_ACCENT = new RegExp(`--on-accent:\\s*#${HEX_CLASS}`);
const COMMENTS = /\/\*[\s\S]*?\*\//g;

// Every *.css under src/renderer except the token home. Recursive so a new
// component subdir can't silently escape the guard (fail-closed, not fail-open).
function tokenConsumerCss(): string[] {
  return readdirSync(rendererDir, { recursive: true })
    .map(String)
    .filter((rel) => rel.endsWith(".css") && rel !== TOKEN_HOME)
    .map((rel) => join(rendererDir, rel));
}

describe("design tokens", () => {
  test("global.css defines --on-accent in both light and dark themes", () => {
    const css = readFileSync(globalCss, "utf8");
    // Split at the dark-theme media query so each half is asserted independently
    // (a single match would pass with only one theme defined).
    const darkIndex = css.indexOf("prefers-color-scheme: dark");
    expect(darkIndex).toBeGreaterThan(-1);
    expect(css.slice(0, darkIndex)).toMatch(ON_ACCENT);
    expect(css.slice(darkIndex)).toMatch(ON_ACCENT);
  });

  test("no token-consumer CSS hardcodes a color literal", () => {
    // Guard is hex-only: rgba()/hsl() shadows and backdrops are intentionally
    // out of scope (not theme color). Comments are blanked first — preserving
    // newlines so line numbers stay accurate — so an in-file note like
    // `/* was #ffffff */` documenting the migration doesn't trip a red build.
    const files = tokenConsumerCss();
    // Guard the guard: an empty walk would pass vacuously (fail-open).
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, "utf8")
        .replace(COMMENTS, (m) => m.replace(/[^\n]/g, " "))
        .split(/\r?\n/);
      lines.forEach((line, i) => {
        if (HEX.test(line)) {
          offenders.push(
            `${file.replace(repoRoot, "").replace(/\\/g, "/")}:${i + 1}  ${line.trim()}`,
          );
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
