import type { BuildOptions } from "esbuild";

/**
 * esbuild options for the self-contained search worker bundle.
 * @param repoRoot absolute path to the repository root.
 */
export function workerBuildOptions(repoRoot: string): BuildOptions;
