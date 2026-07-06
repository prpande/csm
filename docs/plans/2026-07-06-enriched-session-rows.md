# Enriched Session Rows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third line of extracted facts (`N msgs · span · N edited · Model · N tok`) to every session row of the currently listed folder, loaded windowed and lazily.

**Architecture:** A new pure `extractSessionFacts` in `sessionParser` walks the JSONL once; the existing `sessionStore` gains a `sessionId→path` map (captured during scan) and a `getFacts` method with an in-memory `mtime:size` cache; a batch `session:getFacts` IPC handler + preload method deliver facts to the renderer; a `useSessionFacts` hook fetches the visible window and a third line on `SessionRow` renders skeleton→text.

**Tech Stack:** TypeScript, Electron (main + sandboxed preload), React 19, Vite, Vitest (node-context tests in `test/main`, jsdom tests in `test/renderer`).

**Spec:** `docs/specs/2026-07-06-enriched-session-rows-design.md`

## Global Constraints

- **Read-only over Claude's `.jsonl`.** Only `readdir`/`stat`/`readFile`; never write, move, or delete a session file.
- **Render as text, never `innerHTML`.** All row values are JSX text children (≡ `textContent`).
- **Electron hardening unchanged:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the renderer reaches main only through the `csm` preload bridge.
- **UUID-validate `sessionId`** before any path resolution (reuse `terminalLauncher`'s existing `UUID_RE`).
- **No hardcoded hex in component CSS.** Every color is a `var(--*)` token defined in `src/renderer/styles/global.css` (enforced by `test/main/designTokens.test.ts`).
- **Keep pure units pure:** `sessionParser` and `sessionRowView` import no `fs`/`child_process`/Electron; they are unit-tested in `test/main`.
- **Tooling:** run a single test file with `npm test -- <path>`; full suite `npm test`; typecheck `npm run typecheck`; lint `npm run lint`. Run one build/test at a time, foreground, timeout ≥ 300000 ms.
- **Commits:** Conventional Commit messages; commit after each green task.

---

### Task 1: `extractSessionFacts` (pure fact extraction)

**Files:**
- Modify: `src/sessionParser.ts` (add `SessionFacts` + `extractSessionFacts`; `parseSession`/`SessionMetadata` stay untouched)
- Test: `test/main/sessionParser.facts.test.ts`

**Interfaces:**
- Consumes: existing module-private `parseRecords`, `isRecord`, `asString`, `asNonEmptyString`, `eligiblePromptText`.
- Produces:
  ```ts
  export interface SessionFacts {
    sessionId: string;
    messageCount: number;
    firstActivity: string | null;
    lastActivity: string | null;
    editedFileCount: number;
    firstModel: string | null;
    distinctModelCount: number;
    outputTokens: number;
  }
  export function extractSessionFacts(sessionId: string, content: string): SessionFacts;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/main/sessionParser.facts.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- test/main/sessionParser.facts.test.ts`
Expected: FAIL — `extractSessionFacts` is not exported.

- [ ] **Step 3: Implement `extractSessionFacts`**

Append to `src/sessionParser.ts` (after `parseSession`; do not modify existing exports):

```ts
export interface SessionFacts {
  sessionId: string;
  messageCount: number;
  firstActivity: string | null;
  lastActivity: string | null;
  editedFileCount: number;
  firstModel: string | null;
  distinctModelCount: number;
  outputTokens: number;
}

// Tools that MUTATE a file. editedFileCount counts distinct paths from these only
// (a read tool touching a file is not an edit). NotebookEdit carries notebook_path.
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// tool_use blocks on an assistant message (content is a block array), else [].
function toolUseBlocks(rec: Record_): Record_[] {
  const message = rec.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(
    (b): b is Record_ => isRecord(b) && b.type === "tool_use",
  );
}

// An assistant record counts as a conversational turn only if it emitted text
// (a pure tool-use turn is plumbing, not a message the user reads).
function hasAssistantText(rec: Record_): boolean {
  const message = rec.message;
  if (!isRecord(message)) return false;
  const content = message.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) => isRecord(b) && b.type === "text" && asNonEmptyString(b.text) !== undefined,
  );
}

/**
 * Extract the heavier per-session facts for the enriched row (spec §4). Shares the
 * record-walk with parseSession but is a SEPARATE entry point so the light list
 * path stays cheap. Pure and fail-soft: a junk file yields an all-fallback object.
 */
export function extractSessionFacts(sessionId: string, content: string): SessionFacts {
  const records = parseRecords(content);

  let messageCount = 0;
  let firstActivity: string | null = null;
  let lastActivity: string | null = null;
  let firstModel: string | null = null;
  let outputTokens = 0;
  const editedPaths = new Set<string>();
  const models = new Set<string>();

  for (const r of records) {
    // Genuine conversational turns only.
    if (r.type === "user") {
      if (eligiblePromptText(r) !== undefined) messageCount++;
    } else if (r.type === "assistant" && hasAssistantText(r)) {
      messageCount++;
    }

    // First/last record carrying a timestamp.
    const ts = asString(r.timestamp);
    if (ts) {
      if (firstActivity === null) firstActivity = ts;
      lastActivity = ts;
    }

    if (r.type !== "assistant") continue;
    const message = isRecord(r.message) ? r.message : undefined;
    if (!message) continue;

    // Model: first REAL id wins; a placeholder (<synthetic> / any "<"-prefixed) is skipped.
    const model = asNonEmptyString(message.model);
    if (model && !model.startsWith("<")) {
      if (firstModel === null) firstModel = model;
      models.add(model);
    }

    // Output tokens: sum, cache-read excluded (we read only output_tokens).
    const usage = isRecord(message.usage) ? message.usage : undefined;
    if (usage && typeof usage.output_tokens === "number") {
      outputTokens += usage.output_tokens;
    }

    // Distinct mutated file paths.
    for (const block of toolUseBlocks(r)) {
      if (typeof block.name !== "string" || !MUTATING_TOOLS.has(block.name)) continue;
      const input = isRecord(block.input) ? block.input : undefined;
      const path = input
        ? (asNonEmptyString(input.file_path) ?? asNonEmptyString(input.notebook_path))
        : undefined;
      if (path) editedPaths.add(path);
    }
  }

  return {
    sessionId,
    messageCount,
    firstActivity,
    lastActivity,
    editedFileCount: editedPaths.size,
    firstModel,
    distinctModelCount: models.size,
    outputTokens,
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- test/main/sessionParser.facts.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sessionParser.ts test/main/sessionParser.facts.test.ts
git commit -m "feat: add extractSessionFacts pure fact extractor (#115)"
```

---

### Task 2: Fact formatters (pure row view helpers)

**Files:**
- Modify: `src/sessionRowView.ts` (add formatters; existing `chipVariant`/`shortSessionId`/`formatRelativeTime` untouched)
- Test: `test/main/sessionRowView.facts.test.ts`

**Interfaces:**
- Consumes: `SessionFacts` (Task 1).
- Produces:
  ```ts
  export function formatModel(firstModel: string | null, distinctModelCount: number): string | null;
  export function formatTokens(n: number): string;
  export function formatSpan(firstActivity: string | null, lastActivity: string | null): string | null;
  export function formatEdited(editedFileCount: number): string;
  export function formatMessages(messageCount: number): string;
  export function factSegments(facts: SessionFacts): string[];
  ```

- [ ] **Step 1: Write the failing test**

Create `test/main/sessionRowView.facts.test.ts`:

```ts
import { test, expect, describe } from "vitest";
import {
  formatModel, formatTokens, formatSpan, formatEdited, formatMessages, factSegments,
} from "../../src/sessionRowView";
import type { SessionFacts } from "../../src/sessionParser";

describe("fact formatters", () => {
  test("formatModel: known id, unknown strip+cap, +N, null", () => {
    expect(formatModel("claude-opus-4-8", 1)).toBe("Opus 4.8");
    expect(formatModel("claude-opus-4-8", 3)).toBe("Opus 4.8 +2");
    expect(formatModel("claude-future-xl-experimental-2027", 1)).toBe("future-xl-experiment…");
    expect(formatModel(null, 0)).toBeNull();
  });

  test("formatTokens buckets", () => {
    expect(formatTokens(999)).toBe("999 tok");
    expect(formatTokens(1000)).toBe("1k tok");
    expect(formatTokens(999999)).toBe("999k tok");
    expect(formatTokens(1000000)).toBe("1.0M tok");
    expect(formatTokens(1200000)).toBe("1.2M tok");
  });

  test("formatSpan: buckets, >24h cap, omitted when missing/single/degenerate", () => {
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T03:41:00Z")).toBe("span 3h 41m");
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T00:05:00Z")).toBe("span 5m");
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T00:00:30Z")).toBe("span <1m");
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-16T00:00:00Z")).toBe("span >24h");
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z")).toBeNull();
    expect(formatSpan(null, "2026-07-01T00:00:00Z")).toBeNull();
  });

  test("formatEdited and formatMessages", () => {
    expect(formatEdited(0)).toBe("read-only");
    expect(formatEdited(5)).toBe("5 edited");
    expect(formatMessages(42)).toBe("42 msgs");
  });

  test("factSegments omits null model/span without a dangling separator", () => {
    const base: SessionFacts = {
      sessionId: "s", messageCount: 42, firstActivity: "2026-07-01T00:00:00Z",
      lastActivity: "2026-07-01T03:41:00Z", editedFileCount: 5,
      firstModel: "claude-opus-4-8", distinctModelCount: 1, outputTokens: 1200000,
    };
    expect(factSegments(base)).toEqual(["42 msgs", "span 3h 41m", "5 edited", "Opus 4.8", "1.2M tok"]);
    const bare: SessionFacts = { ...base, firstModel: null, firstActivity: null, lastActivity: null };
    expect(factSegments(bare)).toEqual(["42 msgs", "5 edited", "1.2M tok"]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- test/main/sessionRowView.facts.test.ts`
Expected: FAIL — formatters not exported.

- [ ] **Step 3: Implement the formatters**

Append to `src/sessionRowView.ts`:

```ts
import type { SessionFacts } from "./sessionParser";

// Friendly names for known model ids; an unknown id is stripped of its "claude-"
// prefix and capped so a future id still renders legibly on the row.
const MODEL_NAMES: Record<string, string> = {
  "claude-opus-4-8": "Opus 4.8",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-haiku-4-5": "Haiku 4.5",
  "claude-fable-5": "Fable 5",
};
const MODEL_MAX = 20;

export function formatModel(firstModel: string | null, distinctModelCount: number): string | null {
  if (firstModel === null) return null;
  let name = MODEL_NAMES[firstModel];
  if (!name) {
    const stripped = firstModel.replace(/^claude-/, "");
    name = stripped.length > MODEL_MAX ? stripped.slice(0, MODEL_MAX - 1) + "…" : stripped;
  }
  return distinctModelCount > 1 ? `${name} +${distinctModelCount - 1}` : name;
}

export function formatTokens(n: number): string {
  let body: string;
  if (n >= 1_000_000) body = `${(n / 1_000_000).toFixed(1)}M`;
  else if (n >= 1_000) body = `${Math.floor(n / 1_000)}k`;
  else body = String(n);
  return `${body} tok`;
}

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

// Wall-clock span first..last, prefixed "span " and capped at >24h so a session
// reopened across days is not read as effort. Omitted (null) when there is no
// second timestamp to measure against.
export function formatSpan(firstActivity: string | null, lastActivity: string | null): string | null {
  if (!firstActivity || !lastActivity) return null;
  const a = Date.parse(firstActivity);
  const b = Date.parse(lastActivity);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const ms = b - a;
  if (ms <= 0) return null;
  if (ms >= DAY_MS) return "span >24h";
  const mins = Math.round(ms / MIN_MS);
  if (mins >= 60) return `span ${Math.floor(mins / 60)}h ${mins % 60}m`;
  if (mins >= 1) return `span ${mins}m`;
  return "span <1m";
}

export function formatEdited(editedFileCount: number): string {
  return editedFileCount === 0 ? "read-only" : `${editedFileCount} edited`;
}

export function formatMessages(messageCount: number): string {
  return `${messageCount} msgs`;
}

// Ordered, ready-to-render segments: msgs · span · edited · model · tokens.
// span and model are dropped when null so the row never shows a dangling "·".
export function factSegments(facts: SessionFacts): string[] {
  const span = formatSpan(facts.firstActivity, facts.lastActivity);
  const model = formatModel(facts.firstModel, facts.distinctModelCount);
  return [
    formatMessages(facts.messageCount),
    ...(span ? [span] : []),
    formatEdited(facts.editedFileCount),
    ...(model ? [model] : []),
    formatTokens(facts.outputTokens),
  ];
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- test/main/sessionRowView.facts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sessionRowView.ts test/main/sessionRowView.facts.test.ts
git commit -m "feat: add session-fact row formatters (#115)"
```

---

### Task 3: `sessionStore` — path map, fact cache, `getFacts`

**Files:**
- Modify: `src/terminalLauncher.ts` (export `isValidSessionId`)
- Modify: `src/sessionStore.ts` (capture `sessionId→path` during scan; add `getFacts` with an mtime:size cache; return it)
- Test: `test/main/sessionStore.facts.test.ts`

**Interfaces:**
- Consumes: `extractSessionFacts` (Task 1), `terminalLauncher.UUID_RE` (existing).
- Produces:
  ```ts
  // terminalLauncher.ts
  export function isValidSessionId(id: string): boolean;
  // sessionStore.ts — createSessionStore's return now includes:
  getFacts(sessionIds: string[]): Promise<Record<string, SessionFacts | { error: true }>>;
  // StoreDeps gains an injectable extractor:
  extractFacts?: (sessionId: string, content: string) => SessionFacts;
  ```

- [ ] **Step 1: Export `isValidSessionId` from `terminalLauncher.ts`**

In `src/terminalLauncher.ts`, directly below the `UUID_RE` definition (line ~29), add:

```ts
// Boolean form of the UUID gate for callers that validate without throwing (e.g.
// the getFacts IPC path). Reuses the SAME regex as assertLaunchInputs so the two
// can never drift.
export function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}
```

- [ ] **Step 2: Write the failing test**

Create `test/main/sessionStore.facts.test.ts`:

```ts
import { test, expect, describe, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../../src/sessionStore";
import type { SessionFacts } from "../../src/sessionParser";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID2 = "22222222-2222-4222-8222-222222222222";

// Minimal session file: one assistant turn on Opus with 100 output tokens.
const body = (text: string) =>
  JSON.stringify({
    type: "assistant", timestamp: "2026-07-01T00:00:00Z",
    message: { role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text }], usage: { output_tokens: 100 } },
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
    const spy = vi.fn((id: string, c: string) =>
      ({ sessionId: id, messageCount: 1, firstActivity: null, lastActivity: null,
         editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: c.length }) as SessionFacts);
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
    const spy = vi.fn((id: string) =>
      ({ sessionId: id, messageCount: 1, firstActivity: null, lastActivity: null,
         editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: 0 }) as SessionFacts);
    const store = createSessionStore(root, { extractFacts: spy });
    await store.scan({ now: Date.parse("2026-07-01T00:00:00Z") });
    await store.getFacts([UUID]);

    // Grow the file, then re-scan so the path map re-stats it.
    writeFileSync(join(root, "encoded-cwd", `${UUID}.jsonl`), body("hello") + "\n" + body("more"));
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
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `npm test -- test/main/sessionStore.facts.test.ts`
Expected: FAIL — `getFacts` does not exist.

- [ ] **Step 4: Implement in `src/sessionStore.ts`**

Add imports at the top (extend the existing parser import):

```ts
import { parseSession, extractSessionFacts, type SessionMetadata, type SessionFacts } from "./sessionParser";
import { isValidSessionId } from "./terminalLauncher";
```

Extend `StoreDeps`:

```ts
export interface StoreDeps {
  parse?: (sessionId: string, content: string) => SessionMetadata;
  /** Injectable so tests can spy fact-parse call counts (cache behaviour). */
  extractFacts?: (sessionId: string, content: string) => SessionFacts;
}
```

Inside `createSessionStore`, after `const cache = new Map<...>();` (line ~127) add:

```ts
  const extractFacts = deps.extractFacts ?? extractSessionFacts;
  // sessionId -> absolute path, captured during scan. The on-disk path is grouped
  // by ENCODED cwd, not the authoritative in-file cwd, so it is not derivable from
  // a session's cwd — it must be remembered here. Populated in scan(), read by getFacts().
  const pathById = new Map<string, string>();
  // Fact cache keyed by sessionId; value carries the mtime:size freshness key.
  // SUCCESS entries only — an error is returned transiently so it retries.
  const factCache = new Map<string, { key: string; facts: SessionFacts }>();
```

In `scan`, right after `const files = await collectFiles(rootDir);` add:

```ts
    for (const f of files) pathById.set(sessionIdOf(f.path), f.path);
```

Add the `getFacts` function inside `createSessionStore` (before the `return`):

```ts
  async function getFacts(
    sessionIds: string[],
  ): Promise<Record<string, SessionFacts | { error: true }>> {
    const out: Record<string, SessionFacts | { error: true }> = {};
    for (const id of sessionIds) {
      // UUID gate BEFORE any path use — a hostile id can never reach the filesystem.
      if (!isValidSessionId(id)) {
        out[id] = { error: true };
        continue;
      }
      const path = pathById.get(id);
      if (!path) {
        out[id] = { error: true };
        continue;
      }
      let st;
      try {
        st = await stat(path);
      } catch {
        out[id] = { error: true };
        continue;
      }
      const key = `${st.mtimeMs}:${st.size}`;
      const cached = factCache.get(id);
      if (cached && cached.key === key) {
        out[id] = cached.facts;
        continue;
      }
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch {
        out[id] = { error: true }; // NOT cached: a transient failure retries next call.
        continue;
      }
      const facts = extractFacts(id, content);
      factCache.set(id, { key, facts });
      out[id] = facts;
    }
    return out;
  }
```

Change the return statement:

```ts
  return { scan, getFacts };
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `npm test -- test/main/sessionStore.facts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/terminalLauncher.ts src/sessionStore.ts test/main/sessionStore.facts.test.ts
git commit -m "feat: sessionStore path map + getFacts fact cache (#115)"
```

---

### Task 4: IPC wire — channel, type, `getFacts` handler

**Files:**
- Modify: `src/ipcChannels.ts` (add `sessionGetFacts`)
- Modify: `src/ipcTypes.ts` (add `SessionFactsResult`)
- Modify: `src/ipc.ts` (hoist the store to one instance; add the `getFacts` handler; widen the `createSessionStore` dep type)
- Test: `test/main/ipc.test.ts` (extend)

**Interfaces:**
- Consumes: `SessionFacts` (Task 1), `store.getFacts` (Task 3), `CH` (channels).
- Produces: `CH.sessionGetFacts`, `SessionFactsResult`, an `ipcMain.handle(CH.sessionGetFacts, …)` handler.

- [ ] **Step 1: Add the channel**

In `src/ipcChannels.ts`, inside the `CH` object after `sessionReopen`:

```ts
  // Batch fact fetch for the enriched-row third line (#115). Renderer sends the
  // visible-window sessionIds; main returns per-id facts or { error: true }.
  sessionGetFacts: "session:getFacts",
```

- [ ] **Step 2: Add the wire type**

In `src/ipcTypes.ts`, add (it already imports `SessionMetadata` from `./sessionParser`; extend that import to include `SessionFacts`):

```ts
import type { SessionMetadata, SessionFacts } from "./sessionParser";

/** Result of a batch getFacts call: per requested id, the facts or an error marker.
 *  Structured-clone safe (plain objects). */
export type SessionFactsResult = Record<string, SessionFacts | { error: true }>;
```

- [ ] **Step 3: Write the failing test**

Add to `test/main/ipc.test.ts` a suite (reuse the file's existing fake-ipcMain harness pattern — a `handlers` map populated by a fake `ipcMain.handle`, a trusted and untrusted sender):

```ts
describe("session:getFacts handler", () => {
  test("delegates valid ids to store.getFacts for a trusted sender", async () => {
    const getFacts = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, { error: true }])));
    const { handlers, trusted } = setupHandlers({ createSessionStore: () => ({ scan: vi.fn(), getFacts }) });
    const res = await handlers["session:getFacts"]({ sender: trusted }, ["a", 5, "b"]);
    expect(getFacts).toHaveBeenCalledWith(["a", "b"]); // non-strings filtered out
    expect(res).toEqual({ a: { error: true }, b: { error: true } });
  });

  test("returns {} for an untrusted sender without calling the store", async () => {
    const getFacts = vi.fn();
    const { handlers, untrusted } = setupHandlers({ createSessionStore: () => ({ scan: vi.fn(), getFacts }) });
    expect(await handlers["session:getFacts"]({ sender: untrusted }, ["a"])).toEqual({});
    expect(getFacts).not.toHaveBeenCalled();
  });

  test("returns {} when args is not an array", async () => {
    const { handlers, trusted } = setupHandlers({});
    expect(await handlers["session:getFacts"]({ sender: trusted }, "nope")).toEqual({});
  });
});
```

> Note: match the exact harness helpers already used in `test/main/ipc.test.ts` (it constructs `registerIpcHandlers` deps with a fake `ipcMain`). If that file uses inline setup rather than a `setupHandlers` helper, mirror that existing shape instead — the assertions above are what matter.

- [ ] **Step 4: Run the test, verify it fails**

Run: `npm test -- test/main/ipc.test.ts`
Expected: FAIL — no `session:getFacts` handler registered.

- [ ] **Step 5: Implement the handler + hoist the store**

In `src/ipc.ts`:

1. Widen the `createSessionStore` dep type in `IpcHandlerDeps`:

```ts
  createSessionStore: (rootDir: string) => {
    scan(opts: ScanOptions): Promise<GroupedSessions>;
    getFacts(sessionIds: string[]): Promise<import("./ipcTypes").SessionFactsResult>;
  };
```

2. In `registerIpcHandlers`, create ONE store instance up front (just after the `deps` destructure) and use it for both scan and getFacts:

```ts
  // One long-lived store: its sessionId->path map and fact cache must persist
  // across a scan and the subsequent getFacts calls (a fresh-per-scan store would
  // discard the path map getFacts needs). The metadata cache is keyed by
  // path+mtime, so reusing it across re-scans is a strict win.
  const store = createSessionStore(projectsRoot);
```

3. In the `sessionsScan` handler, replace `const store = createSessionStore(projectsRoot);` with using the hoisted `store` (delete that inner line).

4. Add the new handler (after the reopen handler):

```ts
  // getFacts: batch fact fetch for the enriched-row third line (#115). Untrusted
  // frame or a non-array arg → {} (renderer shows skeletons). Non-string elements
  // are filtered before delegating; store.getFacts does the UUID/path/cache work.
  ipcMain.handle(CH.sessionGetFacts, async (event, ids) => {
    if (!isTrustedSender(event.sender) || !Array.isArray(ids)) return {};
    const valid = ids.filter((x): x is string => typeof x === "string");
    return store.getFacts(valid);
  });
```

- [ ] **Step 6: Run the tests, verify they pass**

Run: `npm test -- test/main/ipc.test.ts`
Expected: PASS. (If the existing scan test asserted `createSessionStore` was called once per scan, update it: the store is now created once at registration — assert that instead.)

- [ ] **Step 7: Commit**

```bash
git add src/ipcChannels.ts src/ipcTypes.ts src/ipc.ts test/main/ipc.test.ts
git commit -m "feat: session:getFacts IPC handler over a hoisted store (#115)"
```

---

### Task 5: Preload + renderer bridge contract

**Files:**
- Modify: `src/preload.ts` (expose `getFacts`)
- Modify: `src/renderer/types/csm.d.ts` (add `getFacts` to `CsmBridge`)

**Interfaces:**
- Consumes: `CH.sessionGetFacts`, `SessionFactsResult` (Task 4).
- Produces: `window.csm.getFacts(ids: string[]): Promise<SessionFactsResult>`.

- [ ] **Step 1: Expose the method in the preload**

In `src/preload.ts`, extend the `SessionFactsResult` type import and add the method inside `exposeInMainWorld("csm", { … })` (next to `reopenSession`):

```ts
// (extend the existing ipcTypes import list)
import type { /* …existing… */ SessionFactsResult } from "./ipcTypes";

  getFacts: (ids: string[]): Promise<SessionFactsResult> =>
    ipcRenderer.invoke(CH.sessionGetFacts, ids),
```

- [ ] **Step 2: Add it to the renderer contract**

In `src/renderer/types/csm.d.ts`, extend the type imports and the `CsmBridge` interface:

```ts
import type {
  ReopenRequestDto, ReopenResult, SessionsListener, ThemePreference, SessionFactsResult,
} from "../../ipcTypes";

// …inside CsmBridge:
  /** Batch fact fetch for enriched rows (#115). Absent without the preload, so
   *  consumers must treat it as optional. */
  getFacts(ids: string[]): Promise<SessionFactsResult>;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (all three tsc projects clean).

- [ ] **Step 4: Commit**

```bash
git add src/preload.ts src/renderer/types/csm.d.ts
git commit -m "feat: expose csm.getFacts on the preload bridge (#115)"
```

---

### Task 6: `useSessionFacts` renderer hook

**Files:**
- Create: `src/renderer/hooks/useSessionFacts.ts`
- Test: `test/renderer/useSessionFacts.test.tsx`

**Interfaces:**
- Consumes: `window.csm.getFacts` via `currentBridge()`; `SessionFacts` (Task 1).
- Produces:
  ```ts
  export type FactEntry = { status: "loaded"; facts: SessionFacts } | { status: "error" };
  export function useSessionFacts(bridge?: CsmBridge): {
    facts: ReadonlyMap<string, FactEntry>;
    requestFacts: (ids: readonly string[]) => void;
  };
  ```
  A row whose id is absent from `facts` is still loading (renders a skeleton). The hook's state is dropped when the component unmounts — `SessionList` is keyed by folder path, so a folder switch re-mounts it and clears the map.

- [ ] **Step 1: Write the failing test**

Create `test/renderer/useSessionFacts.test.tsx`:

```tsx
import { test, expect, describe, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessionFacts } from "../../src/renderer/hooks/useSessionFacts";
import type { CsmBridge } from "../../src/renderer/types/csm";

const facts = (id: string) => ({
  sessionId: id, messageCount: 1, firstActivity: null, lastActivity: null,
  editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: 0,
});

function bridgeWith(getFacts: CsmBridge["getFacts"]): CsmBridge {
  return { isDesktop: true, platform: "win32" } as unknown as CsmBridge &
    { getFacts: CsmBridge["getFacts"] } as CsmBridge, getFacts as never; // see note
}

describe("useSessionFacts", () => {
  test("fetches uncached ids and exposes loaded/error entries", async () => {
    const getFacts = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, id === "bad" ? { error: true } : facts(id)])));
    const bridge = { isDesktop: true, platform: "win32", getFacts } as unknown as CsmBridge;
    const { result } = renderHook(() => useSessionFacts(bridge));

    act(() => result.current.requestFacts(["a", "bad"]));
    await waitFor(() => expect(result.current.facts.size).toBe(2));
    expect(result.current.facts.get("a")).toEqual({ status: "loaded", facts: facts("a") });
    expect(result.current.facts.get("bad")).toEqual({ status: "error" });
  });

  test("does not re-request already-known or in-flight ids", async () => {
    const getFacts = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, facts(id)])));
    const bridge = { isDesktop: true, platform: "win32", getFacts } as unknown as CsmBridge;
    const { result } = renderHook(() => useSessionFacts(bridge));

    act(() => result.current.requestFacts(["a"]));
    await waitFor(() => expect(result.current.facts.has("a")).toBe(true));
    act(() => result.current.requestFacts(["a"]));
    expect(getFacts).toHaveBeenCalledTimes(1);
  });
});
```

> Note: ignore the `bridgeWith` helper sketch above — use the inline `{ isDesktop, platform, getFacts } as unknown as CsmBridge` cast shown in the test bodies.

- [ ] **Step 2: Run the test, verify it fails**

Run: `npm test -- test/renderer/useSessionFacts.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook**

