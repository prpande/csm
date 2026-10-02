// Runs sqlite-probe.mjs with the repo's Electron binary acting as Node, so CI
// checks the SQLite build the app actually ships rather than the runner's Node.
import console from "node:console";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { URL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Under plain Node the electron package exports the path to its binary.
const electronPath = require("electron");
const probe = fileURLToPath(new URL("./sqlite-probe.mjs", import.meta.url));
const r = spawnSync(electronPath, [probe], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
if (r.error) {
  console.error(r.error);
  process.exit(1);
}
process.exit(r.status ?? 1);
