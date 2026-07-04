import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionRow } from "../../src/renderer/components/SessionRow";
import type { SessionMetadata } from "../../src/sessionParser";
import type { PermissionMode } from "../../src/sessionParser";

const makeSession = (over: Partial<SessionMetadata> = {}): SessionMetadata => ({
  sessionId: "abcdefgh-1111-2222-3333-444455556666",
  cwd: "D:\\src\\csm",
  title: "Refactor the parser",
  permissionMode: "default",
  lastActivity: null,
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

test("title is inserted as text, never as HTML (spec §9)", () => {
  const evil = '<img src=x onerror="alert(1)">';
  const { container } = render(
    <SessionRow session={makeSession({ title: evil })} rowHeight={56} />,
  );
  // The angle-bracket string appears literally, and no <img> element is created.
  expect(screen.getByText(evil)).toBeTruthy();
  expect(container.querySelector("img")).toBe(null);
});
