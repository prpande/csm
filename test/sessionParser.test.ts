import { test, expect } from "vitest";
import {
  parseSession,
  TITLE_MAX_LENGTH,
  type SessionMetadata,
} from "../src/sessionParser";

// Fixtures are JSONL strings — one record per line — mirroring the real record
// shapes verified against ~/.claude/projects/**: `ai-title`, `summary`,
// `permission-mode`, `mode`, `user` (message.content is a string OR a block
// array), `system` (carries cwd/timestamp/version/messageCount). The parser is
// pure (text in, metadata out), so tests need no fs and no Electron.

const SID = "0fbd7307-e9a9-457d-9a91-233db62ab886";
const jsonl = (...records: unknown[]): string =>
  records.map((r) => JSON.stringify(r)).join("\n");

test("happy path: extracts every field", () => {
  const content = jsonl(
    {
      type: "system",
      subtype: "init",
      cwd: "D:\\src\\PRism",
      version: "2.1.153",
      messageCount: 124,
      timestamp: "2026-05-29T02:00:16.047Z",
      gitBranch: "main",
      sessionId: SID,
    },
    { type: "ai-title", aiTitle: "Align UI with design", sessionId: SID },
    { type: "permission-mode", permissionMode: "acceptEdits", sessionId: SID },
    {
      type: "permission-mode",
      permissionMode: "bypassPermissions",
      sessionId: SID,
    },
    {
      type: "user",
      message: { role: "user", content: "do the thing" },
      timestamp: "2026-05-29T02:05:00.000Z",
      sessionId: SID,
    },
  );
  expect(parseSession(SID, content)).toEqual<SessionMetadata>({
    sessionId: SID,
    cwd: "D:\\src\\PRism",
    title: "Align UI with design",
    permissionMode: "bypassPermissions",
    lastActivity: "2026-05-29T02:05:00.000Z",
    gitBranch: "main",
    version: "2.1.153",
    messageCount: 124,
  });
});

test("cwd falls back to (unknown) when no record carries one", () => {
  const content = jsonl({ type: "ai-title", aiTitle: "x", sessionId: SID });
  expect(parseSession(SID, content).cwd).toBe("(unknown)");
});

test("title: ai-title wins over summary and prompts", () => {
  const content = jsonl(
    { type: "summary", summary: "a summary" },
    { type: "user", message: { role: "user", content: "a prompt" } },
    { type: "ai-title", aiTitle: "the ai title" },
  );
  expect(parseSession(SID, content).title).toBe("the ai title");
});

test("title: summary used when no ai-title", () => {
  const content = jsonl(
    { type: "user", message: { role: "user", content: "a prompt" } },
    { type: "summary", summary: "a summary" },
  );
  expect(parseSession(SID, content).title).toBe("a summary");
});

test("title: first eligible user prompt when no ai-title/summary, truncated", () => {
  const long = "x".repeat(TITLE_MAX_LENGTH + 50);
  const content = jsonl({
    type: "user",
    message: { role: "user", content: long },
  });
  const title = parseSession(SID, content).title;
  expect(title.length).toBe(TITLE_MAX_LENGTH + 1); // + ellipsis char
  expect(title.endsWith("…")).toBe(true);
  expect(title.startsWith("x".repeat(TITLE_MAX_LENGTH))).toBe(true);
});

test("title: truncation keeps a multibyte char intact at the boundary (no lone surrogate)", () => {
  // 119 ASCII code points + one emoji = the 120th code point; the emoji occupies
  // UTF-16 units 120-121, so a code-UNIT slice(0,120) would split its surrogate
  // pair and leave a lone high surrogate. Code-POINT truncation keeps it whole.
  const prompt = "x".repeat(TITLE_MAX_LENGTH - 1) + "😀" + "yyyy";
  const title = parseSession(
    SID,
    jsonl({ type: "user", message: { role: "user", content: prompt } }),
  ).title;
  expect(title).toBe("x".repeat(TITLE_MAX_LENGTH - 1) + "😀" + "…");
  expect(title).toContain("😀"); // full emoji survived
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false); // no lone high surrogate
});

test("title: short prompt is used verbatim (trimmed, no ellipsis)", () => {
  const content = jsonl({
    type: "user",
    message: { role: "user", content: "  short prompt  " },
  });
  expect(parseSession(SID, content).title).toBe("short prompt");
});

