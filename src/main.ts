import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isOpenableUrl, navigationDecision, windowOpenDecision } from "./urls";
import { registerIpcHandlers } from "./ipc";
import { CH } from "./ipcChannels";
import { createSessionStore } from "./sessionStore";
import { createSettingsStore } from "./settingsStore";
import { reopenSession } from "./reopenSession";
import { defaultProjectsRoot } from "./pathAdapter";

let mainWindow: BrowserWindow | null = null;

// Built renderer: dist/renderer/index.html, resolved relative to the compiled
// main.js in dist/. Loaded via loadFile() in the packaged app.
const RENDERER_INDEX = path.join(__dirname, "renderer", "index.html");

// Dev mode loads the Vite dev server (HMR) instead of the built files. Gated by a
// RUNTIME check (env var + not-packaged), never a VITE_ build-time gate — those
// are fragile on Windows CI. Set CSM_DEV_SERVER_URL=http://localhost:5173 when
// running `npm run dev` alongside Electron.
function resolveDevServerUrl(): string | undefined {
  if (app.isPackaged) return undefined;
  const raw = process.env.CSM_DEV_SERVER_URL;
  if (!raw) return undefined;
  try {
    // Validate here so the later `new URL(devServerUrl)` in createWindow can't
    // throw into a swallowed promise rejection (app starts with no window).
    return new URL(raw).href;
  } catch {
    console.warn(
      `[CSM] CSM_DEV_SERVER_URL is not a valid URL: "${raw}" — falling back to loadFile`,
    );
    return undefined;
  }
}

// Content-Security-Policy is enforced here (response header) rather than via an
// index.html <meta>, so the policy can differ between the dev server (HMR needs
// inline + ws) and the strict packaged file:// load. Both keep
// `style-src 'unsafe-inline'`: React inline `style={…}` props set the element
// style attribute, which that directive governs — dropping it would break any
// component using inline styles. script-src stays strict ('self') in prod.
function installCsp(devServerUrl: string | undefined): void {
  const policy =
    devServerUrl !== undefined
      ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:5173 http://localhost:5173; object-src 'none'; base-uri 'none'; form-action 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

// Single-instance gate FIRST — a second launch focuses the existing window
// instead of opening a duplicate.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Windows groups taskbar buttons by AppUserModelID and reads the icon from it.
  // Without an explicit ID an unpackaged dev run groups under electron.exe.
  if (process.platform === "win32") {
    app.setAppUserModelId("com.prpande.csm");
  }

  // macOS reads the dock label and the "About/Hide/Quit <app>" role items from
  // app.name. An unpackaged dev run is hosted by Electron.app, so without this the
  // dock shows "Electron". A packaged .app gets the name from electron-builder at
  // build time (issue #7); setting it here makes the dev run match.
  if (process.platform === "darwin") {
    app.setName("CSM");
  }

  // shell.openExternal is security-sensitive: (1) only the main window's renderer
  // may call (fromMainWindow), (2) only https: URLs pass (isOpenableUrl rejects
  // file:/javascript:/data:/…), (3) the handler never throws to the renderer —
  // returns true on success, false on a rejected URL or a thrown open.
  const fromMainWindow = (e: Electron.IpcMainInvokeEvent): boolean =>
    mainWindow !== null && e.sender === mainWindow.webContents;

  ipcMain.handle(CH.shellOpenExternal, async (e, url: string) => {
    if (!fromMainWindow(e)) return false;
    if (typeof url !== "string" || !isOpenableUrl(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });

  // The session-scan / reopen / settings bridge (#59). Registered once at startup
  // (ipcMain.handle is process-global); the sender guard resolves mainWindow
  // lazily, so it correctly rejects until the window exists. The scan/reopen/
  // settings deps are the shipped units, injected here with real I/O.
  registerIpcHandlers({
    ipcMain,
    isTrustedSender: (sender) =>
      mainWindow !== null && sender === mainWindow.webContents,
    createSessionStore,
    settingsStore: createSettingsStore(app.getPath("userData")),
    reopen: reopenSession,
    projectsRoot: defaultProjectsRoot(),
    platform: process.platform,
    now: () => Date.now(),
  });

  void app.whenReady().then(() => {
    const devServerUrl = resolveDevServerUrl();
    // CSP is installed ONCE here (onHeadersReceived is a single-slot, session-wide
    // API) — not inside createWindow, which the macOS `activate` path re-enters.
    installCsp(devServerUrl);
    return createWindow(devServerUrl);
  });

  app.on("window-all-closed", () => app.quit());

  // macOS: re-create the window when the dock icon is clicked and none are open.
  // CSP is already installed at startup; only the window is recreated here.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow(resolveDevServerUrl());
    }
  });
}

async function createWindow(devServerUrl: string | undefined): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    // Native title bar for the scaffold; the custom full-width title bar with our
    // own window controls is deferred to a later phase.
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External-link safety net. Under sandbox:true Electron denies window.open by
  // default and would drop renderer-initiated opens silently, so route every one
  // through shell.openExternal (https-only). windowOpenDecision always returns
  // action:"deny"; `open` gates the OS-browser hand-off.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const { action, open } = windowOpenDecision(url);
    if (open) void shell.openExternal(url);
    return { action };
  });

  // will-navigate catches a PLAIN in-window anchor click (a top-frame navigation
  // that bypasses setWindowOpenHandler) — without it the window could navigate
  // away from the app to an external page. appOrigin is the loaded content's
  // origin (dev-server origin or the built file's origin); the initial load is
  // programmatic and never fires will-navigate, so this only ever sees
  // same-origin in-app hops or real escaping navigations.
  const appOrigin =
    devServerUrl !== undefined
      ? new URL(devServerUrl).origin
      : new URL(pathToFileURL(RENDERER_INDEX).href).origin;
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const { prevent, open } = navigationDecision(url, appOrigin);
    if (prevent) event.preventDefault();
    if (open) void shell.openExternal(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (devServerUrl !== undefined) {
    await mainWindow.loadURL(devServerUrl);
  } else {
    await mainWindow.loadFile(RENDERER_INDEX);
  }
  mainWindow.show();
}