Create `src/renderer/hooks/useSessionFacts.ts`:

```ts
import { useCallback, useRef, useState } from "react";
import type { SessionFacts } from "../../sessionParser";
import type { CsmBridge } from "../types/csm";
import { currentBridge } from "../bridge";

export type FactEntry =
  | { status: "loaded"; facts: SessionFacts }
  | { status: "error" };

// Lazy, windowed fact loader for the enriched row (#115). Rows call requestFacts
// with the visible-window ids; the hook fetches only the uncached, not-in-flight
// ones via csm.getFacts and merges results. A row absent from `facts` is still
// loading. State lives per mounted list — SessionList is keyed by folder path, so
// a folder switch re-mounts and clears the map (no cross-folder growth).
export function useSessionFacts(bridge: CsmBridge | undefined = currentBridge()): {
  facts: ReadonlyMap<string, FactEntry>;
  requestFacts: (ids: readonly string[]) => void;
} {
  const [facts, setFacts] = useState<Map<string, FactEntry>>(new Map());
  // Refs mirror state for the has-check so requestFacts stays referentially stable
  // (an effect in SessionList calls it — a changing identity would re-fire it).
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const inFlight = useRef<Set<string>>(new Set());

  const requestFacts = useCallback(
    (ids: readonly string[]) => {
      const getFacts = bridge?.getFacts;
      if (!getFacts) return;
      const need = ids.filter((id) => !factsRef.current.has(id) && !inFlight.current.has(id));
      if (need.length === 0) return;
      need.forEach((id) => inFlight.current.add(id));
      void getFacts([...need])
        .then((res) => {
          setFacts((prev) => {
            const next = new Map(prev);
            for (const id of need) {
              const r = res[id];
              next.set(id, r && !("error" in r) ? { status: "loaded", facts: r } : { status: "error" });
              inFlight.current.delete(id);
            }
            return next;
          });
        })
        .catch(() => {
          need.forEach((id) => inFlight.current.delete(id)); // allow a later retry
        });
    },
    [bridge],
  );

  return { facts, requestFacts };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npm test -- test/renderer/useSessionFacts.test.tsx`