test("title: skips meta / system-reminder / command-wrapper / tool_result prompts", () => {
  const content = jsonl(
    // isMeta wrapper (skill injection) — skipped
    {
      type: "user",
      isMeta: true,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Base directory for this skill: C:\\x" },
        ],
      },
    },
    // tool_result — skipped
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }],
      },
    },
    // system-reminder text block — skipped
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "<system-reminder>hi</system-reminder>" },
        ],
      },
    },
    // command wrapper string — skipped
    {
      type: "user",
      message: { role: "user", content: "<command-name>/foo</command-name>" },
    },
    // caveat wrapper — skipped
    {
      type: "user",
      message: {
        role: "user",
        content: "Caveat: The messages below were generated...",
      },
    },
    // the first REAL prompt — used
    {
      type: "user",
      message: { role: "user", content: "the real first prompt" },
    },
  );
  expect(parseSession(SID, content).title).toBe("the real first prompt");
});

test("title: (untitled) when nothing eligible", () => {
  const content = jsonl(
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "meta only" },
    },
    { type: "assistant", message: { role: "assistant", content: "hi" } },
  );
  expect(parseSession(SID, content).title).toBe("(untitled)");
});

// --- custom-title (session rename via /rename) composes with the descriptor (#176) ---

test("title: custom name leads, ai-title descriptor follows", () => {
  const content = jsonl(
    { type: "custom-title", customTitle: "my-label" },
    { type: "ai-title", aiTitle: "Align UI with design" },
  );
  expect(parseSession(SID, content).title).toBe(
    "my-label — Align UI with design",
  );
});

test("title: custom name composes with the first-prompt descriptor too", () => {
  const content = jsonl(
    { type: "custom-title", customTitle: "my-label" },
    {
      type: "user",
      message: { role: "user", content: "the real first prompt" },
    },
  );
  expect(parseSession(SID, content).title).toBe(
    "my-label — the real first prompt",
  );
});

test("title: custom name alone when there is no descriptor (no trailing separator)", () => {
  const content = jsonl(
    { type: "custom-title", customTitle: "my-label" },
    // only ineligible prompts — nothing to derive a descriptor from
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "meta only" },
    },
  );
  const title = parseSession(SID, content).title;
  expect(title).toBe("my-label");
  expect(title).not.toContain("—");
  expect(title).not.toContain("(untitled)");
});

test("title: last custom-title wins across repeated renames", () => {
  const content = jsonl(
    { type: "custom-title", customTitle: "old-name" },
    { type: "ai-title", aiTitle: "a descriptor" },
    { type: "custom-title", customTitle: "new-name" },
  );
  expect(parseSession(SID, content).title).toBe("new-name — a descriptor");
});

test("title: a blank/whitespace custom-title is ignored (descriptor stands alone)", () => {
  const content = jsonl(
    { type: "custom-title", customTitle: "   " },
    { type: "ai-title", aiTitle: "a descriptor" },
  );
  expect(parseSession(SID, content).title).toBe("a descriptor");
});

test("title: composite obeys the 120 budget — name kept, descriptor truncated", () => {
  const name = "N".repeat(10);
  const prompt = "x".repeat(TITLE_MAX_LENGTH + 200);
  const content = jsonl(
    { type: "custom-title", customTitle: name },
    { type: "user", message: { role: "user", content: prompt } },
  );
  const title = parseSession(SID, content).title;
  // At most the 120-code-point budget plus the single ellipsis (mirrors tier 3).
  expect([...title].length).toBeLessThanOrEqual(TITLE_MAX_LENGTH + 1);
  expect(title.endsWith("…")).toBe(true);
  expect(title.startsWith(name + " — ")).toBe(true); // name survives in full
});

test("title: a name longer than the whole budget truncates to the name, no dangling separator", () => {
  const name = "N".repeat(TITLE_MAX_LENGTH + 30);
  const content = jsonl(
    { type: "custom-title", customTitle: name },
    { type: "ai-title", aiTitle: "a descriptor" },
  );
  const title = parseSession(SID, content).title;
  expect([...title].length).toBe(TITLE_MAX_LENGTH + 1); // 120 + ellipsis
  expect(title.endsWith("…")).toBe(true);
  expect(title).not.toContain("—"); // descriptor dropped, no separator left hanging
});

