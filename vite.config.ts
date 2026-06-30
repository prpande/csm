// defineConfig from "vitest/config" (a superset of Vite's) so the `test` field
// is typed; `vite build` still consumes this config unchanged.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Renderer build. Output goes to dist/renderer (a SUBDIR of dist/) so Vite's
// emptyOutDir only clears the renderer bundle and never wipes the tsc-built
// dist/main.js + dist/preload.js. `base: "./"` makes the built index.html use
// relative asset URLs, which is required for Electron to load it via loadFile().
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
