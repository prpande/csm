import { test, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// electron-builder switches on implicit publishing whenever it detects CI, which
// demands GH_TOKEN and fails the run after every artifact is already packaged.
// `npm run dist` runs in no CI job, so this is the only guard on the flag.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function distScript(): string {
  const pkg: unknown = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  );
  const scripts = (pkg as { scripts?: Record<string, string> }).scripts;
  return scripts?.dist ?? "";
}

const PUBLISH_NEVER = /(?:--publish[=\s]+|-p\s+)never(?=\s|$)/;

describe("packaging publish policy", () => {
  test("dist script still invokes electron-builder, so the publish assertion is not vacuous", () => {
    expect(distScript()).toMatch(/\belectron-builder\b/);
  });

  test("dist script disables electron-builder's implicit CI publishing", () => {
    expect(distScript()).toMatch(PUBLISH_NEVER);
  });
});
