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

function seedEmptyScan() {
  window.csm!.listSessions = vi.fn((listener: SessionsListener) => {
    listener.onDone();
    return () => {};
  });
}

const plainSession: SessionMetadata = {
  sessionId: "abcdefgh-1111-2222-3333-444455556666",
  cwd: "D:\\settings-test",
  title: "Plain session title",
  permissionMode: "default",
  lastActivity: null,
  gitBranch: null,
};

const bypassSession: SessionMetadata = {
  ...plainSession,
  title: "Bypass session title",
  permissionMode: "bypassPermissions",
};

// Click the selectable folder in the sidebar tree (the one carrying sessions).
function selectFolder() {
  const selectable = screen
    .getAllByRole("treeitem")
    .find((el) => el.getAttribute("aria-selected") !== null);
  expect(selectable).toBeTruthy();
  fireEvent.click(selectable!.querySelector("div")!);
}

async function openSettings() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Settings"));
  });
}

test("the title-bar gear opens the settings dialog", async () => {
  seedEmptyScan();
  await act(async () => {
    render(<FolderBrowser />);
  });
  expect(screen.queryByRole("dialog")).toBe(null);
  await openSettings();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("Claude executable path")).toBeTruthy();
});

test("save closes the dialog and shows the confirmation toast", async () => {
  seedEmptyScan();
  await act(async () => {
    render(<FolderBrowser />);
  });
  await openSettings();
  await act(async () => {
    fireEvent.click(screen.getByTestId("settings-save"));
  });
  expect(screen.queryByRole("dialog")).toBe(null);
  expect(window.csm!.setClaudePath).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status").textContent).toContain(
    "Claude path saved.",
  );
});

test("cancel closes the dialog without persisting and without a toast", async () => {
  seedEmptyScan();
  await act(async () => {
    render(<FolderBrowser />);
  });
  await openSettings();
  fireEvent.click(screen.getByTestId("settings-cancel"));
  expect(screen.queryByRole("dialog")).toBe(null);
  expect(window.csm!.setClaudePath).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBe(null);
});

test("a live reopen-error toast is replaced by the save confirmation (newest wins)", async () => {
  seedOneSession(plainSession);
  window.csm!.reopenSession = vi.fn(async () => ({
    ok: false as const,
    code: "SPAWN_FAILED" as const,
  }));
  await act(async () => {
    render(<FolderBrowser />);
  });
  selectFolder();
  await act(async () => {
    fireEvent.doubleClick(screen.getByText("Plain session title"));
  });
  const errorText = screen.getByRole("status").textContent;
  expect(errorText).toBeTruthy();
  expect(errorText).not.toContain("Claude path saved.");

  await openSettings();
  await act(async () => {
    fireEvent.click(screen.getByTestId("settings-save"));
  });
  const statuses = screen.getAllByRole("status");
  expect(statuses.length).toBe(1);
  expect(statuses[0].textContent).toContain("Claude path saved.");
});

test("the gear is inert while the bypass confirmation is pending", async () => {
  seedOneSession(bypassSession);
  await act(async () => {
    render(<FolderBrowser />);
  });
  selectFolder();
  fireEvent.doubleClick(screen.getByText("Bypass session title"));
  expect(screen.getByTestId("confirm-bypass")).toBeTruthy();

  await openSettings();
  expect(screen.getByTestId("confirm-bypass")).toBeTruthy();
  expect(screen.queryByTestId("settings-save")).toBe(null);
});

test("row open gestures are inert while the settings modal is open", async () => {
  seedOneSession(plainSession);
  await act(async () => {
    render(<FolderBrowser />);
  });
  selectFolder();
  await openSettings();
  await act(async () => {
    fireEvent.doubleClick(screen.getByText("Plain session title"));
  });
  expect(window.csm!.reopenSession).not.toHaveBeenCalled();
  expect(screen.queryByTestId("confirm-bypass")).toBe(null);
});
