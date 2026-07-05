// Bundle the sandboxed preload into a SINGLE self-contained CommonJS file.
//
// Why this step exists (issue #81): main.ts creates the window with
// `sandbox: true`. A sandboxed preload runs with a polyfilled require() that
// resolves ONLY `electron` plus a few built-ins — it CANNOT load sibling files
// from disk. The plain `tsc` build emitted `require("./ipcChannels")`, which the
// sandbox rejects ("module not found: ./ipcChannels"): the preload threw before
// contextBridge.exposeInMainWorld ran, window.csm was never defined, and the
// renderer showed "Couldn't load sessions". Bundling inlines ipcChannels (and any
// future local import) so the shipped preload has no local require left; only
// `electron` stays external, which the sandbox provides at runtime.
//
// Runs AFTER `tsc` (build:main) in the npm `build` script, overwriting the
// tsc-emitted dist/preload.js + .map with the bundled version. The self-
// containment invariant is guarded by test/main/preloadBundle.test.ts, which
// imports preloadBuildOptions below so the test and the real build never drift.

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
// Imported explicitly (not used as an ambient global) so this .mjs lints cleanly
// under eslint's base JS config, which sets no Node globals for scripts/.
import process from "node:process";

/**
 * esbuild options for the preload bundle. A pure function of the repo root so the
 * regression test can bundle in-memory (write:false) against the same config.
 *
 * @param {string} repoRoot absolute path to the repository root.
 */
export function preloadBuildOptions(repoRoot) {
  return {
    entryPoints: [join(repoRoot, "src", "preload.ts")],
    outfile: join(repoRoot, "dist", "preload.js"),
    bundle: true,
    // CommonJS: Electron loads a sandboxed preload as CJS (require/module.exports).
    format: "cjs",
    // node platform gives the CJS require() semantics preload needs and keeps
    // esbuild from trying to browser-shim anything.
    platform: "node",
    // Electron 43 ships a Node 20-era runtime; keep syntax within its support.
    target: "node20",
    sourcemap: true,
    // The ONLY module left external: the sandbox resolves `electron` for us. Every
    // other import (ipcChannels, and any future local/npm import) is inlined so no
    // unresolvable require survives.
    external: ["electron"],
  };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Run the build only when invoked directly (node scripts/build-preload.mjs), not
// when imported by the test.
if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await build(preloadBuildOptions(repoRoot));
}
