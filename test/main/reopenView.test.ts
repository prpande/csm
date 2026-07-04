import { test, expect } from "vitest";
import {
  needsBypassConfirm,
  reopenErrorMessage,
  DOWNGRADE_MODE,
  GENERIC_REOPEN_MESSAGE,
} from "../../src/reopenView";
import { REOPEN_ERROR_CODES } from "../../src/ipcTypes";
import type { PermissionMode } from "../../src/sessionParser";

test("needsBypassConfirm is true only for bypassPermissions", () => {
  const modes: PermissionMode[] = [
    "default",
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "dontAsk",
    "plan",
  ];
  for (const mode of modes) {
    expect(needsBypassConfirm(mode)).toBe(mode === "bypassPermissions");
  }
});

test("needsBypassConfirm handles an unrecognized/empty mode as no-confirm", () => {
  expect(needsBypassConfirm("")).toBe(false);
  expect(needsBypassConfirm("something-else")).toBe(false);
});

test("the safe downgrade target is acceptEdits", () => {
  expect(DOWNGRADE_MODE).toBe("acceptEdits");
});

test("FOLDER_MISSING maps to a specific folder-gone message", () => {
  const msg = reopenErrorMessage("FOLDER_MISSING");
  expect(msg.toLowerCase()).toContain("folder");
  expect(msg.toLowerCase()).toContain("no longer");
});

test("every other error code maps to the shared generic reopen-failed message", () => {
  for (const code of REOPEN_ERROR_CODES) {
    const msg = reopenErrorMessage(code);
    expect(typeof msg).toBe("string");
    expect(msg.length).toBeGreaterThan(0);
    if (code !== "FOLDER_MISSING") {
      // Assert against the exported constant, not a value re-derived from the
      // function under test, so wrong-but-consistent copy would still fail.
      expect(msg).toBe(GENERIC_REOPEN_MESSAGE);
    } else {
      expect(msg).not.toBe(GENERIC_REOPEN_MESSAGE);
    }
  }
});

test("no error message leaks a path or raw error string", () => {
  for (const code of REOPEN_ERROR_CODES) {
    const msg = reopenErrorMessage(code);
    // Sanity: the messages are short, human-facing, and contain no path chars.
    expect(msg).not.toContain("\\");
    expect(msg).not.toContain("/");
  }
});
