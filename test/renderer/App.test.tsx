import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../../src/renderer/App";

describe("App", () => {
  it("renders the scaffold heading", () => {
    render(<App />);
    expect(
      screen.getByRole("heading", { name: /claude session manager/i }),
    ).toBeInTheDocument();
  });

  it("shows the platform from the window.csm bridge", () => {
    window.csm = {
      isDesktop: true,
      platform: "win32",
      openExternal: vi.fn(async () => true),
      listSessions: vi.fn(() => vi.fn()),
      reopenSession: vi.fn(async () => ({ ok: true as const })),
      getClaudePath: vi.fn(async () => "claude"),
      setClaudePath: vi.fn(async () => {}),
    };
    render(<App />);
    expect(screen.getByText(/platform: win32/i)).toBeInTheDocument();
  });

  it("falls back to 'web' when the bridge is absent", () => {
    window.csm = undefined;
    render(<App />);
    expect(screen.getByText(/platform: web/i)).toBeInTheDocument();
  });
});
