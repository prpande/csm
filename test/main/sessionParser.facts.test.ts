import { test, expect, describe } from "vitest";
import { extractSessionFacts } from "../../src/sessionParser";

// Build a JSONL body from record objects (one JSON per line).
const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n");

const userPrompt = (text: string, ts?: string) => ({
  type: "user",
  ...(ts ? { timestamp: ts } : {}),
  message: { role: "user", content: text },
});
const toolResult = (ts?: string) => ({
  type: "user",
  ...(ts ? { timestamp: ts } : {}),
  message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
});
const assistant = (
  opts: { text?: string; model?: string; out?: number; edits?: string[]; reads?: string[]; ts?: string },
) => {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (const p of opts.edits ?? []) content.push({ type: "tool_use", name: "Edit", input: { file_path: p } });
  for (const p of opts.reads ?? []) content.push({ type: "tool_use", name: "Read", input: { file_path: p } });
  return {
    type: "assistant",
    ...(opts.ts ? { timestamp: opts.ts } : {}),
    message: {
      role: "assistant",
      ...(opts.model ? { model: opts.model } : {}),
      content,
      ...(opts.out !== undefined ? { usage: { output_tokens: opts.out, cache_read_input_tokens: 999 } } : {}),
    },
  };
};

describe("extractSessionFacts", () => {
  test("counts genuine turns, not tool plumbing", () => {
    const content = jsonl(
      userPrompt("hello"),
      assistant({ text: "hi" }),
      assistant({ edits: ["/a.ts"] }), // tool-use-only assistant: not a turn
      toolResult(), // tool_result user: not a turn
      userPrompt("again"),
    );
    expect(extractSessionFacts("s", content).messageCount).toBe(3);
  });

  test("firstModel skips synthetic; distinctModelCount counts real models", () => {
    const content = jsonl(
      assistant({ text: "x", model: "<synthetic>" }),
      assistant({ text: "y", model: "claude-sonnet-4-6" }),
      assistant({ text: "z", model: "claude-opus-4-8" }),
    );
    const f = extractSessionFacts("s", content);
    expect(f.firstModel).toBe("claude-sonnet-4-6");
    expect(f.distinctModelCount).toBe(2);
  });

  test("editedFileCount dedupes mutating tools and ignores reads", () => {
    const content = jsonl(
      assistant({ edits: ["/a.ts", "/a.ts"], reads: ["/b.ts"] }),
      { type: "assistant", message: { content: [{ type: "tool_use", name: "NotebookEdit", input: { notebook_path: "/n.ipynb" } }] } },
    );
    expect(extractSessionFacts("s", content).editedFileCount).toBe(2);
  });

  test("read-only session reports zero edited", () => {
    const content = jsonl(userPrompt("hi"), assistant({ text: "hi", reads: ["/a.ts"] }));
    expect(extractSessionFacts("s", content).editedFileCount).toBe(0);
  });

  test("sums output_tokens excluding cache-read", () => {
    const content = jsonl(assistant({ text: "a", out: 100 }), assistant({ text: "b", out: 250 }));
    expect(extractSessionFacts("s", content).outputTokens).toBe(350);
  });

  test("captures first/last activity from timestamps", () => {
    const content = jsonl(
      userPrompt("a", "2026-07-01T00:00:00Z"),
      assistant({ text: "b", ts: "2026-07-01T01:00:00Z" }),
    );
    const f = extractSessionFacts("s", content);
    expect(f.firstActivity).toBe("2026-07-01T00:00:00Z");
    expect(f.lastActivity).toBe("2026-07-01T01:00:00Z");
  });

  test("junk/malformed file yields a well-formed fallback, no throw", () => {
    const f = extractSessionFacts("s", "not json\n{bad\n");
    expect(f).toEqual({
      sessionId: "s", messageCount: 0, firstActivity: null, lastActivity: null,
      editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: 0,
    });
  });
});
