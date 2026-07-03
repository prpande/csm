import { test, expect, describe } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLaunchSpec } from "../../src/terminalLauncher";

// terminalLauncher's pure core: buildLaunchSpec turns (os, cwd, sessionId, mode,
// claudePath) into the OS-specific argv that reopens a session in a new terminal.
// Its whole purpose is to make command injection impossible, so the escaping /
// validation tests ARE the point of this unit (spec §5). Pure — no I/O, no spawn.

const ID = "877f5cdd-0250-4ced-bcc6-b44cf0b2ade2"; // valid v4
const CWD = "/Users/me/proj";
const CLAUDE = "claude";
const MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

// Reverse the AppleScript double-quoted-literal escaping (\\ -> \, \" -> ") so we
// can inspect what Terminal.app's shell actually receives. Not a mirror of the
// builder — it decodes the *outer* layer only, to prove the inner shell line.
function decodeAppleScriptLiteral(script: string): string {
  const m = script.match(/^tell application "Terminal" to do script "(.*)"$/s);
  if (!m) throw new Error(`unexpected osascript shape: ${script}`);
  return m[1].replace(/\\(["\\])/g, "$1");
}

describe("win32 — wt.exe", () => {
  test("builds the exact new-tab argv", () => {
    expect(buildLaunchSpec("win32", CWD, ID, "default", CLAUDE)).toEqual({
      file: "wt.exe",
      args: [
        "new-tab",
        "-d",
        CWD,
        CLAUDE,
        "--resume",
        ID,
        "--permission-mode",
        "default",
      ],
    });
  });

  // new-tab must lead, else wt parses --resume/--permission-mode as its own options.
  test("new-tab is args[0]", () => {
    expect(buildLaunchSpec("win32", CWD, ID, "default", CLAUDE).args[0]).toBe(
      "new-tab",
    );
  });
});

describe("darwin — osascript", () => {
  test("builds osascript -e with a Terminal do script", () => {
    const spec = buildLaunchSpec("darwin", CWD, ID, "default", CLAUDE);
    expect(spec.file).toBe("osascript");
    expect(spec.args[0]).toBe("-e");
    expect(decodeAppleScriptLiteral(spec.args[1])).toBe(
      `cd '/Users/me/proj' && 'claude' --resume ${ID} --permission-mode default`,
    );
  });
});

describe("permissionMode pass-through (both OSes)", () => {
  test.each(MODES)("win32 emits %s verbatim", (mode) => {
    const { args } = buildLaunchSpec("win32", CWD, ID, mode, CLAUDE);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe(mode);
  });

  test.each(MODES)("darwin emits %s verbatim", (mode) => {
    const spec = buildLaunchSpec("darwin", CWD, ID, mode, CLAUDE);
    expect(decodeAppleScriptLiteral(spec.args[1])).toContain(
      `--permission-mode ${mode}`,
    );
  });
});

describe("sessionId UUID gate", () => {
  test.each([
    "../../etc",
    "a; rm -rf ~",
    "",
    "not-a-uuid",
    "877F5CDD-0250-4CED-7BC6-B44CF0B2ADE2", // bad variant (7)
    `${ID}\n; rm -rf ~`, // valid-looking prefix + newline payload
  ])("rejects %j", (bad) => {
    // Gate runs in assertValidInputs before the OS switch, so win32 suffices
    // (matches the mode / cwd / claudePath gate blocks below).
    expect(() =>
      buildLaunchSpec("win32", CWD, bad, "default", CLAUDE),
    ).toThrow();
  });

  test.each([
    "877f5cdd-0250-4ced-bcc6-b44cf0b2ade2", // v4
    "f47ac10b-58cc-1372-a567-0e02b2c3d479", // v1, RFC-4122
    "877F5CDD-0250-4CED-BCC6-B44CF0B2ADE2", // uppercase v4
  ])("accepts %s", (good) => {
    expect(() =>
      buildLaunchSpec("win32", CWD, good, "default", CLAUDE),
    ).not.toThrow();
  });
});

describe("mode allowlist gate", () => {
  test.each(["root", "auto; calc", "", "Default", "acceptedits"])(
    "rejects %j",
    (bad) => {
      expect(() => buildLaunchSpec("win32", CWD, ID, bad, CLAUDE)).toThrow();
    },
  );
});

describe("cwd / claudePath sanity gate", () => {
  test("rejects empty cwd", () => {
    expect(() => buildLaunchSpec("win32", "", ID, "default", CLAUDE)).toThrow();
  });
  test("rejects empty claudePath", () => {
    expect(() => buildLaunchSpec("win32", CWD, ID, "default", "")).toThrow();
  });
  test.each(["\n", "\r", "\t", "\x00"])(
    "rejects control char %j in cwd",
    (ctrl) => {
      const bad = `/Users/me/pr${ctrl}oj`;
      expect(() =>
        buildLaunchSpec("darwin", bad, ID, "default", CLAUDE),
      ).toThrow();
    },
  );
  test.each(["\n", "\r", "\t", "\x00"])(
    "rejects control char %j in claudePath",
    (ctrl) => {
      const bad = `cla${ctrl}ude`;
      expect(() =>
        buildLaunchSpec("darwin", CWD, ID, "default", bad),
      ).toThrow();
    },
  );
});

describe("macOS injection / escaping (highest-risk surface)", () => {
  const HAZARDS = [
    `/x" & (do shell script "rm -rf ~") & "`,
    `/a"b`,
    `/a\\b`,
    "/a`b`",
    "/a$b",
    "/a;b",
    "/a|b",
    "/a&b",
    "/a b",
    "/it's",
    `/Users/it's a "project"/src`, // BOTH ' and "
    "\\\\server\\share",
    "/Users/josé/项目",
  ];

  test.each(HAZARDS)("cwd %j cannot break out of the AS literal", (cwd) => {
    const spec = buildLaunchSpec("darwin", cwd, ID, "default", CLAUDE);
    const body = spec.args[1].match(/do script "(.*)"$/s)![1];
    // After removing every escaped pair (\\ or \"), no bare " may remain — a bare
    // " would terminate the literal early and enable AppleScript injection.
    expect(body.replace(/\\[\\"]/g, "")).not.toContain('"');
    // And the shell actually receives a single-quote-wrapped cd argument.
    expect(decodeAppleScriptLiteral(spec.args[1])).toMatch(/^cd '/);
  });

  test("composition order: single-quote wrap THEN AS-escape (doubled backslash)", () => {
    // cwd with a single quote -> shell wrap yields '\'' -> AS-escape doubles the
    // backslash -> the emitted -e string must contain '\\''. Reversed order would
    // leave a single backslash and mis-decode.
    const spec = buildLaunchSpec("darwin", "/it's", ID, "default", CLAUDE);
    expect(spec.args[1]).toContain("'\\\\''");
  });

  test.each(["/opt/my claude/claude", "/opt/cla&ude"])(
    "claudePath %j is single-quote wrapped",
    (claudePath) => {
      const spec = buildLaunchSpec("darwin", CWD, ID, "default", claudePath);
      expect(decodeAppleScriptLiteral(spec.args[1])).toContain(
        `&& '${claudePath}' --resume`,
      );
    },
  );
});

describe("win32 injection / no-op (argv array guarantee)", () => {
  test.each([
    `/x" & (do shell script "rm -rf ~") & "`,
    "/a b",
    "/a&b",
    "\\\\server\\share",
    "/Users/josé/项目",
  ])("cwd %j is exactly one unmodified argv element", (cwd) => {
    const { args } = buildLaunchSpec("win32", cwd, ID, "default", CLAUDE);
    expect(args.filter((a) => a === cwd)).toHaveLength(1);
  });

  test("claudePath with a space stays one argv element", () => {
    const claudePath = "C:\\Program Files\\claude\\claude.exe";
    const { args } = buildLaunchSpec("win32", CWD, ID, "default", claudePath);
    expect(args.filter((a) => a === claudePath)).toHaveLength(1);
  });
});

describe("unsupported OS", () => {
  test("throws on linux", () => {
    expect(() =>
      // @ts-expect-error — exercising the runtime guard for a non-LaunchOS value.
      buildLaunchSpec("linux", CWD, ID, "default", CLAUDE),
    ).toThrow();
  });
});

describe("purity", () => {
  test("imports no child_process / fs / os / electron", () => {
    // vitest runs with cwd at the project root; resolve the source from there.
    const src = readFileSync(
      join(process.cwd(), "src", "terminalLauncher.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from\s+["']node:(child_process|fs|os)["']/);
    expect(src).not.toMatch(/from\s+["']electron["']/);
  });
});
