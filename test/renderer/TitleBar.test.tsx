import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { TitleBar } from "../../src/renderer/components/TitleBar";

afterEach(() => {
  cleanup();
  delete (window as { csm?: unknown }).csm;
});

describe("TitleBar", () => {
  it("renders the brand icon as an <img> (never innerHTML) beside the app name", () => {
    const { container } = render(
      <TitleBar onRefresh={vi.fn()} refreshing={false} />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBe(null);
    // Vite resolves the PNG import to a real URL string.
    expect(img?.getAttribute("src")).toBeTruthy();
    expect(screen.getByText(/Claude Session Manager/i)).toBeTruthy();
  });

  it("names the app with the page's top-level heading (#83)", () => {
    // The scaffold's <h1> was dropped in #65, leaving the app with no heading at
    // all — which silently broke e2e/app.smoke.spec.ts's getByRole("heading")
    // for every release since. That went unnoticed because the _electron e2e is
    // local/manual, not a CI job. This assertion lives in the unit suite ON
    // PURPOSE: it is the copy of the guard that 3-OS CI actually runs.
    render(<TitleBar onRefresh={vi.fn()} refreshing={false} />);
    expect(
      screen.getByRole("heading", {
        name: /claude session manager/i,
        level: 1,
      }),
    ).toBeTruthy();
  });

  it("wires the refresh control and disables it while scanning", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <TitleBar onRefresh={onRefresh} refreshing={false} />,
    );
    fireEvent.click(screen.getByLabelText("Refresh all sessions"));
    expect(onRefresh).toHaveBeenCalledOnce();

    rerender(<TitleBar onRefresh={onRefresh} refreshing={true} />);
    expect(
      (screen.getByLabelText("Refresh all sessions") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("omits the window controls when the desktop bridge is absent", () => {
    render(<TitleBar onRefresh={vi.fn()} refreshing={false} />);
    expect(screen.queryByLabelText("Minimize")).toBe(null);
  });

  it("shows the theme control as a disabled placeholder when the bridge is absent", () => {
    render(<TitleBar onRefresh={vi.fn()} refreshing={false} />);
    const toggle = screen.getByLabelText(
      /toggle theme \(unavailable\)/i,
    ) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });
});
