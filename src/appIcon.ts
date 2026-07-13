import * as path from "node:path";
import type { AppDetailsOptions } from "electron";

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

// The Windows AppUserModelID. Windows groups taskbar buttons by this ID, and it
// is also the `appId` written onto the window's property store by
// windowsTaskbarAppDetails(). Single source of truth so app.setAppUserModelId()
// and the setAppDetails() payload can't drift apart.
export const WINDOWS_APP_USER_MODEL_ID = "com.prpande.csm";

// Builds the Windows-only `BrowserWindow.setAppDetails()` payload that pins a
// taskbar button's icon (and name) to a source Explorer can resolve WITHOUT the
// app process — or null when no payload should be applied.
//
// A taskbar button's icon normally comes from the window (WM_GETICON, set via
// BrowserWindow.icon). But when Explorer rebuilds the button while the owning
// process can't answer — e.g. it was suspended by Modern Standby across a
// sleep/wake — Explorer falls back to app-identity resolution and caches that
// fallback for the life of the button. For an unpackaged dev run the identity
// chain ends at electron.exe, so the button reverts to the Electron atom icon +
// "Electron" name until relaunch. setAppDetails writes System.AppUserModel.ID +
// RelaunchIconResource (+ RelaunchCommand/DisplayName) onto the window's property
// store, a durable process-independent source that survives the rebuild.
//
// Gated to win32 && !isPackaged: non-win32 has no such button-identity model,
// and a packaged build is hosted by the app exe (whose embedded icon already
// survives the rebuild) — skipping the call there also avoids handing Explorer an
// appIconPath inside the package, which it (a separate process) cannot read.
//
// appId MUST be present or Electron ignores the other fields; relaunchCommand and
// relaunchDisplayName are set together. AppDetailsOptions is a type-only import,
// so this stays runtime-Electron-free and unit-testable, matching the resolvers
// above.
export function windowsTaskbarAppDetails(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  execPath: string,
  appDir: string,
  iconPath: string | undefined,
): AppDetailsOptions | null {
  if (platform !== "win32" || isPackaged) return null;
  return {
    appId: WINDOWS_APP_USER_MODEL_ID,
    ...(iconPath ? { appIconPath: iconPath, appIconIndex: 0 } : {}),
    relaunchCommand: `"${execPath}" "${appDir}"`,
    relaunchDisplayName: "CSM",
  };
}
