import { defineConfig } from "@playwright/test";

// e2e via Playwright's Electron driver. We only use `_electron` (the app's bundled
// Electron from node_modules) — no browser binaries — so `playwright install` is
// not required, sidestepping the Windows browser-download hang.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});
