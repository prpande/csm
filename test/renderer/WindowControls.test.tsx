import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  cleanup,
} from "@testing-library/react";
import { WindowControls } from "../../src/renderer/components/WindowControls";

// Plain vitest matchers only (no jest-dom) so these pass locally too.

afterEach(() => {
  cleanup();
  delete (window as { csm?: unknown }).csm;
});

function installBridge(opts?: { maximized?: boolean }) {
  let changeCb: ((m: boolean) => void) | undefined;
  const controls = {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(async () => opts?.maximized ?? false),
    onMaximizedChange: vi.fn((cb: (m: boolean) => void) => {
      changeCb = cb;
      return vi.fn();
    }),
  };
  window.csm = {
    isDesktop: true,
    platform: "win32",
    openExternal: vi.fn(async () => true),
    windowControls: controls,
    listSessions: vi.fn(() => vi.fn()),
    reopenSession: vi.fn(async () => ({ ok: true as const })),
    getClaudePath: vi.fn(async () => "claude"),
    getTempRoots: vi.fn(async () => []),
    setClaudePath: vi.fn(async () => {}),
  };
  return { controls, emitMaximized: (m: boolean) => changeCb?.(m) };
}

describe("WindowControls", () => {
  it("renders nothing when the preload bridge is absent", () => {
    const { container } = render(<WindowControls />);
    expect(container.firstChild).toBe(null);
  });

  it("renders three controls, each wired to its bridge call", async () => {
    const { controls } = installBridge();
    render(<WindowControls />);
    // Let the async isMaximized() seed settle before interacting.
    await screen.findByLabelText("Minimize");
    fireEvent.click(screen.getByLabelText("Minimize"));
    fireEvent.click(screen.getByLabelText("Maximize"));
    fireEvent.click(screen.getByLabelText("Close"));
    expect(controls.minimize).toHaveBeenCalledOnce();
    expect(controls.toggleMaximize).toHaveBeenCalledOnce();
    expect(controls.close).toHaveBeenCalledOnce();
  });

  it("swaps the maximize button to Restore when the window maximizes", async () => {
    const { emitMaximized } = installBridge({ maximized: false });
    render(<WindowControls />);
    expect(await screen.findByLabelText("Maximize")).toBeTruthy();
    act(() => emitMaximized(true));
    expect(screen.getByLabelText("Restore")).toBeTruthy();
    expect(screen.queryByLabelText("Maximize")).toBe(null);
  });

  it("seeds the Restore glyph when the window starts maximized", async () => {
    installBridge({ maximized: true });
    render(<WindowControls />);
    expect(await screen.findByLabelText("Restore")).toBeTruthy();
  });

  it("unsubscribes from maximize changes on unmount", async () => {
    const { controls } = installBridge();
    const { unmount } = render(<WindowControls />);
    await screen.findByLabelText("Minimize");
    const off = controls.onMaximizedChange.mock.results[0]?.value as ReturnType<
      typeof vi.fn
    >;
    unmount();
    expect(off).toHaveBeenCalledOnce();
  });
});
