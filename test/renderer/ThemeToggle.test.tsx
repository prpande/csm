import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { ThemeToggle } from "../../src/renderer/components/ThemeToggle";
import type { ThemePreference } from "../../src/ipcTypes";

// Plain vitest matchers only (no jest-dom) so these pass locally too.

afterEach(() => {
  cleanup();
  delete (window as { csm?: unknown }).csm;
});

function installBridge(initial: ThemePreference = "system") {
  const theme = {
    get: vi.fn(async () => initial),
    set: vi.fn(async () => {}),
  };
  window.csm = {
    isDesktop: true,
    platform: "win32",
    openExternal: vi.fn(async () => true),
    theme,
    listSessions: vi.fn(() => vi.fn()),
    reopenSession: vi.fn(async () => ({ ok: true as const })),
    getClaudePath: vi.fn(async () => "claude"),
    getTempRoots: vi.fn(async () => []),
    setClaudePath: vi.fn(async () => {}),
    getFacts: vi.fn(async () => ({})),
  };
  return theme;
}

// The button's aria-label starts "Theme: <current>." — find it by that prefix.
const toggle = () => screen.getByRole("button", { name: /^Theme: / });

describe("ThemeToggle", () => {
  it("renders a disabled placeholder when the preload bridge is absent", () => {
    render(<ThemeToggle />);
    const btn = screen.getByLabelText(
      /toggle theme \(unavailable\)/i,
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("seeds the glyph from the persisted preference", async () => {
    installBridge("dark");
    render(<ThemeToggle />);
    expect(await screen.findByLabelText(/^Theme: Dark\./)).toBeTruthy();
  });

  it("cycles System → Light → Dark → System, persisting each step", async () => {
    const theme = installBridge("system");
    render(<ThemeToggle />);
    await screen.findByLabelText(/^Theme: System\./);

    fireEvent.click(toggle());
    expect(theme.set).toHaveBeenLastCalledWith("light");
    expect(await screen.findByLabelText(/^Theme: Light\./)).toBeTruthy();

    fireEvent.click(toggle());
    expect(theme.set).toHaveBeenLastCalledWith("dark");
    expect(await screen.findByLabelText(/^Theme: Dark\./)).toBeTruthy();

    fireEvent.click(toggle());
    expect(theme.set).toHaveBeenLastCalledWith("system");
    expect(await screen.findByLabelText(/^Theme: System\./)).toBeTruthy();
  });

  it("reverts the glyph if persisting the new mode fails", async () => {
    const theme = installBridge("system");
    theme.set.mockRejectedValueOnce(new Error("disk full"));
    render(<ThemeToggle />);
    await screen.findByLabelText(/^Theme: System\./);

    // Optimistic flip to Light happens synchronously on click…
    fireEvent.click(toggle());
    expect(theme.set).toHaveBeenCalledWith("light");
    expect(screen.getByLabelText(/^Theme: Light\./)).toBeTruthy();
    // …then the rejected persist reverts it — Light is gone, System is back.
    await waitFor(() =>
      expect(screen.queryByLabelText(/^Theme: Light\./)).toBe(null),
    );
    expect(screen.getByLabelText(/^Theme: System\./)).toBeTruthy();
  });
});