Expected: PASS.

> If jest-dom matcher errors appear locally (a known flake), rely on the plain `expect(...).toEqual/.toBe` assertions used here — they don't need jest-dom — or fall back to CI.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/useSessionFacts.ts test/renderer/useSessionFacts.test.tsx
git commit -m "feat: useSessionFacts windowed fact-loading hook (#115)"
```

---

### Task 7: `SessionRow` third line + skeleton token

**Files:**
- Modify: `src/renderer/styles/global.css` (add `--skeleton-bg` in both themes)
- Modify: `test/main/designTokens.test.ts` (assert the new token in both themes)
- Modify: `src/renderer/components/SessionRow.module.css` (facts line + skeleton styles)
- Modify: `src/renderer/components/SessionRow.tsx` (render the third line)
- Test: `test/renderer/SessionRow.test.tsx` (extend)

**Interfaces:**
- Consumes: `FactEntry` (Task 6), `factSegments` (Task 2).
- Produces: `SessionRow` accepts a new `factState?: FactEntry` prop (undefined = loading → skeleton).

- [ ] **Step 1: Add the `--skeleton-bg` token (both themes)**

In `src/renderer/styles/global.css`, in the light `:root` block after `--count-text: #786d61;` (line ~39):

```css
  /* Loading-skeleton fill for lazily-loaded row facts (#115): a hair above the
     count surface so the bar reads as an empty placeholder in both themes. */
  --skeleton-bg: #e3d8c8;
```

