// @vitest-environment node
//
// esbuild's Node API relies on runtime invariants that jsdom (the default
// vitest environment, set in vite.config.ts) breaks by overriding globals, so
// this build-tooling test opts into the real node environment.
import { test, expect, describe } from "vitest";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { preloadBuildOptions } from "../../scripts/build-preload.mjs";

// Sandbox self-containment guard (issue #81). main.ts creates the window with
// `sandbox: true`, and a sandboxed preload runs with a polyfilled require() that
// resolves ONLY `electron` plus a few built-ins — it CANNOT load sibling files
// from disk. The plain-tsc build emitted `require("./ipcChannels")`, which the
// sandbox rejects ("module not found: ./ipcChannels"); the preload threw before
// contextBridge.exposeInMainWorld ran, so window.csm was undefined and the
// renderer showed "Couldn't load sessions". This guard bundles src/preload.ts
// with the EXACT options the build uses and asserts the output requires nothing
// outside the sandbox-safe allowlist — catching both the original relative
// import and any future local/built-in import creeping back in. Node-context
// (esbuild + fs) → test/main/ per the tsconfig.node.json seam.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The only module Electron's sandboxed preload require() can resolve. It stays
// external in the bundle (the sandbox provides it) and so appears as a require().
const SANDBOX_SAFE = new Set(["electron"]);

// Every require("<literal>") target in the bundled CommonJS output. esbuild
// leaves an external module as a bare require(); anything bundled is inlined and
// never appears here — so a leftover require() means a module the sandbox must
// resolve at runtime.
function requiredModules(code: string): string[] {
  return [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => m[1],
  );
}

describe("preload bundle (sandbox self-containment)", () => {
  test("bundled preload requires only sandbox-safe modules", async () => {
    const result = await build({
      ...preloadBuildOptions(repoRoot),
      write: false,
    });
    // sourcemap:true emits both preload.js and preload.js.map; inspect the JS.
    // write:false guarantees outputFiles, but esbuild types it as optional.
    const out = (result.outputFiles ?? []).find((f) => f.path.endsWith(".js"));
    expect(out).toBeDefined();
    const required = requiredModules(out!.text);

    const forbidden = required.filter((m) => !SANDBOX_SAFE.has(m));
    expect(forbidden).toEqual([]);

    // Non-vacuous: the preload genuinely uses electron (contextBridge/ipcRenderer),
    // so a correct bundle MUST still require it. Guards against a false green on
    // empty/garbled output.
    expect(required).toContain("electron");
  });
});
