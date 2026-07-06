import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Reset the window.csm bridge before EVERY test (not once per file) so a test
// that reassigns it can't leak that value into later tests. CSM's renderer talks
// to main only through this IPC bridge (there is no HTTP layer, so no MSW) —
// tests mock it directly, and may override window.csm within a test as needed.
// Node-environment tests (e.g. the esbuild-driven preload-bundle guard, which
// opts out of jsdom) have no `window`; the DOM bridge stub is meaningless there,
// so skip it rather than crash the shared setup.
beforeEach(() => {
  if (typeof window === "undefined") return;
  window.csm = {
    isDesktop: true,
    platform: "darwin",
    openExternal: vi.fn(async () => true),
    listSessions: vi.fn(() => vi.fn()),
    reopenSession: vi.fn(async () => ({ ok: true as const })),
    getClaudePath: vi.fn(async () => "claude"),
    getTempRoots: vi.fn(async () => []),
    setClaudePath: vi.fn(async () => {}),
  };
});

// Unmount React trees between tests so the jsdom DOM doesn't leak across cases.
afterEach(() => {
  cleanup();
});
