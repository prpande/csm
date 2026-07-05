import type { BuildOptions } from "esbuild";

// Types the JS build helper for TypeScript consumers (the test/main preload-bundle
// guard imports preloadBuildOptions). Node/esbuild/vitest ignore this at runtime;
// it exists only so `tsc` can resolve the .mjs import with real types.

/**
 * esbuild options for the self-contained sandboxed-preload bundle (issue #81).
 * @param repoRoot absolute path to the repository root.
 */
export function preloadBuildOptions(repoRoot: string): BuildOptions;
