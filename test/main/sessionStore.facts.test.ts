import { test, expect, describe, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../../src/sessionStore";
import type { SessionFacts } from "../../src/sessionParser";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

// Minimal session file: one assistant turn on Opus with 100 output tokens.
const body = (text: string) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text }],
      usage: { output_tokens: 100 },
    },
  });

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "csm-facts-"));
  const sub = join(root, "encoded-cwd");
  mkdirSync(sub);
  writeFileSync(join(sub, `${UUID}.jsonl`), body("hello"));
  return root;
}

describe("sessionStore.getFacts", () => {
  test("rejects a non-UUID id without touching the filesystem", async () => {
    const store = createSessionStore(fixtureRoot());
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    const res = await store.getFacts(["../../etc/passwd"]);
    expect(res["../../etc/passwd"]).toEqual({ error: true });
  });

  test("returns facts for a scanned session and caches by mtime:size", async () => {
    const root = fixtureRoot();
    const spy = vi.fn(
      (id: string, c: string) =>
        ({
          sessionId: id,
          messageCount: 1,
          firstActivity: null,
          lastActivity: null,
          editedFileCount: 0,
          firstModel: null,
          distinctModelCount: 0,
          outputTokens: c.length,
        }) as SessionFacts,
    );
    const store = createSessionStore(root, { extractFacts: spy });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });

    const a = await store.getFacts([UUID]);
    const b = await store.getFacts([UUID]);
    expect((a[UUID] as SessionFacts).messageCount).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1); // second call is a cache hit
    expect(b[UUID]).toBe(a[UUID]);
  });

  test("re-parses when the file grows (new size)", async () => {
    const root = fixtureRoot();
    const spy = vi.fn(
      (id: string) =>
        ({
          sessionId: id,
          messageCount: 1,
          firstActivity: null,
          lastActivity: null,
          editedFileCount: 0,
          firstModel: null,
          distinctModelCount: 0,
          outputTokens: 0,
        }) as SessionFacts,
    );
    const store = createSessionStore(root, { extractFacts: spy });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    await store.getFacts([UUID]);

    // Grow the file, then re-scan so the path map re-stats it.
    writeFileSync(
      join(root, "encoded-cwd", `${UUID}.jsonl`),
      body("hello") + "\n" + body("more"),
    );
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    await store.getFacts([UUID]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("returns error (not cached) for an unknown/vanished id", async () => {
    const store = createSessionStore(fixtureRoot());
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    const res = await store.getFacts([UUID2]);
    expect(res[UUID2]).toEqual({ error: true });
  });
});