In the dark `@media (prefers-color-scheme: dark) :root` block after `--count-text: #b7aa9b;` (line ~84):

```css
  --skeleton-bg: #3f362e;
```

- [ ] **Step 2: Extend the token test (write the failing assertion first)**

In `test/main/designTokens.test.ts`, add a token regex near the others (line ~22):

```ts
const SKELETON_BG = new RegExp(`--skeleton-bg:\\s*#${HEX_CLASS}`);
```

And a new test mirroring the existing per-theme pattern:

```ts
test("global.css defines --skeleton-bg in both light and dark themes", () => {
  const css = readFileSync(globalCss, "utf8");
  const darkIndex = css.indexOf("prefers-color-scheme: dark");
  expect(darkIndex).toBeGreaterThan(-1);
  expect(css.slice(0, darkIndex)).toMatch(SKELETON_BG);
  expect(css.slice(darkIndex)).toMatch(SKELETON_BG);
});
```

Run: `npm test -- test/main/designTokens.test.ts`
Expected: PASS (Step 1 already added the tokens; this locks them in). If it FAILS, the token is missing/misplaced — fix Step 1.

- [ ] **Step 3: Add the facts-line CSS**

Append to `src/renderer/components/SessionRow.module.css`:

```css
/* Third line: lazily-loaded session facts (#115). Reserves a fixed line so the
   skeleton->text swap never reflows the virtualized list; truncates (never wraps)
   so a narrow pane can't break the reserved height. */