test("title: composite truncation keeps a multibyte char intact at the boundary", () => {
  // "N — " is 4 code points; pad so the 120th code point is the emoji, which a
  // code-UNIT slice would split. Code-POINT truncation of the composite keeps it.
  const prompt = "x".repeat(TITLE_MAX_LENGTH - 4 - 1) + "😀" + "tail";
  const content = jsonl(
    { type: "custom-title", customTitle: "N" },
    { type: "user", message: { role: "user", content: prompt } },
  );
  const title = parseSession(SID, content).title;
  expect(title).toBe("N — " + "x".repeat(TITLE_MAX_LENGTH - 5) + "😀" + "…");
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false); // no lone surrogate
});

test("permissionMode: last permission-mode record wins", () => {
  const content = jsonl(
    { type: "permission-mode", permissionMode: "plan" },
    { type: "permission-mode", permissionMode: "acceptEdits" },
    { type: "permission-mode", permissionMode: "auto" },
  );
  expect(parseSession(SID, content).permissionMode).toBe("auto");
});

test("permissionMode: every recognized CLI value passes through (esp. auto)", () => {
  for (const mode of [
    "default",
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "dontAsk",
    "plan",
  ]) {
    const content = jsonl({ type: "permission-mode", permissionMode: mode });
    expect(parseSession(SID, content).permissionMode).toBe(mode);
  }
});

test("permissionMode: unrecognized/absent -> default; {type:mode} ignored", () => {
  expect(
    parseSession(SID, jsonl({ type: "mode", mode: "plan" })).permissionMode,
  ).toBe("default");
  expect(
    parseSession(
      SID,
      jsonl({ type: "permission-mode", permissionMode: "bogus" }),
    ).permissionMode,
  ).toBe("default");
  expect(
    parseSession(SID, jsonl({ type: "ai-title", aiTitle: "x" })).permissionMode,
  ).toBe("default");
});

test("lastActivity: last timestamped record's ISO; null when none", () => {
  const content = jsonl(
    {
      type: "user",
      message: { role: "user", content: "a" },
      timestamp: "2026-05-29T02:00:00.000Z",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: "b" },
      timestamp: "2026-05-29T03:00:00.000Z",
    },
    { type: "permission-mode", permissionMode: "auto" }, // no timestamp — must not clobber
  );
  expect(parseSession(SID, content).lastActivity).toBe(
    "2026-05-29T03:00:00.000Z",
  );
  expect(
    parseSession(SID, jsonl({ type: "ai-title", aiTitle: "x" })).lastActivity,
  ).toBeNull();
});

test("malformed/blank lines are skipped; all-junk file -> full-fallback object", () => {
  const content = [
    "",
    "not json at all",
    "{ broken json",
    JSON.stringify({ type: "ai-title", aiTitle: "survived" }),
    "   ",
    "}{",
  ].join("\n");
  const meta = parseSession(SID, content);
  expect(meta.title).toBe("survived");

  const junk = parseSession(SID, "garbage\n{oops\n\n");
  expect(junk).toEqual<SessionMetadata>({
    sessionId: SID,
    cwd: "(unknown)",
    title: "(untitled)",
    permissionMode: "default",
    lastActivity: null,
    gitBranch: null,
  });
});

test("optional version/messageCount omitted when absent", () => {
  const meta = parseSession(SID, jsonl({ type: "ai-title", aiTitle: "x" }));
  expect("version" in meta).toBe(false);
  expect("messageCount" in meta).toBe(false);
});

test("empty content -> full-fallback object", () => {
  expect(parseSession(SID, "")).toEqual<SessionMetadata>({
    sessionId: SID,
    cwd: "(unknown)",
    title: "(untitled)",
    permissionMode: "default",
    lastActivity: null,
    gitBranch: null,
  });
});

test("gitBranch: last non-empty gitBranch wins; blank does not clobber", () => {
  const content = jsonl(
    {
      type: "user",
      message: { role: "user", content: "a" },
      gitBranch: "main",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: "b" },
      gitBranch: "worktree-81-preload-bundle",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: "c" },
      gitBranch: "  ",
    },
    { type: "permission-mode", permissionMode: "auto" }, // no gitBranch — must not clobber
  );
  expect(parseSession(SID, content).gitBranch).toBe(
    "worktree-81-preload-bundle",
  );
});

test("gitBranch: null when no record carries one (or all blank)", () => {
  expect(
    parseSession(SID, jsonl({ type: "ai-title", aiTitle: "x" })).gitBranch,
  ).toBeNull();
  expect(
    parseSession(
      SID,
      jsonl({
        type: "user",
        message: { role: "user", content: "a" },
        gitBranch: "",
      }),
    ).gitBranch,
  ).toBeNull();
});
