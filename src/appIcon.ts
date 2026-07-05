import * as path from "node:path";

// Runtime app-icon resolution for the UNPACKAGED (dev) run, where the taskbar
// (Windows) / dock (macOS) otherwise show Electron's default icon. Packaged builds
// embed the icon in the exe/.icns via electron-builder (win.icon / mac.icon), and
// assets/ is not shipped inside the package (electron-builder.yml `files` ships
// only dist/** + package.json) — so these resolvers return undefined there and the
// baked bundle icon stands, which is exactly what we want.
//
// Pure + DI'd (an injected `exists` predicate) so the platform/candidate logic is
// unit-testable without a filesystem or Electron, matching the menu.ts /
// windowControls.ts convention.

export interface IconEnv {
  platform: NodeJS.Platform;
  // __dirname of the compiled main.js (dist/); assets/ sits one level up in dev.
  appDir: string;
  // Electron's process.resourcesPath — the packaged fallback location.
  resourcesPath: string;
  exists: (p: string) => boolean;
}

// The Windows window/taskbar icon (.ico, multi-resolution). macOS ignores
// BrowserWindow.icon entirely (its dock icon comes from macDockIconPath below), so
// in practice this drives the Windows (and Linux) window icon. Returns the first
// existing candidate — the dev path next to dist/, then the packaged resourcesPath
// location — or undefined to fall back to Electron's default without erroring.
export function windowIconPath(env: IconEnv): string | undefined {
  const candidates = [
    path.join(env.appDir, "..", "assets", "icons", "icon.ico"),
    path.join(env.resourcesPath, "assets", "icons", "icon.ico"),
  ];
  return candidates.find(env.exists);
}

// The macOS dock/app icon (.icns) for a dev run, applied post-ready via
// app.dock.setIcon. undefined off macOS, or when the .icns isn't present (a
// packaged .app shows the bundle icon electron-builder bakes from mac.icon, and
// the .icns is not shipped in Resources).
export function macDockIconPath(env: IconEnv): string | undefined {
  if (env.platform !== "darwin") return undefined;
  const candidate = path.join(env.appDir, "..", "assets", "icons", "icon.icns");
  return env.exists(candidate) ? candidate : undefined;
}
