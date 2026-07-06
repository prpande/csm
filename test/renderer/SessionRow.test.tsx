import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionRow } from "../../src/renderer/components/SessionRow";
import type { SessionMetadata } from "../../src/sessionParser";
import type { PermissionMode } from "../../src/sessionParser";
import type { FactEntry } from "../../src/renderer/hooks/useSessionFacts";

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

test("shows a worktree branch chip only when a branch is provided", () => {
  const { rerender } = render(
    <SessionRow session={makeSession()} rowHeight={56} />,
  );
  expect(screen.queryByTestId("worktree-branch")).toBeNull();

  rerender(
    <SessionRow
      session={makeSession()}
      rowHeight={56}
      worktreeBranch="feature-x"
    />,
  );
  expect(screen.getByTestId("worktree-branch").textContent).toContain(
    "feature-x",
  );
});

test("worktree branch is inserted as text, never as HTML", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const { container } = render(
    <SessionRow session={makeSession()} rowHeight={56} worktreeBranch={evil} />,
  );
  expect(screen.getByText(evil)).toBeTruthy();
  expect(container.querySelector("img")).toBe(null);
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

const sampleSession = makeSession();

const loaded: FactEntry = {
  status: "loaded",
  facts: {
    sessionId: "s",
    messageCount: 42,
    firstActivity: "2026-07-01T00:00:00Z",
    lastActivity: "2026-07-01T03:41:00Z",
    editedFileCount: 5,
    firstModel: "claude-opus-4-8",
    distinctModelCount: 1,
    outputTokens: 1200000,
  },
};

test("renders the fact segments when loaded", () => {
  const { container } = render(
    <SessionRow session={sampleSession} rowHeight={76} factState={loaded} />,
  );
  // The facts div has aria-label with all segments joined; check individual spans too.
  const factsDiv = container.querySelector("[aria-label]");
  expect(factsDiv).toBeTruthy();
  const text = factsDiv!.textContent ?? "";
  expect(text).toContain("42 msgs");
  expect(text).toContain("3h 41m");
  expect(text).toContain("5 edited");
  expect(text).toContain("Opus 4.8");
  expect(text).toContain("1.2M tok");
});

test("shows a skeleton (aria-busy) while facts are loading", () => {
  const { container } = render(
    <SessionRow session={sampleSession} rowHeight={76} />,
  );
  expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
});

test("shows an em-dash on fact error", () => {
  render(
    <SessionRow
      session={sampleSession}
      rowHeight={76}
      factState={{ status: "error" }}
    />,
  );
  expect(screen.getByText("—")).toBeTruthy();
});
