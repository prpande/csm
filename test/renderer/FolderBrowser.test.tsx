import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  createEvent,
  within,
  act,
} from "@testing-library/react";
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

  // ---- #83: the two failure states must read differently -------------------
  // #81 shipped because "Couldn't load sessions" covered both a dead preload
  // (build/packaging bug) and a thrown scan (runtime/data problem). These
  // assert end-to-end through the hook that each cause gets its own notice.

  it("shows a bridge-unavailable notice when the preload never loaded (#83)", () => {
    window.csm = undefined;
    render(<FolderBrowser />);

    expect(screen.getByText(/session bridge unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/couldn’t load sessions/i)).toBe(null);
  });

  it("shows a scan-failed notice when the scan throws (#83)", () => {
    const bridge = fakeBridge();
    render(<FolderBrowser />);
    act(() => bridge.emit().onError());

    expect(screen.getByText(/couldn’t load sessions/i)).toBeTruthy();
    expect(screen.queryByText(/session bridge unavailable/i)).toBe(null);
  });

  // ---- #111: git-repo markers on tree nodes --------------------------------

  it("marks only the folders whose sessions carry a git branch (#111)", () => {
    // Two sibling leaves under D:\src: one a repo, one not. Asserting BOTH in
    // one tree is the point — a marker on every row would pass a
    // repo-only test.
    renderScanned([
      { ...sess("a", "D:\\src\\csm"), gitBranch: "feature-x" },
      sess("b", "D:\\src\\scratch"),
    ]);

    const repoRow = screen.getByText("csm").closest("li")!;
    const plainRow = screen.getByText("scratch").closest("li")!;
    expect(within(repoRow).queryByTestId("git-repo-marker")).toBeTruthy();
    expect(within(plainRow).queryByTestId("git-repo-marker")).toBe(null);
  });

  // ---- #70: keyboard navigation (integration; no FolderTree.test.tsx) -------
  // The key map itself is unit-tested in test/main/sessionTree.test.ts. These
  // assert the WIRING: that keys reach it, its actions are dispatched, and real
  // DOM focus follows — none of which the pure tests can see.

  const treeOf = () => screen.getByRole("tree", { name: /session folders/i });
  const itemFor = (name: string): HTMLElement =>
    screen.getByText(name).closest("li")!;
  // Enter the tree the way a real user does — Tab lands DOM focus on the roving
  // tab stop. Arrows only move focus once the tree already holds it (it must
  // never grab focus on its own; see the two seeding tests below), so a test
  // that arrows without this would assert a state no user can reach.
  const tabIntoTree = (name: string) => itemFor(name).focus();

  it("focus starts on the first tree row once the tree has rows (#70)", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    // Roving tabindex: exactly one row is tabbable, and it's the first.
    expect(itemFor("D:\\src").getAttribute("tabindex")).toBe("0");
    expect(itemFor("csm").getAttribute("tabindex")).toBe("-1");
  });

  it("seeding the tab stop does NOT steal real DOM focus (#70)", () => {
    // A scan streams in tiers, so the seed re-runs per batch — and compactTree
    // can change a node's path mid-scan, remounting TreeNode and re-firing its
    // focus effect. Focusing unconditionally stole focus on populate, again on
    // every tier, and again on every refresh. Measured in real Electron.
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);

    expect(itemFor("D:\\src").getAttribute("tabindex")).toBe("0"); // ready...
    expect(document.activeElement).not.toBe(itemFor("D:\\src")); // ...but not taken
  });

  it("a later streaming tier does not yank focus off another control (#70)", () => {
    const bridge = fakeBridge();
    render(<FolderBrowser />);
    act(() => bridge.emit().onBatch([sess("a", "D:\\src\\csm")]));

    // The declutter switch, NOT the refresh button — refresh is disabled while
    // scanning, so it cannot hold focus and this would pass for the wrong reason.
    const declutter = screen.getByRole("switch");
    declutter.focus();
    expect(document.activeElement).toBe(declutter);

    // Later tiers land, re-seeding the tree's tab stop each time.
    act(() => bridge.emit().onBatch([sess("b", "D:\\other\\proj")]));
    act(() => bridge.emit().onDone());

    expect(document.activeElement).toBe(declutter);
  });

  it("keeps focus in the tree when a mouse-collapse removes the focused row (#70)", () => {
    // Arrow onto a nested row, then MOUSE-collapse its ancestor: the focused
    // <li> is removed and the browser blurs to <body>. The collapse is itself a
    // gesture, so the chevron handler focuses its own row — focus stays in the
    // tree instead of being stranded, and no render had to guess.
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    tabIntoTree("D:\\src");
    fireEvent.keyDown(treeOf(), { key: "ArrowDown" }); // -> csm (nested)
    expect(document.activeElement).toBe(itemFor("csm"));

    fireEvent.click(
      screen.getAllByRole("button", { name: /collapse folder/i })[0],
    );
    expect(screen.queryByText("csm")).toBe(null); // the focused row is gone

    expect(treeOf().contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    // ...and the keyboard still drives the tree.
    fireEvent.keyDown(treeOf(), { key: "ArrowRight" });
    expect(screen.getByText("csm")).toBeTruthy();
  });

  it("keyboard-collapsing the focused node keeps focus on it (#70)", () => {
    // The keyboard can never remove the row it stands on: Left collapses the
    // focused node IN PLACE (that node stays mounted) and only walks to the
    // parent once already collapsed. So the arrow path has no self-removal case
    // to recover from — the key map's shape is what makes that true.
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    tabIntoTree("D:\\src");

    fireEvent.keyDown(treeOf(), { key: "ArrowLeft" }); // collapse D:\src itself
    expect(screen.queryByText("csm")).toBe(null);
    expect(document.activeElement).toBe(itemFor("D:\\src"));
  });

  it("Down/Up move focus between rows and pull real DOM focus (#70)", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    tabIntoTree("D:\\src");

    fireEvent.keyDown(treeOf(), { key: "ArrowDown" });
    expect(itemFor("csm").getAttribute("tabindex")).toBe("0");
    // Real focus, not just the attribute — that's what :focus-visible needs.
    expect(document.activeElement).toBe(itemFor("csm"));

    fireEvent.keyDown(treeOf(), { key: "ArrowUp" });
    expect(itemFor("D:\\src").getAttribute("tabindex")).toBe("0");
    expect(document.activeElement).toBe(itemFor("D:\\src"));
  });

  it("Left collapses the focused node, Right expands it again (#70)", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    expect(screen.getByText("csm")).toBeTruthy(); // roots auto-expand

    fireEvent.keyDown(treeOf(), { key: "ArrowLeft" });
    expect(screen.queryByText("csm")).toBe(null); // subtree unmounted

    fireEvent.keyDown(treeOf(), { key: "ArrowRight" });
    expect(screen.getByText("csm")).toBeTruthy();
  });

  it("Left from a child moves focus to its parent (#70)", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    tabIntoTree("D:\\src");
    fireEvent.keyDown(treeOf(), { key: "ArrowDown" }); // -> csm (a leaf)
    expect(document.activeElement).toBe(itemFor("csm"));

    fireEvent.keyDown(treeOf(), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(itemFor("D:\\src"));
  });

  it("Enter selects the focused folder that owns sessions (#70)", () => {
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    expect(
      screen.getByText(/select a folder to view its sessions/i),
    ).toBeTruthy();

    fireEvent.keyDown(treeOf(), { key: "ArrowDown" }); // -> csm
    fireEvent.keyDown(treeOf(), { key: "Enter" });
    // Same outcome as a click: the pane header shows the folder's full cwd.
    expect(screen.getByText("D:\\src\\csm")).toBeTruthy();
    expect(screen.getByText(/1 session/i)).toBeTruthy();
  });

  it("clicking a row moves keyboard focus to it, so arrows resume from there (#70)", () => {
    // Without this, the next arrow key would jump from wherever the keyboard
    // last was rather than from what the user just clicked.
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    tabIntoTree("D:\\src");
    fireEvent.click(screen.getByText("prism"));
    expect(itemFor("prism").getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(treeOf(), { key: "ArrowUp" });
    expect(document.activeElement).toBe(itemFor("csm"));
  });

  it("keeps the tree to a single Tab stop (#70)", () => {
    // A chevron per visible node in the Tab order would make "Tab moves between
    // tree and list" unreachable in practice.
    renderScanned([sess("a", "D:\\src\\csm"), sess("b", "D:\\src\\prism")]);
    const chevron = screen.getAllByRole("button", { name: /folder$/i })[0];
    expect(chevron.getAttribute("tabindex")).toBe("-1");
    const tabbable = treeOf().querySelectorAll('[tabindex="0"]');
    expect(tabbable).toHaveLength(1);
  });

  it("does not swallow keys it doesn't handle, so Tab can leave the pane (#70)", () => {
    renderScanned([sess("a", "D:\\src\\csm")]);
    const e = createEvent.keyDown(treeOf(), { key: "Tab" });
    fireEvent(treeOf(), e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("does not mark an intermediate folder above a repo (#111)", () => {
    // D:\src owns no sessions, so it is not itself a repo — only its child is.
    // Two children keep the chain from being compacted away by #77.
    renderScanned([
      { ...sess("a", "D:\\src\\csm"), gitBranch: "feature-x" },
      { ...sess("b", "D:\\src\\other"), gitBranch: "feature-y" },
    ]);

    const srcRow = screen.getByText("D:\\src").closest("li")!;
    // The marker inside the nested children must not be mistaken for the
    // parent's own, so scope to D:\src's own row div, not its whole <li>.
    const ownRow = srcRow.querySelector("div")!;
    expect(within(ownRow).queryByTestId("git-repo-marker")).toBe(null);
    // ...while the repo children below it ARE marked.
    expect(screen.getAllByTestId("git-repo-marker")).toHaveLength(2);
  });

  // ---- #164: resizable sidebar splitter -------------------------------------
  // The width math (clamp/restore/keyboard) is unit-tested in
  // test/main/sidebarWidth.test.ts. These assert the WIRING: the separator's
  // ARIA value semantics, that gestures reach the pure map, persistence, and
  // the CSS variable the sidebar consumes. jsdom applies no stylesheets, so
  // the inline --sidebar-width on the flex row is the observable width.

  describe("sidebar splitter (#164)", () => {
    beforeEach(() => {
      localStorage.clear();
    });
    afterEach(() => {
      // The re-clamp test shrinks the window; every other test assumes the
      // jsdom default (1024 -> max 614).
      window.innerWidth = 1024;
    });

    const splitter = () =>
      screen.getByRole("separator", { name: /resize the folder sidebar/i });

    it("renders a focusable vertical separator with value semantics", () => {
      renderScanned([]);
      const sep = splitter();
      expect(sep.getAttribute("aria-orientation")).toBe("vertical");
      expect(sep.getAttribute("tabindex")).toBe("0");
      expect(sep.getAttribute("aria-valuenow")).toBe("260");
      expect(sep.getAttribute("aria-valuemin")).toBe("160");
      // jsdom window is 1024 wide -> max = round(1024 * 0.6).
      expect(sep.getAttribute("aria-valuemax")).toBe("614");
    });

    it("ArrowRight/ArrowLeft resize by a step and persist the width", () => {
      renderScanned([]);
      fireEvent.keyDown(splitter(), { key: "ArrowRight" });
      expect(splitter().getAttribute("aria-valuenow")).toBe("276");
      expect(localStorage.getItem("csm.sidebar-width")).toBe("276");

      fireEvent.keyDown(splitter(), { key: "ArrowLeft" });
      expect(splitter().getAttribute("aria-valuenow")).toBe("260");
      expect(localStorage.getItem("csm.sidebar-width")).toBe("260");
    });

    it("Home/End jump to min/max", () => {
      renderScanned([]);
      fireEvent.keyDown(splitter(), { key: "Home" });
      expect(splitter().getAttribute("aria-valuenow")).toBe("160");
      fireEvent.keyDown(splitter(), { key: "End" });
      expect(splitter().getAttribute("aria-valuenow")).toBe("614");
    });

    it("does not swallow keys it doesn't own, so Tab can leave", () => {
      renderScanned([]);
      const e = createEvent.keyDown(splitter(), { key: "Tab" });
      fireEvent(splitter(), e);
      expect(e.defaultPrevented).toBe(false);
    });

    it("feeds the width to the sidebar via the CSS variable", () => {
      renderScanned([]);
      const body = splitter().parentElement!;
      expect(body.style.getPropertyValue("--sidebar-width")).toBe("260px");
      fireEvent.keyDown(splitter(), { key: "ArrowRight" });
      expect(body.style.getPropertyValue("--sidebar-width")).toBe("276px");
    });

    it("restores a persisted width on mount, clamped to the window", () => {
      localStorage.setItem("csm.sidebar-width", "320");
      renderScanned([]);
      expect(splitter().getAttribute("aria-valuenow")).toBe("320");
    });

    it("clamps an out-of-range persisted width on mount", () => {
      localStorage.setItem("csm.sidebar-width", "5000");
      renderScanned([]);
      expect(splitter().getAttribute("aria-valuenow")).toBe("614");
    });

    it("falls back to the default on a corrupt persisted value", () => {
      localStorage.setItem("csm.sidebar-width", "garbage");
      renderScanned([]);
      expect(splitter().getAttribute("aria-valuenow")).toBe("260");
    });

    it("drag resizes relative to the pointer-down origin and persists on move", () => {
      renderScanned([]);
      const sep = splitter();
      fireEvent.pointerDown(sep, { clientX: 260, pointerId: 1 });
      fireEvent.pointerMove(sep, { clientX: 320, pointerId: 1 });
      expect(sep.getAttribute("aria-valuenow")).toBe("320");

      // Still the SAME drag: the delta is against the down-origin, not the
      // previous move, so a jittery pointer can't accumulate rounding drift.
      fireEvent.pointerMove(sep, { clientX: 300, pointerId: 1 });
      expect(sep.getAttribute("aria-valuenow")).toBe("300");

      fireEvent.pointerUp(sep, { pointerId: 1 });
      expect(localStorage.getItem("csm.sidebar-width")).toBe("300");

      // After release, a stray move must not resize.
      fireEvent.pointerMove(sep, { clientX: 500, pointerId: 1 });
      expect(sep.getAttribute("aria-valuenow")).toBe("300");
    });

    it("clamps a drag that outruns the max", () => {
      renderScanned([]);
      const sep = splitter();
      fireEvent.pointerDown(sep, { clientX: 260, pointerId: 1 });
      fireEvent.pointerMove(sep, { clientX: 5000, pointerId: 1 });
      expect(sep.getAttribute("aria-valuenow")).toBe("614");
    });

    it("double-click resets to the default width", () => {
      renderScanned([]);
      fireEvent.keyDown(splitter(), { key: "End" });
      expect(splitter().getAttribute("aria-valuenow")).toBe("614");
      fireEvent.dblClick(splitter());
      expect(splitter().getAttribute("aria-valuenow")).toBe("260");
      expect(localStorage.getItem("csm.sidebar-width")).toBe("260");
    });

    it("re-clamps the width when the window shrinks under it", () => {
      renderScanned([]);
      fireEvent.keyDown(splitter(), { key: "End" }); // 614
      act(() => {
        window.innerWidth = 500;
        fireEvent(window, new Event("resize"));
      });
      // max is now round(500 * 0.6) = 300; the width and the announced range follow.
      expect(splitter().getAttribute("aria-valuenow")).toBe("300");
      expect(splitter().getAttribute("aria-valuemax")).toBe("300");
    });

    it("a second pointer cannot hijack or end an active drag", () => {
      renderScanned([]);
      const sep = splitter();
      fireEvent.pointerDown(sep, { clientX: 260, pointerId: 1 });
      fireEvent.pointerMove(sep, { clientX: 300, pointerId: 1 });
      expect(sep.getAttribute("aria-valuenow")).toBe("300");

      // A stray second pointer (a touch on the widened hit area) lands
      // mid-drag: its down must not re-seed the origin, its moves must not
      // steer, and its up must not end pointer 1's drag.
      fireEvent.pointerDown(sep, { clientX: 500, pointerId: 2 });
      fireEvent.pointerMove(sep, { clientX: 520, pointerId: 2 });
      expect(sep.getAttribute("aria-valuenow")).toBe("300");
      fireEvent.pointerUp(sep, { pointerId: 2 });

      // Pointer 1 still drags against ITS original origin, and its up ends it.
      fireEvent.pointerMove(sep, { clientX: 340, pointerId: 1 });
      expect(sep.getAttribute("aria-valuenow")).toBe("340");
      fireEvent.pointerUp(sep, { pointerId: 1 });
      fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 });
      expect(sep.getAttribute("aria-valuenow")).toBe("340");
    });

    it("renders with the default width when reading storage throws", () => {
      const spy = vi
        .spyOn(Storage.prototype, "getItem")
        .mockImplementation(() => {
          throw new Error("storage disabled");
        });
      try {
        renderScanned([]);
        expect(splitter().getAttribute("aria-valuenow")).toBe("260");
      } finally {
        spy.mockRestore();
      }
    });

    it("keeps resizing when persisting to storage throws", () => {
      const spy = vi
        .spyOn(Storage.prototype, "setItem")
        .mockImplementation(() => {
          throw new Error("quota exceeded");
        });
      try {
        renderScanned([]);
        fireEvent.keyDown(splitter(), { key: "ArrowRight" });
        expect(splitter().getAttribute("aria-valuenow")).toBe("276");
      } finally {
        spy.mockRestore();
      }
    });

    it("ignores a non-primary-button pointerdown (right-click is not a drag)", () => {
      renderScanned([]);
      const sep = splitter();
      fireEvent.pointerDown(sep, { clientX: 260, pointerId: 1, button: 2 });
      fireEvent.pointerMove(sep, { clientX: 320, pointerId: 1 });
      expect(sep.getAttribute("aria-valuenow")).toBe("260");
    });

    it("widening the sidebar reveals more of a long compacted label", () => {
      // A single deep session compacts into one chain node whose label is the
      // full path (#77) — 46 chars, past the default 36-char budget.
      const longCwd = "D:\\alpha\\bravo\\charlie\\delta\\echo\\foxtrot\\golf";
      renderScanned([sess("a", longCwd)]);
      expect(screen.queryByText(longCwd)).toBe(null); // middle-elided at 260px
      // End jumps to the max width; the width-derived budget now fits the
      // whole label, so the row shows the full path.
      fireEvent.keyDown(splitter(), { key: "End" });
      expect(screen.getByText(longCwd)).toBeTruthy();
    });
  });
});
