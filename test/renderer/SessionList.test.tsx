import { test, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  createEvent,
  waitFor,
} from "@testing-library/react";
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
  const rows = screen.getAllByRole("option");
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

  const list = screen.getByRole("listbox");
  fireEvent.scroll(list, { target: { scrollTop: 100 * ROW_HEIGHT } });

  // After scrolling ~100 rows down, the window has moved: row 0 unmounted,
  // row 100 mounted.
  expect(screen.queryByText("session 0")).toBe(null);
  expect(screen.queryByText("session 100")).toBeTruthy();
});

test("renders an empty list without crashing", () => {
  render(<SessionList sessions={[]} />);
  expect(screen.getByRole("listbox")).toBeTruthy();
  expect(screen.queryAllByRole("option").length).toBe(0);
});

// ---- #70: keyboard navigation (listbox + aria-activedescendant) -------------

test("is a listbox and the pane's single tab stop (#70)", () => {
  render(<SessionList sessions={makeSessions(5)} />);
  expect(screen.getByRole("listbox").getAttribute("tabindex")).toBe("0");
});

test("seeds the active option to the first row (#70)", () => {
  render(<SessionList sessions={makeSessions(5)} />);
  const listbox = screen.getByRole("listbox");
  expect(listbox.getAttribute("aria-activedescendant")).toBe(
    "session-opt-id000000",
  );
  // The active option reflects it (selection-follows-focus).
  expect(
    document
      .getElementById("session-opt-id000000")
      ?.getAttribute("aria-selected"),
  ).toBe("true");
});

test("ArrowDown / ArrowUp move the active option (#70)", () => {
  render(<SessionList sessions={makeSessions(5)} />);
  const listbox = screen.getByRole("listbox");
  fireEvent.keyDown(listbox, { key: "ArrowDown" });
  expect(listbox.getAttribute("aria-activedescendant")).toBe(
    "session-opt-id000001",
  );
  fireEvent.keyDown(listbox, { key: "ArrowDown" });
  expect(listbox.getAttribute("aria-activedescendant")).toBe(
    "session-opt-id000002",
  );
  fireEvent.keyDown(listbox, { key: "ArrowUp" });
  expect(listbox.getAttribute("aria-activedescendant")).toBe(
    "session-opt-id000001",
  );
});

test("End / Home reveal and activate a row far outside the mounted window (#70)", () => {
  // The virtualization 'hard part': moving focus to a row that is not currently
  // mounted must scroll it into the window so aria-activedescendant resolves.
  render(<SessionList sessions={makeSessions(2500)} />);
  const listbox = screen.getByRole("listbox");
  expect(screen.queryByText("session 2499")).toBe(null); // not mounted at the top

  fireEvent.keyDown(listbox, { key: "End" });
  expect(screen.getByText("session 2499")).toBeTruthy(); // revealed + mounted
  expect(listbox.getAttribute("aria-activedescendant")).toBe(
    "session-opt-id002499",
  );

  fireEvent.keyDown(listbox, { key: "Home" });
  expect(screen.getByText("session 0")).toBeTruthy();
  expect(listbox.getAttribute("aria-activedescendant")).toBe(
    "session-opt-id000000",
  );
});

test("Enter opens the focused session via the provided handler (no parallel path) (#70)", () => {
  const onOpen = vi.fn();
  render(<SessionList sessions={makeSessions(5)} onOpen={onOpen} />);
  const listbox = screen.getByRole("listbox");
  fireEvent.keyDown(listbox, { key: "ArrowDown" }); // active = row 1
  fireEvent.keyDown(listbox, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onOpen.mock.calls[0][0].sessionId).toBe("id000001");
});

test("owns the arrow keys — preventDefault so the page never scrolls under it (#70)", () => {
  render(<SessionList sessions={makeSessions(5)} />);
  const listbox = screen.getByRole("listbox");
  const ev = createEvent.keyDown(listbox, { key: "ArrowDown" });
  fireEvent(listbox, ev);
  expect(ev.defaultPrevented).toBe(true);
});

test("does not swallow Tab — focus can leave the pane (spec §9) (#70)", () => {
  render(<SessionList sessions={makeSessions(5)} />);
  const listbox = screen.getByRole("listbox");
  const ev = createEvent.keyDown(listbox, { key: "Tab" });
  fireEvent(listbox, ev);
  expect(ev.defaultPrevented).toBe(false);
});

test("re-seeds the active option when the focused row disappears between batches (#70)", () => {
  const { rerender } = render(<SessionList sessions={makeSessions(5)} />);
  const listbox = screen.getByRole("listbox");
  fireEvent.keyDown(listbox, { key: "ArrowDown" });
  fireEvent.keyDown(listbox, { key: "ArrowDown" }); // active = row 2
  expect(listbox.getAttribute("aria-activedescendant")).toBe(
    "session-opt-id000002",
  );
  // A later batch drops rows 0-2 (aged out / folded away). The active id is gone.
  rerender(<SessionList sessions={makeSessions(5).slice(3)} />);
  expect(listbox.getAttribute("aria-activedescendant")).toBe(
    "session-opt-id000003",
  );
});

const sampleSession: SessionMetadata = {
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  cwd: "D:\\src\\csm",
  title: "test session",
  permissionMode: "default",
  lastActivity: null,
  gitBranch: null,
};

afterEach(() => {
  (window as unknown as Record<string, unknown>).csm = undefined;
});

test("requests facts for the visible window and passes them to rows", async () => {
  const getFacts = vi.fn(async (ids: string[]) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          sessionId: id,
          messageCount: 7,
          firstActivity: null,
          lastActivity: null,
          editedFileCount: 0,
          firstModel: null,
          distinctModelCount: 0,
          outputTokens: 0,
        },
      ]),
    ),
  );
  (window as unknown as { csm: unknown }).csm = {
    isDesktop: true,
    platform: "win32",
    getFacts,
  };

  render(<SessionList sessions={[sampleSession]} />);
  await waitFor(() => expect(getFacts).toHaveBeenCalled());
  expect(getFacts.mock.calls[0][0]).toContain(sampleSession.sessionId);
  await waitFor(() => expect(screen.getByText(/7 msgs/)).toBeTruthy());
});
