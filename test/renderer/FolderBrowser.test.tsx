import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { FolderBrowser } from "../../src/renderer/components/FolderBrowser";
import type { SessionsListener } from "../../src/ipcTypes";
import type { SessionMetadata } from "../../src/sessionParser";

// FolderBrowser is the slice-2 shell: it drives the #64 data layer, owns the
// tree's expansion + selection state (decision A), and lays out the title bar,
// sidebar tree, and folder-view pane. A fake bridge captures the streaming
// listener so a test drives onBatch/onDone and asserts on the rendered DOM.
// Assertions use plain vitest matchers (no jest-dom) so they pass locally too.

const sess = (id: string, cwd: string): SessionMetadata => ({
  sessionId: id,
  cwd,
  title: id,
  permissionMode: "default",
  lastActivity: null,
  gitBranch: null,
});

function fakeBridge() {
  const unsubscribe = vi.fn();
  let listener: SessionsListener | undefined;
  const listSessions = vi.fn((l: SessionsListener) => {
    listener = l;
    return unsubscribe;
  });
  window.csm = {
    isDesktop: true,
    platform: "win32",
    openExternal: vi.fn(async () => true),
    listSessions,
    reopenSession: vi.fn(async () => ({ ok: true as const })),
    getClaudePath: vi.fn(async () => "claude"),
    getTempRoots: vi.fn(async () => []),
    setClaudePath: vi.fn(async () => {}),
    getFacts: vi.fn(async () => ({})),
  };
  return {
    unsubscribe,
    listSessions,
    emit: (): SessionsListener => {
      if (!listener) throw new Error("listSessions was not called");
      return listener;
    },
  };
}

// Render + stream one batch then complete, so the tree is populated and settled.
function renderScanned(sessions: SessionMetadata[]) {
  const bridge = fakeBridge();
  render(<FolderBrowser />);
  act(() => bridge.emit().onBatch(sessions));
  act(() => bridge.emit().onDone());
  return bridge;
}

// The clickable row (name + chevron + count) — its parent <li> also contains the
// nested children <ul>, so scope count assertions to the row, not the treeitem.
const rowFor = (name: string): HTMLElement => {
  const row = screen.getByText(name).parentElement;
  if (!row) throw new Error(`no row for "${name}"`);
  return row;
};

