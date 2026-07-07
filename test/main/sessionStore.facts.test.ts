import { test, expect, describe, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../../src/sessionStore";
import type { SessionFacts } from "../../src/sessionParser";
import { createSessionIndex } from "../../src/sessionIndex";

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

const createdRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "csm-facts-"));
  createdRoots.push(root);
  const sub = join(root, "encoded-cwd");
  mkdirSync(sub);
  writeFileSync(join(sub, `${UUID}.jsonl`), body("hello"));
  return root;
}

// Remove the temp dirs fixtureRoot created so test runs don't leak them.
afterEach(() => {
  while (createdRoots.length > 0) {
    rmSync(createdRoots.pop()!, { recursive: true, force: true });
  }
});

describe("sessionStore.getFacts", () => {
  test("rejects a non-UUID id without touching the filesystem", async () => {
    const store = createSessionStore(fixtureRoot());
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    const res = await store.getFacts(["../../etc/passwd"]);
    expect(res["../../etc/passwd"]).toEqual({ error: true });
  });

  test("returns facts for a scanned session and caches by mtime:size", async () => {
    const root = fixtureRoot();
    const userData = mkdtempSync(join(tmpdir(), "csm-facts-idx-"));
    createdRoots.push(userData);
    const index = createSessionIndex({
      dir: userData,
      enabled: true,
      debounceMs: 0,
    });
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
    const store = createSessionStore(root, { extractFacts: spy, index });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });

    const a = await store.getFacts([UUID]);
    const b = await store.getFacts([UUID]);
    expect((a[UUID] as SessionFacts).messageCount).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1); // second call is a cache hit
    expect(b[UUID]).toEqual(a[UUID]); // value-equal (reconstructed from the entry)
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

  test("computed facts persist across a fresh store over the same index", async () => {
    const root = fixtureRoot();
    const userData = mkdtempSync(join(tmpdir(), "csm-facts-persist-"));
    createdRoots.push(userData);
    const index = createSessionIndex({
      dir: userData,
      enabled: true,
      debounceMs: 0,
    });

    const spy1 = vi.fn(
      () =>
        ({
          sessionId: UUID,
          messageCount: 7,
          firstActivity: null,
          lastActivity: null,
          editedFileCount: 0,
          firstModel: null,
          distinctModelCount: 0,
          outputTokens: 3,
        }) as SessionFacts,
    );
    const store1 = createSessionStore(root, { extractFacts: spy1, index });
    await store1.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    await store1.getFacts([UUID]);
    await index.flush();
    expect(spy1).toHaveBeenCalledTimes(1);

    // A brand-new index instance loads the persisted facts from disk.
    const index2 = createSessionIndex({
      dir: userData,
      enabled: true,
      debounceMs: 0,
    });
    const spy2 = vi.fn(
      () =>
        ({
          sessionId: UUID,
          messageCount: 99,
          firstActivity: null,
          lastActivity: null,
          editedFileCount: 0,
          firstModel: null,
          distinctModelCount: 0,
          outputTokens: 0,
        }) as SessionFacts,
    );
    const store2 = createSessionStore(root, {
      extractFacts: spy2,
      index: index2,
    });
    await store2.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    const res = await store2.getFacts([UUID]);
    expect((res[UUID] as SessionFacts).messageCount).toBe(7); // from disk, not recomputed
    expect(spy2).not.toHaveBeenCalled();
  });
});

describe("sessionStore.startBackfill (seam — not auto-run in #116)", () => {
  test("computes + persists facts for every scanned session, and is idempotent", async () => {
    const root = fixtureRoot();
    const userData = mkdtempSync(join(tmpdir(), "csm-backfill-"));
    createdRoots.push(userData);
    const index = createSessionIndex({
      dir: userData,
      enabled: true,
      debounceMs: 0,
    });
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
    const store = createSessionStore(root, { extractFacts: spy, index });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });

    await store.startBackfill();
    expect(spy).toHaveBeenCalledTimes(1); // the one fixture session got facts
    expect(index.get(UUID)?.facts).toBeDefined();

    // Second run: everything is warm → no recompute (idempotent).
    spy.mockClear();
    await store.startBackfill();
    expect(spy).not.toHaveBeenCalled();
  });

  test("skips a session already in flight (in-flight Set de-dup)", async () => {
    const root = fixtureRoot();
    const userData = mkdtempSync(join(tmpdir(), "csm-backfill-inflight-"));
    createdRoots.push(userData);
    const index = createSessionIndex({
      dir: userData,
      enabled: true,
      debounceMs: 0,
    });
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
    const store = createSessionStore(root, { extractFacts: spy, index });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });

    // Simulate a concurrent lazy pull already computing this id.
    store.inFlight.add(UUID);
    await store.startBackfill();
    expect(spy).not.toHaveBeenCalled(); // skipped — owned by the in-flight pull
    store.inFlight.delete(UUID);
  });
});
