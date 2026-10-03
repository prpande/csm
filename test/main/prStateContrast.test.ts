import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const globalCss = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "renderer",
  "styles",
  "global.css",
);

const STATES = ["open", "draft", "merged", "closed"] as const;

function themeBlocks(): { light: string; dark: string } {
  const css = readFileSync(globalCss, "utf8");
  const darkIndex = css.indexOf("prefers-color-scheme: dark");
  expect(darkIndex).toBeGreaterThan(-1);
  return { light: css.slice(0, darkIndex), dark: css.slice(darkIndex) };
}

function token(block: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block);
  expect(match, `${name} missing`).not.toBeNull();
  return match![1];
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("PR state token contrast", () => {
  test("the ratio helper rejects a deliberately failing pair", () => {
    expect(contrast("#777777", "#808080")).toBeLessThan(3);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  for (const theme of ["light", "dark"] as const) {
    describe(theme, () => {
      for (const state of STATES) {
        test(`${state}: text on fill is at least 4.5:1`, () => {
          const block = themeBlocks()[theme];
          expect(
            contrast(
              token(block, `--pr-${state}-text`),
              token(block, `--pr-${state}-bg`),
            ),
          ).toBeGreaterThanOrEqual(4.5);
        });

        test(`${state}: text colour is at least 3:1 against every row surface`, () => {
          const block = themeBlocks()[theme];
          const text = token(block, `--pr-${state}-text`);
          for (const surface of ["--bg", "--hover-bg", "--selection-bg"]) {
            expect(
              contrast(text, token(block, surface)),
              surface,
            ).toBeGreaterThanOrEqual(3);
          }
        });
      }

      test("unfetched: text and border are readable on plain, hovered and selected rows", () => {
        const block = themeBlocks()[theme];
        for (const surface of ["--bg", "--hover-bg"]) {
          const bg = token(block, surface);
          expect(
            contrast(token(block, "--text"), bg),
            surface,
          ).toBeGreaterThanOrEqual(4.5);
          expect(
            contrast(token(block, "--text-muted"), bg),
            surface,
          ).toBeGreaterThanOrEqual(3);
        }
        expect(
          contrast(
            token(block, "--selection-text"),
            token(block, "--selection-bg"),
          ),
        ).toBeGreaterThanOrEqual(4.5);
      });
    });
  }
});