describe("FolderBrowser", () => {
  it("shows the empty-state prompt and no folder header before any selection", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    expect(
      screen.getByText(/select a folder to view its sessions/i),
    ).toBeTruthy();
    // The folder header renders a selected folder's full cwd path. "D:\\src\\csm"
    // is a header path, never a tree-row label (the row shows the leaf "csm"), so
    // its absence proves no header is shown before a selection.
    expect(screen.queryByText("D:\\src\\csm")).toBe(null);
  });

  it("renders the compacted branch root with its auto-expanded children", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    // D: has one child and no sessions, so #77 collapses it into src; the tree
    // starts at the compacted branch root "D:\\src".
    expect(screen.getByText("D:\\src")).toBeTruthy();
    // Roots auto-expand, so both leaves under the branch are mounted.
    expect(screen.getByText("csm")).toBeTruthy();
    expect(screen.getByText("prism")).toBeTruthy();
  });

  it("selecting a folder with sessions shows the folder header with path and count", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    fireEvent.click(screen.getByText("csm"));
    expect(screen.getByText("D:\\src\\csm")).toBeTruthy(); // pane header = full cwd
    expect(screen.getByText(/1 session/i)).toBeTruthy();
    expect(screen.queryByText(/select a folder to view its sessions/i)).toBe(
      null,
    );
  });

  it("clicking an intermediate nav node expands it without selecting", () => {
    renderScanned([
      sess("a", "D:\\src\\csm\\x"),
      sess("b", "D:\\src\\csm\\y"),
      sess("c", "D:\\src\\prism"),
    ]);
    // Compacted root "D:\\src" auto-expands -> its children "csm" (a nested nav
    // branch) and "prism" are visible; csm is collapsed, so x/y aren't mounted.
    expect(screen.getByText("csm")).toBeTruthy();
    expect(screen.queryByText("x")).toBe(null);

    fireEvent.click(screen.getByText("csm"));
    expect(screen.getByText("x")).toBeTruthy();
    expect(screen.getByText("y")).toBeTruthy();
    // Nav click expands, never selects: still no header, empty state remains.
    expect(
      screen.getByText(/select a folder to view its sessions/i),
    ).toBeTruthy();
  });

  it("pins the (unknown) group last and lets it be selected", () => {
    renderScanned([sess("a", "D:\\proj"), sess("u", "(unknown)")]);
    const tree = screen.getByRole("tree");
    const text = tree.textContent ?? "";
    expect(text.indexOf("(unknown)")).toBeGreaterThan(text.indexOf("D:\\proj"));

    fireEvent.click(screen.getByText("(unknown)"));
    expect(screen.getByText(/1 session/i)).toBeTruthy();
  });

  it("collapsing a root unmounts its subtree", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    expect(screen.getByText("csm")).toBeTruthy();
    // "D:\\src" is a pure nav node (no own sessions) -> a row click toggles it.
    fireEvent.click(screen.getByText("D:\\src"));
    expect(screen.queryByText("csm")).toBe(null);
    fireEvent.click(screen.getByText("D:\\src"));
    expect(screen.getByText("csm")).toBeTruthy();
  });

  it("title-bar refresh restarts the scan and is disabled while scanning", () => {
    const bridge = fakeBridge();
    render(<FolderBrowser />);
    const refresh = screen.getByRole("button", {
      name: /refresh all sessions/i,
    });
    // Initial scan in flight -> disabled.
    expect(refresh.hasAttribute("disabled")).toBe(true);

    act(() => bridge.emit().onDone());
    expect(refresh.hasAttribute("disabled")).toBe(false);
    expect(bridge.listSessions).toHaveBeenCalledTimes(1);

    fireEvent.click(refresh);
    expect(bridge.listSessions).toHaveBeenCalledTimes(2);
    expect(refresh.hasAttribute("disabled")).toBe(true);
  });

  it("provides a per-folder refresh: disabled while scanning, enabled when done, and re-scans", () => {
    const bridge = fakeBridge();
    render(<FolderBrowser />);
    // Batch in (folder present) but scan still in flight, then select it.
    act(() => bridge.emit().onBatch([sess("a", "D:\\proj")]));
    fireEvent.click(screen.getByText("D:\\proj"));
    const folderRefresh = screen.getByRole("button", {
      name: /refresh this folder/i,
    });
    // Selected folder + scan in flight -> the per-folder control is disabled.
    expect(folderRefresh.hasAttribute("disabled")).toBe(true);

    act(() => bridge.emit().onDone());
    expect(folderRefresh.hasAttribute("disabled")).toBe(false);

    fireEvent.click(folderRefresh);
    // Decision (a): wired to the global re-scan until a per-folder API exists.
    expect(bridge.listSessions).toHaveBeenCalledTimes(2);
  });

  it("shows the loading indicator while scanning and hides it when done", () => {
    const bridge = fakeBridge();
    render(<FolderBrowser />);
    expect(screen.getByText(/loading older sessions/i)).toBeTruthy();
    act(() => bridge.emit().onDone());
    expect(screen.queryByText(/loading older sessions/i)).toBe(null);
  });

  it("shows a count on a leaf folder but not on an intermediate nav folder", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    // "D:\\src" is the compacted branch root (auto-expanded); csm/prism are leaves.
    // The nav folder carries no count (children counts live in a sibling <ul>,
    // not the row).
    expect(within(rowFor("D:\\src")).queryByText("1")).toBe(null);
    // Leaf folder shows its own-session count.
    expect(within(rowFor("csm")).getByText("1")).toBeTruthy();
  });

  it("renders folder names as text, never as HTML", () => {
    renderScanned([sess("a", "D:\\<img src=x>")]);
    // D: collapses into its single child, so the compacted label is the full path.
    expect(screen.getByText("D:\\<img src=x>")).toBeTruthy();
    // The literal was inserted as text, so it never became a real element: no
    // <img> with the injected src="x" exists. (The title bar renders its own
    // legitimate brand <img>, so we key on the injected src, not "any img".)
    expect(document.querySelector('img[src="x"]')).toBe(null);
  });

  it("clears a stale selection when a refresh makes the selected folder unselectable", () => {
    const bridge = fakeBridge();
    render(<FolderBrowser />);
    act(() => bridge.emit().onBatch([sess("a", "D:\\proj")]));
    act(() => bridge.emit().onDone());
    // Pre-selection the row is the only "D:\\proj" text, so this click is unambiguous.
    fireEvent.click(screen.getByText("D:\\proj"));
    expect(screen.getByText(/1 session/i)).toBeTruthy(); // header shown

    // Refresh replaces the scan: this time "D:\\proj" owns no sessions (only a
    // deeper child), so #77 absorbs it into "D:\\proj\\sub" and the old
    // selectedPath "D:\\proj" no longer resolves -> selection self-clears.
    fireEvent.click(
      screen.getByRole("button", { name: /refresh all sessions/i }),
    );
    act(() => bridge.emit().onBatch([sess("b", "D:\\proj\\sub")]));
    act(() => bridge.emit().onDone());

    // Empty state, not a stale "1 session" header.
    expect(
      screen.getByText(/select a folder to view its sessions/i),
    ).toBeTruthy();
    expect(screen.queryByText(/1 session/i)).toBe(null);
  });

  it("auto-expands a root that first appears in a later streaming tier", () => {
    const bridge = fakeBridge();
    render(<FolderBrowser />);
    // tier 1: only the D: cluster (a branch, so it has children to expand).
    act(() =>
      bridge
        .emit()
        .onBatch([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]),
    );
    // later tier: the C: cluster first appears.
    act(() =>
      bridge
        .emit()
        .onBatch([sess("c", "C:\\work\\api"), sess("d", "C:\\work\\web")]),
    );
    act(() => bridge.emit().onDone());
    // Both compacted roots auto-expand once seen, so a leaf under each is mounted.
    expect(screen.getByText("csm")).toBeTruthy();
    expect(screen.getByText("api")).toBeTruthy();
  });

  it("declutter switch hides temp folders by default and reveals them when toggled off", async () => {
    // A bridge whose temp roots include C:\Temp, so the filter has something to
    // hide. getTempRoots is async, so flush it before streaming the batch.
    const unsubscribe = vi.fn();
    let listener: SessionsListener | undefined;
    window.csm = {
      isDesktop: true,
      platform: "win32",
      openExternal: vi.fn(async () => true),
      listSessions: vi.fn((l: SessionsListener) => {
        listener = l;
        return unsubscribe;
      }),
      reopenSession: vi.fn(async () => ({ ok: true as const })),
      getClaudePath: vi.fn(async () => "claude"),
      getTempRoots: vi.fn(async () => ["C:\\Temp"]),
      setClaudePath: vi.fn(async () => {}),
      getFacts: vi.fn(async () => ({})),
    };
    render(<FolderBrowser />);
    await act(async () => {}); // resolve getTempRoots -> tempRoots state
    act(() =>
      listener!.onBatch([
        sess("keep", "D:\\src\\csm"),
        sess("tmp", "C:\\Temp\\junk"),
      ]),
    );
    act(() => listener!.onDone());

    const sw = screen.getByRole("switch");
    // Default: declutter ON -> temp cluster hidden, normal project shown.
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("D:\\src\\csm")).toBeTruthy();
    expect(screen.queryByText("C:\\Temp\\junk")).toBe(null);

    // Toggle OFF -> raw structure, temp cluster reappears (no re-scan).
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("C:\\Temp\\junk")).toBeTruthy();
    expect(window.csm!.listSessions).toHaveBeenCalledTimes(1);
  });

  it("re-expands a root whose compacted identity shrinks as a sibling streams in", () => {
    // tier 1: a lone session fully collapses the chain to a leaf root "D:\\a\\b".
    const bridge = fakeBridge();
    render(<FolderBrowser />);
    act(() => bridge.emit().onBatch([sess("a", "D:\\a\\b")]));
    expect(screen.getByText("D:\\a\\b")).toBeTruthy();
    expect(screen.queryByText("b")).toBe(null); // no separate leaf row yet

    // tier 2: a sibling makes "D:\\a" branch, so the root shrinks from the leaf
    // "D:\\a\\b" to the shallower branch "D:\\a" (a new root path). Auto-expand
    // seeds that fresh path, so both leaves mount.
    act(() => bridge.emit().onBatch([sess("c", "D:\\a\\c")]));
    act(() => bridge.emit().onDone());
    expect(screen.getByText("D:\\a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(screen.getByText("c")).toBeTruthy();
  });
});
