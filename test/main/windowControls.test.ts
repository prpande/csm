import { test, expect, vi } from "vitest";
import { registerWindowControls } from "../../src/windowControls";
import { CH } from "../../src/ipcChannels";

// Exercised with a fake ipcMain (records on/handle listeners by channel) + a fake
// window + fake events ({ sender }) — no Electron runtime.

interface IpcEventLike {
  sender: unknown;
}
type Listener = (event: IpcEventLike, ...args: unknown[]) => unknown;

function fakeIpc() {
  const on = new Map<string, Listener>();
  const handle = new Map<string, Listener>();
  return {
    ipcMain: {
      on: (ch: string, fn: Listener) => void on.set(ch, fn),
      handle: (ch: string, fn: Listener) => void handle.set(ch, fn),
    },
    on,
    handle,
  };
}

function fakeWindow(maximized = false) {
  return {
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: () => maximized,
  };
}

const trustedSender = { trusted: true };
const ev = (sender: unknown): IpcEventLike => ({ sender });

function setup(win: ReturnType<typeof fakeWindow> | null) {
  const { ipcMain, on, handle } = fakeIpc();
  registerWindowControls({
    ipcMain,
    isTrustedSender: (s) => s === trustedSender,
    getWindow: () => win,
  });
  return { on, handle };
}

test("minimize and close call through for the trusted sender", () => {
  const win = fakeWindow();
  const { on } = setup(win);
  on.get(CH.windowMinimize)!(ev(trustedSender));
  on.get(CH.windowClose)!(ev(trustedSender));
  expect(win.minimize).toHaveBeenCalledOnce();
  expect(win.close).toHaveBeenCalledOnce();
});

test("toggle-maximize maximizes when the window is not maximized", () => {
  const win = fakeWindow(false);
  const { on } = setup(win);
  on.get(CH.windowToggleMaximize)!(ev(trustedSender));
  expect(win.maximize).toHaveBeenCalledOnce();
  expect(win.unmaximize).not.toHaveBeenCalled();
});

test("toggle-maximize unmaximizes when the window is already maximized", () => {
  const win = fakeWindow(true);
  const { on } = setup(win);
  on.get(CH.windowToggleMaximize)!(ev(trustedSender));
  expect(win.unmaximize).toHaveBeenCalledOnce();
  expect(win.maximize).not.toHaveBeenCalled();
});

test("is-maximized reflects the window for the trusted sender", () => {
  const { handle } = setup(fakeWindow(true));
  expect(handle.get(CH.windowIsMaximized)!(ev(trustedSender))).toBe(true);
});

test("an untrusted sender is a no-op and is-maximized returns false", () => {
  const win = fakeWindow(true);
  const { on, handle } = setup(win);
  const bad = ev({ imposter: true });
  on.get(CH.windowMinimize)!(bad);
  on.get(CH.windowToggleMaximize)!(bad);
  on.get(CH.windowClose)!(bad);
  expect(win.minimize).not.toHaveBeenCalled();
  expect(win.maximize).not.toHaveBeenCalled();
  expect(win.unmaximize).not.toHaveBeenCalled();
  expect(win.close).not.toHaveBeenCalled();
  expect(handle.get(CH.windowIsMaximized)!(bad)).toBe(false);
});

test("handlers are safe no-ops when the window is gone", () => {
  const { on, handle } = setup(null);
  expect(() => on.get(CH.windowMinimize)!(ev(trustedSender))).not.toThrow();
  expect(() =>
    on.get(CH.windowToggleMaximize)!(ev(trustedSender)),
  ).not.toThrow();
  expect(() => on.get(CH.windowClose)!(ev(trustedSender))).not.toThrow();
  expect(handle.get(CH.windowIsMaximized)!(ev(trustedSender))).toBe(false);
});
