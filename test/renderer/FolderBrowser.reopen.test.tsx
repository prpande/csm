import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FolderBrowser } from "../../src/renderer/components/FolderBrowser";
import type { SessionMetadata } from "../../src/sessionParser";
import type { SessionsListener } from "../../src/ipcTypes";

// Seed the streaming bridge to emit one session synchronously, then complete.
function seedOneSession(session: SessionMetadata) {
  window.csm!.listSessions = vi.fn((listener: SessionsListener) => {
    listener.onBatch([session]);
    listener.onDone();
    return () => {};
  });
}

const bypassSession: SessionMetadata = {
  sessionId: "abcdefgh-1111-2222-3333-444455556666",
  cwd: "D:\\reopen-test",
  title: "Bypass session title",
  permissionMode: "bypassPermissions",
  lastActivity: null,
};

// Click the selectable folder in the sidebar tree (the one carrying sessions).
function selectFolder() {
  const selectable = screen
    .getAllByRole("treeitem")
    .find((el) => el.getAttribute("aria-selected") !== null);
  expect(selectable).toBeTruthy();
  fireEvent.click(selectable!.querySelector("div")!);
}

test("double-clicking a bypass row opens the confirm modal; confirm reopens with bypassPermissions", async () => {
  const reopen = vi.fn(async () => ({ ok: true as const }));
  seedOneSession(bypassSession);
  window.csm!.reopenSession = reopen;

  await act(async () => {
    render(<FolderBrowser />);
  });
  selectFolder();

  // No modal until the open gesture.
  expect(screen.queryByRole("dialog")).toBe(null);
  fireEvent.doubleClick(screen.getByText("Bypass session title"));

  // Modal appears; the bridge has NOT been called yet.
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(reopen).not.toHaveBeenCalled();

  await act(async () => {
    fireEvent.click(screen.getByTestId("confirm-bypass"));
  });

  expect(reopen).toHaveBeenCalledWith({
    cwd: "D:\\reopen-test",
    sessionId: "abcdefgh-1111-2222-3333-444455556666",
    mode: "bypassPermissions",
  });
  // Modal dismissed after confirm.
  expect(screen.queryByRole("dialog")).toBe(null);
});

test("cancelling the confirm modal does not call the bridge", async () => {
  const reopen = vi.fn(async () => ({ ok: true as const }));
  seedOneSession(bypassSession);
  window.csm!.reopenSession = reopen;

  await act(async () => {
    render(<FolderBrowser />);
  });
  selectFolder();
  fireEvent.doubleClick(screen.getByText("Bypass session title"));
  fireEvent.click(screen.getByTestId("confirm-cancel"));

  expect(reopen).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBe(null);
});
