import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../../src/renderer/components/SessionRow";
import type { SessionMetadata } from "../../src/sessionParser";
import type { PermissionMode } from "../../src/sessionParser";

const makeSession = (over: Partial<SessionMetadata> = {}): SessionMetadata => ({
  sessionId: "abcdefgh-1111-2222-3333-444455556666",
  cwd: "D:\\src\\csm",
  title: "Refactor the parser",
  permissionMode: "default",
  lastActivity: null,
  gitBranch: null,
  ...over,
});

test("renders the title, short id, and a time string", () => {
  render(<SessionRow session={makeSession()} rowHeight={56} />);
  expect(screen.getByText("Refactor the parser")).toBeTruthy();
  // short id = first 8 chars of the sessionId.
  expect(screen.getByText("abcdefgh")).toBeTruthy();
  // null lastActivity => deterministic "unknown".
  expect(screen.getByText("unknown")).toBeTruthy();
});

test("chip carries the risk-coded variant and the raw mode label", () => {
  const cases: Array<[PermissionMode, string]> = [
    ["bypassPermissions", "bypass"],
    ["acceptEdits", "info"],
    ["auto", "info"],
    ["plan", "plan"],
    ["default", "default"],
    ["dontAsk", "default"],
  ];
  for (const [mode, variant] of cases) {
    const { container, unmount } = render(
      <SessionRow
        session={makeSession({ permissionMode: mode })}
        rowHeight={56}
      />,
    );
    const chip = container.querySelector("[data-variant]");
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-variant")).toBe(variant);
    // Label is the raw mode string, rendered as text.
    expect(chip?.textContent).toBe(mode);
    unmount();
  }
});

test("shows an Open button (per-row accessible name) that fires onOpen on click", () => {
  const onOpen = vi.fn();
  const session = makeSession();
  render(<SessionRow session={session} rowHeight={56} onOpen={onOpen} />);
  // Accessible name is per-row so screen-reader users can tell the buttons apart.
  const btn = screen.getByRole("button", {
    name: "Open session: Refactor the parser",
  });
  // Visible label stays the short "Open".
  expect(btn.textContent).toBe("Open");
  fireEvent.click(btn);
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(session);
});

test("clicking the Open button does not double-fire via the row (stopPropagation)", () => {
  const onOpen = vi.fn();
  render(<SessionRow session={makeSession()} rowHeight={56} onOpen={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: /open session:/i }));
  expect(onOpen).toHaveBeenCalledTimes(1);
});

test("the Open button's dblclick event is stopped before it reaches the row's reopen handler", () => {
  // Scope note: fireEvent.doubleClick dispatches only a synthetic `dblclick`,
  // NOT the real browser sequence (click, click, dblclick). So this asserts
  // exactly one thing — the button's dblclick handler stops that event from
  // bubbling to the row's onDoubleClick reopen. It does NOT model a real
  // double-click, where the two intervening `click`s would each call onOpen
  // (both collapsed by the reopen consumer's in-flight guard). The button owns
  // its own gesture regardless of that guard.
  const onOpen = vi.fn();
  render(<SessionRow session={makeSession()} rowHeight={56} onOpen={onOpen} />);
  fireEvent.doubleClick(screen.getByRole("button", { name: /open session:/i }));
  expect(onOpen).not.toHaveBeenCalled();
});

test("double-click fires onOpen with the session (the reopen gesture)", () => {
  const onOpen = vi.fn();
  const session = makeSession();
  render(<SessionRow session={session} rowHeight={56} onOpen={onOpen} />);
  fireEvent.doubleClick(screen.getByText("Refactor the parser"));
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(session);
});

test("a row with no onOpen handler does not crash on double-click", () => {
  render(<SessionRow session={makeSession()} rowHeight={56} />);
  // No throw when the optional handler is absent.
  fireEvent.doubleClick(screen.getByText("Refactor the parser"));
  expect(screen.getByText("Refactor the parser")).toBeTruthy();
});

test("title is inserted as text, never as HTML (spec §9)", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const { container } = render(
    <SessionRow session={makeSession({ title: evil })} rowHeight={56} />,
  );
  // The angle-bracket string appears literally, and no <img> element is created.
  expect(screen.getByText(evil)).toBeTruthy();
  expect(container.querySelector("img")).toBe(null);
});
