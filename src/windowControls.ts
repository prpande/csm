// Main-process handlers for the custom traffic-light window controls (#86). The
// frameless shell drops the OS caption buttons, so the renderer's own buttons
// drive minimize / maximize-restore / close over IPC. Kept a separate DI'd module
// (not inlined in main.ts) so the toggle + sender-guard logic is unit-testable
// with a fake ipcMain + fake window — matching the ipc.ts convention. The window
// is reached through getWindow() (not captured) because the reference is null
// until createWindow runs and is recreated on macOS dock-activate.
import { CH } from "./ipcChannels";

/** The slice of BrowserWindow these controls touch. */
export interface ControllableWindow {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
  isMaximized(): boolean;
}

interface IpcEventLike {
  sender: unknown;
}
type OnListener = (event: IpcEventLike, ...args: unknown[]) => void;
type HandleListener = (event: IpcEventLike, ...args: unknown[]) => unknown;

export interface WindowControlsDeps {
  ipcMain: {
    on(channel: string, listener: OnListener): void;
    handle(channel: string, listener: HandleListener): void;
  };
  /** True only for the main window's webContents (defense in depth, mirroring the
   *  ipc.ts / shell:open-external guards). Receives event.sender. */
  isTrustedSender: (sender: unknown) => boolean;
  /** The live main window, or null between teardown and recreate. */
  getWindow: () => ControllableWindow | null;
}

export function registerWindowControls(deps: WindowControlsDeps): void {
  const { ipcMain, isTrustedSender, getWindow } = deps;
  const trusted = (e: IpcEventLike): boolean => isTrustedSender(e.sender);

  ipcMain.on(CH.windowMinimize, (e) => {
    if (trusted(e)) getWindow()?.minimize();
  });

  ipcMain.on(CH.windowToggleMaximize, (e) => {
    if (!trusted(e)) return;
    const win = getWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on(CH.windowClose, (e) => {
    if (trusted(e)) getWindow()?.close();
  });

  // Request/response so the renderer can seed its maximize-button glyph on mount;
  // an untrusted frame (or a torn-down window) reads as "not maximized".
  ipcMain.handle(CH.windowIsMaximized, (e) =>
    trusted(e) ? (getWindow()?.isMaximized() ?? false) : false,
  );
}
