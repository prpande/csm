import { describe, it, expect } from "vitest";
import {
  DEFAULT_NEW_SESSION_MODE,
  PERMISSION_MODE_OPTIONS,
  isBypassMode,
  newSessionErrorMessage,
} from "../../src/renderer/newSessionView";
import { KNOWN_PERMISSION_MODES } from "../../src/sessionParser";

// Pure view helpers for the new-session launcher (#165). No DOM — plain vitest.

describe("PERMISSION_MODE_OPTIONS", () => {
  const values = PERMISSION_MODE_OPTIONS.map((o) => o.value);

  it("offers exactly the parser's known modes, default first, bypass last", () => {
    expect(new Set(values)).toEqual(KNOWN_PERMISSION_MODES);
    expect(values[0]).toBe("default");
    expect(values[values.length - 1]).toBe("bypassPermissions");
  });

  it("has the default mode present in the list", () => {
    expect(values).toContain(DEFAULT_NEW_SESSION_MODE);
  });
});

describe("isBypassMode", () => {
  it("is true only for bypassPermissions", () => {
    expect(isBypassMode("bypassPermissions")).toBe(true);
    expect(isBypassMode("default")).toBe(false);
    expect(isBypassMode("acceptEdits")).toBe(false);
  });
});

describe("newSessionErrorMessage", () => {
  it("shows the display-safe detail for INVALID_ARGS", () => {
    expect(
      newSessionErrorMessage({
        ok: false,
        code: "INVALID_ARGS",
        detail: "argument contains a cmd.exe metacharacter: a&b",
      }),
    ).toBe("Invalid arguments: argument contains a cmd.exe metacharacter: a&b");
  });

  it("falls back to a generic message when INVALID_ARGS has no detail", () => {
    expect(newSessionErrorMessage({ ok: false, code: "INVALID_ARGS" })).toBe(
      "Those arguments aren't valid.",
    );
  });

  it("maps the other codes to fixed strings (no path leak)", () => {
    expect(newSessionErrorMessage({ ok: false, code: "FOLDER_MISSING" })).toBe(
      "That folder no longer exists.",
    );
    expect(newSessionErrorMessage({ ok: false, code: "UNSUPPORTED_OS" })).toBe(
      "Launching sessions isn't supported on this OS.",
    );
    expect(newSessionErrorMessage({ ok: false, code: "SPAWN_FAILED" })).toBe(
      "Couldn't start a new session.",
    );
    expect(newSessionErrorMessage({ ok: false, code: "UNSAFE_PATH" })).toBe(
      "Couldn't start a new session.",
    );
  });
});
