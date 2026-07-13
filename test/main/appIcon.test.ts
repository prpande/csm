import { test, expect } from "vitest";
import * as path from "node:path";
import {
  windowIconPath,
  macDockIconPath,
  windowsTaskbarAppDetails,
  WINDOWS_APP_USER_MODEL_ID,
  type IconEnv,
} from "../../src/appIcon";

// Pure resolvers exercised with an injected `exists` predicate — no filesystem,
// no Electron. appDir stands in for dist/ (assets/ sits one level up).
const APP_DIR = path.join("C:", "app", "dist");
const RESOURCES = path.join("C:", "app", "resources");
const devIco = path.join(APP_DIR, "..", "assets", "icons", "icon.ico");
const pkgIco = path.join(RESOURCES, "assets", "icons", "icon.ico");
const devIcns = path.join(APP_DIR, "..", "assets", "icons", "icon.icns");

function env(platform: NodeJS.Platform, present: Set<string>): IconEnv {
  return {
    platform,
    appDir: APP_DIR,
    resourcesPath: RESOURCES,
    exists: (p) => present.has(p),
  };
}

test("windowIconPath prefers the dev .ico next to dist/ when it exists", () => {
  expect(windowIconPath(env("win32", new Set([devIco, pkgIco])))).toBe(devIco);
});

test("windowIconPath falls back to the packaged resourcesPath .ico", () => {
  expect(windowIconPath(env("win32", new Set([pkgIco])))).toBe(pkgIco);
});

test("windowIconPath returns undefined when no .ico is present (packaged, assets unshipped)", () => {
  expect(windowIconPath(env("win32", new Set()))).toBeUndefined();
});

test("macDockIconPath returns the dev .icns on darwin when present", () => {
  expect(macDockIconPath(env("darwin", new Set([devIcns])))).toBe(devIcns);
});

test("macDockIconPath returns undefined on darwin when the .icns is absent", () => {
  expect(macDockIconPath(env("darwin", new Set()))).toBeUndefined();
});

test("macDockIconPath returns undefined off darwin even when the .icns exists", () => {
  expect(macDockIconPath(env("win32", new Set([devIcns])))).toBeUndefined();
});

// windowsTaskbarAppDetails — the setAppDetails() payload that keeps the taskbar
// button's icon durable across an Explorer button rebuild (Modern Standby).
const EXE = path.join(
  "C:",
  "app",
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);
const DIR = path.join("C:", "app");

test("windowsTaskbarAppDetails returns the full payload on an unpackaged Windows run", () => {
  expect(windowsTaskbarAppDetails("win32", false, EXE, DIR, devIco)).toEqual({
    appId: WINDOWS_APP_USER_MODEL_ID,
    appIconPath: devIco,
    appIconIndex: 0,
    relaunchCommand: `"${EXE}" "${DIR}"`,
    relaunchDisplayName: "CSM",
  });
});

test("windowsTaskbarAppDetails always sets appId — Electron ignores every other field without it", () => {
  expect(
    windowsTaskbarAppDetails("win32", false, EXE, DIR, devIco)?.appId,
  ).toBe(WINDOWS_APP_USER_MODEL_ID);
});

test("windowsTaskbarAppDetails returns null on a packaged Windows build (the host exe icon already survives)", () => {
  expect(windowsTaskbarAppDetails("win32", true, EXE, DIR, devIco)).toBeNull();
});

test("windowsTaskbarAppDetails returns null off Windows (macOS, Linux)", () => {
  expect(
    windowsTaskbarAppDetails("darwin", false, EXE, DIR, devIco),
  ).toBeNull();
  expect(windowsTaskbarAppDetails("linux", false, EXE, DIR, devIco)).toBeNull();
});

test("windowsTaskbarAppDetails pins the name without an icon, omitting appIconPath", () => {
  const details = windowsTaskbarAppDetails("win32", false, EXE, DIR, undefined);
  expect(details).toEqual({
    appId: WINDOWS_APP_USER_MODEL_ID,
    relaunchCommand: `"${EXE}" "${DIR}"`,
    relaunchDisplayName: "CSM",
  });
  expect(details && "appIconPath" in details).toBe(false);
});

test("windowsTaskbarAppDetails quotes exe and dir so spaced paths survive relaunch", () => {
  const spacedExe = path.join("C:", "Program Files", "CSM", "electron.exe");
  const spacedDir = path.join("C:", "Program Files", "CSM");
  expect(
    windowsTaskbarAppDetails("win32", false, spacedExe, spacedDir, devIco)
      ?.relaunchCommand,
  ).toBe(`"${spacedExe}" "${spacedDir}"`);
});
