import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isOpenableUrl, navigationDecision, windowOpenDecision } from "./urls";

let mainWindow: BrowserWindow | null = null;

// Scaffold renderer: a static placeholder page until the real renderer lands
// (issue #5 replaces this with the Vite-built UI). Resolved relative to the
// compiled main.js in dist/, so it points at public/index.html in the repo.
const INDEX_HTML = path.join(__dirname, "..", "public", "index.html");

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

  ipcMain.handle("shell:open-external", async (e, url: string) => {
    if (!fromMainWindow(e)) return false;
    if (typeof url !== "string" || !isOpenableUrl(url)) return false;
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      return false;
    }
  });

  void app.whenReady().then(createWindow);

  app.on("window-all-closed", () => app.quit());

  // macOS: re-create the window when the dock icon is clicked and none are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    // Native title bar for the scaffold; the custom full-width title bar with our
    // own window controls arrives with the renderer (issue #5).
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
  // away from the app to an external page. appOrigin is the loaded file's origin;
  // the initial loadFile is programmatic and never fires will-navigate, so this
  // only ever sees same-origin in-app hops or real escaping navigations.
  const appOrigin = new URL(pathToFileURL(INDEX_HTML).href).origin;
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const { prevent, open } = navigationDecision(url, appOrigin);
    if (prevent) event.preventDefault();
    if (open) void shell.openExternal(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadFile(INDEX_HTML);
  mainWindow.show();
}
