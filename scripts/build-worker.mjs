// Bundles the search worker into the CommonJS file the packaged app ships unpacked.

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

/**
 * esbuild options for the search worker bundle.
 *
 * @param {string} repoRoot absolute path to the repository root.
 */
export function workerBuildOptions(repoRoot) {
  return {
    entryPoints: [join(repoRoot, "src", "search", "searchWorker.ts")],
    outfile: join(repoRoot, "dist", "searchWorker.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: true,
  };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await build(workerBuildOptions(repoRoot));
}
