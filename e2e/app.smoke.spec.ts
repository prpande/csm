import { test, expect, _electron as electron } from "@playwright/test";
import path from "node:path";

// Smoke: launch the packaged-style app (built dist/main.js loading
// dist/renderer/index.html via loadFile) and assert it came up HEALTHY.
// Requires `npm run build` first so dist/ exists.
//
// Asserting the heading is not enough, and #81 proved it: the sandboxed preload
// failed to load, `window.csm` was undefined, every session silently vanished —
// and this test still passed, because the heading renders with or without a
// bridge. So the checks below cover the two things that actually broke (#83):
// the preload bridge exists, and the scan settles somewhere healthy.
test("app launches with a live IPC bridge and a healthy scan", async () => {
  const app = await electron.launch({
    args: [path.join(__dirname, "..", "dist", "main.js")],
  });

  const window = await app.firstWindow();
  await expect(
    window.getByRole("heading", { name: /claude session manager/i }),
  ).toBeVisible();

  // The bridge itself. Probe the calls the renderer actually makes, not just
  // that the global is truthy — a partially-wired preload is still broken.
  // Read through `globalThis` (not `window.csm`): the e2e tsconfig compiles with
  // types:["node"] and no DOM lib, so the `Window.csm` augmentation isn't in
  // scope here even though this callback runs in the renderer.
  const bridge = await window.evaluate(() => {
    const csm = (globalThis as { csm?: Record<string, unknown> }).csm;
    return {
      present: typeof csm === "object" && csm !== null,
      listSessions: typeof csm?.listSessions,
      reopenSession: typeof csm?.reopenSession,
      getFacts: typeof csm?.getFacts,
    };
  });
  expect(bridge).toEqual({
    present: true,
    listSessions: "function",
    reopenSession: "function",
    getFacts: "function",
  });

  // Wait for the scan to reach ANY terminal state. Both healthy outcomes are
  // legal: this reads the developer's real ~/.claude/projects, and the _electron
  // e2e is local/manual (not a CI job), so it cannot assume a seeded corpus.
  const scanFailed = window.getByText(/couldn’t load sessions/i);
  const bridgeGone = window.getByText(/session bridge unavailable/i);
  const settled = window
    .getByRole("treeitem")
    .or(window.getByText(/no claude sessions found/i))
    .or(scanFailed)
    .or(bridgeGone)
    .first();
  await expect(settled).toBeVisible();

  // ...and require that terminal state to be a healthy one. This is the part
  // with teeth: on a machine with no sessions the empty state renders whether or
  // not the scan works, so only asserting the ABSENCE of both failure notices
  // distinguishes "nothing to show" from "nothing works".
  await expect(scanFailed).toHaveCount(0);
  await expect(bridgeGone).toHaveCount(0);

  await app.close();
});
