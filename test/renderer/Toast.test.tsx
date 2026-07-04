import { test, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Toast } from "../../src/renderer/components/Toast";

afterEach(() => {
  vi.useRealTimers();
});

test("renders the message as a non-blocking status region", () => {
  render(<Toast message="That folder no longer exists." onDismiss={vi.fn()} />);
  const status = screen.getByRole("status");
  expect(status).toBeTruthy();
  expect(status.textContent).toContain("That folder no longer exists.");
});

test("the close button dismisses the toast", () => {
  const onDismiss = vi.fn();
  render(
    <Toast message="Couldn't reopen this session." onDismiss={onDismiss} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("auto-dismisses after its timeout", () => {
  vi.useFakeTimers();
  const onDismiss = vi.fn();
  render(<Toast message="gone soon" onDismiss={onDismiss} />);
  expect(onDismiss).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(6000);
  });
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

test("the message is inserted as text, never HTML", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const { container } = render(<Toast message={evil} onDismiss={vi.fn()} />);
  expect(screen.getByText(evil)).toBeTruthy();
  expect(container.querySelector("img")).toBe(null);
});
