import { test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionList } from "../../src/renderer/components/SessionList";
import { ROW_HEIGHT } from "../../src/sessionListWindow";
import type { SessionMetadata } from "../../src/sessionParser";

const makeSessions = (n: number): SessionMetadata[] =>
  Array.from({ length: n }, (_, i) => ({
    sessionId: `id${String(i).padStart(6, "0")}`,
    cwd: "D:\\src\\csm",
    title: `session ${i}`,
    permissionMode: "default",
    lastActivity: null,
    gitBranch: null,
  }));

test("virtualizes: a huge folder mounts only a bounded number of rows (spec §11)", () => {
  render(<SessionList sessions={makeSessions(2500)} />);
  const rows = screen.getAllByRole("listitem");
  expect(rows.length).toBeGreaterThan(0);
  // Far fewer than the 2500 items — the whole point of windowing.
  expect(rows.length).toBeLessThan(60);
});

test("reserves full scroll height so the scrollbar reflects the true size", () => {
  const { container } = render(<SessionList sessions={makeSessions(2500)} />);
  const spacer = container.querySelector(
    '[data-testid="session-list-spacer"]',
  ) as HTMLElement | null;
  expect(spacer).toBeTruthy();
  expect(spacer?.style.height).toBe(`${2500 * ROW_HEIGHT}px`);
});

test("slides the mounted window as the list scrolls", () => {
  render(<SessionList sessions={makeSessions(2500)} />);
  // At the top: row 0 is mounted, a deep row is not.
  expect(screen.queryByText("session 0")).toBeTruthy();
  expect(screen.queryByText("session 100")).toBe(null);

  const list = screen.getByRole("list");
  fireEvent.scroll(list, { target: { scrollTop: 100 * ROW_HEIGHT } });

  // After scrolling ~100 rows down, the window has moved: row 0 unmounted,
  // row 100 mounted.
  expect(screen.queryByText("session 0")).toBe(null);
  expect(screen.queryByText("session 100")).toBeTruthy();
});

test("renders an empty list without crashing", () => {
  render(<SessionList sessions={[]} />);
  expect(screen.getByRole("list")).toBeTruthy();
  expect(screen.queryAllByRole("listitem").length).toBe(0);
});
