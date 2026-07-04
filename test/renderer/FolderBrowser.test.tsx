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
    setClaudePath: vi.fn(async () => {}),
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
    renderScanned([sess("a", "D:\\proj")]);
    expect(
      screen.getByText(/select a folder to view its sessions/i),
    ).toBeTruthy();
    // The folder header renders the full cwd path; absent until a folder is picked.
    expect(screen.queryByText("D:\\proj")).toBe(null);
  });

  it("renders the drive root with its auto-expanded child folder", () => {
    renderScanned([sess("a", "D:\\proj")]);
    expect(screen.getByText("D:")).toBeTruthy();
    // Roots auto-expand, so the leaf under the drive is mounted.
    expect(screen.getByText("proj")).toBeTruthy();
  });

  it("selecting a folder with sessions shows the folder header with path and count", () => {
    renderScanned([sess("a", "D:\\proj")]);
    fireEvent.click(screen.getByText("proj"));
    expect(screen.getByText("D:\\proj")).toBeTruthy();
    expect(screen.getByText(/1 session/i)).toBeTruthy();
    expect(screen.queryByText(/select a folder to view its sessions/i)).toBe(
      null,
    );
  });

  it("clicking an intermediate nav node expands it without selecting", () => {
    renderScanned([sess("a", "D:\\src\\csm")]);
    // D: auto-expanded -> "src" (nav) visible; its child "csm" not yet mounted.
    expect(screen.getByText("src")).toBeTruthy();
    expect(screen.queryByText("csm")).toBe(null);

    fireEvent.click(screen.getByText("src"));
    expect(screen.getByText("csm")).toBeTruthy();
    // Nav click expands, never selects: still no header, empty state remains.
    expect(
      screen.getByText(/select a folder to view its sessions/i),
    ).toBeTruthy();
  });

  it("pins the (unknown) group last and lets it be selected", () => {
    renderScanned([sess("a", "D:\\proj"), sess("u", "(unknown)")]);
    const tree = screen.getByRole("tree");
    const text = tree.textContent ?? "";
    expect(text.indexOf("(unknown)")).toBeGreaterThan(text.indexOf("D:"));

    fireEvent.click(screen.getByText("(unknown)"));
    expect(screen.getByText(/1 session/i)).toBeTruthy();
  });

  it("collapsing a root unmounts its subtree", () => {
    renderScanned([sess("a", "D:\\proj")]);
    expect(screen.getByText("proj")).toBeTruthy();
    // D: is a pure nav node -> a row click toggles it.
    fireEvent.click(screen.getByText("D:"));
    expect(screen.queryByText("proj")).toBe(null);
    fireEvent.click(screen.getByText("D:"));
    expect(screen.getByText("proj")).toBeTruthy();
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
    fireEvent.click(screen.getByText("proj"));
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
    renderScanned([sess("a", "D:\\src\\csm")]);
    fireEvent.click(screen.getByText("src"));
    // Intermediate nav folder carries no count.
    expect(within(rowFor("src")).queryByText("1")).toBe(null);
    // Leaf folder shows its own-session count.
    expect(within(rowFor("csm")).getByText("1")).toBeTruthy();
  });

  it("renders folder names as text, never as HTML", () => {
    renderScanned([sess("a", "D:\\<img src=x>")]);
    expect(screen.getByText("<img src=x>")).toBeTruthy();
    // The literal was inserted as text, so no real <img> element exists.
    expect(document.querySelector("img")).toBe(null);
  });
});
