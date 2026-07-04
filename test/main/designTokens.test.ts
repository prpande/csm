import { test, expect, describe } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Design-token centralization guard (issue #78). CSM routes every color through
// the semantic tokens in `styles/global.css`; component CSS modules must carry
// zero hardcoded color literals so a palette swap is a one-file value edit. This
// is a node-context test (reads files via fs) so it lives in test/main/.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rendererDir = join(repoRoot, "src", "renderer");
const globalCss = join(rendererDir, "styles", "global.css");
const componentsDir = join(rendererDir, "components");

const HEX = /#[0-9a-fA-F]{3,8}\b/;

function componentCssFiles(): string[] {
  return readdirSync(componentsDir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => join(componentsDir, f));
}

describe("design tokens", () => {
  test("global.css defines --on-accent in both light and dark themes", () => {
    const css = readFileSync(globalCss, "utf8");
    // Split at the dark-theme media query so each half is asserted independently.
    const darkIndex = css.indexOf("prefers-color-scheme: dark");
    expect(darkIndex).toBeGreaterThan(-1);
    const light = css.slice(0, darkIndex);
    const dark = css.slice(darkIndex);
    expect(light).toMatch(/--on-accent:\s*#[0-9a-fA-F]{3,8}/);
    expect(dark).toMatch(/--on-accent:\s*#[0-9a-fA-F]{3,8}/);
  });

  test("no component CSS module hardcodes a color literal", () => {
    const offenders: string[] = [];
    for (const file of componentCssFiles()) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
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
