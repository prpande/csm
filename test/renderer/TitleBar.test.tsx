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
