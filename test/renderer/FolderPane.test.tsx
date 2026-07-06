import { test, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FolderPane } from "../../src/renderer/components/FolderPane";
import { ROW_HEIGHT } from "../../src/sessionListWindow";
import type { FolderNode } from "../../src/sessionTree";
import type { SessionMetadata } from "../../src/sessionParser";

const noop = () => {};

const makeFolder = (label: string, n: number): FolderNode => {
  const sessions = Array.from({ length: n }, (_, i) => ({
    sessionId: `${label}${String(i).padStart(6, "0")}`,
    cwd: `D:\\${label}`,
    title: `${label} session ${i}`,
    permissionMode: "default" as const,
    lastActivity: null,
    gitBranch: null,
  }));
  return {
    name: label,
    path: `D:\\${label}`,
    sessions,
    children: [],
    ownCount: n,
    totalCount: n,
    worktreeBranches: new Map(),
  };
};

test("tags rolled-up worktree sessions with a branch chip; own sessions get none", () => {
  const mk = (id: string, branch: string | null): SessionMetadata => ({
    sessionId: id,
    cwd: "D:\\src\\csm",
    title: `session ${id}`,
    permissionMode: "default",
    lastActivity: null,
    gitBranch: branch,
  });
  const folder: FolderNode = {
    name: "csm",
    path: "D:\\src\\csm",
    sessions: [mk("wt000000", "feature-x"), mk("own00000", null)],
    children: [],
    ownCount: 2,
    totalCount: 2,
    worktreeBranches: new Map([["wt000000", "feature-x"]]),
  };
  render(
    <FolderPane selected={folder} onRefreshFolder={noop} refreshDisabled={false} />,
  );
  // Exactly one row (the folded-in worktree session) carries the provenance chip.
  const chips = screen.getAllByTestId("worktree-branch");
  expect(chips).toHaveLength(1);
  expect(chips[0].textContent).toContain("feature-x");
});

test("labels the header as a folder so it reads distinctly from the session rows", () => {
  render(
    <FolderPane
      selected={makeFolder("A", 3)}
      onRefreshFolder={noop}
      refreshDisabled={false}
    />,
  );
  // An eyebrow label marks the header as the folder identity, not a session row.
  expect(screen.getByText("Folder")).toBeTruthy();
  // The folder path is still shown alongside it.
  expect(screen.getByText("D:\\A")).toBeTruthy();
});

test("shows no folder label before a selection (empty state has no header)", () => {
  render(
    <FolderPane
      selected={null}
      onRefreshFolder={noop}
      refreshDisabled={false}
    />,
  );
  expect(screen.queryByText("Folder")).toBe(null);
});

test("renders the selected folder's session list", () => {
  render(
    <FolderPane
      selected={makeFolder("A", 3)}
      onRefreshFolder={noop}
      refreshDisabled={false}
    />,
  );
  expect(screen.getByRole("list")).toBeTruthy();
  expect(screen.getByText("A session 0")).toBeTruthy();
});

test("double-clicking a row forwards the session to onOpen (reopen gesture)", () => {
  const opened: string[] = [];
  render(
    <FolderPane
      selected={makeFolder("A", 3)}
      onRefreshFolder={noop}
      refreshDisabled={false}
      onOpen={(s) => opened.push(s.sessionId)}
    />,
  );
  fireEvent.doubleClick(screen.getByText("A session 1"));
  expect(opened).toEqual(["A000001"]);
});

// Regression (preflight finding): the SessionList instance must not carry one
// folder's scroll offset into the next. Switching folders should show the new
// folder from the top (newest-first, spec §9), not mid-list.
test("switching folders resets the list to the top", () => {
  const { rerender } = render(
    <FolderPane
      selected={makeFolder("A", 50)}
      onRefreshFolder={noop}
      refreshDisabled={false}
    />,
  );
  const list = screen.getByRole("list");
  fireEvent.scroll(list, { target: { scrollTop: 8 * ROW_HEIGHT } });
  // Scrolled down in A: its first row has left the mounted window.
  expect(screen.queryByText("A session 0")).toBe(null);

  rerender(
    <FolderPane
      selected={makeFolder("B", 50)}
      onRefreshFolder={noop}
      refreshDisabled={false}
    />,
  );
  // B must render from the top, not inherit A's scroll position.
  expect(screen.getByText("B session 0")).toBeTruthy();
});