.facts {
  font-size: 0.7rem;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-height: 1em;
  line-height: 1;
}

.factsText {
  animation: factsFade 0.15s ease;
}

@keyframes factsFade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .factsText {
    animation: none;
  }
}

/* Placeholder bar shown until facts arrive. */
.skeleton {
  display: inline-block;
  width: 60%;
  height: 0.65em;
  border-radius: 4px;
  background: var(--skeleton-bg);
}
```

- [ ] **Step 4: Write the failing row test**

Add to `test/renderer/SessionRow.test.tsx` (mirror its existing render helper):

```tsx
import type { FactEntry } from "../../src/renderer/hooks/useSessionFacts";

const loaded: FactEntry = {
  status: "loaded",
  facts: {
    sessionId: "s", messageCount: 42, firstActivity: "2026-07-01T00:00:00Z",
    lastActivity: "2026-07-01T03:41:00Z", editedFileCount: 5,
    firstModel: "claude-opus-4-8", distinctModelCount: 1, outputTokens: 1200000,
  },
};

test("renders the fact segments when loaded", () => {
  render(<SessionRow session={sampleSession} rowHeight={76} factState={loaded} />);
  const line = screen.getByText(/42 msgs/);
  expect(line.textContent).toContain("span 3h 41m");
  expect(line.textContent).toContain("5 edited");
  expect(line.textContent).toContain("Opus 4.8");
  expect(line.textContent).toContain("1.2M tok");
});

