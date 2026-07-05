import { test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BypassConfirmModal } from "../../src/renderer/components/BypassConfirmModal";
import type { SessionMetadata } from "../../src/sessionParser";

const session: SessionMetadata = {
  sessionId: "abcdefgh-1111-2222-3333-444455556666",
  cwd: "D:\\src\\csm",
  title: "Dangerous session",
  permissionMode: "bypassPermissions",
  lastActivity: null,
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
