import { test, expect } from "vitest";
import * as path from "node:path";
import {
  windowIconPath,
  macDockIconPath,
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
