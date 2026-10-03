// @vitest-environment node
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { workerBuildOptions } from "../../scripts/build-worker.mjs";
import { asarUnpackedPath } from "../../src/searchHost";

// Packaging is not in CI, so this is the only guard that the bundle, the unpack
// entry and main's path rewrite agree.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("packaged search worker", () => {
  test("electron-builder unpacks the worker bundle", () => {
    const yml = readFileSync(join(repoRoot, "electron-builder.yml"), "utf8");
    expect(yml).toMatch(/^asarUnpack:\s+-\s+dist\/searchWorker\.js\s*$/m);
  });

  test("the bundle is written where the unpack entry points", () => {
    expect(workerBuildOptions(repoRoot).outfile).toBe(
      join(repoRoot, "dist", "searchWorker.js"),
    );
  });

  test("a packaged path moves to app.asar.unpacked; a dev path is unchanged", () => {
    expect(
      asarUnpackedPath(
        "C:\\x\\resources\\app.asar\\dist\\searchWorker.js",
        "\\",
      ),
    ).toBe("C:\\x\\resources\\app.asar.unpacked\\dist\\searchWorker.js");
    expect(
      asarUnpackedPath("/x/Resources/app.asar/dist/searchWorker.js", "/"),
    ).toBe("/x/Resources/app.asar.unpacked/dist/searchWorker.js");
    expect(asarUnpackedPath("/repo/dist/searchWorker.js", "/")).toBe(
      "/repo/dist/searchWorker.js",
    );
  });
});
