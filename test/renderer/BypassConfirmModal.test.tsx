import { test, expect, vi } from "vitest";
import { render, screen, fireEvent, createEvent } from "@testing-library/react";
import { BypassConfirmModal } from "../../src/renderer/components/BypassConfirmModal";
import type { SessionMetadata } from "../../src/sessionParser";

const session: SessionMetadata = {
  sessionId: "abcdefgh-1111-2222-3333-444455556666",
  cwd: "D:\\src\\csm",
  title: "Dangerous session",
  permissionMode: "bypassPermissions",
  lastActivity: null,
  gitBranch: null,
};

test("renders as a dialog that names the bypass consequence", () => {
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog");
  expect(dialog).toBeTruthy();
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  // Names the consequence: every tool call is auto-approved.
  expect(dialog.textContent?.toLowerCase()).toContain("auto-approve");
  // Shows the session title as text (never innerHTML).
  expect(screen.getByText("Dangerous session")).toBeTruthy();
});

test("the reopen-with-bypass button confirms with bypassPermissions", () => {
  const onConfirm = vi.fn();
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTestId("confirm-bypass"));
  expect(onConfirm).toHaveBeenCalledWith("bypassPermissions");
});

test("the downgrade button confirms with acceptEdits", () => {
  const onConfirm = vi.fn();
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={onConfirm}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTestId("confirm-downgrade"));
  expect(onConfirm).toHaveBeenCalledWith("acceptEdits");
});

test("the cancel button cancels without confirming", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  fireEvent.click(screen.getByTestId("confirm-cancel"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
});

test("initial focus lands on the safe downgrade action", () => {
  // #98 AC: after the button restructure, focus must still open on the safe
  // (acceptEdits downgrade) action, not the risky bypass — guards the ref
  // surviving the layout change.
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  expect(document.activeElement).toBe(screen.getByTestId("confirm-downgrade"));
});

test("Escape cancels the modal", () => {
  const onCancel = vi.fn();
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={vi.fn()}
      onCancel={onCancel}
    />,
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test("Tab cycles forward through the actions and wraps (focus trap, #70)", () => {
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog");
  const downgrade = screen.getByTestId("confirm-downgrade");
  const cancel = screen.getByTestId("confirm-cancel");
  const bypass = screen.getByTestId("confirm-bypass");

  // Initial focus is on the safe downgrade; Tab steps in DOM order and wraps.
  expect(document.activeElement).toBe(downgrade);
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(document.activeElement).toBe(bypass);
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(document.activeElement).toBe(downgrade); // wrapped
});

test("Shift+Tab cycles backward and wraps to the last action (focus trap, #70)", () => {
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog");
  const downgrade = screen.getByTestId("confirm-downgrade");
  const bypass = screen.getByTestId("confirm-bypass");

  expect(document.activeElement).toBe(downgrade);
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(bypass); // wrapped backward to the last
});

test("Tab is trapped: focus never lands outside the three actions (#70)", () => {
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog");
  const actions = new Set([
    screen.getByTestId("confirm-downgrade"),
    screen.getByTestId("confirm-cancel"),
    screen.getByTestId("confirm-bypass"),
  ]);
  // Many tabs in both directions — focus stays within the action set every step.
  for (let i = 0; i < 7; i++) {
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(actions.has(document.activeElement as HTMLElement)).toBe(true);
  }
  for (let i = 0; i < 7; i++) {
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(actions.has(document.activeElement as HTMLElement)).toBe(true);
  }
});

test("the Tab trap preventDefaults so the browser's own focus move is suppressed (#70)", () => {
  render(
    <BypassConfirmModal
      session={session}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  const dialog = screen.getByRole("dialog");
  const ev = createEvent.keyDown(dialog, { key: "Tab" });
  fireEvent(dialog, ev);
  expect(ev.defaultPrevented).toBe(true);
});