test("shows a skeleton (aria-busy) while facts are loading", () => {
  const { container } = render(<SessionRow session={sampleSession} rowHeight={76} />);
  expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
});

test("shows an em-dash on fact error", () => {
  render(<SessionRow session={sampleSession} rowHeight={76} factState={{ status: "error" }} />);
  expect(screen.getByText("—")).toBeTruthy();
});
```

> Use whatever `sampleSession` / `render` fixtures the existing file defines. Prefer `getByText`/`.toBeTruthy()` over jest-dom matchers (known local flake).

- [ ] **Step 5: Run the row test, verify it fails**

Run: `npm test -- test/renderer/SessionRow.test.tsx`
Expected: FAIL — `factState` prop / third line not rendered.

- [ ] **Step 6: Render the third line in `SessionRow.tsx`**

Add imports:

```ts
import { chipVariant, formatRelativeTime, shortSessionId, factSegments } from "../../sessionRowView";
import type { FactEntry } from "../hooks/useSessionFacts";
```

Add `factState` to props:

```ts
interface SessionRowProps {
  session: SessionMetadata;
  rowHeight: number;
  onOpen?: (session: SessionMetadata) => void;
  worktreeBranch?: string;
  /** Lazily-loaded facts (#115). Undefined = still loading (renders a skeleton). */
  factState?: FactEntry;
}
```

Add the third line inside `<div className={styles.text}>`, immediately after the `.meta` div (before its closing so it becomes the third line in the text column):

```tsx
        {factState === undefined ? (
          <div className={styles.facts} aria-busy="true">
            <span className={styles.skeleton} />
          </div>
        ) : factState.status === "error" ? (
          <div className={styles.facts}>—</div>
        ) : (
          (() => {
            const segments = factSegments(factState.facts);
            return (
              <div className={styles.facts} aria-label={segments.join(", ")}>
                <span className={styles.factsText}>
                  {segments.map((seg, i) => (
                    <span key={i}>
                      {i > 0 && (
                        <span className={styles.sep} aria-hidden="true">
                          {" · "}
                        </span>
                      )}
                      {seg}
                    </span>
                  ))}
                </span>
              </div>
            );
          })()
        )}
