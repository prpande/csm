import { test, expect, _electron as electron } from "@playwright/test";
import path from "node:path";

// Smoke: launch the packaged-style app (built dist/main.js loading
// dist/renderer/index.html via loadFile) and assert the renderer mounted.
// Requires `npm run build` first so dist/ exists.
test("app launches and renders the scaffold", async () => {
  // CI runs e2e inside the Playwright container as root, where Chromium's setuid
  // sandbox refuses to start; --no-sandbox disables only the OS-level zygote
  // sandbox for that run. Production keeps webPreferences.sandbox: true.
  const args = [path.join(__dirname, "..", "dist", "main.js")];
  if (process.env.CI) args.push("--no-sandbox");

  const app = await electron.launch({ args });

  const window = await app.firstWindow();
  await expect(
    window.getByRole("heading", { name: /claude session manager/i }),
  ).toBeVisible();

  await app.close();
});
