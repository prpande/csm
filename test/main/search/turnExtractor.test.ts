// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  emptySessionFields,
  extractTurn,
  mergeRecordFields,
  recordTimestamp,
} from "../../../src/search/turnExtractor";
import { TITLE_MAX_LENGTH } from "../../../src/sessionParser";

const user = (content: unknown, extra: object = {}) => ({
  type: "user",
  uuid: "u1",
  timestamp: "2026-10-01T10:00:00.000Z",
  message: { role: "user", content },
  ...extra,
});
const assistant = (content: unknown[], extra: object = {}) => ({
  type: "assistant",
  uuid: "a1",
  timestamp: "2026-10-01T10:00:01.000Z",
  message: { role: "assistant", content },
  ...extra,
});

describe("extractTurn", () => {
  test("a real prompt becomes a user turn", () => {
    expect(extractTurn(user("  Fix getUserName  "))).toEqual({
      uuid: "u1",
      role: "user",
      ts: Date.parse("2026-10-01T10:00:00.000Z"),
      text: "Fix getUserName",
      searchText: "fix getusername\nget user name",
    });
  });

  test("meta, wrapper and tool_result-only user records are not turns", () => {
    expect(extractTurn(user("x", { isMeta: true }))).toBeUndefined();
    expect(extractTurn(user("<command-name>/clear"))).toBeUndefined();
    expect(
      extractTurn(
        user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
      ),
    ).toBeUndefined();
  });

  test("assistant text blocks are joined; tool_use and thinking are excluded", () => {
    const turn = extractTurn(
      assistant([
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "First" },
        { type: "tool_use", id: "t", name: "Bash", input: { command: "ls" } },
        { type: "text", text: "Second" },
      ]),
    );
    expect(turn?.role).toBe("assistant");
    expect(turn?.text).toBe("First\n\nSecond");
  });

  test("an assistant record with no text is not a turn", () => {
    expect(
      extractTurn(assistant([{ type: "thinking", thinking: "x" }])),
    ).toBeUndefined();
  });

  test("missing uuid and bad timestamp become null", () => {
    const turn = extractTurn({
      ...user("hi"),
      uuid: undefined,
      timestamp: "nope",
    });
    expect(turn?.uuid).toBeNull();
    expect(turn?.ts).toBeNull();
  });

  test("other record types are not turns", () => {
    expect(extractTurn({ type: "pr-link" })).toBeUndefined();
  });
});

describe("mergeRecordFields", () => {
  test("first cwd, last non-empty branch, max timestamp", () => {
    const f = emptySessionFields();
    mergeRecordFields(f, {
      cwd: "/a",
      gitBranch: "main",
      timestamp: "2026-10-01T10:00:05Z",
    });
    mergeRecordFields(f, {
      cwd: "/b",
      gitBranch: "",
      timestamp: "2026-10-01T10:00:01Z",
    });
    mergeRecordFields(f, {
      gitBranch: "feat",
      timestamp: "2026-10-01T10:00:03Z",
    });
    expect(f.cwd).toBe("/a");
    expect(f.branch).toBe("feat");
    expect(f.lastActivity).toBe(Date.parse("2026-10-01T10:00:05Z"));
  });

  test("custom-title last-wins, ai-title and summary first-wins, all values kept distinct", () => {
    const f = emptySessionFields();
    for (const rec of [
      { type: "ai-title", aiTitle: "AI one" },
      { type: "ai-title", aiTitle: "AI two" },
      { type: "summary", summary: "Sum" },
      { type: "custom-title", customTitle: "a" },
      { type: "custom-title", customTitle: "b" },
      { type: "custom-title", customTitle: "a" },
    ])
      mergeRecordFields(f, rec);
    expect(f.aiTitle).toBe("AI one");
    expect(f.summaryTitle).toBe("Sum");
    expect(f.customTitle).toBe("a");
    expect(f.titleValues).toEqual(["AI one", "AI two", "Sum", "a", "b"]);
  });

  test("first eligible prompt is kept, truncated", () => {
    const f = emptySessionFields();
    mergeRecordFields(f, user("<system-reminder>skip"));
    mergeRecordFields(f, user("y".repeat(TITLE_MAX_LENGTH + 5)));
    mergeRecordFields(f, user("later"));
    expect(f.firstPrompt).toBe("y".repeat(TITLE_MAX_LENGTH) + "…");
  });
});

test("recordTimestamp parses ISO strings only", () => {
  expect(recordTimestamp({ timestamp: "2026-10-01T00:00:00Z" })).toBe(
    Date.parse("2026-10-01T00:00:00Z"),
  );
  expect(recordTimestamp({ timestamp: 5 })).toBeNull();
});