```

(Destructure `factState` in the function signature alongside the other props.)

- [ ] **Step 7: Run the row test, verify it passes**

Run: `npm test -- test/renderer/SessionRow.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/styles/global.css test/main/designTokens.test.ts src/renderer/components/SessionRow.module.css src/renderer/components/SessionRow.tsx test/renderer/SessionRow.test.tsx
git commit -m "feat: enriched-row third line with skeleton/error states (#115)"
```

---

### Task 8: `SessionList` wiring + row-height bump

**Files:**
- Modify: `src/sessionListWindow.ts` (`ROW_HEIGHT` 56 → 76)
- Modify: `src/renderer/components/SessionList.tsx` (drive `useSessionFacts`, request the visible window, pass `factState`)
- Test: `test/main/sessionListWindow.test.ts` (update any `ROW_HEIGHT === 56` expectation)
- Test: `test/renderer/SessionList.test.tsx` (facts requested for the visible window)

**Interfaces:**
- Consumes: `useSessionFacts` (Task 6), `factSegments` via `SessionRow` (Task 7).
- Produces: no new exports; `SessionRow`s now receive `factState`.

- [ ] **Step 1: Bump `ROW_HEIGHT`**

In `src/sessionListWindow.ts`, change:

```ts
export const ROW_HEIGHT = 76;
```

(Was 56; the third line needs the extra height. This one constant drives `computeWindow`, the spacer height, and each row's `translateY`.)

- [ ] **Step 2: Update the windowing test if it pins the value**

Run: `npm test -- test/main/sessionListWindow.test.ts`
If it FAILS on a hardcoded `56`/height expectation, update those expected values to `76` (the windowing math is unchanged — only the constant moved). If it PASSES (the tests pass `rowHeight` explicitly), no change.

- [ ] **Step 3: Write the failing list test**

Add to `test/renderer/SessionList.test.tsx`:

```tsx
test("requests facts for the visible window and passes them to rows", async () => {
  const getFacts = vi.fn(async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, {
      sessionId: id, messageCount: 7, firstActivity: null, lastActivity: null,
      editedFileCount: 0, firstModel: null, distinctModelCount: 0, outputTokens: 0,
    }])));
  (window as unknown as { csm: unknown }).csm = { isDesktop: true, platform: "win32", getFacts };

  render(<SessionList sessions={[sampleSession]} />);
  await waitFor(() => expect(getFacts).toHaveBeenCalled());
  expect(getFacts.mock.calls[0][0]).toContain(sampleSession.sessionId);
  await waitFor(() => expect(screen.getByText(/7 msgs/)).toBeTruthy());
});
```

> Use the file's existing `sampleSession` fixture; clean up `window.csm` in an `afterEach` if the suite doesn't already.

- [ ] **Step 4: Run the list test, verify it fails**

Run: `npm test -- test/renderer/SessionList.test.tsx`
Expected: FAIL — facts are never requested/rendered.

- [ ] **Step 5: Wire `useSessionFacts` into `SessionList.tsx`**

Add imports:

```ts
import { useEffect } from "react";
import { useSessionFacts } from "../hooks/useSessionFacts";
```

Inside `SessionList`, after computing `visible`:

```ts
  const { facts, requestFacts } = useSessionFacts();
  // Request facts for the rows actually mounted (the window). Keyed on the id list
  // so a scroll into new rows fetches just the newly-visible, uncached ones.
  const visibleIds = visible.map((s) => s.sessionId).join(",");
  useEffect(() => {
    if (visible.length > 0) requestFacts(visible.map((s) => s.sessionId));
    // visibleIds is the stable dependency; `visible`/`requestFacts` identities are derived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIds, requestFacts]);
```

Pass `factState` to each row:

```tsx
            <SessionRow
              key={session.sessionId}
              session={session}
              rowHeight={ROW_HEIGHT}
              onOpen={onOpen}
              worktreeBranch={worktreeBranches?.get(session.sessionId)}
              factState={facts.get(session.sessionId)}
            />
```

- [ ] **Step 6: Run the list test, verify it passes**

Run: `npm test -- test/renderer/SessionList.test.tsx`
Expected: PASS.

- [ ] **Step 7: Full verification (lint, typecheck, whole suite)**

Run each, one at a time (timeout ≥ 300000 ms):

```bash
npm run lint
npm run typecheck
npm test
```

Expected: all green. Fix any fallout (e.g. a prettier reformat, or a scan test expecting a per-scan store) before committing.

- [ ] **Step 8: Commit**

```bash
git add src/sessionListWindow.ts src/renderer/components/SessionList.tsx test/main/sessionListWindow.test.ts test/renderer/SessionList.test.tsx
git commit -m "feat: wire windowed fact-loading into the session list (#115)"
```

---

## Self-Review

**Spec coverage:**
- §4 `extractSessionFacts` (all fields incl. genuine-turn `messageCount`, `firstModel`+`distinctModelCount`, output tokens, edited count) → Task 1. ✅
- §5 UUID validation, `sessionId→path` map, mtime:size cache, errors-not-cached, read-only → Tasks 3 (store) + 4 (handler). ✅
- §6 windowed request, skeleton/error/loaded states, `ROW_HEIGHT` bump, drop-on-folder-switch (via `key`) → Tasks 6, 7, 8. ✅
- §7 formatters (model +N, token buckets, span cap, edited/msgs, no dangling separator) → Task 2. ✅
- §9 security (UUID gate, read-only, textContent, narrow preload) → Tasks 3, 4, 5, 7. ✅
- §10 testing matrix → each task's tests. ✅
- **Deliberately deferred (not in this plan):** persistent index (#116), `filesTouched[]` (#118), live/interval refresh (#120). Confirmed absent. ✅

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Two `> Note:` callouts point the implementer at existing test fixtures/harnesses rather than duplicating unknown boilerplate — acceptable (they name what to mirror). ✅

**Type consistency:** `SessionFacts` (Task 1) is consumed identically in Tasks 2/3/6/7; `SessionFactsResult` (Task 4) flows through Tasks 4/5; `FactEntry` (Task 6) is used by Tasks 7/8; `getFacts` signature matches across store (Task 3), IPC dep (Task 4), preload/contract (Task 5), hook (Task 6). ✅

## Execution Handoff

Plan complete and saved to `docs/plans/2026-07-06-enriched-session-rows.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — I execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
