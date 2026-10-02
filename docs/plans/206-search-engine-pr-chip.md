# Search slice 1 (#206): search.db engine, incremental ingest, gh enrichment, PR chip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the persisted search store (`search.db`) and its worker, ingest every transcript incrementally (conversation turns, titles and PR links), enrich PRs through `gh`, and show a PR chip on each session row.

**Architecture:** A `worker_threads` worker (`dist/searchWorker.js`, bundled by esbuild like the preload) is the only code that opens `search.db` (`node:sqlite` + FTS5, one connection). Pure units (`searchText`, `turnExtractor`, `prExtractor`, `fileCursor`, `tombstone`, `recordFilter`) feed an ingest pass that reads only appended bytes per transcript. Main owns the worker lifecycle (`searchHost`) and relays one IPC request (`search:prsFor`) and one event (`search:changed`) to the renderer, where `useSessionPrs` feeds the chip in `SessionRow`.

**Tech Stack:** TypeScript 6, Electron 43 (Node 24.18), `node:sqlite` (SQLite 3.5x with FTS5), esbuild, React 19, vitest 4 (jsdom by default; `// @vitest-environment node` for fs/sqlite tests).

**Spec:** `docs/specs/2026-10-02-session-search-and-pr-links-design.md` (§5–§8, §11–§14 for this slice). Slices 2 (#207, PR view) and 3 (#208, query engine + search UI) get their own plans once this slice's interfaces exist in code.

## Global Constraints

- Transcripts under the projects root are opened read-only (`fs.open(path, "r")`, `readdir`, `stat`); nothing under the projects root is ever written, moved or deleted (spec §13, CLAUDE.md).
- `gh` is spawned with `child_process.spawn(ghPath, argsArray, { shell: false })`; repo owner/name go as `-f` raw strings, PR numbers as `-F` typed ints; no user or transcript text is interpolated into the query string (spec §8.2, §13).
- Every SQL statement binds parameters; never concatenate input into SQL. `node:sqlite` cannot bind `undefined` or booleans: pass `null` and `0`/`1` (spec §13).
- Every new `ipcMain.handle` checks `isTrustedSender` and validates arguments; session ids are UUID-validated with `isValidSessionId` from `src/terminalLauncher.ts`; a `search:prsFor` request carries at most 500 ids (spec §8.4, §12).
- All transcript-derived text renders as React text children (never `innerHTML` / `dangerouslySetInnerHTML`) (spec §13, CLAUDE.md).
- Electron hardening stays as is: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; the renderer reaches main only through `window.csm` (CLAUDE.md).
- `EXTRACT_VERSION = 1`, `SCHEMA_VERSION = 1` (`PRAGMA user_version`), `HEAD_MAX = 4096`, `ANCHOR_MAX = 256`, `MISSING_GRACE_MS = 60_000`, `PENDING_CAP = 20`, PR body cap `65_536` bytes, `gh` batch `50` PRs, `2` calls in flight, `20_000` ms timeout, repo backoff `15` min, enrichment timer `10` min, OPEN refetch after `10` min, CLOSED after `24` h, MERGED never (spec §6–§8).
- Read chunks are `1 MiB`; a line over `16 MiB` is discarded; a non-contributing line over `256 KiB` is skipped unless it contains `"type":"text"`, `"content":"` or `gh pr create` (spec §7.3).
- Conventional Commit messages (`feat:`, `test:`, `chore:`, `docs:`), each referencing `(#206)`; no `Co-Authored-By`/`Claude-Session` trailers.
- Run git from PowerShell in the worktree (`D:\src\CSM\.claude\worktrees\206-search-engine-pr-chip`); never bare `git stash`.
- One build/test command at a time, foreground, timeout ≥ 300000 ms. Run vitest through the local binary: `./node_modules/.bin/vitest run <file>` (PowerShell: `& .\node_modules\.bin\vitest.cmd run <file>`), never `npx vitest`.
- Code comments: default none; keep only a non-obvious why, an external constraint or a gotcha, one line where possible.
- Every commit step runs `prettier --write` on its non-markdown files first: CI's `npm run lint` runs `prettier --check .` (markdown is ignored). `.mjs` files get no Node globals from eslint, so import `process`, `console` and timers from `node:*` explicitly.
- No new design tokens: the chip uses the existing CSS custom properties (`--border`, `--text`, `--text-muted`, `--accent`).

## Review Focus

Inputs the spec implies but no other test pins, most likely first. Each has its test in the owning task.

1. **A transcript written with CRLF line endings, or starting with a UTF-8 BOM** (hand-copied or tool-rewritten files). Expected: every record still ingests; the BOM does not make the first record unparseable. Test: Task 12, "CRLF and BOM transcripts ingest every record".
2. **The projects root missing entirely** (fresh machine, Claude Code never run, or the root on an unmounted drive). Expected: the pass records nothing, no rows are tombstoned, the worker stays up. Test: Task 12, "an unreadable projects root records nothing".
3. **The same session id under two project folders** (EnterWorktree left a copy behind). Expected: one session row whose path is the newest file; no double turns. Test: Task 12, "the same sid in two folders keeps the newest file".
4. **A session with thousands of repeated `pr-link` records** (measured up to ~6k per file). Expected: one `session_pr` row with `last_seen` = the latest timestamp, written without one statement per record. Test: Task 12, "6000 repeated pr-link records collapse to one link".
5. **A project folder deleted wholesale** (user cleans up `~/.claude/projects/<folder>`). Expected: its sessions are tombstoned after the 60 s floor, not kept as "present" forever because the parent is unreadable. Test: Task 6, "a missing parent folder under a readable root is absent", and Task 12, "deleting a whole project folder tombstones its sessions".

## File Structure

Create:

| File | Responsibility |
|---|---|
| `src/search/searchText.ts` | `fold`, `tokenize` (unicode61 rule), `identifierParts`, `searchTextOf` |
| `src/search/turnExtractor.ts` | record → conversation turn; record → session fields (cwd, branch, titles, first prompt, max timestamp) |
| `src/search/prExtractor.ts` | PR ref validation, `pr-link` records, `gh pr create` tool_use/tool_result pairing, link merging |
| `src/search/fileCursor.ts` | offset/head/anchor change-detection decision |
| `src/search/tombstone.ts` | deletion state machine |
| `src/search/recordFilter.ts` | cheap pre-`JSON.parse` line filter |
| `src/search/lineReader.ts` | streaming 1 MiB reads, complete lines with end offsets |
| `src/search/transcriptFiles.ts` | list top-level transcripts under the projects root (shared with `sessionStore`) |
| `src/search/searchDb.ts` | the only module that touches `node:sqlite`: schema, migrations, every statement, corruption recovery |
| `src/search/ingest.ts` | one ingest pass: classify, read, extract, write, tombstones; single-flight |
| `src/search/ghClient.ts` | resolve `gh`, build GraphQL args, spawn, parse partial output |
| `src/search/ghEnrich.ts` | due PRs → per-repo batches, concurrency, backoff, apply results |
| `src/search/protocol.ts` | host ↔ worker message types |
| `src/search/searchService.ts` | the worker's logic (no `worker_threads` import), testable in-process |
| `src/search/searchWorker.ts` | worker entry: wires `parentPort`/`workerData` to `searchService` |
| `src/searchHost.ts` | main-side worker lifecycle, restart backoff, request relay |
| `src/searchFiles.ts` | delete `search.db*`, backups and corrupt copies with retry |
| `src/prChip.ts` | pure: primary PR, state label, tooltip text |
| `src/renderer/hooks/useSessionPrs.ts` | windowed PR-link loader, invalidated on `search:changed` |
| `scripts/build-worker.mjs`, `scripts/build-worker.d.mts` | esbuild options + build for the worker bundle (typed for the bundle test) |
| `test/main/search/fixtures/fake-gh.mjs` | stand-in `gh` for `ghClient` tests (modes: ok, partial, null repo, malformed, no data, hang, big body) |
| `scripts/sqlite-probe.mjs` | asserts `node:sqlite` + FTS5 work (run under Electron in CI) |
| `scripts/run-sqlite-probe.mjs` | runs the probe with the repo's Electron binary as Node |

Modify: `src/sessionParser.ts`, `src/sessionStore.ts`, `src/ipcChannels.ts`, `src/ipcTypes.ts`, `src/ipc.ts`, `src/preload.ts`, `src/main.ts`, `src/sessionListWindow.ts`, `src/renderer/types/csm.d.ts`, `src/renderer/components/SessionRow.tsx`, `src/renderer/components/SessionRow.module.css`, `src/renderer/components/SessionList.tsx`, `package.json`, `electron-builder.yml`, `.github/workflows/ci.yml`; tests `test/main/ipc.test.ts`, `test/main/sessionListWindow.test.ts`, `test/renderer/SessionRow.test.tsx`, `test/renderer/SessionList.test.tsx`.

Tests live in `test/main/search/` (node environment, `tsconfig.node.json`) and `test/renderer/` (jsdom).

## Decisions made while planning

- **One SQLite connection** instead of the spec's earlier write + read pair: every statement is synchronous on the worker thread, so a query can never run inside an open write transaction. The spec (§5, §12) was updated in the same commit as this plan.
- **DB tests run under vitest on Node 24**, whose `node:sqlite` compiles FTS5 (verified: `CREATE VIRTUAL TABLE … USING fts5(…, prefix='2 3', detail=column)` passes under `vitest run`). The Electron runtime is covered by the CI probe in Task 20. Spec §14 updated.
- **A deleted project folder counts as absent** when the projects root is readable (the spec's "parent still readable" rule alone would keep such sessions present forever). Spec §7.5 updated.
- **`pr.fetched_at` is the last attempt**, success or failure, so a deleted or forbidden PR is retried every 10 minutes rather than on every pass. Spec §8.2 updated.
- **`search:progress` is forwarded by main but not yet exposed in the preload**; slices 2 and 3 add the renderer listener with its first consumer.
- **`gh.exe` only on Windows.** `spawn(…, { shell: false })` cannot run a `.cmd`/`.bat` shim, so a `gh` reachable only through a shim counts as not installed. Main resolves the path when it starts the worker and passes it in `WorkerInit.ghPath`, which also lets tests run the real worker with `gh` off.
- **The worker ships unpacked.** `dist/searchWorker.js` is one esbuild bundle listed in `asarUnpack`, and main rewrites its path to `app.asar.unpacked`, so the packaged worker loads from a plain file and does not rely on asar support inside `worker_threads` (spec §2's probe ran one from inside an asar; spec §5 keeps it unpacked). `test/main/packagingSearchWorker.test.ts` pins the bundle path, the unpack entry and the rewrite together.
- **Ready counts as a change.** The host emits `search:changed` when the worker reports ready, so a warm start that ingests nothing still makes the renderer fetch PR links. `prsFor` requests sent while the worker starts are queued by the message port and answered after the open.
- **One before-quit handler** flushes the session index and stops the worker together; two handlers would each re-quit and the second flush would be cut short.
- **The host owns the `search:changed` generation**; the worker posts a bare `changed`. Spec §5 updated.
- **A worker that fails for good is logged only.** The host's `failed` state gets a visible surface with the PR view (#207); in this slice rows just render without chips.
- **Tooltip format** is `owner/repo#N · state · title`, primary first, because one session can link PRs in several repos. Spec §8.4 updated.
- **Orphan PR rows are pruned after each pass** (`pruneOrphanPrs`), so a PR whose only session was rewritten without the link stops being enriched.
- **Opt-out purge ordering stays as today.** With the index setting off, main deletes `search.*` files at startup with a 5 s retry; changing the setting at runtime is #134's scope.

---

### Task 1: Export the title helpers from `sessionParser`

**Files:**
- Modify: `src/sessionParser.ts`
- Test: `test/sessionParser.test.ts` (append a `describe` block)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `export function eligiblePromptText(rec: Record<string, unknown>): string | undefined`
  - `export function truncateTitle(text: string): string`
  - `export interface TitleSources { customTitle?: string | null; aiTitle?: string | null; summary?: string | null; firstPrompt?: string | null }`
  - `export function composeTitleFrom(src: TitleSources): string` — `firstPrompt` must already be truncated with `truncateTitle`.

- [ ] **Step 1: Write the failing test**

Append to `test/sessionParser.test.ts`:

```ts
describe("composeTitleFrom", () => {
  const jsonl = (recs: object[]) => recs.map((r) => JSON.stringify(r)).join("\n");
  const prompt = (text: string) => ({
    type: "user",
    message: { role: "user", content: text },
  });
  const long = "x".repeat(TITLE_MAX_LENGTH + 30);

  const cases: { name: string; recs: object[]; sources: Parameters<typeof composeTitleFrom>[0] }[] = [
    {
      name: "custom name leads the ai-title",
      recs: [
        { type: "custom-title", customTitle: "fix-auth" },
        { type: "ai-title", aiTitle: "Fix login bug" },
      ],
      sources: { customTitle: "fix-auth", aiTitle: "Fix login bug" },
    },
    {
      name: "summary when no ai-title",
      recs: [{ type: "summary", summary: "Refactor parser" }, prompt("hello")],
      sources: { summary: "Refactor parser", firstPrompt: "hello" },
    },
    {
      name: "truncated first prompt",
      recs: [prompt(long)],
      sources: { firstPrompt: truncateTitle(long) },
    },
    {
      name: "fallback when nothing",
      recs: [{ type: "mode", mode: "normal" }],
      sources: {},
    },
    {
      name: "null columns behave like absent ones",
      recs: [{ type: "ai-title", aiTitle: "T" }],
      sources: { customTitle: null, aiTitle: "T", summary: null, firstPrompt: null },
    },
  ];

  test.each(cases)("$name matches parseSession", ({ recs, sources }) => {
    expect(composeTitleFrom(sources)).toBe(parseSession("s", jsonl(recs)).title);
  });

  test("eligiblePromptText rejects wrappers and meta records", () => {
    expect(eligiblePromptText(prompt("  real prompt "))).toBe("real prompt");
    expect(eligiblePromptText(prompt("<system-reminder>x"))).toBeUndefined();
    expect(eligiblePromptText({ ...prompt("x"), isMeta: true })).toBeUndefined();
  });
});
```

Add `composeTitleFrom`, `eligiblePromptText` and `truncateTitle` to the existing `../src/sessionParser` import at the top of the file, which already imports `parseSession` and `TITLE_MAX_LENGTH`. Add `describe` to the existing `import { test, expect } from "vitest";` line. Do not add a second import statement for either module.

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/sessionParser.test.ts`
Expected: FAIL — `composeTitleFrom` / `eligiblePromptText` / `truncateTitle` are not exported.

- [ ] **Step 3: Implement**

In `src/sessionParser.ts`:

1. Change `function eligiblePromptText(rec: Record_): string | undefined {` to `export function eligiblePromptText(rec: Record<string, unknown>): string | undefined {`.
2. Change `function truncateTitle(text: string): string {` to `export function truncateTitle(text: string): string {`.
3. Replace the whole `extractTitle` function with:

```ts
export interface TitleSources {
  customTitle?: string | null;
  aiTitle?: string | null;
  summary?: string | null;
  /** Already truncated with truncateTitle. */
  firstPrompt?: string | null;
}

// The single title rule shared by the browse parser and the search index, so the
// two cannot drift.
export function composeTitleFrom(src: TitleSources): string {
  return composeTitle(
    src.customTitle ?? undefined,
    src.aiTitle ?? src.summary ?? src.firstPrompt ?? undefined,
  );
}

function extractTitle(records: Record_[]): string {
  return composeTitleFrom({
    customTitle: fieldValue(records, "custom-title", "customTitle", {
      last: true,
    }),
    aiTitle: fieldValue(records, "ai-title", "aiTitle"),
    summary: fieldValue(records, "summary", "summary"),
    firstPrompt: firstPromptTitle(records),
  });
}
```

Keep the existing doc comment above `extractTitle` (it still describes the tiers).

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/sessionParser.test.ts test/main/sessionParser.facts.test.ts`
Expected: PASS (all existing title tests still pass — the refactor is behaviour-preserving).

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/sessionParser.ts test/sessionParser.test.ts
git add src/sessionParser.ts test/sessionParser.test.ts
git commit -m "feat: export the shared title helpers from sessionParser (#206)"
```

---

### Task 2: `searchText` — folding, tokenizing, identifier expansion

**Files:**
- Create: `src/search/searchText.ts`
- Test: `test/main/search/searchText.test.ts`

**Interfaces:**
- Produces:
  - `export function fold(text: string): string` — NFKD, combining marks removed, lowercased.
  - `export interface Token { text: string; start: number; end: number }`
  - `export function tokenize(text: string): Token[]` — maximal runs of letters, digits, marks and private-use chars; everything else (including `_`) separates. Offsets index into `text`.
  - `export function identifierParts(token: string): string[]` — camelCase/PascalCase parts, folded; `[]` when the token does not split.
  - `export function searchTextOf(text: string): string` — `fold(text)`, plus one line per distinct identifier expansion.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  fold,
  identifierParts,
  searchTextOf,
  tokenize,
} from "../../../src/search/searchText";

describe("fold", () => {
  test("strips diacritics, lowercases, applies compatibility forms", () => {
    expect(fold("Café ÑANDÚ")).toBe("cafe nandu");
    expect(fold("ﬁle ＡＢＣ")).toBe("file abc");
  });
});

describe("tokenize", () => {
  test("splits on punctuation and underscore like unicode61", () => {
    expect(
      tokenize("rate-limit sessionStore.ts node:sqlite snake_case 50%").map(
        (t) => t.text,
      ),
    ).toEqual([
      "rate",
      "limit",
      "sessionStore",
      "ts",
      "node",
      "sqlite",
      "snake",
      "case",
      "50",
    ]);
  });

  test("offsets index the original string", () => {
    expect(tokenize("a  bc")[1]).toEqual({ text: "bc", start: 3, end: 5 });
  });

  test("pure punctuation yields no tokens", () => {
    expect(tokenize(`"*:-%`)).toEqual([]);
  });
});

describe("identifierParts", () => {
  test.each([
    ["getUserName", ["get", "user", "name"]],
    ["HTTPServer", ["http", "server"]],
    ["sessionStore", ["session", "store"]],
    ["lowercase", []],
    ["v2", []],
    ["ABC", []],
  ])("%s", (token, parts) => {
    expect(identifierParts(token)).toEqual(parts);
  });
});

describe("searchTextOf", () => {
  test("adds one expansion line per distinct identifier", () => {
    expect(searchTextOf("Call getUserName then getUserName")).toBe(
      "call getusername then getusername\nget user name",
    );
  });

  test("plain text is just folded", () => {
    expect(searchTextOf("Plain Wörds")).toBe("plain words");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchText.test.ts`
Expected: FAIL — cannot resolve `src/search/searchText`.

- [ ] **Step 3: Implement**

`src/search/searchText.ts`:

```ts
// Shared by ingest (what FTS indexes) and, in slice 3, by query parsing and
// snippet ranges, so both sides fold and split text identically.

const TOKEN_RE = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;
const CAMEL_RE = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?[\p{Ll}\p{N}]+|\p{Lu}+\p{N}*/gu;

export interface Token {
  text: string;
  start: number;
  end: number;
}

export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    tokens.push({ text: m[0], start, end: start + m[0].length });
  }
  return tokens;
}

export function identifierParts(token: string): string[] {
  const parts = token.match(CAMEL_RE) ?? [];
  return parts.length > 1 ? parts.map(fold) : [];
}

export function searchTextOf(text: string): string {
  const expansions = new Set<string>();
  for (const token of tokenize(text)) {
    const parts = identifierParts(token.text);
    if (parts.length > 1) expansions.add(parts.join(" "));
  }
  const folded = fold(text);
  return expansions.size === 0
    ? folded
    : `${folded}\n${[...expansions].join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchText.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/searchText.ts test/main/search/searchText.test.ts
git add src/search/searchText.ts test/main/search/searchText.test.ts
git commit -m "feat: add searchText folding and identifier expansion (#206)"
```

---

### Task 3: `turnExtractor` — turns and session fields from records

**Files:**
- Create: `src/search/turnExtractor.ts`
- Test: `test/main/search/turnExtractor.test.ts`

**Interfaces:**
- Consumes: `eligiblePromptText`, `truncateTitle` (Task 1); `searchTextOf` (Task 2); `isRecord`, `isNonEmptyString` from `src/typeGuards.ts`.
- Produces:
  - `export interface TurnRow { uuid: string | null; role: "user" | "assistant"; ts: number | null; text: string; searchText: string }`
  - `export function recordTimestamp(rec: Record<string, unknown>): number | null`
  - `export function extractTurn(rec: Record<string, unknown>): TurnRow | undefined`
  - `export interface SessionFields { cwd: string | null; branch: string | null; lastActivity: number | null; customTitle: string | null; aiTitle: string | null; summaryTitle: string | null; firstPrompt: string | null; titleValues: string[] }`
  - `export function emptySessionFields(): SessionFields`
  - `export function mergeRecordFields(fields: SessionFields, rec: Record<string, unknown>): void` — mutates `fields`.

- [ ] **Step 1: Write the failing test**

```ts
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
      extractTurn(user([{ type: "tool_result", tool_use_id: "t", content: "ok" }])),
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
    expect(extractTurn(assistant([{ type: "thinking", thinking: "x" }]))).toBeUndefined();
  });

  test("missing uuid and bad timestamp become null", () => {
    const turn = extractTurn({ ...user("hi"), uuid: undefined, timestamp: "nope" });
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
    mergeRecordFields(f, { cwd: "/a", gitBranch: "main", timestamp: "2026-10-01T10:00:05Z" });
    mergeRecordFields(f, { cwd: "/b", gitBranch: "", timestamp: "2026-10-01T10:00:01Z" });
    mergeRecordFields(f, { gitBranch: "feat", timestamp: "2026-10-01T10:00:03Z" });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/turnExtractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/search/turnExtractor.ts`:

```ts
import { isNonEmptyString, isRecord } from "../typeGuards";
import { eligiblePromptText, truncateTitle } from "../sessionParser";
import { searchTextOf } from "./searchText";

type Rec = Record<string, unknown>;

export interface TurnRow {
  uuid: string | null;
  role: "user" | "assistant";
  ts: number | null;
  text: string;
  searchText: string;
}

export interface SessionFields {
  cwd: string | null;
  branch: string | null;
  lastActivity: number | null;
  customTitle: string | null;
  aiTitle: string | null;
  summaryTitle: string | null;
  firstPrompt: string | null;
  titleValues: string[];
}

export function recordTimestamp(rec: Rec): number | null {
  if (typeof rec.timestamp !== "string") return null;
  const t = Date.parse(rec.timestamp);
  return Number.isNaN(t) ? null : t;
}

function assistantText(rec: Rec): string | undefined {
  const message = rec.message;
  if (!isRecord(message)) return undefined;
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && isNonEmptyString(block.text))
      parts.push(block.text.trim());
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function extractTurn(rec: Rec): TurnRow | undefined {
  let role: TurnRow["role"];
  let text: string | undefined;
  if (rec.type === "user") {
    role = "user";
    text = eligiblePromptText(rec);
  } else if (rec.type === "assistant") {
    role = "assistant";
    text = assistantText(rec);
  } else {
    return undefined;
  }
  if (!text) return undefined;
  return {
    uuid: isNonEmptyString(rec.uuid) ? rec.uuid : null,
    role,
    ts: recordTimestamp(rec),
    text,
    searchText: searchTextOf(text),
  };
}

export function emptySessionFields(): SessionFields {
  return {
    cwd: null,
    branch: null,
    lastActivity: null,
    customTitle: null,
    aiTitle: null,
    summaryTitle: null,
    firstPrompt: null,
    titleValues: [],
  };
}

function addTitleValue(fields: SessionFields, value: string): void {
  if (!fields.titleValues.includes(value)) fields.titleValues.push(value);
}

export function mergeRecordFields(fields: SessionFields, rec: Rec): void {
  if (fields.cwd === null && isNonEmptyString(rec.cwd)) fields.cwd = rec.cwd;
  if (isNonEmptyString(rec.gitBranch)) fields.branch = rec.gitBranch;
  const ts = recordTimestamp(rec);
  if (ts !== null && (fields.lastActivity === null || ts > fields.lastActivity))
    fields.lastActivity = ts;

  switch (rec.type) {
    case "custom-title":
      if (isNonEmptyString(rec.customTitle)) {
        fields.customTitle = rec.customTitle;
        addTitleValue(fields, rec.customTitle);
      }
      break;
    case "ai-title":
      if (isNonEmptyString(rec.aiTitle)) {
        fields.aiTitle ??= rec.aiTitle;
        addTitleValue(fields, rec.aiTitle);
      }
      break;
    case "summary":
      if (isNonEmptyString(rec.summary)) {
        fields.summaryTitle ??= rec.summary;
        addTitleValue(fields, rec.summary);
      }
      break;
    case "user":
      if (fields.firstPrompt === null) {
        const prompt = eligiblePromptText(rec);
        if (prompt) fields.firstPrompt = truncateTitle(prompt);
      }
      break;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/turnExtractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/turnExtractor.ts test/main/search/turnExtractor.test.ts
git add src/search/turnExtractor.ts test/main/search/turnExtractor.test.ts
git commit -m "feat: extract conversation turns and session fields for search (#206)"
```

---

### Task 4: `prExtractor` — validated PR links from `pr-link` and `gh pr create`

**Files:**
- Create: `src/search/prExtractor.ts`
- Test: `test/main/search/prExtractor.test.ts`

**Interfaces:**
- Consumes: `recordTimestamp` (Task 3); `isRecord` from `src/typeGuards.ts`.
- Produces:
  - `export interface PrRef { repo: string; number: number; url: string }`
  - `export interface PrLinkObs extends PrRef { createdHere: boolean; firstSeen: number | null; lastSeen: number | null }`
  - `export const PENDING_CAP = 20`
  - `export function parsePrUrl(raw: string): PrRef | undefined` — strips trailing path segments, `?…` and `#…` after `/pull/<n>`.
  - `export function validatePrRef(repo: unknown, number: unknown, url: unknown): PrRef | undefined`
  - `export interface PrExtraction { links: PrLinkObs[]; pending: string[]; invalid: number }`
  - `export function extractPrs(rec: Record<string, unknown>, pending: readonly string[]): PrExtraction`
  - `export function linkKey(ref: { repo: string; number: number }): string` — `"<repo lowercased>#<number>"`.
  - `export function mergeLinkObs(into: Map<string, PrLinkObs>, link: PrLinkObs): void`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  extractPrs,
  linkKey,
  mergeLinkObs,
  parsePrUrl,
  PENDING_CAP,
  validatePrRef,
  type PrLinkObs,
} from "../../../src/search/prExtractor";

const T1 = "2026-10-01T10:00:00.000Z";
const prLink = (repo: string, n: number, url: string, ts = T1) => ({
  type: "pr-link",
  sessionId: "s",
  prNumber: n,
  prRepository: repo,
  prUrl: url,
  timestamp: ts,
});
const createUse = (id: string, tool = "Bash", command = "gh pr create --fill") => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", id, name: tool, input: { command } }] },
});
const result = (id: string, content: unknown, ts = T1) => ({
  type: "user",
  timestamp: ts,
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});

describe("validatePrRef / parsePrUrl", () => {
  test("accepts a matching record, comparing repo case-insensitively", () => {
    expect(
      validatePrRef("Owner/Repo.Name", 12, "https://github.com/owner/repo.name/pull/12"),
    ).toEqual({ repo: "Owner/Repo.Name", number: 12, url: "https://github.com/owner/repo.name/pull/12" });
  });

  test("strips trailing segments, query and fragment", () => {
    expect(parsePrUrl("https://github.com/o/r/pull/7/files?x=1#y")).toEqual({
      repo: "o/r",
      number: 7,
      url: "https://github.com/o/r/pull/7",
    });
  });

  test.each([
    ["bad repo chars", "o/r;rm", 1, "https://github.com/o/r/pull/1"],
    ["number mismatch", "o/r", 2, "https://github.com/o/r/pull/1"],
    ["repo mismatch", "o/x", 1, "https://github.com/o/r/pull/1"],
    ["zero", "o/r", 0, "https://github.com/o/r/pull/0"],
    ["2^31", "o/r", 2 ** 31, `https://github.com/o/r/pull/${2 ** 31}`],
    ["http", "o/r", 1, "http://github.com/o/r/pull/1"],
    ["other host", "o/r", 1, "https://gitlab.com/o/r/pull/1"],
    ["string number", "o/r", "1", "https://github.com/o/r/pull/1"],
  ])("rejects %s", (_name, repo, n, url) => {
    expect(validatePrRef(repo, n, url)).toBeUndefined();
  });
});

describe("extractPrs", () => {
  test("a pr-link record yields a link seen at its timestamp", () => {
    const out = extractPrs(prLink("o/r", 5, "https://github.com/o/r/pull/5"), []);
    expect(out.links).toEqual([
      {
        repo: "o/r",
        number: 5,
        url: "https://github.com/o/r/pull/5",
        createdHere: false,
        firstSeen: Date.parse(T1),
        lastSeen: Date.parse(T1),
      },
    ]);
    expect(out.invalid).toBe(0);
  });

  test("an invalid pr-link is counted, not stored", () => {
    const out = extractPrs(prLink("o/r", 5, "https://github.com/o/r/pull/6"), []);
    expect(out.links).toEqual([]);
    expect(out.invalid).toBe(1);
  });

  test.each(["Bash", "PowerShell"])(
    "pairs a %s gh pr create with its result across calls",
    (tool) => {
      const a = extractPrs(createUse("t1", tool), []);
      expect(a.pending).toEqual(["t1"]);
      const b = extractPrs(result("t1", "https://github.com/o/r/pull/9\n"), a.pending);
      expect(b.pending).toEqual([]);
      expect(b.links).toEqual([
        {
          repo: "o/r",
          number: 9,
          url: "https://github.com/o/r/pull/9",
          createdHere: true,
          firstSeen: Date.parse(T1),
          lastSeen: null,
        },
      ]);
    },
  );

  test("block-array tool results are read too", () => {
    const out = extractPrs(
      result("t1", [{ type: "text", text: "Creating…\nhttps://github.com/o/r/pull/3" }]),
      ["t1"],
    );
    expect(out.links.map((l) => l.number)).toEqual([3]);
  });

  test("grep-style lines never match", () => {
    const out = extractPrs(
      result("t1", "docs/x.md:12:https://github.com/o/r/pull/3"),
      ["t1"],
    );
    expect(out.links).toEqual([]);
    expect(out.pending).toEqual([]);
  });

  test("a result for an unknown tool_use id is ignored", () => {
    expect(extractPrs(result("zz", "https://github.com/o/r/pull/3"), ["t1"]).links).toEqual([]);
  });

  test("other tools and other commands are not pending", () => {
    expect(extractPrs(createUse("t1", "Read"), []).pending).toEqual([]);
    expect(extractPrs(createUse("t1", "Bash", "gh pr view 3"), []).pending).toEqual([]);
  });

  test("pending list is capped, oldest dropped", () => {
    let pending: string[] = [];
    for (let i = 0; i < PENDING_CAP + 3; i++)
      pending = extractPrs(createUse(`t${i}`), pending).pending;
    expect(pending).toHaveLength(PENDING_CAP);
    expect(pending[0]).toBe("t3");
  });
});

describe("mergeLinkObs", () => {
  test("collapses by case-insensitive repo and number", () => {
    const into = new Map<string, PrLinkObs>();
    const base = { repo: "O/R", number: 1, url: "https://github.com/O/R/pull/1" };
    mergeLinkObs(into, { ...base, createdHere: false, firstSeen: 20, lastSeen: 20 });
    mergeLinkObs(into, { ...base, repo: "o/r", createdHere: true, firstSeen: 10, lastSeen: null });
    mergeLinkObs(into, { ...base, createdHere: false, firstSeen: 30, lastSeen: 30 });
    expect([...into.values()]).toEqual([
      { ...base, createdHere: true, firstSeen: 10, lastSeen: 30 },
    ]);
    expect(linkKey({ repo: "O/R", number: 1 })).toBe("o/r#1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/prExtractor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/search/prExtractor.ts`:

```ts
import { isRecord } from "../typeGuards";
import { recordTimestamp } from "./turnExtractor";

export interface PrRef {
  repo: string;
  number: number;
  url: string;
}

export interface PrLinkObs extends PrRef {
  createdHere: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
}

export interface PrExtraction {
  links: PrLinkObs[];
  pending: string[];
  invalid: number;
}

export const PENDING_CAP = 20;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PR_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)$/;
const PR_URL_PREFIX_RE =
  /^(https:\/\/github\.com\/[^/?#\s]+\/[^/?#\s]+\/pull\/\d+)(?:[/?#].*)?$/;
const PR_CREATE_TOOLS = new Set(["Bash", "PowerShell"]);

function validNumber(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n < 2 ** 31;
}

function exactPrUrl(url: string): PrRef | undefined {
  const m = PR_URL_RE.exec(url);
  if (!m) return undefined;
  const number = Number(m[2]);
  return validNumber(number) ? { repo: m[1], number, url } : undefined;
}

export function parsePrUrl(raw: string): PrRef | undefined {
  const m = PR_URL_PREFIX_RE.exec(raw.trim());
  return m ? exactPrUrl(m[1]) : undefined;
}

export function validatePrRef(
  repo: unknown,
  number: unknown,
  url: unknown,
): PrRef | undefined {
  if (typeof repo !== "string" || !REPO_RE.test(repo)) return undefined;
  if (typeof number !== "number" || !validNumber(number)) return undefined;
  if (typeof url !== "string") return undefined;
  const fromUrl = parsePrUrl(url);
  if (!fromUrl) return undefined;
  if (fromUrl.repo.toLowerCase() !== repo.toLowerCase()) return undefined;
  if (fromUrl.number !== number) return undefined;
  return { repo, number, url: fromUrl.url };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => isRecord(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

function contentBlocks(rec: Record<string, unknown>): unknown[] {
  const message = rec.message;
  return isRecord(message) && Array.isArray(message.content) ? message.content : [];
}

export function extractPrs(
  rec: Record<string, unknown>,
  pending: readonly string[],
): PrExtraction {
  const links: PrLinkObs[] = [];
  let next = [...pending];
  let invalid = 0;
  const ts = recordTimestamp(rec);

  if (rec.type === "pr-link") {
    const ref = validatePrRef(rec.prRepository, rec.prNumber, rec.prUrl);
    if (ref) links.push({ ...ref, createdHere: false, firstSeen: ts, lastSeen: ts });
    else invalid++;
  } else if (rec.type === "assistant") {
    for (const b of contentBlocks(rec)) {
      if (
        isRecord(b) &&
        b.type === "tool_use" &&
        typeof b.id === "string" &&
        typeof b.name === "string" &&
        PR_CREATE_TOOLS.has(b.name) &&
        isRecord(b.input) &&
        typeof b.input.command === "string" &&
        b.input.command.includes("gh pr create")
      ) {
        const id = b.id;
        next = next.filter((p) => p !== id);
        next.push(id);
      }
    }
    if (next.length > PENDING_CAP) next = next.slice(next.length - PENDING_CAP);
  } else if (rec.type === "user") {
    for (const b of contentBlocks(rec)) {
      if (!isRecord(b) || b.type !== "tool_result") continue;
      const id = b.tool_use_id;
      if (typeof id !== "string" || !next.includes(id)) continue;
      next = next.filter((p) => p !== id);
      // gh pr create prints the URL alone on a line; anything else is not its output.
      for (const line of toolResultText(b.content).split(/\r?\n/)) {
        const ref = exactPrUrl(line.trim());
        if (ref) links.push({ ...ref, createdHere: true, firstSeen: ts, lastSeen: null });
      }
    }
  }
  return { links, pending: next, invalid };
}

export function linkKey(ref: { repo: string; number: number }): string {
  return `${ref.repo.toLowerCase()}#${ref.number}`;
}

const minNullable = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);
const maxNullable = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.max(a, b);

export function mergeLinkObs(into: Map<string, PrLinkObs>, link: PrLinkObs): void {
  const key = linkKey(link);
  const prev = into.get(key);
  if (!prev) {
    into.set(key, { ...link });
    return;
  }
  prev.createdHere ||= link.createdHere;
  prev.firstSeen = minNullable(prev.firstSeen, link.firstSeen);
  prev.lastSeen = maxNullable(prev.lastSeen, link.lastSeen);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/prExtractor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/prExtractor.ts test/main/search/prExtractor.test.ts
git add src/search/prExtractor.ts test/main/search/prExtractor.test.ts
git commit -m "feat: extract validated PR links from pr-link and gh pr create (#206)"
```

---

### Task 5: `fileCursor` — change detection decision

**Files:**
- Create: `src/search/fileCursor.ts`
- Test: `test/main/search/fileCursor.test.ts`

**Interfaces:**
- Produces:
  - `export const HEAD_MAX = 4096; export const ANCHOR_MAX = 256;`
  - `export interface CursorState { offset: number; headLen: number; headHash: string | null; anchorHash: string | null; extractVersion: number }`
  - `export type FilePlan = { kind: "new" } | { kind: "unchanged" } | { kind: "verify" } | { kind: "rewrite"; reason: "stale" | "truncated" }`
  - `export function classifyFile(row: CursorState | undefined, size: number, extractVersion: number): FilePlan`
  - `export interface Span { start: number; length: number }`
  - `export function headSpan(offset: number): Span` — span stored after an ingest that ended at `offset`.
  - `export function anchorSpan(offset: number): Span`
  - `export function verifySpans(row: CursorState): { head: Span; anchor: Span }` — spans to hash on the CURRENT file to verify an append (head uses the stored `headLen`).
  - `export function decideAppend(row: CursorState, headHashNow: string, anchorHashNow: string): "appended" | "rewritten"`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  anchorSpan,
  classifyFile,
  decideAppend,
  headSpan,
  verifySpans,
  type CursorState,
} from "../../../src/search/fileCursor";

const row = (over: Partial<CursorState> = {}): CursorState => ({
  offset: 1000,
  headLen: 1000,
  headHash: "H",
  anchorHash: "A",
  extractVersion: 1,
  ...over,
});

describe("classifyFile", () => {
  test("no row is new", () => {
    expect(classifyFile(undefined, 10, 1)).toEqual({ kind: "new" });
  });
  test("same size as offset is unchanged", () => {
    expect(classifyFile(row(), 1000, 1)).toEqual({ kind: "unchanged" });
  });
  test("bigger needs verification", () => {
    expect(classifyFile(row(), 1500, 1)).toEqual({ kind: "verify" });
  });
  test("smaller is a truncation rewrite", () => {
    expect(classifyFile(row(), 900, 1)).toEqual({ kind: "rewrite", reason: "truncated" });
  });
  test("an older extract version is stale even when unchanged", () => {
    expect(classifyFile(row({ extractVersion: 0 }), 1000, 1)).toEqual({
      kind: "rewrite",
      reason: "stale",
    });
  });
});

describe("spans", () => {
  test("head covers at most 4096 bytes, anchor at most 256 ending at offset", () => {
    expect(headSpan(100)).toEqual({ start: 0, length: 100 });
    expect(headSpan(10_000)).toEqual({ start: 0, length: 4096 });
    expect(anchorSpan(100)).toEqual({ start: 0, length: 100 });
    expect(anchorSpan(10_000)).toEqual({ start: 9744, length: 256 });
  });

  test("a file ingested below 4096 bytes is verified over its stored head length", () => {
    expect(verifySpans(row({ offset: 3000, headLen: 3000 }))).toEqual({
      head: { start: 0, length: 3000 },
      anchor: { start: 2744, length: 256 },
    });
  });
});

describe("decideAppend", () => {
  test("both hashes equal is an append", () => {
    expect(decideAppend(row(), "H", "A")).toBe("appended");
  });
  test("a changed head is a rewrite", () => {
    expect(decideAppend(row(), "X", "A")).toBe("rewritten");
  });
  test("a changed middle (anchor) is a rewrite", () => {
    expect(decideAppend(row(), "H", "X")).toBe("rewritten");
  });
  test("a row without stored hashes is a rewrite", () => {
    expect(decideAppend(row({ headHash: null }), "H", "A")).toBe("rewritten");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/fileCursor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/search/fileCursor.ts`:

```ts
export const HEAD_MAX = 4096;
export const ANCHOR_MAX = 256;

export interface CursorState {
  offset: number;
  headLen: number;
  headHash: string | null;
  anchorHash: string | null;
  extractVersion: number;
}

export type FilePlan =
  | { kind: "new" }
  | { kind: "unchanged" }
  | { kind: "verify" }
  | { kind: "rewrite"; reason: "stale" | "truncated" };

export interface Span {
  start: number;
  length: number;
}

export function classifyFile(
  row: CursorState | undefined,
  size: number,
  extractVersion: number,
): FilePlan {
  if (!row) return { kind: "new" };
  if (row.extractVersion !== extractVersion) return { kind: "rewrite", reason: "stale" };
  if (size < row.offset) return { kind: "rewrite", reason: "truncated" };
  if (size === row.offset) return { kind: "unchanged" };
  return { kind: "verify" };
}

export function headSpan(offset: number): Span {
  return { start: 0, length: Math.min(offset, HEAD_MAX) };
}

export function anchorSpan(offset: number): Span {
  const length = Math.min(offset, ANCHOR_MAX);
  return { start: offset - length, length };
}

// The head is re-hashed over the STORED length: a file ingested at 3000 bytes that
// has since grown past 4096 must compare its first 3000 bytes, not 4096.
export function verifySpans(row: CursorState): { head: Span; anchor: Span } {
  return { head: { start: 0, length: row.headLen }, anchor: anchorSpan(row.offset) };
}

export function decideAppend(
  row: CursorState,
  headHashNow: string,
  anchorHashNow: string,
): "appended" | "rewritten" {
  return row.headHash !== null &&
    row.anchorHash !== null &&
    headHashNow === row.headHash &&
    anchorHashNow === row.anchorHash
    ? "appended"
    : "rewritten";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/fileCursor.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/fileCursor.ts test/main/search/fileCursor.test.ts
git add src/search/fileCursor.ts test/main/search/fileCursor.test.ts
git commit -m "feat: add fileCursor change detection for incremental ingest (#206)"
```

---

### Task 6: `tombstone` — deletion state machine

**Files:**
- Create: `src/search/tombstone.ts`
- Test: `test/main/search/tombstone.test.ts`

**Interfaces:**
- Produces:
  - `export const MISSING_GRACE_MS = 60_000`
  - `export type ParentState = "readable" | "missing" | "error"`
  - `export type Presence = "present" | "absent"`
  - `export function presence(statErrorCode: string | undefined, parent: ParentState): Presence` — `statErrorCode` is `undefined` when `stat` succeeded.
  - `export interface TombstoneState { missingSince: number | null; deletedAt: number | null }`
  - `export function nextTombstone(prev: TombstoneState, p: Presence, now: number): TombstoneState`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  MISSING_GRACE_MS,
  nextTombstone,
  presence,
} from "../../../src/search/tombstone";

describe("presence", () => {
  test("a successful stat is present", () => {
    expect(presence(undefined, "readable")).toBe("present");
  });
  test("ENOENT under a readable parent is absent", () => {
    expect(presence("ENOENT", "readable")).toBe("absent");
  });
  test("a missing parent folder under a readable root is absent", () => {
    expect(presence("ENOENT", "missing")).toBe("absent");
  });
  test("ENOENT under an unreadable parent counts as present", () => {
    expect(presence("ENOENT", "error")).toBe("present");
  });
  test.each(["EBUSY", "EPERM", "EACCES", "EMFILE", "EIO"])("%s counts as present", (code) => {
    expect(presence(code, "readable")).toBe("present");
  });
});

describe("nextTombstone", () => {
  const live = { missingSince: null, deletedAt: null };
  test("first absence sets missingSince only", () => {
    expect(nextTombstone(live, "absent", 1000)).toEqual({ missingSince: 1000, deletedAt: null });
  });
  test("absent again within 60 s is not tombstoned", () => {
    const s = { missingSince: 1000, deletedAt: null };
    expect(nextTombstone(s, "absent", 1000 + MISSING_GRACE_MS - 1)).toEqual(s);
  });
  test("absent again after 60 s is tombstoned", () => {
    expect(
      nextTombstone({ missingSince: 1000, deletedAt: null }, "absent", 1000 + MISSING_GRACE_MS),
    ).toEqual({ missingSince: 1000, deletedAt: 1000 + MISSING_GRACE_MS });
  });
  test("a tombstone stays put while absent", () => {
    const s = { missingSince: 1000, deletedAt: 70_000 };
    expect(nextTombstone(s, "absent", 999_999)).toEqual(s);
  });
  test("reappearing clears both", () => {
    expect(nextTombstone({ missingSince: 1000, deletedAt: 70_000 }, "present", 5)).toEqual(live);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/tombstone.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/search/tombstone.ts`:

```ts
// A time floor rather than a pass count: two passes can run seconds apart at launch.
export const MISSING_GRACE_MS = 60_000;

export type ParentState = "readable" | "missing" | "error";
export type Presence = "present" | "absent";

export interface TombstoneState {
  missingSince: number | null;
  deletedAt: number | null;
}

export function presence(
  statErrorCode: string | undefined,
  parent: ParentState,
): Presence {
  if (statErrorCode === undefined) return "present";
  return statErrorCode === "ENOENT" && parent !== "error" ? "absent" : "present";
}

export function nextTombstone(
  prev: TombstoneState,
  p: Presence,
  now: number,
): TombstoneState {
  if (p === "present") return { missingSince: null, deletedAt: null };
  if (prev.deletedAt !== null) return prev;
  if (prev.missingSince === null) return { missingSince: now, deletedAt: null };
  return now - prev.missingSince >= MISSING_GRACE_MS
    ? { missingSince: prev.missingSince, deletedAt: now }
    : prev;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/tombstone.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/tombstone.ts test/main/search/tombstone.test.ts
git add src/search/tombstone.ts test/main/search/tombstone.test.ts
git commit -m "feat: add the transcript tombstone state machine (#206)"
```

---

### Task 7: `searchDb` — open, schema, session/turn/link writes

**Files:**
- Create: `src/search/searchDb.ts`
- Test: `test/main/search/searchDb.test.ts`

**Interfaces:**
- Consumes: `SessionFields`, `TurnRow` (Task 3); `PrLinkObs` (Task 4); `TombstoneState` (Task 6).
- Produces:
  - `export const SEARCH_DB_FILENAME = "search.db"; export const SCHEMA_VERSION = 1;`
  - `export const FTS_DDL: string`
  - `export interface OpenOptions { platform: NodeJS.Platform; ftsDdl?: string }` — `ftsDdl` is a test seam that simulates a runtime without FTS5.
  - `export interface SessionRow { root: string; sid: string; cwd: string | null; branch: string | null; title: string | null; titlesText: string | null; customTitle: string | null; aiTitle: string | null; summaryTitle: string | null; firstPrompt: string | null; lastActivity: number | null; path: string; size: number; offset: number; headLen: number; headHash: string | null; anchorHash: string | null; pendingPrCreate: string[]; extractVersion: number; missingSince: number | null; deletedAt: number | null }`
  - `export interface CursorWrite { offset: number; headLen: number; headHash: string; anchorHash: string }`
  - `export interface ChunkWrite { root: string; sid: string; path: string; size: number; cursor: CursorWrite; fields: SessionFields; title: string; turns: TurnRow[]; links: PrLinkObs[]; pending: string[]; extractVersion: number }`
  - `export interface SearchDb` with `readonly ftsOk: boolean` and the methods `getSession(root, sid): SessionRow | undefined`, `listSessions(root): SessionRow[]`, `writeChunk(w: ChunkWrite): { turnsInserted: number }`, `resetSession(root, sid): void`, `setPath(root, sid, path): void`, `setTombstone(root, sid, t: TombstoneState): void`, `restampTitle(root, sid, title, extractVersion): void`, `getMeta(key): string | undefined`, `setMeta(key, value): void`, `optimizeFts(): void`, `close(): void` (idempotent). Tasks 8 and 9 add methods to this interface.
  - `export function openSearchDb(dir: string, opts: OpenOptions): SearchDb` — closes the connection before rethrowing any open error.

- [ ] **Step 1: Write the failing test**

`test/main/search/searchDb.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openSearchDb,
  SCHEMA_VERSION,
  SEARCH_DB_FILENAME,
  type ChunkWrite,
  type SearchDb,
} from "../../../src/search/searchDb";
import { emptySessionFields } from "../../../src/search/turnExtractor";
import type { PrLinkObs } from "../../../src/search/prExtractor";

const ROOT = "/projects";
let dir: string;
let db: SearchDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-searchdb-"));
  db = openSearchDb(dir, { platform: process.platform });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// A second, read-only connection, so assertions do not go through the API under test.
function q<T = Record<string, unknown>>(
  sql: string,
  ...args: (string | number)[]
): T[] {
  const ro = new DatabaseSync(join(dir, SEARCH_DB_FILENAME), { readOnly: true });
  try {
    return ro.prepare(sql).all(...args) as T[];
  } finally {
    ro.close();
  }
}

const chunk = (over: Partial<ChunkWrite> = {}): ChunkWrite => ({
  root: ROOT,
  sid: "s1",
  path: "/projects/a/s1.jsonl",
  size: 100,
  cursor: { offset: 100, headLen: 100, headHash: "h", anchorHash: "a" },
  fields: { ...emptySessionFields(), cwd: "D:\\src\\x", titleValues: ["T1", "T2"] },
  title: "T1",
  turns: [],
  links: [],
  pending: [],
  extractVersion: 1,
  ...over,
});
const turn = (uuid: string | null, text: string) => ({
  uuid,
  role: "user" as const,
  ts: 1,
  text,
  searchText: text.toLowerCase(),
});
const link = (repo: string, n: number, over: Partial<PrLinkObs> = {}): PrLinkObs => ({
  repo,
  number: n,
  url: `https://github.com/${repo}/pull/${n}`,
  createdHere: false,
  firstSeen: 10,
  lastSeen: 10,
  ...over,
});
const match = (term: string) =>
  q("SELECT rowid FROM fts WHERE fts MATCH ?", `"${term}"`);

describe("openSearchDb", () => {
  test("creates the schema in WAL mode at the current user_version", () => {
    expect(q("PRAGMA journal_mode")[0].journal_mode).toBe("wal");
    expect(q("PRAGMA user_version")[0].user_version).toBe(SCHEMA_VERSION);
    const tables = q<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["session", "turn", "fts", "pr", "session_pr", "meta"]),
    );
    expect(db.ftsOk).toBe(true);
  });

  test.skipIf(process.platform === "win32")("creates the file owner-only", () => {
    expect(statSync(join(dir, SEARCH_DB_FILENAME)).mode & 0o777).toBe(0o600);
  });

  test("refuses a database written by a newer build", () => {
    db.close();
    const w = new DatabaseSync(join(dir, SEARCH_DB_FILENAME));
    w.exec("PRAGMA user_version = 99");
    w.close();
    expect(() => openSearchDb(dir, { platform: process.platform })).toThrow(/newer/);
  });

  test("without FTS5 writes still land, and a later open rebuilds the index", () => {
    const sub = join(dir, "nofts");
    mkdirSync(sub);
    const noFts = openSearchDb(sub, {
      platform: process.platform,
      ftsDdl: "CREATE VIRTUAL TABLE fts USING no_such_module(search_text)",
    });
    expect(noFts.ftsOk).toBe(false);
    noFts.writeChunk(chunk({ turns: [turn("u1", "Rate limit")] }));
    expect(noFts.getMeta("fts_ok")).toBe("0");
    noFts.close();

    const again = openSearchDb(sub, { platform: process.platform });
    expect(again.ftsOk).toBe(true);
    again.close();
    const ro = new DatabaseSync(join(sub, SEARCH_DB_FILENAME), { readOnly: true });
    expect(ro.prepare("SELECT rowid FROM fts WHERE fts MATCH '\"rate\"'").all()).toHaveLength(1);
    ro.close();
  });
});

describe("writes", () => {
  test("writeChunk round-trips session fields and the cursor", () => {
    db.writeChunk(chunk({ pending: ["t1"] }));
    expect(db.getSession(ROOT, "s1")).toMatchObject({
      cwd: "D:\\src\\x",
      title: "T1",
      titlesText: "T1\nT2",
      offset: 100,
      headLen: 100,
      headHash: "h",
      anchorHash: "a",
      pendingPrCreate: ["t1"],
      extractVersion: 1,
      missingSince: null,
      deletedAt: null,
    });
  });

  test("turns are searchable and a replayed uuid is stored once", () => {
    const r = db.writeChunk(
      chunk({
        turns: [turn("u1", "Rate limit"), turn("u1", "Rate limit"), turn(null, "x"), turn(null, "x")],
      }),
    );
    expect(r.turnsInserted).toBe(3);
    expect(q("SELECT id FROM turn")).toHaveLength(3);
    expect(q("SELECT rowid FROM fts WHERE fts MATCH ?", '"rate" AND "limit"')).toHaveLength(1);
  });

  test("resetSession removes turns, FTS rows and links, and rewinds the cursor", () => {
    db.writeChunk(chunk({ turns: [turn("u1", "alpha")], links: [link("o/r", 1)], pending: ["t"] }));
    db.resetSession(ROOT, "s1");
    expect(q("SELECT id FROM turn")).toEqual([]);
    expect(q("SELECT sid FROM session_pr")).toEqual([]);
    expect(match("alpha")).toEqual([]);
    expect(db.getSession(ROOT, "s1")).toMatchObject({
      offset: 0,
      headLen: 0,
      headHash: null,
      pendingPrCreate: [],
    });
  });

  test("links collapse case-insensitively and keep created_here, min first_seen, max last_seen", () => {
    db.writeChunk(chunk({ links: [link("O/R", 1, { firstSeen: 20, lastSeen: 20 })] }));
    db.writeChunk(chunk({ links: [link("o/r", 1, { createdHere: true, firstSeen: 10, lastSeen: null })] }));
    db.writeChunk(chunk({ links: [link("O/R", 1, { firstSeen: 30, lastSeen: 30 })] }));
    expect(q("SELECT created_here, first_seen, last_seen FROM session_pr")).toEqual([
      { created_here: 1, first_seen: 10, last_seen: 30 },
    ]);
    expect(q("SELECT repo, state FROM pr")).toEqual([{ repo: "O/R", state: null }]);
  });

  test("a write clears a tombstone", () => {
    db.writeChunk(chunk());
    db.setTombstone(ROOT, "s1", { missingSince: 5, deletedAt: 6 });
    expect(db.getSession(ROOT, "s1")).toMatchObject({ missingSince: 5, deletedAt: 6 });
    db.writeChunk(chunk());
    expect(db.getSession(ROOT, "s1")).toMatchObject({ missingSince: null, deletedAt: null });
  });

  test("setPath, restampTitle and listSessions", () => {
    db.writeChunk(chunk());
    db.setPath(ROOT, "s1", "/projects/b/s1.jsonl");
    db.restampTitle(ROOT, "s1", "New", 2);
    expect(db.getSession(ROOT, "s1")).toMatchObject({
      path: "/projects/b/s1.jsonl",
      title: "New",
      extractVersion: 2,
    });
    expect(db.listSessions(ROOT).map((s) => s.sid)).toEqual(["s1"]);
    expect(db.listSessions("/other")).toEqual([]);
  });

  test("meta upserts and optimize keeps matches", () => {
    expect(db.getMeta("k")).toBeUndefined();
    db.setMeta("k", "v");
    db.setMeta("k", "w");
    expect(db.getMeta("k")).toBe("w");
    db.writeChunk(chunk({ turns: [turn("u1", "alpha")] }));
    db.optimizeFts();
    expect(match("alpha")).toHaveLength(1);
  });

  test("close is idempotent", () => {
    db.close();
    expect(() => db.close()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchDb.test.ts`
Expected: FAIL — cannot resolve `src/search/searchDb`.

- [ ] **Step 3: Implement**

`src/search/searchDb.ts`:

```ts
// The only module that touches node:sqlite, so an API change or a move to
// utilityProcess stays contained here.
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PrLinkObs } from "./prExtractor";
import type { TombstoneState } from "./tombstone";
import type { SessionFields, TurnRow } from "./turnExtractor";

export const SEARCH_DB_FILENAME = "search.db";
export const SCHEMA_VERSION = 1;

type Row = Record<string, unknown>;

const SESSION_COLUMNS =
  "root, sid, cwd, branch, title, titles_text, custom_title, ai_title, summary_title, " +
  "first_prompt, last_activity, path, size, offset, head_len, head_hash, anchor_hash, " +
  "pending_pr_create, extract_version, missing_since, deleted_at";

const SCHEMA_V1 = `
CREATE TABLE session (
  root TEXT NOT NULL,
  sid TEXT NOT NULL,
  cwd TEXT,
  branch TEXT,
  title TEXT,
  titles_text TEXT,
  custom_title TEXT,
  ai_title TEXT,
  summary_title TEXT,
  first_prompt TEXT,
  last_activity INTEGER,
  path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  head_len INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT,
  anchor_hash TEXT,
  pending_pr_create TEXT,
  extract_version INTEGER NOT NULL DEFAULT 0,
  missing_since INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (root, sid)
);
CREATE TABLE turn (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL,
  sid TEXT NOT NULL,
  uuid TEXT,
  role TEXT NOT NULL,
  ts INTEGER,
  text TEXT NOT NULL,
  search_text TEXT NOT NULL,
  UNIQUE (root, sid, uuid)
);
CREATE INDEX turn_session ON turn (root, sid);
CREATE TABLE pr (
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  state TEXT,
  is_draft INTEGER,
  body TEXT,
  fetched_at INTEGER,
  fetch_error TEXT,
  PRIMARY KEY (repo, number)
);
CREATE TABLE session_pr (
  root TEXT NOT NULL,
  sid TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  created_here INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER,
  last_seen INTEGER,
  PRIMARY KEY (root, sid, repo, number)
);
CREATE INDEX session_pr_pr ON session_pr (repo, number);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

export const FTS_DDL = `CREATE VIRTUAL TABLE fts USING fts5 (
  search_text,
  content = 'turn', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3',
  detail = column
)`;

export interface OpenOptions {
  platform: NodeJS.Platform;
  ftsDdl?: string;
}

export interface SessionRow {
  root: string;
  sid: string;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  titlesText: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summaryTitle: string | null;
  firstPrompt: string | null;
  lastActivity: number | null;
  path: string;
  size: number;
  offset: number;
  headLen: number;
  headHash: string | null;
  anchorHash: string | null;
  pendingPrCreate: string[];
  extractVersion: number;
  missingSince: number | null;
  deletedAt: number | null;
}

export interface CursorWrite {
  offset: number;
  headLen: number;
  headHash: string;
  anchorHash: string;
}

export interface ChunkWrite {
  root: string;
  sid: string;
  path: string;
  size: number;
  cursor: CursorWrite;
  fields: SessionFields;
  title: string;
  turns: TurnRow[];
  links: PrLinkObs[];
  pending: string[];
  extractVersion: number;
}

export interface SearchDb {
  readonly ftsOk: boolean;
  getSession(root: string, sid: string): SessionRow | undefined;
  listSessions(root: string): SessionRow[];
  writeChunk(w: ChunkWrite): { turnsInserted: number };
  resetSession(root: string, sid: string): void;
  setPath(root: string, sid: string, path: string): void;
  setTombstone(root: string, sid: string, t: TombstoneState): void;
  restampTitle(root: string, sid: string, title: string, extractVersion: number): void;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  optimizeFts(): void;
  close(): void;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function parsePending(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function toSessionRow(r: Row): SessionRow {
  return {
    root: String(r.root),
    sid: String(r.sid),
    cwd: str(r.cwd),
    branch: str(r.branch),
    title: str(r.title),
    titlesText: str(r.titles_text),
    customTitle: str(r.custom_title),
    aiTitle: str(r.ai_title),
    summaryTitle: str(r.summary_title),
    firstPrompt: str(r.first_prompt),
    lastActivity: num(r.last_activity),
    path: String(r.path),
    size: num(r.size) ?? 0,
    offset: num(r.offset) ?? 0,
    headLen: num(r.head_len) ?? 0,
    headHash: str(r.head_hash),
    anchorHash: str(r.anchor_hash),
    pendingPrCreate: parsePending(r.pending_pr_create),
    extractVersion: num(r.extract_version) ?? 0,
    missingSince: num(r.missing_since),
    deletedAt: num(r.deleted_at),
  };
}

// SQLite creates the file with the process umask; create it owner-only first.
function ensurePrivateFile(file: string, platform: NodeJS.Platform): void {
  if (platform !== "win32" && !existsSync(file))
    closeSync(openSync(file, "a", 0o600));
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec("PRAGMA journal_size_limit = 67108864");
}

function migrate(db: DatabaseSync): void {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as Row).user_version,
  );
  if (version > SCHEMA_VERSION)
    throw new Error(
      `search.db schema ${version} is newer than this build (${SCHEMA_VERSION})`,
    );
  if (version === 0)
    inTransaction(db, () => {
      db.exec(SCHEMA_V1);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
}

function ensureFts(db: DatabaseSync, ddl: string): boolean {
  const wasOk =
    (db.prepare("SELECT value FROM meta WHERE key = 'fts_ok'").get() as Row | undefined)
      ?.value === "1";
  const exists =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fts'")
      .get() !== undefined;
  let ok: boolean;
  try {
    if (!exists) db.exec(ddl);
    // Turns written while FTS5 was unavailable are missing from the index.
    if (!exists || !wasOk) db.exec("INSERT INTO fts(fts) VALUES('rebuild')");
    else db.prepare("SELECT rowid FROM fts LIMIT 0").all();
    ok = true;
  } catch {
    ok = false;
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('fts_ok', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(ok ? "1" : "0");
  return ok;
}

export function openSearchDb(dir: string, opts: OpenOptions): SearchDb {
  const file = join(dir, SEARCH_DB_FILENAME);
  ensurePrivateFile(file, opts.platform);
  const db = new DatabaseSync(file);
  let ftsOk: boolean;
  try {
    configure(db);
    migrate(db);
    ftsOk = ensureFts(db, opts.ftsDdl ?? FTS_DDL);
  } catch (err) {
    db.close();
    throw err;
  }

  const getSession = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE root = ? AND sid = ?`,
  );
  const listSessions = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE root = ? ORDER BY sid`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO session (${SESSION_COLUMNS})
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
     ON CONFLICT (root, sid) DO UPDATE SET
       cwd = excluded.cwd, branch = excluded.branch, title = excluded.title,
       titles_text = excluded.titles_text, custom_title = excluded.custom_title,
       ai_title = excluded.ai_title, summary_title = excluded.summary_title,
       first_prompt = excluded.first_prompt, last_activity = excluded.last_activity,
       path = excluded.path, size = excluded.size, offset = excluded.offset,
       head_len = excluded.head_len, head_hash = excluded.head_hash,
       anchor_hash = excluded.anchor_hash, pending_pr_create = excluded.pending_pr_create,
       extract_version = excluded.extract_version, missing_since = NULL, deleted_at = NULL`,
  );
  const insertTurn = db.prepare(
    `INSERT INTO turn (root, sid, uuid, role, ts, text, search_text) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT DO NOTHING RETURNING id`,
  );
  const ftsInsert = ftsOk
    ? db.prepare("INSERT INTO fts (rowid, search_text) VALUES (?, ?)")
    : null;
  const ftsDeleteSession = ftsOk
    ? db.prepare(
        `INSERT INTO fts (fts, rowid, search_text)
         SELECT 'delete', id, search_text FROM turn WHERE root = ? AND sid = ?`,
      )
    : null;
  const insertPr = db.prepare(
    "INSERT INTO pr (repo, number, url) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const upsertLink = db.prepare(
    `INSERT INTO session_pr (root, sid, repo, number, created_here, first_seen, last_seen)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (root, sid, repo, number) DO UPDATE SET
       created_here = max(created_here, excluded.created_here),
       first_seen = coalesce(min(first_seen, excluded.first_seen), first_seen, excluded.first_seen),
       last_seen = coalesce(max(last_seen, excluded.last_seen), last_seen, excluded.last_seen)`,
  );
  const deleteTurns = db.prepare("DELETE FROM turn WHERE root = ? AND sid = ?");
  const deleteLinks = db.prepare("DELETE FROM session_pr WHERE root = ? AND sid = ?");
  const rewind = db.prepare(
    `UPDATE session SET offset = 0, head_len = 0, head_hash = NULL, anchor_hash = NULL,
       pending_pr_create = '[]', title = NULL, titles_text = NULL, custom_title = NULL,
       ai_title = NULL, summary_title = NULL, first_prompt = NULL, cwd = NULL,
       branch = NULL, last_activity = NULL
     WHERE root = ? AND sid = ?`,
  );
  const setPath = db.prepare("UPDATE session SET path = ? WHERE root = ? AND sid = ?");
  const setTombstone = db.prepare(
    "UPDATE session SET missing_since = ?, deleted_at = ? WHERE root = ? AND sid = ?",
  );
  const restamp = db.prepare(
    "UPDATE session SET title = ?, extract_version = ? WHERE root = ? AND sid = ?",
  );
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );

  return {
    ftsOk,
    getSession(root, sid) {
      const r = getSession.get(root, sid) as Row | undefined;
      return r ? toSessionRow(r) : undefined;
    },
    listSessions(root) {
      return (listSessions.all(root) as Row[]).map(toSessionRow);
    },
    writeChunk(w) {
      const f = w.fields;
      return inTransaction(db, () => {
        upsertSession.run(
          w.root,
          w.sid,
          f.cwd,
          f.branch,
          w.title,
          f.titleValues.length > 0 ? f.titleValues.join("\n") : null,
          f.customTitle,
          f.aiTitle,
          f.summaryTitle,
          f.firstPrompt,
          f.lastActivity,
          w.path,
          w.size,
          w.cursor.offset,
          w.cursor.headLen,
          w.cursor.headHash,
          w.cursor.anchorHash,
          JSON.stringify(w.pending),
          w.extractVersion,
        );
        let turnsInserted = 0;
        for (const t of w.turns) {
          const r = insertTurn.get(w.root, w.sid, t.uuid, t.role, t.ts, t.text, t.searchText) as
            | Row
            | undefined;
          if (!r) continue;
          turnsInserted++;
          ftsInsert?.run(Number(r.id), t.searchText);
        }
        for (const l of w.links) {
          insertPr.run(l.repo, l.number, l.url);
          upsertLink.run(
            w.root,
            w.sid,
            l.repo,
            l.number,
            l.createdHere ? 1 : 0,
            l.firstSeen,
            l.lastSeen,
          );
        }
        return { turnsInserted };
      });
    },
    resetSession(root, sid) {
      inTransaction(db, () => {
        ftsDeleteSession?.run(root, sid);
        deleteTurns.run(root, sid);
        deleteLinks.run(root, sid);
        rewind.run(root, sid);
      });
    },
    setPath(root, sid, path) {
      setPath.run(path, root, sid);
    },
    setTombstone(root, sid, t) {
      setTombstone.run(t.missingSince, t.deletedAt, root, sid);
    },
    restampTitle(root, sid, title, extractVersion) {
      restamp.run(title, extractVersion, root, sid);
    },
    getMeta(key) {
      return str((getMeta.get(key) as Row | undefined)?.value) ?? undefined;
    },
    setMeta(key, value) {
      setMeta.run(key, value);
    },
    optimizeFts() {
      if (ftsOk) db.exec("INSERT INTO fts(fts) VALUES('optimize')");
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchDb.test.ts`
Expected: PASS (the `ExperimentalWarning: SQLite is an experimental feature` line on stderr is expected).

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/searchDb.ts test/main/search/searchDb.test.ts
git add src/search/searchDb.ts test/main/search/searchDb.test.ts
git commit -m "feat: add the search.db store with schema, FTS5 and chunk writes (#206)"
```

---

### Task 8: `searchDb` — PR queries and enrichment writes

**Files:**
- Modify: `src/ipcTypes.ts` (append the PR wire types)
- Modify: `src/search/searchDb.ts`
- Test: `test/main/search/searchDb.prs.test.ts`

**Interfaces:**
- Consumes: `openSearchDb`, `ChunkWrite` (Task 7).
- Produces:
  - In `src/ipcTypes.ts`: `export const PR_STATES = ["OPEN", "MERGED", "CLOSED"] as const; export type PrState = (typeof PR_STATES)[number];` `export const isPrState: (v: unknown) => v is PrState;` `export interface SessionPrLink { repo: string; number: number; url: string; title: string | null; state: PrState | null; isDraft: boolean; createdHere: boolean; firstSeen: number | null; lastSeen: number | null }` `export type SessionPrsResult = Record<string, SessionPrLink[]>;`
  - In `src/search/searchDb.ts`: `export const OPEN_REFRESH_MS = 600_000; export const CLOSED_REFRESH_MS = 86_400_000;` `export interface PrKey { repo: string; number: number }` `export interface PrDetails { title: string; state: PrState; isDraft: boolean; body: string }`
  - New `SearchDb` methods: `prsForSessions(root: string, sids: string[]): SessionPrsResult` (only sids with links appear; each list ordered by number descending), `duePrs(now: number): PrKey[]`, `applyPrDetails(key: PrKey, d: PrDetails, now: number): void`, `markPrError(key: PrKey, code: string, now: number): void`, `pruneOrphanPrs(): number`.

- [ ] **Step 1: Write the failing test**

`test/main/search/searchDb.prs.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CLOSED_REFRESH_MS,
  OPEN_REFRESH_MS,
  openSearchDb,
  SEARCH_DB_FILENAME,
  type ChunkWrite,
  type PrDetails,
  type SearchDb,
} from "../../../src/search/searchDb";
import { emptySessionFields } from "../../../src/search/turnExtractor";

const ROOT = "/projects";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const MIN = 60_000;
let dir: string;
let db: SearchDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-searchdb-prs-"));
  db = openSearchDb(dir, { platform: process.platform });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function q<T = Record<string, unknown>>(sql: string): T[] {
  const ro = new DatabaseSync(join(dir, SEARCH_DB_FILENAME), { readOnly: true });
  try {
    return ro.prepare(sql).all() as T[];
  } finally {
    ro.close();
  }
}

function linkSession(sid: string, numbers: number[]): void {
  const w: ChunkWrite = {
    root: ROOT,
    sid,
    path: `/projects/a/${sid}.jsonl`,
    size: 1,
    cursor: { offset: 1, headLen: 1, headHash: "h", anchorHash: "a" },
    fields: emptySessionFields(),
    title: "t",
    turns: [],
    links: numbers.map((n) => ({
      repo: "o/r",
      number: n,
      url: `https://github.com/o/r/pull/${n}`,
      createdHere: n === 1,
      firstSeen: 100 + n,
      lastSeen: n === 1 ? null : 200 + n,
    })),
    pending: [],
    extractVersion: 1,
  };
  db.writeChunk(w);
}

const details = (over: Partial<PrDetails> = {}): PrDetails => ({
  title: "Fix",
  state: "OPEN",
  isDraft: false,
  body: "b",
  ...over,
});
const key = (n: number) => ({ repo: "o/r", number: n });

describe("prsForSessions", () => {
  test("returns each requested session's links, newest number first, with PR details", () => {
    linkSession("s1", [1, 2]);
    linkSession("s2", [1]);
    db.applyPrDetails({ repo: "O/R", number: 1 }, details({ isDraft: true }), NOW);
    const out = db.prsForSessions(ROOT, ["s1", "s2", "nope"]);
    expect(Object.keys(out).sort()).toEqual(["s1", "s2"]);
    expect(out.s1.map((l) => l.number)).toEqual([2, 1]);
    expect(out.s1[1]).toEqual({
      repo: "o/r",
      number: 1,
      url: "https://github.com/o/r/pull/1",
      title: "Fix",
      state: "OPEN",
      isDraft: true,
      createdHere: true,
      firstSeen: 101,
      lastSeen: null,
    });
    expect(out.s1[0]).toMatchObject({ title: null, state: null, isDraft: false });
  });

  test("an empty id list returns nothing", () => {
    expect(db.prsForSessions(ROOT, [])).toEqual({});
  });
});

describe("duePrs", () => {
  test("follows the refetch rules", () => {
    linkSession("s1", [1, 2, 3, 4, 5, 6, 7, 8]);
    // 1: never attempted
    db.markPrError(key(2), "timeout", NOW - 5 * MIN); // unfetched, tried recently
    db.markPrError(key(3), "timeout", NOW - OPEN_REFRESH_MS); // unfetched, tried 10 min ago
    db.applyPrDetails(key(4), details(), NOW - 5 * MIN); // OPEN, fresh
    db.applyPrDetails(key(5), details(), NOW - OPEN_REFRESH_MS); // OPEN, stale
    db.applyPrDetails(key(6), details({ state: "CLOSED" }), NOW - CLOSED_REFRESH_MS + MIN);
    db.applyPrDetails(key(7), details({ state: "CLOSED" }), NOW - CLOSED_REFRESH_MS);
    db.applyPrDetails(key(8), details({ state: "MERGED" }), NOW - 365 * 24 * 60 * MIN);
    expect(db.duePrs(NOW).map((k) => k.number)).toEqual([1, 3, 5, 7]);
  });
});

describe("enrichment writes", () => {
  test("applyPrDetails sets the fields and clears fetch_error", () => {
    linkSession("s1", [1]);
    db.markPrError(key(1), "timeout", NOW - MIN);
    db.applyPrDetails(key(1), details({ body: "body" }), NOW);
    expect(q("SELECT title, state, is_draft, body, fetched_at, fetch_error FROM pr")).toEqual([
      { title: "Fix", state: "OPEN", is_draft: 0, body: "body", fetched_at: NOW, fetch_error: null },
    ]);
  });

  test("markPrError keeps an existing title and state", () => {
    linkSession("s1", [1]);
    db.applyPrDetails(key(1), details(), NOW - MIN);
    db.markPrError(key(1), "not-returned", NOW);
    expect(q("SELECT title, state, fetched_at, fetch_error FROM pr")).toEqual([
      { title: "Fix", state: "OPEN", fetched_at: NOW, fetch_error: "not-returned" },
    ]);
  });

  test("pruneOrphanPrs drops PRs no session links any more", () => {
    linkSession("s1", [9]);
    expect(db.pruneOrphanPrs()).toBe(0);
    db.resetSession(ROOT, "s1");
    expect(db.pruneOrphanPrs()).toBe(1);
    expect(q("SELECT number FROM pr")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchDb.prs.test.ts`
Expected: FAIL — `db.prsForSessions is not a function` (and missing exports).

- [ ] **Step 3: Implement**

Append to `src/ipcTypes.ts`:

```ts
/** GitHub PR states as stored after enrichment (#206). A runtime array so main
 * validates stored values against the same source the type is derived from. */
export const PR_STATES = ["OPEN", "MERGED", "CLOSED"] as const;

export type PrState = (typeof PR_STATES)[number];

export const isPrState = (v: unknown): v is PrState =>
  (PR_STATES as readonly unknown[]).includes(v);

/** One PR linked to a session (#206). `title`/`state` are null until `gh`
 * enrichment succeeds. Times are epoch ms; `lastSeen` is null when the link came
 * only from the session's own `gh pr create`. */
export interface SessionPrLink {
  repo: string;
  number: number;
  url: string;
  title: string | null;
  state: PrState | null;
  isDraft: boolean;
  createdHere: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
}

/** `search:prsFor` result: sessionId → its links. Absent ids have none. */
export type SessionPrsResult = Record<string, SessionPrLink[]>;
```

In `src/search/searchDb.ts`:

1. Add the import `import { isPrState, type PrState, type SessionPrsResult } from "../ipcTypes";`.
2. Add these exports below `SCHEMA_VERSION`:

```ts
export const OPEN_REFRESH_MS = 10 * 60_000;
export const CLOSED_REFRESH_MS = 24 * 60 * 60_000;

export interface PrKey {
  repo: string;
  number: number;
}

export interface PrDetails {
  title: string;
  state: PrState;
  isDraft: boolean;
  body: string;
}
```

3. Add to the `SearchDb` interface:

```ts
  prsForSessions(root: string, sids: string[]): SessionPrsResult;
  duePrs(now: number): PrKey[];
  applyPrDetails(key: PrKey, d: PrDetails, now: number): void;
  markPrError(key: PrKey, code: string, now: number): void;
  pruneOrphanPrs(): number;
```

4. Prepare these statements inside `openSearchDb`, after `setMeta`:

```ts
  const prsFor = db.prepare(
    `SELECT sp.sid, p.repo, p.number, p.url, p.title, p.state, p.is_draft,
            sp.created_here, sp.first_seen, sp.last_seen
     FROM session_pr sp JOIN pr p ON p.repo = sp.repo AND p.number = sp.number
     WHERE sp.root = ? AND sp.sid IN (SELECT value FROM json_each(?))
     ORDER BY sp.sid, p.number DESC`,
  );
  const duePrs = db.prepare(
    `SELECT repo, number FROM pr
     WHERE fetched_at IS NULL
        OR ((state IS NULL OR state = 'OPEN') AND fetched_at <= ?)
        OR (state = 'CLOSED' AND fetched_at <= ?)
     ORDER BY repo, number`,
  );
  const applyPr = db.prepare(
    `UPDATE pr SET title = ?, state = ?, is_draft = ?, body = ?, fetched_at = ?, fetch_error = NULL
     WHERE repo = ? AND number = ?`,
  );
  const markPr = db.prepare(
    "UPDATE pr SET fetch_error = ?, fetched_at = ? WHERE repo = ? AND number = ?",
  );
  const pruneOrphans = db.prepare(
    `DELETE FROM pr WHERE NOT EXISTS (
       SELECT 1 FROM session_pr sp WHERE sp.repo = pr.repo AND sp.number = pr.number)`,
  );
```

5. Add to the returned object (before `optimizeFts`):

```ts
    prsForSessions(root, sids) {
      const out: SessionPrsResult = {};
      if (sids.length === 0) return out;
      for (const r of prsFor.all(root, JSON.stringify(sids)) as Row[]) {
        const sid = String(r.sid);
        (out[sid] ??= []).push({
          repo: String(r.repo),
          number: Number(r.number),
          url: String(r.url),
          title: str(r.title),
          state: isPrState(r.state) ? r.state : null,
          isDraft: r.is_draft === 1,
          createdHere: r.created_here === 1,
          firstSeen: num(r.first_seen),
          lastSeen: num(r.last_seen),
        });
      }
      return out;
    },
    duePrs(now) {
      return (duePrs.all(now - OPEN_REFRESH_MS, now - CLOSED_REFRESH_MS) as Row[]).map(
        (r) => ({ repo: String(r.repo), number: Number(r.number) }),
      );
    },
    applyPrDetails(key, d, now) {
      applyPr.run(d.title, d.state, d.isDraft ? 1 : 0, d.body, now, key.repo, key.number);
    },
    markPrError(key, code, now) {
      markPr.run(code, now, key.repo, key.number);
    },
    pruneOrphanPrs() {
      return Number(pruneOrphans.run().changes);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchDb.prs.test.ts test/main/search/searchDb.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/ipcTypes.ts src/search/searchDb.ts test/main/search/searchDb.prs.test.ts
git add src/ipcTypes.ts src/search/searchDb.ts test/main/search/searchDb.prs.test.ts
git commit -m "feat: add PR link queries and enrichment writes to searchDb (#206)"
```

---

### Task 9: `searchDb` — corruption recovery

**Files:**
- Modify: `src/search/searchDb.ts`
- Test: `test/main/search/searchDb.recovery.test.ts`

**Interfaces:**
- Consumes: `openSearchDb`, `SearchDb`, `OpenOptions` (Tasks 7–8).
- Produces:
  - `export function isCorruptionError(err: unknown): boolean` — true for `SQLITE_CORRUPT` (11) and `SQLITE_NOTADB` (26), including extended codes.
  - `export interface SafeOpenOptions extends OpenOptions { now: number }`
  - `export function openSearchDbSafe(dir: string, opts: SafeOpenOptions): { db: SearchDb; recovered: boolean }` — on a corruption error renames the file to `search.corrupt-<now>.db`, keeps only that corrupt copy, opens a fresh database and salvages tombstoned sessions; any other error is rethrown.
  - New `SearchDb` method `salvageTombstoned(corruptPath: string): void` — best effort; never throws for a bad source file.

- [ ] **Step 1: Write the failing test**

`test/main/search/searchDb.recovery.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  isCorruptionError,
  openSearchDb,
  openSearchDbSafe,
  SEARCH_DB_FILENAME,
  type ChunkWrite,
  type SearchDb,
} from "../../../src/search/searchDb";
import { emptySessionFields } from "../../../src/search/turnExtractor";

const ROOT = "/projects";
let dir: string;
const opened: SearchDb[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-recovery-"));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

const write = (db: SearchDb, sid: string, text: string): void => {
  const w: ChunkWrite = {
    root: ROOT,
    sid,
    path: `/projects/a/${sid}.jsonl`,
    size: 1,
    cursor: { offset: 1, headLen: 1, headHash: "h", anchorHash: "a" },
    fields: emptySessionFields(),
    title: text,
    turns: [{ uuid: `${sid}-u`, role: "user", ts: 1, text, searchText: text }],
    links: [
      {
        repo: "o/r",
        number: sid === "gone" ? 1 : 2,
        url: `https://github.com/o/r/pull/${sid === "gone" ? 1 : 2}`,
        createdHere: false,
        firstSeen: 1,
        lastSeen: 1,
      },
    ],
    pending: [],
    extractVersion: 1,
  };
  db.writeChunk(w);
};

test("isCorruptionError recognises SQLITE_CORRUPT and SQLITE_NOTADB", () => {
  expect(isCorruptionError({ errcode: 11 })).toBe(true);
  expect(isCorruptionError({ errcode: 26 })).toBe(true);
  expect(isCorruptionError({ errcode: 267 })).toBe(true); // SQLITE_CORRUPT_VTAB
  expect(isCorruptionError({ errcode: 5 })).toBe(false);
  expect(isCorruptionError(new Error("x"))).toBe(false);
});

describe("openSearchDbSafe", () => {
  test("a healthy database opens without recovery", () => {
    const { db, recovered } = openSearchDbSafe(dir, { platform: process.platform, now: 1 });
    opened.push(db);
    expect(recovered).toBe(false);
  });

  test("a garbage file is moved aside and replaced with a working database", () => {
    writeFileSync(join(dir, SEARCH_DB_FILENAME), Buffer.alloc(8192, 7));
    const { db, recovered } = openSearchDbSafe(dir, { platform: process.platform, now: 42 });
    opened.push(db);
    expect(recovered).toBe(true);
    expect(existsSync(join(dir, "search.corrupt-42.db"))).toBe(true);
    write(db, "s1", "works");
    expect(db.getSession(ROOT, "s1")?.title).toBe("works");
  });

  test("only the newest corrupt copy is kept", () => {
    writeFileSync(join(dir, "search.corrupt-1.db"), "old");
    writeFileSync(join(dir, SEARCH_DB_FILENAME), Buffer.alloc(8192, 7));
    const { db } = openSearchDbSafe(dir, { platform: process.platform, now: 2 });
    opened.push(db);
    expect(readdirSync(dir).filter((n) => n.startsWith("search.corrupt-"))).toEqual([
      "search.corrupt-2.db",
    ]);
  });
});

describe("salvageTombstoned", () => {
  test("copies only tombstoned sessions, their turns, links and PRs", () => {
    const oldDir = join(dir, "old");
    mkdirSync(oldDir);
    const old = openSearchDb(oldDir, { platform: process.platform });
    write(old, "gone", "deleted words");
    write(old, "live", "live words");
    old.setTombstone(ROOT, "gone", { missingSince: 1, deletedAt: 2 });
    old.close();

    const fresh = openSearchDb(dir, { platform: process.platform });
    opened.push(fresh);
    fresh.salvageTombstoned(join(oldDir, SEARCH_DB_FILENAME));
    expect(fresh.listSessions(ROOT).map((s) => s.sid)).toEqual(["gone"]);
    expect(fresh.prsForSessions(ROOT, ["gone"]).gone.map((l) => l.number)).toEqual([1]);

    const ro = new DatabaseSync(join(dir, SEARCH_DB_FILENAME), { readOnly: true });
    expect(ro.prepare("SELECT rowid FROM fts WHERE fts MATCH '\"deleted\"'").all()).toHaveLength(1);
    expect(ro.prepare("SELECT number FROM pr").all()).toEqual([{ number: 1 }]);
    ro.close();
  });

  test("an unreadable source is ignored", () => {
    const fresh = openSearchDb(dir, { platform: process.platform });
    opened.push(fresh);
    const junk = join(dir, "junk.db");
    writeFileSync(junk, Buffer.alloc(4096, 7));
    expect(() => fresh.salvageTombstoned(junk)).not.toThrow();
    expect(fresh.listSessions(ROOT)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchDb.recovery.test.ts`
Expected: FAIL — missing exports `isCorruptionError` / `openSearchDbSafe`.

- [ ] **Step 3: Implement**

In `src/search/searchDb.ts`:

1. Change the fs import to `import { closeSync, existsSync, openSync, readdirSync, renameSync, rmSync } from "node:fs";`.
2. Add `salvageTombstoned(corruptPath: string): void;` to the `SearchDb` interface.
3. Add to the returned object:

```ts
    salvageTombstoned(corruptPath) {
      try {
        db.prepare("ATTACH DATABASE ? AS old").run(corruptPath);
      } catch {
        return;
      }
      const steps = [
        `INSERT OR IGNORE INTO session (${SESSION_COLUMNS})
         SELECT ${SESSION_COLUMNS} FROM old.session WHERE deleted_at IS NOT NULL`,
        `INSERT OR IGNORE INTO turn (root, sid, uuid, role, ts, text, search_text)
         SELECT t.root, t.sid, t.uuid, t.role, t.ts, t.text, t.search_text
         FROM old.turn t JOIN old.session s ON s.root = t.root AND s.sid = t.sid
         WHERE s.deleted_at IS NOT NULL`,
        `INSERT OR IGNORE INTO session_pr (root, sid, repo, number, created_here, first_seen, last_seen)
         SELECT sp.root, sp.sid, sp.repo, sp.number, sp.created_here, sp.first_seen, sp.last_seen
         FROM old.session_pr sp JOIN old.session s ON s.root = sp.root AND s.sid = sp.sid
         WHERE s.deleted_at IS NOT NULL`,
        `INSERT OR IGNORE INTO pr (repo, number, url, title, state, is_draft, body, fetched_at, fetch_error)
         SELECT p.repo, p.number, p.url, p.title, p.state, p.is_draft, p.body, p.fetched_at, p.fetch_error
         FROM old.pr p
         WHERE EXISTS (SELECT 1 FROM main.session_pr sp WHERE sp.repo = p.repo AND sp.number = p.number)`,
      ];
      for (const sql of steps) {
        try {
          db.exec(sql);
        } catch {
          // Best effort: a table that no longer reads cleanly is skipped.
        }
      }
      try {
        db.exec("DETACH DATABASE old");
      } catch {
        // Nothing attached means nothing to detach.
      }
      if (ftsOk) db.exec("INSERT INTO fts(fts) VALUES('rebuild')");
    },
```

4. Append at the end of the file:

```ts
const CORRUPT_COPY_RE = /^search\.corrupt-.+\.db$/;

export function isCorruptionError(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null | undefined)?.errcode;
  if (typeof code !== "number") return false;
  const primary = code & 0xff;
  return primary === 11 || primary === 26;
}

export interface SafeOpenOptions extends OpenOptions {
  now: number;
}

export function openSearchDbSafe(
  dir: string,
  opts: SafeOpenOptions,
): { db: SearchDb; recovered: boolean } {
  try {
    return { db: openSearchDb(dir, opts), recovered: false };
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
  }
  const file = join(dir, SEARCH_DB_FILENAME);
  for (const name of readdirSync(dir))
    if (CORRUPT_COPY_RE.test(name)) rmSync(join(dir, name), { force: true });
  const corrupt = join(dir, `search.corrupt-${opts.now}.db`);
  renameSync(file, corrupt);
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  const db = openSearchDb(dir, opts);
  db.salvageTombstoned(corrupt);
  return { db, recovered: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchDb.recovery.test.ts test/main/search/searchDb.test.ts test/main/search/searchDb.prs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/searchDb.ts test/main/search/searchDb.recovery.test.ts
git add src/search/searchDb.ts test/main/search/searchDb.recovery.test.ts
git commit -m "feat: recover from a corrupt search.db and salvage deleted sessions (#206)"
```

---

### Task 10: `lineReader` and `recordFilter` — streaming complete lines, cheap pre-filter

**Files:**
- Create: `src/search/lineReader.ts`, `src/search/recordFilter.ts`
- Test: `test/main/search/lineReader.test.ts`, `test/main/search/recordFilter.test.ts`

**Interfaces:**
- Produces:
  - `export const CHUNK_BYTES = 1_048_576; export const MAX_LINE_BYTES = 16_777_216;`
  - `export interface LineRead { bytes: Buffer | null; end: number }` — `bytes` excludes the `\n` and is only valid until the next iteration; `null` means the line exceeded `maxLineBytes` and was discarded; `end` is the file offset just past the line's `\n`.
  - `export interface ReadOptions { chunkBytes?: number; maxLineBytes?: number }`
  - `export function readCompleteLines(path: string, start: number, opts?: ReadOptions): AsyncGenerator<LineRead>` — opens read-only, never yields an unterminated tail, strips a UTF-8 BOM from a line starting at offset 0, yields to the event loop between chunks.
  - `export const BIG_LINE_BYTES = 262_144;`
  - `export function shouldParse(line: Buffer): boolean`

- [ ] **Step 1: Write the failing tests**

`test/main/search/lineReader.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCompleteLines, type ReadOptions } from "../../../src/search/lineReader";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-lines-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = (content: string | Buffer): string => {
  const p = join(dir, "t.jsonl");
  writeFileSync(p, content);
  return p;
};
async function collect(path: string, start = 0, opts: ReadOptions = { chunkBytes: 4 }) {
  const out: { text: string | null; end: number }[] = [];
  for await (const l of readCompleteLines(path, start, opts))
    out.push({ text: l.bytes === null ? null : l.bytes.toString("utf8"), end: l.end });
  return out;
}

describe("readCompleteLines", () => {
  test("lines spanning chunk boundaries come out whole with end offsets", async () => {
    expect(await collect(file("ab\ncdefgh\n\nij\n"))).toEqual([
      { text: "ab", end: 3 },
      { text: "cdefgh", end: 10 },
      { text: "", end: 11 },
      { text: "ij", end: 14 },
    ]);
  });

  test("an unterminated tail is not yielded", async () => {
    expect(await collect(file("ab\ncd"))).toEqual([{ text: "ab", end: 3 }]);
  });

  test("reading starts at the given offset", async () => {
    expect(await collect(file("ab\ncd\n"), 3)).toEqual([{ text: "cd", end: 6 }]);
  });

  test("an oversized line is discarded but its offset still advances", async () => {
    const p = file(`ab\n${"x".repeat(10)}\nyz\n`);
    expect(await collect(p, 0, { chunkBytes: 4, maxLineBytes: 5 })).toEqual([
      { text: "ab", end: 3 },
      { text: null, end: 14 },
      { text: "yz", end: 17 },
    ]);
  });

  test("a BOM at the start of the file is stripped", async () => {
    const p = file(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}\n{}\n")]));
    expect(await collect(p)).toEqual([
      { text: "{}", end: 6 },
      { text: "{}", end: 9 },
    ]);
  });

  test("CRLF lines keep their \\r, which JSON.parse accepts", async () => {
    const out = await collect(file("{}\r\n[]\r\n"));
    expect(out).toEqual([
      { text: "{}\r", end: 4 },
      { text: "[]\r", end: 8 },
    ]);
    expect(() => JSON.parse(out[0].text!)).not.toThrow();
  });

  test("the default chunk size reads a multi-chunk line", async () => {
    const big = "y".repeat(1_500_000);
    expect(await collect(file(`${big}\n`), 0, {})).toEqual([
      { text: big, end: 1_500_001 },
    ]);
  });
});
```

`test/main/search/recordFilter.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, test } from "vitest";
import { BIG_LINE_BYTES, shouldParse } from "../../../src/search/recordFilter";

const b = (s: string) => Buffer.from(s);
const pad = (n: number) => "z".repeat(n);

describe("shouldParse", () => {
  test.each(["user", "assistant", "pr-link", "custom-title", "ai-title", "summary"])(
    "a leading %s type is parsed",
    (type) => {
      expect(shouldParse(b(`{"type":"${type}","x":1}`))).toBe(true);
    },
  );

  test.each(["file-history-snapshot", "queue-operation", "brand-new-thing"])(
    "a leading %s type is skipped",
    (type) => {
      expect(shouldParse(b(`{"type":"${type}","message":{"content":"x"}}`))).toBe(false);
    },
  );

  test("a record that puts parentUuid first is parsed", () => {
    expect(shouldParse(b('{"parentUuid":null,"type":"assistant"}'))).toBe(true);
  });

  test("a big line without a leading type needs a content marker", () => {
    expect(shouldParse(b(`{"parentUuid":"p","data":"${pad(BIG_LINE_BYTES)}"}`))).toBe(false);
    expect(
      shouldParse(b(`{"parentUuid":"p","content":[{"type":"text"}],"d":"${pad(BIG_LINE_BYTES)}"}`)),
    ).toBe(true);
    expect(shouldParse(b(`{"parentUuid":"p","cmd":"gh pr create","d":"${pad(BIG_LINE_BYTES)}"}`))).toBe(
      true,
    );
  });

  test("a big line with a leading contributing type is parsed", () => {
    expect(shouldParse(b(`{"type":"assistant","d":"${pad(BIG_LINE_BYTES)}"}`))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/lineReader.test.ts test/main/search/recordFilter.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/search/lineReader.ts`:

```ts
import { open } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export const CHUNK_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface LineRead {
  bytes: Buffer | null;
  end: number;
}

export interface ReadOptions {
  chunkBytes?: number;
  maxLineBytes?: number;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export async function* readCompleteLines(
  path: string,
  start: number,
  opts: ReadOptions = {},
): AsyncGenerator<LineRead> {
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const handle = await open(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let carry: Buffer[] = [];
    let carryLen = 0;
    let oversized = false;
    let pos = start;
    let lineStart = start;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkBytes, pos);
      if (bytesRead === 0) return;
      const buf = chunk.subarray(0, bytesRead);
      let from = 0;
      let nl: number;
      while ((nl = buf.indexOf(0x0a, from)) !== -1) {
        const end = pos + nl + 1;
        const piece = buf.subarray(from, nl);
        if (oversized || carryLen + piece.length > maxLineBytes) {
          yield { bytes: null, end };
        } else {
          let line = carryLen === 0 ? piece : Buffer.concat([...carry, piece]);
          if (lineStart === 0 && line.subarray(0, 3).equals(BOM)) line = line.subarray(3);
          yield { bytes: line, end };
        }
        carry = [];
        carryLen = 0;
        oversized = false;
        lineStart = end;
        from = nl + 1;
      }
      const rest = buf.subarray(from);
      if (!oversized && rest.length > 0) {
        if (carryLen + rest.length > maxLineBytes) {
          oversized = true;
          carry = [];
          carryLen = 0;
        } else {
          // Copy: `chunk` is reused by the next read.
          carry.push(Buffer.from(rest));
          carryLen += rest.length;
        }
      }
      pos += bytesRead;
      await yieldToEventLoop();
    }
  } finally {
    await handle.close();
  }
}
```

`src/search/recordFilter.ts`:

```ts
// Skips lines that cannot contribute before paying for JSON.parse (spec §7.3).
const CONTRIBUTING = new Set([
  "user",
  "assistant",
  "pr-link",
  "custom-title",
  "ai-title",
  "summary",
]);
const TYPE_PREFIX = Buffer.from('{"type":"');
const MARKERS = ['"type":"text"', '"content":"', "gh pr create"].map((m) =>
  Buffer.from(m),
);
const QUOTE = 0x22;

export const BIG_LINE_BYTES = 256 * 1024;

export function shouldParse(line: Buffer): boolean {
  if (
    line.length >= TYPE_PREFIX.length &&
    line.compare(TYPE_PREFIX, 0, TYPE_PREFIX.length, 0, TYPE_PREFIX.length) === 0
  ) {
    const close = line.indexOf(QUOTE, TYPE_PREFIX.length);
    if (close === -1) return false;
    return CONTRIBUTING.has(line.toString("latin1", TYPE_PREFIX.length, close));
  }
  if (line.length > BIG_LINE_BYTES) return MARKERS.some((m) => line.includes(m));
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/lineReader.test.ts test/main/search/recordFilter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/lineReader.ts src/search/recordFilter.ts test/main/search/lineReader.test.ts test/main/search/recordFilter.test.ts
git add src/search/lineReader.ts src/search/recordFilter.ts test/main/search/lineReader.test.ts test/main/search/recordFilter.test.ts
git commit -m "feat: stream complete transcript lines and pre-filter records (#206)"
```

---

### Task 11: `transcriptFiles` — one transcript listing shared with `sessionStore`

**Files:**
- Create: `src/search/transcriptFiles.ts`
- Modify: `src/sessionStore.ts:10` (imports), `src/sessionStore.ts:56-59` (`JSONL_EXT`), `src/sessionStore.ts:83-125` (`collectFiles`)
- Test: `test/main/search/transcriptFiles.test.ts`

**Interfaces:**
- Produces:
  - `export const JSONL_EXT = ".jsonl";`
  - `export interface TranscriptFile { sid: string; path: string; size: number; mtimeMs: number }`
  - `export interface TranscriptListing { rootReadable: boolean; files: TranscriptFile[] }`
  - `export function listTranscripts(root: string): Promise<TranscriptListing>` — every `<root>/<folder>/<sid>.jsonl` (top level of each folder only, lowercase extension, non-empty stem); `rootReadable: false` when the root itself cannot be listed.
  - `export function newestPerSession(files: readonly TranscriptFile[]): Map<string, TranscriptFile>` — one entry per sid, the newest `mtimeMs`.

- [ ] **Step 1: Write the failing test**

`test/main/search/transcriptFiles.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listTranscripts,
  newestPerSession,
  type TranscriptFile,
} from "../../../src/search/transcriptFiles";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "csm-transcripts-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("listTranscripts", () => {
  test("a missing root is reported unreadable", async () => {
    expect(await listTranscripts(join(root, "nope"))).toEqual({ rootReadable: false, files: [] });
  });

  test("lists top-level lowercase .jsonl files of each project folder only", async () => {
    mkdirSync(join(root, "proj", "s1", "subagents"), { recursive: true });
    writeFileSync(join(root, "proj", "s1.jsonl"), "{}\n");
    writeFileSync(join(root, "proj", ".jsonl"), "");
    writeFileSync(join(root, "proj", "S2.JSONL"), "");
    writeFileSync(join(root, "proj", "s1", "subagents", "agent-1.jsonl"), "");
    writeFileSync(join(root, "top.jsonl"), "");
    const out = await listTranscripts(root);
    expect(out.rootReadable).toBe(true);
    expect(out.files.map((f) => ({ sid: f.sid, path: f.path, size: f.size }))).toEqual([
      { sid: "s1", path: join(root, "proj", "s1.jsonl"), size: 3 },
    ]);
  });
});

test("newestPerSession keeps the newest copy of a sid", () => {
  const f = (path: string, mtimeMs: number, sid = "s"): TranscriptFile => ({
    sid,
    path,
    size: 1,
    mtimeMs,
  });
  const out = newestPerSession([f("/a/s.jsonl", 1), f("/b/s.jsonl", 3), f("/c/s.jsonl", 2), f("/a/t.jsonl", 1, "t")]);
  expect(out.get("s")?.path).toBe("/b/s.jsonl");
  expect(out.get("t")?.path).toBe("/a/t.jsonl");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/transcriptFiles.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/search/transcriptFiles.ts`:

```ts
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// Case-sensitive: Claude always writes lowercase `.jsonl`; anything else is not
// one of its transcripts.
export const JSONL_EXT = ".jsonl";

export interface TranscriptFile {
  sid: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface TranscriptListing {
  rootReadable: boolean;
  files: TranscriptFile[];
}

export async function listTranscripts(root: string): Promise<TranscriptListing> {
  let folders: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { rootReadable: false, files: [] };
  }
  const files: TranscriptFile[] = [];
  for (const folder of folders) {
    const dir = join(root, folder);
    let names: string[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      names = entries
        .filter(
          (e) =>
            e.isFile() &&
            e.name.endsWith(JSONL_EXT) &&
            e.name.length > JSONL_EXT.length,
        )
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const st = await stat(path);
        files.push({
          sid: basename(name, JSONL_EXT),
          path,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // Removed between readdir and stat.
      }
    }
  }
  return { rootReadable: true, files };
}

export function newestPerSession(
  files: readonly TranscriptFile[],
): Map<string, TranscriptFile> {
  const out = new Map<string, TranscriptFile>();
  for (const f of files) {
    const prev = out.get(f.sid);
    if (!prev || f.mtimeMs > prev.mtimeMs) out.set(f.sid, f);
  }
  return out;
}
```

In `src/sessionStore.ts`:

1. Change line 10 to `import { stat, readFile } from "node:fs/promises";` and line 11 to `import { basename } from "node:path";` (`readdir` and `join` are no longer used here; eslint fails on unused imports).
2. Delete the `JSONL_EXT` comment and constant (lines 56–59) and add `import { JSONL_EXT, listTranscripts } from "./search/transcriptFiles";` to the imports.
3. Replace the whole `collectFiles` function (lines 83–125, keeping its leading comment) with:

```ts
async function collectFiles(rootDir: string): Promise<FileEntry[]> {
  const { files } = await listTranscripts(rootDir);
  return files.map(({ path, mtimeMs, size }) => ({ path, mtimeMs, size }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/transcriptFiles.test.ts test/main/sessionStore.test.ts test/main/sessionStore.facts.test.ts`
Expected: PASS (the existing store tests prove the refactor kept the listing rules).

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/transcriptFiles.ts src/sessionStore.ts test/main/search/transcriptFiles.test.ts
git add src/search/transcriptFiles.ts src/sessionStore.ts test/main/search/transcriptFiles.test.ts
git commit -m "refactor: share the transcript listing between the browse scan and search (#206)"
```

---

### Task 12: `ingest` — one incremental pass over every transcript

**Files:**
- Create: `src/search/ingest.ts`
- Test: `test/main/search/ingest.test.ts`

**Interfaces:**
- Consumes: `composeTitleFrom` (Task 1); `emptySessionFields`, `extractTurn`, `mergeRecordFields`, `SessionFields`, `TurnRow` (Task 3); `extractPrs`, `mergeLinkObs`, `PrLinkObs` (Task 4); `classifyFile`, `decideAppend`, `verifySpans`, `headSpan`, `anchorSpan`, `Span` (Task 5); `nextTombstone`, `presence`, `ParentState` (Task 6); `SearchDb`, `SessionRow`, `CursorWrite` (Tasks 7–8); `readCompleteLines` (Task 10); `shouldParse` (Task 10); `listTranscripts`, `newestPerSession`, `TranscriptFile` (Task 11).
- Produces:
  - `export const EXTRACT_VERSION = 1; export const COMMIT_EVERY_BYTES = 4_194_304;`
  - `export interface PassResult { changed: boolean; rootReadable: boolean; filesIngested: number; invalidPrRefs: number; turnsInserted: number }`
  - `export interface IngestProgress { done: number; total: number }`
  - `export interface IngesterDeps { db: SearchDb; root: string; now: () => number; onProgress?: (p: IngestProgress) => void; log?: (msg: string, err?: unknown) => void; readLines?: typeof readCompleteLines }`
  - `export function createIngester(deps: IngesterDeps): { runPass(): Promise<PassResult> }` — single-flight: a call during a pass returns the running promise and causes exactly one more pass; the promise resolves with the results of every pass it covered merged.

- [ ] **Step 1: Write the failing test**

`test/main/search/ingest.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSearchDb, SEARCH_DB_FILENAME, type SearchDb } from "../../../src/search/searchDb";
import { createIngester, EXTRACT_VERSION, type IngesterDeps } from "../../../src/search/ingest";
import { readCompleteLines } from "../../../src/search/lineReader";
import { MISSING_GRACE_MS } from "../../../src/search/tombstone";
import { parseSession } from "../../../src/sessionParser";

const SID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";
const SID2 = "4c0a2d3b-2f3e-4b6c-9d8e-1a2b3c4d5e6f";
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

let tmp: string;
let root: string;
let dbDir: string;
let db: SearchDb;
let clock: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "csm-ingest-"));
  root = join(tmp, "projects");
  dbDir = join(tmp, "userData");
  mkdirSync(join(root, "proj-a"), { recursive: true });
  mkdirSync(dbDir);
  db = openSearchDb(dbDir, { platform: process.platform });
  clock = Date.parse("2026-10-01T12:00:00Z");
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(ms).toISOString();
const line = (rec: object) => `${JSON.stringify(rec)}\n`;
const user = (uuid: string, text: string, ts = T0) => ({
  type: "user",
  uuid,
  timestamp: iso(ts),
  cwd: "D:\\src\\x",
  message: { role: "user", content: text },
});
const assistant = (uuid: string, text: string, ts = T0) => ({
  type: "assistant",
  uuid,
  timestamp: iso(ts),
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const prLink = (n: number, ts = T0) => ({
  type: "pr-link",
  sessionId: SID,
  prNumber: n,
  prRepository: "o/r",
  prUrl: `https://github.com/o/r/pull/${n}`,
  timestamp: iso(ts),
});
const transcript = (folder = "proj-a", sid = SID) => join(root, folder, `${sid}.jsonl`);
const write = (recs: object[], path = transcript()) => writeFileSync(path, recs.map(line).join(""));
const append = (recs: object[], path = transcript()) => appendFileSync(path, recs.map(line).join(""));

function ingester(over: Partial<IngesterDeps> = {}) {
  return createIngester({ db, root, now: () => clock, ...over });
}

function q<T = Record<string, unknown>>(sql: string, ...args: (string | number)[]): T[] {
  const ro = new DatabaseSync(join(dbDir, SEARCH_DB_FILENAME), { readOnly: true });
  try {
    return ro.prepare(sql).all(...args) as T[];
  } finally {
    ro.close();
  }
}
const texts = () => q<{ text: string }>("SELECT text FROM turn ORDER BY id").map((r) => r.text);
const matches = (term: string) => q("SELECT rowid FROM fts WHERE fts MATCH ?", `"${term}"`);

describe("ingest", () => {
  test("a new transcript yields its turns, title and cwd", async () => {
    write([user("u1", "Fix getUserName"), assistant("a1", "Done")]);
    const r = await ingester().runPass();
    expect(r).toMatchObject({ changed: true, rootReadable: true, filesIngested: 1, turnsInserted: 2 });
    expect(texts()).toEqual(["Fix getUserName", "Done"]);
    expect(matches("user")).toHaveLength(1);
    expect(db.getSession(root, SID)).toMatchObject({
      title: "Fix getUserName",
      cwd: "D:\\src\\x",
      extractVersion: EXTRACT_VERSION,
    });
  });

  test("an append reads only the new bytes", async () => {
    const readLines = vi.fn(readCompleteLines);
    const ing = ingester({ readLines });
    write([user("u1", "first")]);
    await ing.runPass();
    const firstSize = statSync(transcript()).size;
    append([user("u2", "second")]);
    await ing.runPass();
    expect(readLines.mock.calls.map((c) => c[1])).toEqual([0, firstSize]);
    expect(texts()).toEqual(["first", "second"]);
  });

  test("a half-written final line waits for the next pass", async () => {
    const second = line(user("u2", "second"));
    writeFileSync(transcript(), line(user("u1", "first")) + second.slice(0, 10));
    await ingester().runPass();
    expect(texts()).toEqual(["first"]);
    appendFileSync(transcript(), second.slice(10));
    await ingester().runPass();
    expect(texts()).toEqual(["first", "second"]);
  });

  test("a tail that never completes reports no change on later passes", async () => {
    const second = line(user("u2", "second"));
    writeFileSync(transcript(), line(user("u1", "first")) + second.slice(0, 10));
    const ing = ingester();
    expect((await ing.runPass()).changed).toBe(true);
    expect(await ing.runPass()).toMatchObject({ changed: false, filesIngested: 0 });
    expect(texts()).toEqual(["first"]);
  });

  test("an in-place rewrite re-ingests from byte 0", async () => {
    write([user("u1", "alpha"), user("u2", "beta")]);
    await ingester().runPass();
    write([user("u3", "gamma"), user("u4", "delta"), user("u5", "epsilon")]);
    await ingester().runPass();
    expect(texts()).toEqual(["gamma", "delta", "epsilon"]);
    expect(matches("alpha")).toEqual([]);
  });

  test("a truncated transcript is re-ingested", async () => {
    write([user("u1", "one"), user("u2", "two"), user("u3", "three")]);
    await ingester().runPass();
    write([user("u9", "nine")]);
    await ingester().runPass();
    expect(texts()).toEqual(["nine"]);
  });

  test("a replayed uuid is stored once, within and across passes", async () => {
    write([user("u1", "same"), user("u1", "same")]);
    await ingester().runPass();
    append([user("u1", "same")]);
    await ingester().runPass();
    expect(texts()).toEqual(["same"]);
  });

  test("backwards timestamps keep the latest as last activity", async () => {
    write([user("u1", "a", T0 + 5000), user("u2", "b", T0 + 1000)]);
    await ingester().runPass();
    expect(db.getSession(root, SID)?.lastActivity).toBe(T0 + 5000);
  });

  test("a line over 1 MB is ingested", async () => {
    const big = "y".repeat(1_100_000);
    write([user("u1", big)]);
    await ingester().runPass();
    expect(texts()[0]).toHaveLength(1_100_000);
  });

  test("6000 repeated pr-link records collapse to one link", async () => {
    write(Array.from({ length: 6000 }, (_, i) => prLink(5, T0 + i * 1000)));
    await ingester().runPass();
    expect(q("SELECT number, first_seen, last_seen, created_here FROM session_pr")).toEqual([
      { number: 5, first_seen: T0, last_seen: T0 + 5999 * 1000, created_here: 0 },
    ]);
    expect(q("SELECT number, state FROM pr")).toEqual([{ number: 5, state: null }]);
  });

  test("bookkeeping and unknown leading types are skipped; a late type field still parses", async () => {
    const late = JSON.stringify({
      uuid: "a9",
      timestamp: iso(T0),
      message: { role: "assistant", content: [{ type: "text", text: "late type" }] },
      type: "assistant",
    });
    writeFileSync(
      transcript(),
      [
        '{"type":"file-history-snapshot","snapshot":{"text":"nope"}}',
        '{"type":"brand-new","message":{"role":"user","content":"nope"}}',
        late,
        "{not json",
        "",
      ].join("\n"),
    );
    await ingester().runPass();
    expect(texts()).toEqual(["late type"]);
  });

  test("gh pr create pairs with its result across passes", async () => {
    write([
      {
        type: "assistant",
        timestamp: iso(T0),
        message: {
          content: [{ type: "tool_use", id: "t1", name: "PowerShell", input: { command: "gh pr create --fill" } }],
        },
      },
    ]);
    await ingester().runPass();
    expect(db.getSession(root, SID)?.pendingPrCreate).toEqual(["t1"]);
    append([
      {
        type: "user",
        timestamp: iso(T0 + 1000),
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "https://github.com/o/r/pull/12\n" }],
        },
      },
    ]);
    await ingester().runPass();
    expect(q("SELECT number, created_here, first_seen, last_seen FROM session_pr")).toEqual([
      { number: 12, created_here: 1, first_seen: T0 + 1000, last_seen: null },
    ]);
    expect(db.getSession(root, SID)?.pendingPrCreate).toEqual([]);
  });

  test("CRLF and BOM transcripts ingest every record", async () => {
    const body = [user("u1", "one"), user("u2", "two")].map((r) => JSON.stringify(r)).join("\r\n") + "\r\n";
    writeFileSync(transcript(), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]));
    await ingester().runPass();
    expect(texts()).toEqual(["one", "two"]);
  });

  test("a file under 4096 bytes that grows past it is appended, not rewritten", async () => {
    const readLines = vi.fn(readCompleteLines);
    const ing = ingester({ readLines });
    write([user("u1", "small")]);
    await ing.runPass();
    const firstSize = statSync(transcript()).size;
    expect(firstSize).toBeLessThan(4096);
    const firstId = q<{ id: number }>("SELECT id FROM turn")[0].id;
    append(Array.from({ length: 40 }, (_, i) => user(`m${i}`, "x".repeat(200))));
    expect(statSync(transcript()).size).toBeGreaterThan(4096);
    await ing.runPass();
    expect(readLines.mock.calls.map((c) => c[1])).toEqual([0, firstSize]);
    expect(q<{ id: number }>("SELECT id FROM turn ORDER BY id")[0].id).toBe(firstId);
  });

  test("a rename back to an earlier name across appends matches the browse title", async () => {
    write([{ type: "ai-title", aiTitle: "AI words" }, { type: "custom-title", customTitle: "a" }]);
    await ingester().runPass();
    append([{ type: "custom-title", customTitle: "b" }]);
    await ingester().runPass();
    append([{ type: "custom-title", customTitle: "a" }]);
    await ingester().runPass();
    const browse = parseSession(SID, readFileSync(transcript(), "utf8")).title;
    expect(db.getSession(root, SID)?.title).toBe(browse);
  });
});

describe("files that move or disappear", () => {
  test("the same sid in two folders keeps the newest file", async () => {
    mkdirSync(join(root, "proj-b"));
    write([user("u1", "old copy")], transcript("proj-a"));
    write([user("u2", "new copy")], transcript("proj-b"));
    utimesSync(transcript("proj-a"), new Date(T0), new Date(T0));
    await ingester().runPass();
    expect(db.getSession(root, SID)?.path).toBe(transcript("proj-b"));
    expect(texts()).toEqual(["new copy"]);
  });

  test("a file moved to another project folder is not re-ingested", async () => {
    const readLines = vi.fn(readCompleteLines);
    const ing = ingester({ readLines });
    write([user("u1", "moved")]);
    await ing.runPass();
    mkdirSync(join(root, "proj-b"));
    renameSync(transcript("proj-a"), transcript("proj-b"));
    await ing.runPass();
    expect(readLines).toHaveBeenCalledTimes(1);
    expect(db.getSession(root, SID)?.path).toBe(transcript("proj-b"));
    expect(texts()).toEqual(["moved"]);
  });

  test("tombstones only after the 60 s floor, keeps rows, and clears on reappearance", async () => {
    write([user("u1", "keep me")]);
    const ing = ingester();
    await ing.runPass();
    const away = join(tmp, "away.jsonl");
    renameSync(transcript(), away);

    await ing.runPass();
    expect(db.getSession(root, SID)).toMatchObject({ missingSince: clock, deletedAt: null });
    clock += MISSING_GRACE_MS - 1;
    await ing.runPass();
    expect(db.getSession(root, SID)?.deletedAt).toBeNull();
    clock += 1;
    const r = await ing.runPass();
    expect(r.changed).toBe(true);
    expect(db.getSession(root, SID)?.deletedAt).toBe(clock);
    expect(texts()).toEqual(["keep me"]);

    renameSync(away, transcript());
    await ing.runPass();
    expect(db.getSession(root, SID)).toMatchObject({ missingSince: null, deletedAt: null });
  });

  test("deleting a whole project folder tombstones its sessions", async () => {
    mkdirSync(join(root, "proj-b"));
    write([user("u1", "a")], transcript("proj-a", SID));
    write([user("u2", "b")], transcript("proj-b", SID2));
    const ing = ingester();
    await ing.runPass();
    rmSync(join(root, "proj-a"), { recursive: true });
    await ing.runPass();
    clock += MISSING_GRACE_MS;
    await ing.runPass();
    expect(db.getSession(root, SID)?.deletedAt).toBe(clock);
    expect(db.getSession(root, SID2)?.deletedAt).toBeNull();
  });

  test("an unreadable projects root records nothing", async () => {
    write([user("u1", "a")]);
    const ing = ingester();
    await ing.runPass();
    rmSync(root, { recursive: true });
    const r = await ing.runPass();
    clock += 2 * MISSING_GRACE_MS;
    await ing.runPass();
    expect(r).toMatchObject({ rootReadable: false, changed: false });
    expect(db.getSession(root, SID)).toMatchObject({ missingSince: null, deletedAt: null });
  });

  test("a stale extract_version re-ingests a live file and restamps a tombstoned one", async () => {
    mkdirSync(join(root, "proj-b"));
    write([user("u1", "live")], transcript("proj-a", SID));
    write([{ type: "ai-title", aiTitle: "Gone title" }, user("u2", "gone")], transcript("proj-b", SID2));
    const readLines = vi.fn(readCompleteLines);
    const ing = ingester({ readLines });
    await ing.runPass();
    rmSync(transcript("proj-b", SID2));
    await ing.runPass();
    clock += MISSING_GRACE_MS;
    await ing.runPass();
    expect(db.getSession(root, SID2)?.deletedAt).toBe(clock);

    const w = new DatabaseSync(join(dbDir, SEARCH_DB_FILENAME));
    w.exec("UPDATE session SET extract_version = 0, title = 'stale'");
    w.close();
    readLines.mockClear();
    await ing.runPass();
    expect(readLines.mock.calls.map((c) => [c[0], c[1]])).toEqual([[transcript("proj-a", SID), 0]]);
    expect(db.getSession(root, SID)).toMatchObject({ extractVersion: EXTRACT_VERSION, title: "live" });
    expect(db.getSession(root, SID2)).toMatchObject({
      extractVersion: EXTRACT_VERSION,
      title: "Gone title",
    });
    expect(texts()).toEqual(expect.arrayContaining(["live", "gone"]));
  });
});

describe("invariants", () => {
  test("transcripts are never modified", async () => {
    write([user("u1", "a"), prLink(3)]);
    const before = readFileSync(transcript());
    const mtime = statSync(transcript()).mtimeMs;
    const ing = ingester();
    await ing.runPass();
    await ing.runPass();
    expect(readFileSync(transcript()).equals(before)).toBe(true);
    expect(statSync(transcript()).mtimeMs).toBe(mtime);
  });

  test("concurrent runPass calls share one promise and run exactly one more pass", async () => {
    write([user("u1", "a")]);
    const onProgress = vi.fn();
    const ing = ingester({ onProgress });
    const p1 = ing.runPass();
    const p2 = ing.runPass();
    const p3 = ing.runPass();
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
    const r = await p1;
    expect(onProgress.mock.calls.filter(([p]) => p.done === 0)).toHaveLength(2);
    expect(r.filesIngested).toBe(1);
    expect(texts()).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/ingest.test.ts`
Expected: FAIL — cannot resolve `src/search/ingest`.

- [ ] **Step 3: Implement**

`src/search/ingest.ts`:

```ts
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { composeTitleFrom } from "../sessionParser";
import { isRecord } from "../typeGuards";
import {
  anchorSpan,
  classifyFile,
  decideAppend,
  headSpan,
  verifySpans,
  type Span,
} from "./fileCursor";
import { readCompleteLines } from "./lineReader";
import { extractPrs, mergeLinkObs, type PrLinkObs } from "./prExtractor";
import { shouldParse } from "./recordFilter";
import type { CursorWrite, SearchDb, SessionRow } from "./searchDb";
import { nextTombstone, presence, type ParentState } from "./tombstone";
import {
  listTranscripts,
  newestPerSession,
  type TranscriptFile,
} from "./transcriptFiles";
import {
  emptySessionFields,
  extractTurn,
  mergeRecordFields,
  type SessionFields,
  type TurnRow,
} from "./turnExtractor";

export const EXTRACT_VERSION = 1;
export const COMMIT_EVERY_BYTES = 4 * 1024 * 1024;

export interface PassResult {
  changed: boolean;
  rootReadable: boolean;
  filesIngested: number;
  invalidPrRefs: number;
  turnsInserted: number;
}

export interface IngestProgress {
  done: number;
  total: number;
}

export interface IngesterDeps {
  db: SearchDb;
  root: string;
  now: () => number;
  onProgress?: (p: IngestProgress) => void;
  log?: (msg: string, err?: unknown) => void;
  readLines?: typeof readCompleteLines;
}

interface Work {
  file: TranscriptFile;
  base: SessionRow | undefined;
  start: number;
  reset: boolean;
}

async function hashSpan(path: string, span: Span): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(span.length);
    let read = 0;
    while (read < span.length) {
      const { bytesRead } = await handle.read(
        buf,
        read,
        span.length - read,
        span.start + read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return createHash("sha1").update(buf.subarray(0, read)).digest("hex");
  } finally {
    await handle.close();
  }
}

async function cursorAt(path: string, offset: number): Promise<CursorWrite> {
  const head = headSpan(offset);
  return {
    offset,
    headLen: head.length,
    headHash: await hashSpan(path, head),
    anchorHash: await hashSpan(path, anchorSpan(offset)),
  };
}

function fieldsFromRow(row: SessionRow): SessionFields {
  return {
    cwd: row.cwd,
    branch: row.branch,
    lastActivity: row.lastActivity,
    customTitle: row.customTitle,
    aiTitle: row.aiTitle,
    summaryTitle: row.summaryTitle,
    firstPrompt: row.firstPrompt,
    titleValues: row.titlesText ? row.titlesText.split("\n") : [],
  };
}

function titleOf(f: SessionFields): string {
  return composeTitleFrom({
    customTitle: f.customTitle,
    aiTitle: f.aiTitle,
    summary: f.summaryTitle,
    firstPrompt: f.firstPrompt,
  });
}

async function statCode(path: string): Promise<string | undefined> {
  try {
    await stat(path);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
  }
}

async function parentState(
  dir: string,
  cache: Map<string, ParentState>,
): Promise<ParentState> {
  const hit = cache.get(dir);
  if (hit) return hit;
  let state: ParentState;
  try {
    await readdir(dir);
    state = "readable";
  } catch (err) {
    state =
      (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
  }
  cache.set(dir, state);
  return state;
}

function mergeResults(a: PassResult, b: PassResult): PassResult {
  return {
    changed: a.changed || b.changed,
    rootReadable: b.rootReadable,
    filesIngested: a.filesIngested + b.filesIngested,
    invalidPrRefs: a.invalidPrRefs + b.invalidPrRefs,
    turnsInserted: a.turnsInserted + b.turnsInserted,
  };
}

export function createIngester(deps: IngesterDeps): {
  runPass(): Promise<PassResult>;
} {
  const { db, root } = deps;
  const readLines = deps.readLines ?? readCompleteLines;

  async function ingestFile(
    w: Work,
  ): Promise<{ turns: number; invalid: number; advanced: boolean }> {
    const { file } = w;
    const fields = w.base ? fieldsFromRow(w.base) : emptySessionFields();
    let pending = w.base ? [...w.base.pendingPrCreate] : [];
    let turns: TurnRow[] = [];
    let links = new Map<string, PrLinkObs>();
    let offset = w.start;
    let sinceCommit = 0;
    let turnsInserted = 0;
    let invalid = 0;

    const commit = async (): Promise<void> => {
      const cursor = await cursorAt(file.path, offset);
      turnsInserted += db.writeChunk({
        root,
        sid: file.sid,
        path: file.path,
        size: Math.max(file.size, offset),
        cursor,
        fields,
        title: titleOf(fields),
        turns,
        links: [...links.values()],
        pending,
        extractVersion: EXTRACT_VERSION,
      }).turnsInserted;
      turns = [];
      links = new Map();
      sinceCommit = 0;
    };

    for await (const line of readLines(file.path, w.start)) {
      sinceCommit += line.end - offset;
      offset = line.end;
      if (line.bytes && shouldParse(line.bytes)) {
        let rec: unknown;
        try {
          rec = JSON.parse(line.bytes.toString("utf8"));
        } catch {
          rec = undefined;
        }
        if (isRecord(rec)) {
          mergeRecordFields(fields, rec);
          const turn = extractTurn(rec);
          if (turn) turns.push(turn);
          const prs = extractPrs(rec, pending);
          pending = prs.pending;
          invalid += prs.invalid;
          for (const l of prs.links) mergeLinkObs(links, l);
        }
      }
      if (sinceCommit >= COMMIT_EVERY_BYTES) await commit();
    }
    // An append that read no complete line (an unterminated tail) has nothing to commit.
    const advanced = !w.base || offset > w.start;
    if (advanced) await commit();
    return { turns: turnsInserted, invalid, advanced };
  }

  async function settleAbsent(
    rows: Map<string, SessionRow>,
    seen: Map<string, TranscriptFile>,
  ): Promise<boolean> {
    let changed = false;
    const now = deps.now();
    const parents = new Map<string, ParentState>();
    for (const row of rows.values()) {
      if (seen.has(row.sid)) continue;
      if (row.deletedAt !== null) {
        if (row.extractVersion !== EXTRACT_VERSION) {
          db.restampTitle(root, row.sid, titleOf(fieldsFromRow(row)), EXTRACT_VERSION);
          changed = true;
        }
        continue;
      }
      const p = presence(
        await statCode(row.path),
        await parentState(dirname(row.path), parents),
      );
      const next = nextTombstone(row, p, now);
      if (next.missingSince !== row.missingSince || next.deletedAt !== row.deletedAt) {
        db.setTombstone(root, row.sid, next);
        if (next.deletedAt !== row.deletedAt) changed = true;
      }
    }
    return changed;
  }

  async function pass(): Promise<PassResult> {
    const result: PassResult = {
      changed: false,
      rootReadable: true,
      filesIngested: 0,
      invalidPrRefs: 0,
      turnsInserted: 0,
    };
    const listing = await listTranscripts(root);
    if (!listing.rootReadable) return { ...result, rootReadable: false };
    const seen = newestPerSession(listing.files);
    const rows = new Map(db.listSessions(root).map((r) => [r.sid, r]));

    const work: Work[] = [];
    for (const file of seen.values()) {
      let row = rows.get(file.sid);
      if (row && row.path !== file.path) {
        db.setPath(root, file.sid, file.path);
        row = { ...row, path: file.path };
        result.changed = true;
      }
      if (row && (row.missingSince !== null || row.deletedAt !== null)) {
        db.setTombstone(root, file.sid, { missingSince: null, deletedAt: null });
        result.changed = true;
      }
      const plan = classifyFile(row, file.size, EXTRACT_VERSION);
      if (plan.kind === "unchanged") continue;
      if (plan.kind === "new" || !row) {
        work.push({ file, base: undefined, start: 0, reset: false });
        continue;
      }
      if (plan.kind === "verify") {
        const spans = verifySpans(row);
        try {
          const head = await hashSpan(file.path, spans.head);
          const anchor = await hashSpan(file.path, spans.anchor);
          if (decideAppend(row, head, anchor) === "appended") {
            work.push({ file, base: row, start: row.offset, reset: false });
            continue;
          }
        } catch (err) {
          deps.log?.("search: could not verify a transcript", err);
          continue;
        }
      }
      work.push({ file, base: undefined, start: 0, reset: true });
    }

    work.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
    deps.onProgress?.({ done: 0, total: work.length });
    for (const [i, w] of work.entries()) {
      try {
        if (w.reset) db.resetSession(root, w.file.sid);
        const r = await ingestFile(w);
        if (r.advanced) {
          result.filesIngested++;
          result.turnsInserted += r.turns;
          result.invalidPrRefs += r.invalid;
          result.changed = true;
        }
      } catch (err) {
        deps.log?.("search: could not ingest a transcript", err);
      }
      deps.onProgress?.({ done: i + 1, total: work.length });
    }

    if (await settleAbsent(rows, seen)) result.changed = true;
    if (db.pruneOrphanPrs() > 0) result.changed = true;
    if (result.invalidPrRefs > 0)
      deps.log?.(`search: dropped ${result.invalidPrRefs} invalid PR references`);
    return result;
  }

  let running: Promise<PassResult> | null = null;
  let rerun = false;

  async function loop(): Promise<PassResult> {
    rerun = false;
    let merged = await pass();
    while (rerun) {
      rerun = false;
      merged = mergeResults(merged, await pass());
    }
    return merged;
  }

  return {
    runPass() {
      if (running) {
        rerun = true;
        return running;
      }
      running = loop().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/ingest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/ingest.ts test/main/search/ingest.test.ts
git add src/search/ingest.ts test/main/search/ingest.test.ts
git commit -m "feat: ingest transcripts incrementally into search.db (#206)"
```

---

### Task 13: `ghClient` — resolve `gh`, one GraphQL batch, partial output

**Files:**
- Create: `src/search/ghClient.ts`
- Create: `test/main/search/fixtures/fake-gh.mjs`
- Test: `test/main/search/ghClient.test.ts`

**Interfaces:**
- Consumes: `PrDetails` (Task 8); `isPrState` from `src/ipcTypes.ts` (Task 8); `isRecord` from `src/typeGuards.ts`.
- Produces:
  - `export const GH_TIMEOUT_MS = 20_000; export const BODY_MAX_BYTES = 65_536;`
  - `export type GhFailure = "ENOENT" | "timeout" | "bad-output";`
  - `export type BatchOutcome = { kind: "data"; byNumber: Map<number, PrDetails | null> } | { kind: "failed"; reason: GhFailure };` — `null` means the alias came back null or errored ("not-returned").
  - `export function resolveGhPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, isFile: (p: string) => boolean): string | undefined` — Windows looks for `gh.exe` only (a `.cmd` cannot be spawned with `shell: false`); darwin falls back to `/opt/homebrew/bin/gh`, then `/usr/local/bin/gh`.
  - `export function ghEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, ghPath: string): NodeJS.ProcessEnv` — on darwin, prepends `gh`'s directory to `PATH`.
  - `export function buildGraphqlArgs(repo: string, numbers: readonly number[]): string[]`
  - `export function parseGraphqlOutput(stdout: string, numbers: readonly number[]): BatchOutcome`
  - `export function truncateUtf8(s: string, maxBytes: number): string`
  - `export interface GhRunner { ghPath: string | undefined; prefixArgs?: string[]; env: NodeJS.ProcessEnv; timeoutMs?: number }` — `prefixArgs` is a test seam (run `node fake-gh.mjs`).
  - `export function runGhBatch(runner: GhRunner, repo: string, numbers: readonly number[]): Promise<BatchOutcome>` — never rejects.

- [ ] **Step 1: Write the fake `gh` and the failing test**

`test/main/search/fixtures/fake-gh.mjs`:

```js
// Stands in for `gh api graphql` in ghClient tests. FAKE_GH_MODE picks the reply;
// FAKE_GH_ARGS_FILE receives the argument array as JSON.
import process from "node:process";
import { setTimeout } from "node:timers";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_GH_ARGS_FILE)
  writeFileSync(process.env.FAKE_GH_ARGS_FILE, JSON.stringify(args));

const numbers = [];
for (let i = 0; i < args.length; i++)
  if (args[i] === "-F") numbers.push(Number(args[i + 1].split("=")[1]));

const pr = (n, extra = {}) => ({
  number: n,
  title: `PR ${n}`,
  state: "OPEN",
  isDraft: false,
  body: "body",
  url: `https://github.com/o/r/pull/${n}`,
  ...extra,
});
const repository = Object.fromEntries(numbers.map((n, i) => [`p${i}`, pr(n)]));
const print = (obj) => process.stdout.write(JSON.stringify(obj));

switch (process.env.FAKE_GH_MODE ?? "ok") {
  case "ok":
    print({ data: { repository } });
    break;
  case "partial-exit1":
    repository.p1 = null;
    print({
      data: { repository },
      errors: [{ type: "NOT_FOUND", path: ["repository", "p1"], message: "gone" }],
    });
    process.exitCode = 1;
    break;
  case "null-repo":
    print({ data: { repository: null }, errors: [{ type: "NOT_FOUND", path: ["repository"] }] });
    process.exitCode = 1;
    break;
  case "malformed":
    process.stdout.write("not json");
    break;
  case "no-data":
    print({ errors: [{ message: "Bad credentials" }] });
    process.exitCode = 1;
    break;
  case "hang":
    setTimeout(() => {}, 60_000);
    break;
  case "big-body":
    repository.p0 = pr(numbers[0], { body: "é".repeat(40_000) });
    print({ data: { repository } });
    break;
}
```

`test/main/search/ghClient.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BODY_MAX_BYTES,
  buildGraphqlArgs,
  ghEnv,
  parseGraphqlOutput,
  resolveGhPath,
  runGhBatch,
  truncateUtf8,
  type GhRunner,
} from "../../../src/search/ghClient";

const FAKE_GH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-gh.mjs");

describe("resolveGhPath", () => {
  test("finds gh.exe on a Windows Path", () => {
    const isFile = (p: string) => p === "C:\\b\\gh.exe";
    expect(resolveGhPath({ Path: "C:\\a;C:\\b" }, "win32", isFile)).toBe("C:\\b\\gh.exe");
  });

  test("ignores a gh.cmd shim on Windows", () => {
    const isFile = (p: string) => p === "C:\\a\\gh.cmd";
    expect(resolveGhPath({ PATH: "C:\\a" }, "win32", isFile)).toBeUndefined();
  });

  test("finds gh on a POSIX PATH", () => {
    const isFile = (p: string) => p === "/y/gh";
    expect(resolveGhPath({ PATH: "/x:/y" }, "linux", isFile)).toBe("/y/gh");
  });

  test("falls back to Homebrew locations on darwin only", () => {
    const isFile = (p: string) => p === "/usr/local/bin/gh";
    expect(resolveGhPath({ PATH: "/usr/bin" }, "darwin", isFile)).toBe("/usr/local/bin/gh");
    expect(resolveGhPath({ PATH: "/usr/bin" }, "linux", isFile)).toBeUndefined();
  });

  test("skips relative PATH entries", () => {
    const isFile = (p: string) => p === "gh.exe" || p === "C:\\b\\gh.exe";
    expect(resolveGhPath({ Path: ".;C:\\b" }, "win32", isFile)).toBe("C:\\b\\gh.exe");
    expect(resolveGhPath({ PATH: "bin" }, "linux", () => true)).toBeUndefined();
  });
});

test("ghEnv prepends gh's directory on darwin only", () => {
  expect(ghEnv({ PATH: "/usr/bin" }, "darwin", "/opt/homebrew/bin/gh").PATH).toBe(
    "/opt/homebrew/bin:/usr/bin",
  );
  expect(ghEnv({ PATH: "C:\\x" }, "win32", "C:\\gh\\gh.exe").PATH).toBe("C:\\x");
});

describe("buildGraphqlArgs", () => {
  const args = buildGraphqlArgs("Owner/2048", [5, 7]);

  test("passes owner and name as raw -f strings and numbers as -F ints", () => {
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args).toEqual(expect.arrayContaining(["-f", "owner=Owner", "-f", "name=2048"]));
    expect(args).toEqual(expect.arrayContaining(["-F", "n0=5", "-F", "n1=7"]));
  });

  test("never interpolates input into the query or passes an @file value", () => {
    const query = args[args.indexOf("-f") + 1];
    expect(query.startsWith("query=")).toBe(true);
    expect(query).not.toContain("Owner");
    expect(query).not.toContain("2048");
    const fValues = args.filter((_, i) => args[i - 1] === "-F");
    expect(fValues.every((v) => !v.startsWith("@"))).toBe(true);
  });
});

describe("parseGraphqlOutput", () => {
  test("maps aliases back to numbers and nulls errored aliases", () => {
    const out = parseGraphqlOutput(
      JSON.stringify({
        data: {
          repository: {
            p0: { title: "A", state: "MERGED", isDraft: false, body: "x" },
            p1: { title: "B", state: "OPEN", isDraft: true, body: null },
          },
        },
        errors: [{ path: ["repository", "p1"] }],
      }),
      [5, 7],
    );
    expect(out).toEqual({
      kind: "data",
      byNumber: new Map([
        [5, { title: "A", state: "MERGED", isDraft: false, body: "x" }],
        [7, null],
      ]),
    });
  });

  test("an unknown state is treated as not returned", () => {
    const out = parseGraphqlOutput(
      JSON.stringify({ data: { repository: { p0: { title: "A", state: "WEIRD" } } } }),
      [5],
    );
    expect(out).toEqual({ kind: "data", byNumber: new Map([[5, null]]) });
  });

  test.each(["", "not json", "{}", '{"data":null}', "[]"])("%j is bad output", (stdout) => {
    expect(parseGraphqlOutput(stdout, [1])).toEqual({ kind: "failed", reason: "bad-output" });
  });
});

test("truncateUtf8 never splits a character", () => {
  expect(truncateUtf8("aé", 2)).toBe("a");
  expect(truncateUtf8("aé", 3)).toBe("aé");
  expect(truncateUtf8("abc", 10)).toBe("abc");
});

describe("runGhBatch with a fake gh", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "csm-gh-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runner = (mode: string, timeoutMs = 10_000): GhRunner => ({
    ghPath: process.execPath,
    prefixArgs: [FAKE_GH],
    env: { ...process.env, FAKE_GH_MODE: mode, FAKE_GH_ARGS_FILE: join(dir, "args.json") },
    timeoutMs,
  });

  test("success returns every PR and passes the argument array unchanged", async () => {
    const out = await runGhBatch(runner("ok"), "o/r", [5, 7]);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.byNumber.get(5)).toEqual({ title: "PR 5", state: "OPEN", isDraft: false, body: "body" });
    const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[];
    expect(args).toEqual(buildGraphqlArgs("o/r", [5, 7]));
  });

  test("exit 1 with partial data still applies the good aliases", async () => {
    const out = await runGhBatch(runner("partial-exit1"), "o/r", [5, 7]);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.byNumber.get(5)?.title).toBe("PR 5");
    expect(out.byNumber.get(7)).toBeNull();
  });

  test("a withheld repository returns every PR as not returned", async () => {
    const out = await runGhBatch(runner("null-repo"), "o/r", [5]);
    expect(out).toEqual({ kind: "data", byNumber: new Map([[5, null]]) });
  });

  test.each(["malformed", "no-data"])("%s output is a batch failure", async (mode) => {
    expect(await runGhBatch(runner(mode), "o/r", [5])).toEqual({ kind: "failed", reason: "bad-output" });
  });

  test("a hung gh is killed at the timeout", async () => {
    expect(await runGhBatch(runner("hang", 300), "o/r", [5])).toEqual({
      kind: "failed",
      reason: "timeout",
    });
  });

  test("a missing gh is ENOENT", async () => {
    expect(await runGhBatch({ ghPath: undefined, env: process.env }, "o/r", [5])).toEqual({
      kind: "failed",
      reason: "ENOENT",
    });
    expect(
      await runGhBatch({ ghPath: join(dir, "no-such-gh"), env: process.env }, "o/r", [5]),
    ).toEqual({ kind: "failed", reason: "ENOENT" });
  });

  test("a long body is capped at 64 KB", async () => {
    const out = await runGhBatch(runner("big-body"), "o/r", [5]);
    if (out.kind !== "data") throw new Error("expected data");
    const body = out.byNumber.get(5)?.body ?? "";
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(BODY_MAX_BYTES);
    expect(body.length).toBeGreaterThan(30_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/ghClient.test.ts`
Expected: FAIL — cannot resolve `src/search/ghClient`.

- [ ] **Step 3: Implement**

`src/search/ghClient.ts`:

```ts
import { spawn } from "node:child_process";
import path from "node:path";
import { isPrState } from "../ipcTypes";
import { isRecord } from "../typeGuards";
import type { PrDetails } from "./searchDb";

export const GH_TIMEOUT_MS = 20_000;
export const BODY_MAX_BYTES = 65_536;

const DARWIN_FALLBACKS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
const ALIAS_RE = /^p\d+$/;

export type GhFailure = "ENOENT" | "timeout" | "bad-output";

export type BatchOutcome =
  | { kind: "data"; byNumber: Map<number, PrDetails | null> }
  | { kind: "failed"; reason: GhFailure };

export interface GhRunner {
  ghPath: string | undefined;
  prefixArgs?: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export function resolveGhPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isFile: (p: string) => boolean,
): string | undefined {
  const p = platform === "win32" ? path.win32 : path.posix;
  // shell:false cannot run a .cmd/.bat shim, so only the real executable counts.
  const name = platform === "win32" ? "gh.exe" : "gh";
  for (const entry of (env.PATH ?? env.Path ?? "").split(p.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    // A relative entry resolves against the app's cwd, not an install location.
    if (!dir || !p.isAbsolute(dir)) continue;
    const candidate = p.join(dir, name);
    if (isFile(candidate)) return candidate;
  }
  // Apps launched from the Dock or Finder get launchd's minimal PATH.
  return platform === "darwin" ? DARWIN_FALLBACKS.find(isFile) : undefined;
}

export function ghEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ghPath: string,
): NodeJS.ProcessEnv {
  if (platform !== "darwin") return env;
  const dir = path.posix.dirname(ghPath);
  return { ...env, PATH: env.PATH ? `${dir}:${env.PATH}` : dir };
}

function buildQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$n${i}: Int!`).join(", ");
  const fields = Array.from(
    { length: count },
    (_, i) => `p${i}: pullRequest(number: $n${i}) { number title state isDraft body url }`,
  ).join(" ");
  return `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`;
}

export function buildGraphqlArgs(repo: string, numbers: readonly number[]): string[] {
  const [owner, name] = repo.split("/");
  const args = [
    "api",
    "graphql",
    "-f",
    `query=${buildQuery(numbers.length)}`,
    // -f keeps owner/name as strings; -F would turn a numeric name into an Int.
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ];
  numbers.forEach((n, i) => args.push("-F", `n${i}=${n}`));
  return args;
}

export function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
}

function toDetails(node: unknown): PrDetails | null {
  if (!isRecord(node) || typeof node.title !== "string" || !isPrState(node.state))
    return null;
  return {
    title: node.title,
    state: node.state,
    isDraft: node.isDraft === true,
    body: truncateUtf8(typeof node.body === "string" ? node.body : "", BODY_MAX_BYTES),
  };
}

export function parseGraphqlOutput(
  stdout: string,
  numbers: readonly number[],
): BatchOutcome {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { kind: "failed", reason: "bad-output" };
  }
  if (!isRecord(json) || !isRecord(json.data))
    return { kind: "failed", reason: "bad-output" };
  const errored = new Set<string>();
  if (Array.isArray(json.errors))
    for (const e of json.errors)
      if (isRecord(e) && Array.isArray(e.path))
        for (const seg of e.path)
          if (typeof seg === "string" && ALIAS_RE.test(seg)) errored.add(seg);
  const repo = json.data.repository;
  const byNumber = new Map<number, PrDetails | null>();
  numbers.forEach((n, i) => {
    const alias = `p${i}`;
    byNumber.set(
      n,
      errored.has(alias) || !isRecord(repo) ? null : toDetails(repo[alias]),
    );
  });
  return { kind: "data", byNumber };
}

export function runGhBatch(
  runner: GhRunner,
  repo: string,
  numbers: readonly number[],
): Promise<BatchOutcome> {
  const ghPath = runner.ghPath;
  if (!ghPath) return Promise.resolve({ kind: "failed", reason: "ENOENT" });
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const child = spawn(
      ghPath,
      [...(runner.prefixArgs ?? []), ...buildGraphqlArgs(repo, numbers)],
      {
        shell: false,
        env: runner.env,
        // Without this Windows can flash a console window for gh.exe.
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const finish = (outcome: BatchOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ kind: "failed", reason: "timeout" });
    }, runner.timeoutMs ?? GH_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err: NodeJS.ErrnoException) =>
      finish({ kind: "failed", reason: err.code === "ENOENT" ? "ENOENT" : "bad-output" }),
    );
    // Parse whatever arrived regardless of exit code: gh exits 1 on partial data.
    child.on("close", () =>
      finish(parseGraphqlOutput(Buffer.concat(chunks).toString("utf8"), numbers)),
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/ghClient.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/ghClient.ts test/main/search/ghClient.test.ts test/main/search/fixtures/fake-gh.mjs
git add src/search/ghClient.ts test/main/search/ghClient.test.ts test/main/search/fixtures/fake-gh.mjs
git commit -m "feat: fetch PR details through gh api graphql (#206)"
```

---

### Task 14: `ghEnrich` — due PRs into per-repo batches with backoff

**Files:**
- Create: `src/search/ghEnrich.ts`
- Test: `test/main/search/ghEnrich.test.ts`

**Interfaces:**
- Consumes: `SearchDb` (`duePrs`, `applyPrDetails`, `markPrError`), `PrKey`, `PrDetails` (Task 8); `BatchOutcome` (Task 13).
- Produces:
  - `export const BATCH_SIZE = 50; export const MAX_IN_FLIGHT = 2; export const REPO_BACKOFF_MS = 900_000;`
  - `export type RunBatch = (repo: string, numbers: number[]) => Promise<BatchOutcome>;`
  - `export interface EnrichResult { wrote: number; failures: number }` — `wrote` counts PRs whose details were applied.
  - `export interface EnricherDeps { db: Pick<SearchDb, "duePrs" | "applyPrDetails" | "markPrError">; runBatch: RunBatch; now: () => number }`
  - `export function createEnricher(deps: EnricherDeps): { runDue(): Promise<EnrichResult> }` — a call while one runs returns the running promise.

- [ ] **Step 1: Write the failing test**

`test/main/search/ghEnrich.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import {
  BATCH_SIZE,
  createEnricher,
  REPO_BACKOFF_MS,
  type EnricherDeps,
  type RunBatch,
} from "../../../src/search/ghEnrich";
import type { PrDetails, PrKey } from "../../../src/search/searchDb";

const details = (n: number): PrDetails => ({ title: `PR ${n}`, state: "OPEN", isDraft: false, body: "" });

function fakeDb(due: PrKey[]) {
  return {
    duePrs: vi.fn(() => due),
    applyPrDetails: vi.fn(),
    markPrError: vi.fn(),
  } satisfies EnricherDeps["db"];
}

const allData: RunBatch = async (_repo, numbers) => ({
  kind: "data",
  byNumber: new Map(numbers.map((n) => [n, details(n)])),
});

describe("createEnricher", () => {
  test("groups due PRs by repo case-insensitively, keeping the first-seen case", async () => {
    const db = fakeDb([
      { repo: "O/R", number: 1 },
      { repo: "o/r", number: 2 },
      { repo: "x/y", number: 3 },
    ]);
    const runBatch = vi.fn(allData);
    const r = await createEnricher({ db, runBatch, now: () => 0 }).runDue();
    expect(runBatch.mock.calls).toEqual([
      ["O/R", [1, 2]],
      ["x/y", [3]],
    ]);
    expect(r).toEqual({ wrote: 3, failures: 0 });
    expect(db.applyPrDetails).toHaveBeenCalledWith({ repo: "O/R", number: 2 }, details(2), 0);
  });

  test("splits a repo into batches of 50", async () => {
    const db = fakeDb(Array.from({ length: 120 }, (_, i) => ({ repo: "o/r", number: i + 1 })));
    const runBatch = vi.fn(allData);
    await createEnricher({ db, runBatch, now: () => 0 }).runDue();
    expect(runBatch.mock.calls.map((c) => c[1].length)).toEqual([BATCH_SIZE, BATCH_SIZE, 20]);
  });

  test("runs at most two batches at once", async () => {
    const db = fakeDb(["a/a", "b/b", "c/c", "d/d"].map((repo) => ({ repo, number: 1 })));
    let live = 0;
    let peak = 0;
    const runBatch: RunBatch = async (repo, numbers) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return allData(repo, numbers);
    };
    await createEnricher({ db, runBatch, now: () => 0 }).runDue();
    expect(peak).toBe(2);
  });

  test("not-returned PRs are marked without backing off the repo", async () => {
    const db = fakeDb([
      { repo: "o/r", number: 1 },
      { repo: "o/r", number: 2 },
    ]);
    const runBatch = vi.fn<RunBatch>(async () => ({
      kind: "data",
      byNumber: new Map([
        [1, details(1)],
        [2, null],
      ]),
    }));
    const enricher = createEnricher({ db, runBatch, now: () => 0 });
    expect(await enricher.runDue()).toEqual({ wrote: 1, failures: 0 });
    expect(db.markPrError).toHaveBeenCalledWith({ repo: "o/r", number: 2 }, "not-returned", 0);
    await enricher.runDue();
    expect(runBatch).toHaveBeenCalledTimes(2);
  });

  test("a failed batch marks every PR and backs the repo off for 15 minutes", async () => {
    const db = fakeDb([{ repo: "o/r", number: 1 }]);
    let clock = 0;
    const runBatch = vi.fn<RunBatch>(async () => ({ kind: "failed", reason: "timeout" }));
    const enricher = createEnricher({ db, runBatch, now: () => clock });
    expect(await enricher.runDue()).toEqual({ wrote: 0, failures: 1 });
    expect(db.markPrError).toHaveBeenCalledWith({ repo: "o/r", number: 1 }, "timeout", 0);
    clock = REPO_BACKOFF_MS - 1;
    await enricher.runDue();
    expect(runBatch).toHaveBeenCalledTimes(1);
    clock = REPO_BACKOFF_MS;
    await enricher.runDue();
    expect(runBatch).toHaveBeenCalledTimes(2);
  });

  test("a throwing runBatch counts as bad output", async () => {
    const db = fakeDb([{ repo: "o/r", number: 1 }]);
    const runBatch: RunBatch = async () => {
      throw new Error("boom");
    };
    expect(await createEnricher({ db, runBatch, now: () => 0 }).runDue()).toEqual({
      wrote: 0,
      failures: 1,
    });
    expect(db.markPrError).toHaveBeenCalledWith({ repo: "o/r", number: 1 }, "bad-output", 0);
  });

  test("a call while running shares the running promise", async () => {
    const db = fakeDb([{ repo: "o/r", number: 1 }]);
    const runBatch = vi.fn(allData);
    const enricher = createEnricher({ db, runBatch, now: () => 0 });
    const a = enricher.runDue();
    expect(enricher.runDue()).toBe(a);
    await a;
    expect(runBatch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/ghEnrich.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/search/ghEnrich.ts`:

```ts
import type { BatchOutcome } from "./ghClient";
import type { SearchDb } from "./searchDb";

export const BATCH_SIZE = 50;
export const MAX_IN_FLIGHT = 2;
export const REPO_BACKOFF_MS = 15 * 60_000;

export type RunBatch = (repo: string, numbers: number[]) => Promise<BatchOutcome>;

export interface EnrichResult {
  wrote: number;
  failures: number;
}

export interface EnricherDeps {
  db: Pick<SearchDb, "duePrs" | "applyPrDetails" | "markPrError">;
  runBatch: RunBatch;
  now: () => number;
}

interface Batch {
  repo: string;
  numbers: number[];
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export function createEnricher(deps: EnricherDeps): {
  runDue(): Promise<EnrichResult>;
} {
  const backoffUntil = new Map<string, number>();
  let running: Promise<EnrichResult> | null = null;

  function batchesDue(now: number): Batch[] {
    const groups = new Map<string, Batch>();
    for (const key of deps.db.duePrs(now)) {
      const k = key.repo.toLowerCase();
      if ((backoffUntil.get(k) ?? 0) > now) continue;
      let g = groups.get(k);
      if (!g) {
        g = { repo: key.repo, numbers: [] };
        groups.set(k, g);
      }
      g.numbers.push(key.number);
    }
    const batches: Batch[] = [];
    for (const g of groups.values())
      for (let i = 0; i < g.numbers.length; i += BATCH_SIZE)
        batches.push({ repo: g.repo, numbers: g.numbers.slice(i, i + BATCH_SIZE) });
    return batches;
  }

  async function runOnce(): Promise<EnrichResult> {
    const result: EnrichResult = { wrote: 0, failures: 0 };
    await runPool(batchesDue(deps.now()), MAX_IN_FLIGHT, async (b) => {
      const outcome = await deps
        .runBatch(b.repo, b.numbers)
        .catch((): BatchOutcome => ({ kind: "failed", reason: "bad-output" }));
      const at = deps.now();
      if (outcome.kind === "failed") {
        result.failures++;
        backoffUntil.set(b.repo.toLowerCase(), at + REPO_BACKOFF_MS);
        for (const n of b.numbers)
          deps.db.markPrError({ repo: b.repo, number: n }, outcome.reason, at);
        return;
      }
      for (const n of b.numbers) {
        const d = outcome.byNumber.get(n) ?? null;
        if (d) {
          deps.db.applyPrDetails({ repo: b.repo, number: n }, d, at);
          result.wrote++;
        } else {
          deps.db.markPrError({ repo: b.repo, number: n }, "not-returned", at);
        }
      }
    });
    return result;
  }

  return {
    runDue() {
      running ??= runOnce().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/ghEnrich.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/ghEnrich.ts test/main/search/ghEnrich.test.ts
git add src/search/ghEnrich.ts test/main/search/ghEnrich.test.ts
git commit -m "feat: enrich due PRs in per-repo gh batches with backoff (#206)"
```

---

### Task 15: The search worker — protocol, service, entry, bundle

**Files:**
- Create: `src/search/protocol.ts`
- Create: `src/search/searchService.ts`
- Create: `src/search/searchWorker.ts`
- Create: `scripts/build-worker.mjs`, `scripts/build-worker.d.mts`
- Modify: `package.json` (scripts)
- Test: `test/main/search/searchService.test.ts`, `test/main/search/workerBundle.test.ts`

**Interfaces:**
- Consumes: `SearchDb`, `openSearchDb`, `openSearchDbSafe` (Tasks 7–9); `createIngester` (Task 12); `ghEnv`, `runGhBatch` (Task 13); `createEnricher`, `RunBatch` (Task 14); `SessionPrsResult` (Task 8).
- Produces:
  - `src/search/protocol.ts`:
    - `export interface WorkerInit { dbDir: string; projectsRoot: string; platform: NodeJS.Platform; ghPath: string | null }` — main resolves `gh` once at startup; `null` means not installed.
    - `export type HostToWorker = { type: "ingest" } | { type: "prsFor"; id: number; sids: string[] } | { type: "shutdown" };`
    - `export type WorkerToHost = { type: "ready"; ftsOk: boolean; recovered: boolean } | { type: "progress"; done: number; total: number } | { type: "changed" } | { type: "result"; id: number; ok: true; value: SessionPrsResult } | { type: "result"; id: number; ok: false } | { type: "shutdownAck" } | { type: "fatal"; code: "OPEN_FAILED" };`
  - `src/search/searchService.ts`:
    - `export const ENRICH_INTERVAL_MS = 600_000; export const IDLE_BEFORE_MAINTENANCE_MS = 2_000; export const OPTIMIZE_AFTER_TURNS = 1_000; export const PROGRESS_EVERY = 50;`
    - `export interface ServiceTimers { setTimeout(fn: () => void, ms: number): () => void; setInterval(fn: () => void, ms: number): () => void }` — each returns its cancel function.
    - `export interface SearchServiceDeps { db: SearchDb; root: string; post: (msg: WorkerToHost) => void; now: () => number; runBatch: RunBatch; log: (msg: string, err?: unknown) => void; timers?: ServiceTimers }`
    - `export interface SearchService { start(): void; handle(msg: HostToWorker): void; whenIdle(): Promise<void> }`
    - `export function createSearchService(deps: SearchServiceDeps): SearchService`
  - `scripts/build-worker.mjs`: `export function workerBuildOptions(repoRoot: string): BuildOptions` → bundles `src/search/searchWorker.ts` to `dist/searchWorker.js`.
  - `package.json`: `"build:worker": "node scripts/build-worker.mjs"`; `build` runs main → preload → worker → renderer.

- [ ] **Step 1: Write the failing tests**

`test/main/search/searchService.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSearchDb, type PrDetails, type SearchDb } from "../../../src/search/searchDb";
import {
  createSearchService,
  IDLE_BEFORE_MAINTENANCE_MS,
  OPTIMIZE_AFTER_TURNS,
  type SearchServiceDeps,
  type ServiceTimers,
} from "../../../src/search/searchService";
import type { RunBatch } from "../../../src/search/ghEnrich";
import type { WorkerToHost } from "../../../src/search/protocol";

const SID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

let tmp: string;
let root: string;
let db: SearchDb;
let clock: number;
let posted: WorkerToHost[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "csm-svc-"));
  root = join(tmp, "projects");
  mkdirSync(join(root, "proj-a"), { recursive: true });
  mkdirSync(join(tmp, "userData"));
  db = openSearchDb(join(tmp, "userData"), { platform: process.platform });
  clock = Date.parse("2026-10-01T12:00:00Z");
  posted = [];
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const rec = (o: object) => `${JSON.stringify(o)}\n`;
function writeTranscript(turns = 1) {
  const lines = [
    rec({
      type: "pr-link",
      sessionId: SID,
      prNumber: 12,
      prRepository: "o/r",
      prUrl: "https://github.com/o/r/pull/12",
      timestamp: new Date(T0).toISOString(),
    }),
  ];
  for (let i = 0; i < turns; i++)
    lines.push(
      rec({
        type: "user",
        uuid: `u${i}`,
        timestamp: new Date(T0 + i).toISOString(),
        message: { role: "user", content: `turn ${i}` },
      }),
    );
  writeFileSync(join(root, "proj-a", `${SID}.jsonl`), lines.join(""));
}

const details = (n: number): PrDetails => ({ title: `PR ${n}`, state: "OPEN", isDraft: false, body: "" });
const okBatch: RunBatch = async (_repo, numbers) => ({
  kind: "data",
  byNumber: new Map(numbers.map((n) => [n, details(n)])),
});

interface Pending {
  fn: () => void;
  ms: number;
  live: boolean;
}

function service(over: Partial<SearchServiceDeps> = {}) {
  const timeouts: Pending[] = [];
  const timers: ServiceTimers = {
    setTimeout(fn, ms) {
      const t = { fn, ms, live: true };
      timeouts.push(t);
      return () => {
        t.live = false;
      };
    },
    setInterval: () => () => {},
  };
  const fire = () => {
    const t = timeouts.find((x) => x.live);
    if (!t) throw new Error("no live timer");
    t.live = false;
    t.fn();
  };
  const live = () => timeouts.filter((t) => t.live).map((t) => t.ms);
  const log = vi.fn();
  const svc = createSearchService({
    db,
    root,
    post: (m) => posted.push(m),
    now: () => clock,
    runBatch: okBatch,
    log,
    timers,
    ...over,
  });
  return { svc, fire, live, log };
}

const changedCount = () => posted.filter((m) => m.type === "changed").length;

describe("createSearchService", () => {
  test("start ingests, then enriches, posting changed after each", async () => {
    writeTranscript();
    const { svc } = service();
    svc.start();
    await svc.whenIdle();
    expect(changedCount()).toBe(2);
    expect(db.prsForSessions(root, [SID])[SID][0]).toMatchObject({
      number: 12,
      title: "PR 12",
      state: "OPEN",
    });
  });

  test("prsFor replies with the session's links", async () => {
    writeTranscript();
    const { svc } = service();
    svc.start();
    await svc.whenIdle();
    svc.handle({ type: "prsFor", id: 7, sids: [SID] });
    expect(posted.at(-1)).toMatchObject({
      type: "result",
      id: 7,
      ok: true,
      value: { [SID]: [{ number: 12 }] },
    });
  });

  test("a pass that changes nothing posts no changed", async () => {
    writeTranscript();
    const { svc } = service();
    svc.start();
    await svc.whenIdle();
    posted.length = 0;
    svc.handle({ type: "ingest" });
    await svc.whenIdle();
    expect(changedCount()).toBe(0);
  });

  test("a failing query replies ok:false and logs", () => {
    const { svc, log } = service();
    db.close();
    svc.handle({ type: "prsFor", id: 3, sids: [SID] });
    expect(posted).toEqual([{ type: "result", id: 3, ok: false }]);
    expect(log).toHaveBeenCalled();
  });

  test("failed gh batches are logged", async () => {
    writeTranscript();
    const { svc, log } = service({
      runBatch: async () => ({ kind: "failed", reason: "ENOENT" }),
    });
    svc.start();
    await svc.whenIdle();
    expect(log.mock.calls.map((c) => c[0])).toContain(
      "gh enrichment: 1 batch(es) failed",
    );
  });

  test("shutdown closes the store, acks, and ignores later messages", () => {
    const { svc } = service();
    svc.handle({ type: "shutdown" });
    expect(posted).toEqual([{ type: "shutdownAck" }]);
    svc.handle({ type: "prsFor", id: 1, sids: [SID] });
    expect(posted).toHaveLength(1);
    expect(() => db.getMeta("x")).toThrow();
  });
});

describe("fts maintenance", () => {
  test("a large pass optimizes once the store is idle", async () => {
    writeTranscript(OPTIMIZE_AFTER_TURNS);
    const optimize = vi.spyOn(db, "optimizeFts");
    const { svc, fire, live } = service();
    svc.start();
    await svc.whenIdle();
    expect(live()).toEqual([IDLE_BEFORE_MAINTENANCE_MS]);
    fire();
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  test("maintenance waits while queries keep arriving", async () => {
    writeTranscript(OPTIMIZE_AFTER_TURNS);
    const optimize = vi.spyOn(db, "optimizeFts");
    const { svc, fire, live } = service();
    svc.start();
    await svc.whenIdle();
    svc.handle({ type: "prsFor", id: 1, sids: [SID] });
    fire();
    expect(optimize).not.toHaveBeenCalled();
    expect(live()).toEqual([IDLE_BEFORE_MAINTENANCE_MS]);
    clock += IDLE_BEFORE_MAINTENANCE_MS;
    fire();
    expect(optimize).toHaveBeenCalledTimes(1);
  });

  test("a small pass schedules no maintenance", async () => {
    writeTranscript(1);
    const { svc, live } = service();
    svc.start();
    await svc.whenIdle();
    expect(live()).toEqual([]);
  });
});
```

`test/main/search/workerBundle.test.ts`:

```ts
// @vitest-environment node
import { expect, test } from "vitest";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { workerBuildOptions } from "../../../scripts/build-worker.mjs";
import type { HostToWorker, WorkerInit, WorkerToHost } from "../../../src/search/protocol";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";

test("the worker bundle requires only Node built-ins", async () => {
  const result = await build({ ...workerBuildOptions(repoRoot), write: false });
  const out = (result.outputFiles ?? []).find((f) => f.path.endsWith(".js"));
  expect(out).toBeDefined();
  const required = [...out!.text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  expect(required.filter((m) => !isBuiltin(m))).toEqual([]);
  expect(required).toEqual(expect.arrayContaining(["node:sqlite", "node:worker_threads"]));
});

test("the built worker opens the store, ingests and answers prsFor", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "csm-worker-"));
  try {
    const out = join(tmp, "searchWorker.js");
    await build({ ...workerBuildOptions(repoRoot), outfile: out, sourcemap: false });
    const root = join(tmp, "projects");
    mkdirSync(join(root, "p"), { recursive: true });
    writeFileSync(
      join(root, "p", `${SID}.jsonl`),
      `${JSON.stringify({
        type: "pr-link",
        sessionId: SID,
        prNumber: 3,
        prRepository: "o/r",
        prUrl: "https://github.com/o/r/pull/3",
        timestamp: "2026-10-01T10:00:00.000Z",
      })}\n`,
    );
    const init: WorkerInit = { dbDir: tmp, projectsRoot: root, platform: process.platform, ghPath: null };
    const worker = new Worker(out, { workerData: init });
    const messages: WorkerToHost[] = [];
    worker.on("message", (m: WorkerToHost) => messages.push(m));
    const next = (type: WorkerToHost["type"]) =>
      new Promise<WorkerToHost>((resolve, reject) => {
        const seen = messages.find((m) => m.type === type);
        if (seen) return resolve(seen);
        const onMsg = (m: WorkerToHost) => {
          if (m.type !== type) return;
          worker.off("message", onMsg);
          resolve(m);
        };
        worker.on("message", onMsg);
        worker.once("error", reject);
      });

    expect(await next("ready")).toEqual({ type: "ready", ftsOk: true, recovered: false });
    await next("changed");
    worker.postMessage({ type: "prsFor", id: 1, sids: [SID] } satisfies HostToWorker);
    expect(await next("result")).toMatchObject({
      id: 1,
      ok: true,
      value: { [SID]: [{ repo: "o/r", number: 3, title: null }] },
    });
    worker.postMessage({ type: "shutdown" } satisfies HostToWorker);
    await next("shutdownAck");
    await worker.terminate();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}, 30_000);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchService.test.ts test/main/search/workerBundle.test.ts`
Expected: FAIL — cannot resolve `src/search/searchService` and `scripts/build-worker.mjs`.

- [ ] **Step 3: Implement**

`src/search/protocol.ts`:

```ts
import type { SessionPrsResult } from "../ipcTypes";

export interface WorkerInit {
  dbDir: string;
  projectsRoot: string;
  platform: NodeJS.Platform;
  ghPath: string | null;
}

export type HostToWorker =
  | { type: "ingest" }
  | { type: "prsFor"; id: number; sids: string[] }
  | { type: "shutdown" };

export type WorkerToHost =
  | { type: "ready"; ftsOk: boolean; recovered: boolean }
  | { type: "progress"; done: number; total: number }
  | { type: "changed" }
  | { type: "result"; id: number; ok: true; value: SessionPrsResult }
  | { type: "result"; id: number; ok: false }
  | { type: "shutdownAck" }
  | { type: "fatal"; code: "OPEN_FAILED" };
```

`src/search/searchService.ts`:

```ts
import { createEnricher, type RunBatch } from "./ghEnrich";
import { createIngester } from "./ingest";
import type { HostToWorker, WorkerToHost } from "./protocol";
import type { SearchDb } from "./searchDb";

export const ENRICH_INTERVAL_MS = 10 * 60_000;
export const IDLE_BEFORE_MAINTENANCE_MS = 2_000;
export const OPTIMIZE_AFTER_TURNS = 1_000;
export const PROGRESS_EVERY = 50;

export interface ServiceTimers {
  setTimeout(fn: () => void, ms: number): () => void;
  setInterval(fn: () => void, ms: number): () => void;
}

const realTimers: ServiceTimers = {
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
  setInterval(fn, ms) {
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
};

export interface SearchServiceDeps {
  db: SearchDb;
  root: string;
  post: (msg: WorkerToHost) => void;
  now: () => number;
  runBatch: RunBatch;
  log: (msg: string, err?: unknown) => void;
  timers?: ServiceTimers;
}

export interface SearchService {
  start(): void;
  handle(msg: HostToWorker): void;
  whenIdle(): Promise<void>;
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  const { db, root, post, now } = deps;
  const timers = deps.timers ?? realTimers;
  let closed = false;
  let lastQueryAt = Number.NEGATIVE_INFINITY;
  let turnsSinceOptimize = 0;
  let cancelMaintenance: (() => void) | null = null;
  let cancelEnrichTimer: (() => void) | null = null;
  const inflight = new Set<Promise<void>>();

  // Work still in flight at shutdown fails against the closed store; that is expected.
  const log = (msg: string, err?: unknown): void => {
    if (!closed) deps.log(msg, err);
  };

  const ingester = createIngester({
    db,
    root,
    now,
    log,
    onProgress: ({ done, total }) => {
      if (!closed && (done === 0 || done === total || done % PROGRESS_EVERY === 0))
        post({ type: "progress", done, total });
    },
  });
  const enricher = createEnricher({ db, runBatch: deps.runBatch, now });

  function track(task: () => Promise<void>): void {
    if (closed) return;
    const p: Promise<void> = task()
      .catch((err: unknown) => log("search task failed", err))
      .finally(() => inflight.delete(p));
    inflight.add(p);
  }

  async function enrich(): Promise<void> {
    const r = await enricher.runDue();
    if (r.failures > 0) log(`gh enrichment: ${r.failures} batch(es) failed`);
    if (!closed && r.wrote > 0) post({ type: "changed" });
  }

  async function ingestThenEnrich(): Promise<void> {
    const r = await ingester.runPass();
    if (closed) return;
    if (r.changed) {
      post({ type: "changed" });
      turnsSinceOptimize += r.turnsInserted;
      scheduleMaintenance();
    }
    await enrich();
  }

  function scheduleMaintenance(): void {
    if (cancelMaintenance || turnsSinceOptimize < OPTIMIZE_AFTER_TURNS) return;
    cancelMaintenance = timers.setTimeout(runMaintenance, IDLE_BEFORE_MAINTENANCE_MS);
  }

  // optimize blocks this thread, so it waits until PR-link queries go quiet.
  function runMaintenance(): void {
    cancelMaintenance = null;
    if (closed) return;
    const quietFor = now() - lastQueryAt;
    if (quietFor < IDLE_BEFORE_MAINTENANCE_MS) {
      cancelMaintenance = timers.setTimeout(
        runMaintenance,
        IDLE_BEFORE_MAINTENANCE_MS - quietFor,
      );
      return;
    }
    try {
      db.optimizeFts();
      turnsSinceOptimize = 0;
    } catch (err) {
      log("fts optimize failed", err);
    }
  }

  return {
    start() {
      track(ingestThenEnrich);
      cancelEnrichTimer = timers.setInterval(() => track(enrich), ENRICH_INTERVAL_MS);
    },
    handle(msg) {
      if (closed) return;
      switch (msg.type) {
        case "ingest":
          track(ingestThenEnrich);
          break;
        case "prsFor":
          lastQueryAt = now();
          try {
            post({ type: "result", id: msg.id, ok: true, value: db.prsForSessions(root, msg.sids) });
          } catch (err) {
            log("prsFor failed", err);
            post({ type: "result", id: msg.id, ok: false });
          }
          break;
        case "shutdown":
          closed = true;
          cancelMaintenance?.();
          cancelEnrichTimer?.();
          db.close();
          post({ type: "shutdownAck" });
          break;
      }
    },
    async whenIdle() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}
```

`src/search/searchWorker.ts`:

```ts
import { parentPort, workerData } from "node:worker_threads";
import { ghEnv, runGhBatch } from "./ghClient";
import type { HostToWorker, WorkerInit, WorkerToHost } from "./protocol";
import { openSearchDbSafe } from "./searchDb";
import { createSearchService } from "./searchService";

const port = parentPort;
if (!port) throw new Error("searchWorker must run as a worker thread");
const init = workerData as WorkerInit;
const post = (msg: WorkerToHost): void => port.postMessage(msg);
const log = (msg: string, err?: unknown): void =>
  console.error(`[csm search] ${msg}`, err ?? "");

try {
  const { db, recovered } = openSearchDbSafe(init.dbDir, {
    platform: init.platform,
    now: Date.now(),
  });
  const ghPath = init.ghPath ?? undefined;
  const env = ghPath ? ghEnv(process.env, init.platform, ghPath) : process.env;
  const service = createSearchService({
    db,
    root: init.projectsRoot,
    post,
    now: Date.now,
    log,
    runBatch: (repo, numbers) => runGhBatch({ ghPath, env }, repo, numbers),
  });
  port.on("message", (msg: HostToWorker) => service.handle(msg));
  post({ type: "ready", ftsOk: db.ftsOk, recovered });
  service.start();
} catch (err) {
  log("could not open search.db", err);
  post({ type: "fatal", code: "OPEN_FAILED" });
  port.close();
}
```

`scripts/build-worker.mjs`:

```js
// Bundles the search worker into one self-contained CommonJS file, which the
// packaged app ships unpacked (electron-builder.yml asarUnpack).
// test/main/search/workerBundle.test.ts imports workerBuildOptions so the test
// and the real build never drift.

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

/**
 * esbuild options for the search worker bundle.
 *
 * @param {string} repoRoot absolute path to the repository root.
 */
export function workerBuildOptions(repoRoot) {
  return {
    entryPoints: [join(repoRoot, "src", "search", "searchWorker.ts")],
    outfile: join(repoRoot, "dist", "searchWorker.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node22",
    sourcemap: true,
  };
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await build(workerBuildOptions(repoRoot));
}
```

`scripts/build-worker.d.mts`:

```ts
import type { BuildOptions } from "esbuild";

/**
 * esbuild options for the self-contained search worker bundle.
 * @param repoRoot absolute path to the repository root.
 */
export function workerBuildOptions(repoRoot: string): BuildOptions;
```

In `package.json` `scripts`, add `"build:worker": "node scripts/build-worker.mjs",` after `build:preload`, and change `build` to:

```json
"build": "npm run build:main && npm run build:preload && npm run build:worker && npm run build:renderer",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/search/searchService.test.ts test/main/search/workerBundle.test.ts`
Expected: PASS

Then: `npm run build` (timeout 300000). Expected: exits 0 and `dist/searchWorker.js` exists.

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/search/protocol.ts src/search/searchService.ts src/search/searchWorker.ts scripts/build-worker.mjs scripts/build-worker.d.mts package.json test/main/search/searchService.test.ts test/main/search/workerBundle.test.ts
git add src/search/protocol.ts src/search/searchService.ts src/search/searchWorker.ts scripts/build-worker.mjs scripts/build-worker.d.mts package.json test/main/search/searchService.test.ts test/main/search/workerBundle.test.ts
git commit -m "feat: run ingest and enrichment in a bundled search worker (#206)"
```

---

### Task 16: Main side — `searchHost` lifecycle and `searchFiles` purge

**Files:**
- Create: `src/searchHost.ts`
- Create: `src/searchFiles.ts`
- Test: `test/main/searchHost.test.ts`, `test/main/searchFiles.test.ts`

**Interfaces:**
- Consumes: `HostToWorker`, `WorkerToHost` (Task 15); `SessionPrsResult` (Task 8).
- Produces:
  - `src/searchHost.ts`:
    - `export interface WorkerLike { postMessage(msg: HostToWorker): void; on(event: "message", listener: (msg: WorkerToHost) => void): unknown; on(event: "error", listener: (err: Error) => void): unknown; on(event: "exit", listener: (code: number) => void): unknown; terminate(): Promise<number> }` — `node:worker_threads` `Worker` satisfies it.
    - `export type SearchEvent = { type: "changed"; generation: number } | { type: "progress"; done: number; total: number };`
    - `export type SearchHostState = "stopped" | "starting" | "running" | "failed";`
    - `export const RESTART_DELAYS_MS = [1_000, 5_000, 30_000]; export const STABLE_AFTER_MS = 60_000; export const SHUTDOWN_ACK_MS = 2_000; export const REQUEST_TIMEOUT_MS = 10_000;`
    - `export interface SearchHostDeps { createWorker: () => WorkerLike; emit: (e: SearchEvent) => void; log: (msg: string, err?: unknown) => void }`
    - `export interface SearchHost { readonly state: SearchHostState; start(): void; requestIngest(): void; prsFor(sids: string[]): Promise<SessionPrsResult>; stop(): Promise<void> }` — `prsFor` never rejects; it resolves `{}` when there is no worker, no ids, a failed reply, a timeout or a worker exit.
    - `export function createSearchHost(deps: SearchHostDeps): SearchHost`
  - `src/searchFiles.ts`:
    - `export const SEARCH_FILE_RE: RegExp` — `search.db`, `search.db-wal`, `search.db-shm`, `search.bak-*`, `search.corrupt-*`.
    - `export interface PurgeDeps { readdir?: (dir: string) => Promise<string[]>; unlink?: (path: string) => Promise<void>; sleep?: (ms: number) => Promise<void>; retryMs?: number; stepMs?: number }`
    - `export function purgeSearchFiles(dir: string, deps?: PurgeDeps): Promise<{ ok: boolean; remaining: string[] }>` — retries `EBUSY`/`EPERM` for `retryMs` (default 5000) every `stepMs` (default 100); a missing directory or file counts as removed; any other error rejects.

- [ ] **Step 1: Write the failing tests**

`test/main/searchHost.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createSearchHost,
  REQUEST_TIMEOUT_MS,
  RESTART_DELAYS_MS,
  SHUTDOWN_ACK_MS,
  STABLE_AFTER_MS,
  type SearchEvent,
  type WorkerLike,
} from "../../src/searchHost";
import type { HostToWorker, WorkerToHost } from "../../src/search/protocol";

class FakeWorker implements WorkerLike {
  posted: HostToWorker[] = [];
  terminated = false;
  private listeners = new Map<string, ((arg: never) => void)[]>();

  postMessage(msg: HostToWorker): void {
    this.posted.push(msg);
  }
  on(event: "message" | "error" | "exit", listener: (arg: never) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
  send(msg: WorkerToHost): void {
    this.fire("message", msg);
  }
  exit(code = 1): void {
    this.fire("exit", code);
  }
  private fire(event: string, arg: unknown): void {
    for (const l of this.listeners.get(event) ?? []) (l as (a: unknown) => void)(arg);
  }
}

const SID = "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a";
const READY: WorkerToHost = { type: "ready", ftsOk: true, recovered: false };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(createWorker?: () => WorkerLike) {
  const workers: FakeWorker[] = [];
  const events: SearchEvent[] = [];
  const log = vi.fn();
  const host = createSearchHost({
    createWorker:
      createWorker ??
      (() => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      }),
    emit: (e) => events.push(e),
    log,
  });
  return { host, workers, events, log, last: () => workers[workers.length - 1] };
}

describe("createSearchHost", () => {
  test("ready and each worker change emit a rising generation", () => {
    const { host, last, events } = setup();
    host.start();
    expect(host.state).toBe("starting");
    last().send(READY);
    last().send({ type: "changed" });
    expect(host.state).toBe("running");
    expect(events).toEqual([
      { type: "changed", generation: 1 },
      { type: "changed", generation: 2 },
    ]);
  });

  test("start is idempotent", () => {
    const { host, workers } = setup();
    host.start();
    host.start();
    expect(workers).toHaveLength(1);
  });

  test("progress is forwarded", () => {
    const { host, last, events } = setup();
    host.start();
    last().send({ type: "progress", done: 3, total: 9 });
    expect(events).toEqual([{ type: "progress", done: 3, total: 9 }]);
  });

  test("prsFor resolves {} without a worker or without ids", async () => {
    const { host, workers } = setup();
    await expect(host.prsFor([SID])).resolves.toEqual({});
    host.start();
    await expect(host.prsFor([])).resolves.toEqual({});
    expect(workers[0].posted).toEqual([]);
  });

  test("prsFor relays a request and resolves with its reply", async () => {
    const { host, last } = setup();
    host.start();
    const a = host.prsFor([SID]);
    const b = host.prsFor([SID]);
    expect(last().posted).toEqual([
      { type: "prsFor", id: 1, sids: [SID] },
      { type: "prsFor", id: 2, sids: [SID] },
    ]);
    last().send({ type: "result", id: 1, ok: true, value: { [SID]: [] } });
    last().send({ type: "result", id: 2, ok: false });
    await expect(a).resolves.toEqual({ [SID]: [] });
    await expect(b).resolves.toEqual({});
  });

  test("an unanswered prsFor resolves {} after the timeout", async () => {
    const { host } = setup();
    host.start();
    const p = host.prsFor([SID]);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(p).resolves.toEqual({});
  });

  test("requestIngest posts an ingest once a worker exists", () => {
    const { host, last } = setup();
    host.requestIngest();
    host.start();
    host.requestIngest();
    expect(last().posted).toEqual([{ type: "ingest" }]);
  });

  test("a crash settles pending requests and restarts with backoff, then gives up", async () => {
    const { host, workers, last, log } = setup();
    host.start();
    const p = host.prsFor([SID]);
    last().exit(1);
    await expect(p).resolves.toEqual({});
    for (const [i, delay] of RESTART_DELAYS_MS.entries()) {
      vi.advanceTimersByTime(delay - 1);
      expect(workers).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(workers).toHaveLength(i + 2);
      last().exit(1);
    }
    expect(host.state).toBe("failed");
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(workers).toHaveLength(RESTART_DELAYS_MS.length + 1);
    expect(log).toHaveBeenCalled();
  });

  test("a worker that stays up for a minute resets the backoff", () => {
    const { host, workers, last } = setup();
    host.start();
    last().exit(1);
    vi.advanceTimersByTime(RESTART_DELAYS_MS[0]);
    last().send(READY);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    last().exit(1);
    vi.advanceTimersByTime(RESTART_DELAYS_MS[0]);
    expect(workers).toHaveLength(3);
  });

  test("a worker that cannot be created counts as a crash", () => {
    let calls = 0;
    const workers: FakeWorker[] = [];
    const { host, log } = setup(() => {
      if (calls++ === 0) throw new Error("bad path");
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    host.start();
    expect(log).toHaveBeenCalled();
    vi.advanceTimersByTime(RESTART_DELAYS_MS[0]);
    expect(workers).toHaveLength(1);
  });

  test("an open failure stops the host without restarting", () => {
    const { host, workers, last } = setup();
    host.start();
    last().send({ type: "fatal", code: "OPEN_FAILED" });
    last().exit(1);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(workers).toHaveLength(1);
    expect(host.state).toBe("failed");
  });

  test("stop waits for the ack, terminates, and never restarts", async () => {
    const { host, workers, last } = setup();
    host.start();
    last().send(READY);
    const stopping = host.stop();
    expect(last().posted.at(-1)).toEqual({ type: "shutdown" });
    last().send({ type: "shutdownAck" });
    await stopping;
    expect(last().terminated).toBe(true);
    expect(host.state).toBe("stopped");
    last().exit(0);
    vi.advanceTimersByTime(STABLE_AFTER_MS);
    expect(workers).toHaveLength(1);
  });

  test("stop gives up waiting for the ack after 2 s", async () => {
    const { host, last } = setup();
    host.start();
    const stopping = host.stop();
    vi.advanceTimersByTime(SHUTDOWN_ACK_MS);
    await stopping;
    expect(last().terminated).toBe(true);
  });
});
```

`test/main/searchFiles.test.ts`:

```ts
// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeSearchFiles } from "../../src/searchFiles";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-purge-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const errno = (code: string) => Object.assign(new Error(code), { code });

test("deletes the store, its WAL files, backups and corrupt copies, and nothing else", async () => {
  for (const n of [
    "search.db",
    "search.db-wal",
    "search.db-shm",
    "search.bak-1.db",
    "search.corrupt-5.db",
    "settings.json",
    "searchy.db",
  ])
    writeFileSync(join(dir, n), "");
  expect(await purgeSearchFiles(dir)).toEqual({ ok: true, remaining: [] });
  expect(readdirSync(dir).sort()).toEqual(["searchy.db", "settings.json"]);
});

test("a missing directory is already clean", async () => {
  expect(await purgeSearchFiles(join(dir, "nope"))).toEqual({ ok: true, remaining: [] });
});

test("a busy file is retried until it unlocks", async () => {
  let busy = 2;
  const unlink = vi.fn(async () => {
    if (busy-- > 0) throw errno("EBUSY");
  });
  const sleep = vi.fn(async () => {});
  const r = await purgeSearchFiles(dir, { readdir: async () => ["search.db"], unlink, sleep });
  expect(r).toEqual({ ok: true, remaining: [] });
  expect(unlink).toHaveBeenCalledTimes(3);
});

test("a file still locked after the retry window is reported", async () => {
  const sleep = vi.fn(async () => {});
  const r = await purgeSearchFiles(dir, {
    readdir: async () => ["search.db", "search.db-wal"],
    unlink: async (p) => {
      if (p.endsWith("search.db")) throw errno("EPERM");
    },
    sleep,
    retryMs: 300,
    stepMs: 100,
  });
  expect(r).toEqual({ ok: false, remaining: ["search.db"] });
  expect(sleep).toHaveBeenCalledTimes(3);
});

test("an unexpected error rejects", async () => {
  await expect(
    purgeSearchFiles(dir, {
      readdir: async () => ["search.db"],
      unlink: async () => {
        throw errno("EACCES");
      },
    }),
  ).rejects.toThrow("EACCES");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/searchHost.test.ts test/main/searchFiles.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/searchHost.ts`:

```ts
import type { SessionPrsResult } from "./ipcTypes";
import type { HostToWorker, WorkerToHost } from "./search/protocol";

export interface WorkerLike {
  postMessage(msg: HostToWorker): void;
  on(event: "message", listener: (msg: WorkerToHost) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

export type SearchEvent =
  | { type: "changed"; generation: number }
  | { type: "progress"; done: number; total: number };

export type SearchHostState = "stopped" | "starting" | "running" | "failed";

export const RESTART_DELAYS_MS = [1_000, 5_000, 30_000];
export const STABLE_AFTER_MS = 60_000;
export const SHUTDOWN_ACK_MS = 2_000;
export const REQUEST_TIMEOUT_MS = 10_000;

export interface SearchHostDeps {
  createWorker: () => WorkerLike;
  emit: (e: SearchEvent) => void;
  log: (msg: string, err?: unknown) => void;
}

export interface SearchHost {
  readonly state: SearchHostState;
  start(): void;
  requestIngest(): void;
  prsFor(sids: string[]): Promise<SessionPrsResult>;
  stop(): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;

export function createSearchHost(deps: SearchHostDeps): SearchHost {
  let state: SearchHostState = "stopped";
  let started = false;
  let stopping = false;
  let worker: WorkerLike | null = null;
  let generation = 0;
  let nextId = 1;
  let crashes = 0;
  let stableTimer: Timer | undefined;
  let restartTimer: Timer | undefined;
  let onAck: (() => void) | undefined;
  const pending = new Map<number, { resolve: (v: SessionPrsResult) => void; timer: Timer }>();

  function settle(id: number, value: SessionPrsResult): void {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  function settleAll(): void {
    for (const id of [...pending.keys()]) settle(id, {});
  }

  function onMessage(msg: WorkerToHost): void {
    switch (msg.type) {
      case "ready":
        state = "running";
        if (msg.recovered) deps.log("search.db was corrupt and has been rebuilt");
        if (!msg.ftsOk) deps.log("FTS5 is unavailable; full-text search is off");
        stableTimer = setTimeout(() => {
          crashes = 0;
        }, STABLE_AFTER_MS);
        // A warm start may change nothing, so ready alone must refresh the renderer.
        deps.emit({ type: "changed", generation: ++generation });
        break;
      case "changed":
        deps.emit({ type: "changed", generation: ++generation });
        break;
      case "progress":
        deps.emit({ type: "progress", done: msg.done, total: msg.total });
        break;
      case "result":
        settle(msg.id, msg.ok ? msg.value : {});
        break;
      case "shutdownAck":
        onAck?.();
        break;
      case "fatal":
        state = "failed";
        deps.log(`search worker failed: ${msg.code}`);
        break;
    }
  }

  function onExit(code: number | string): void {
    worker = null;
    clearTimeout(stableTimer);
    settleAll();
    if (stopping || state === "failed") return;
    if (crashes >= RESTART_DELAYS_MS.length) {
      state = "failed";
      deps.log(`search worker exited (${code}); not restarting`);
      return;
    }
    const delay = RESTART_DELAYS_MS[crashes++];
    state = "starting";
    deps.log(`search worker exited (${code}); restarting in ${delay} ms`);
    restartTimer = setTimeout(spawn, delay);
  }

  function spawn(): void {
    restartTimer = undefined;
    if (stopping) return;
    state = "starting";
    let w: WorkerLike;
    try {
      w = deps.createWorker();
    } catch (err) {
      deps.log("search worker could not start", err);
      onExit("spawn");
      return;
    }
    worker = w;
    w.on("message", (msg) => {
      if (worker === w) onMessage(msg);
    });
    w.on("error", (err) => deps.log("search worker error", err));
    w.on("exit", (code) => {
      if (worker === w) onExit(code);
    });
  }

  return {
    get state() {
      return state;
    },
    start() {
      if (started) return;
      started = true;
      spawn();
    },
    requestIngest() {
      worker?.postMessage({ type: "ingest" });
    },
    prsFor(sids) {
      const w = worker;
      if (!w || sids.length === 0) return Promise.resolve({});
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, {}), REQUEST_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        w.postMessage({ type: "prsFor", id, sids });
      });
    },
    async stop() {
      stopping = true;
      clearTimeout(restartTimer);
      clearTimeout(stableTimer);
      const w = worker;
      if (w) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, SHUTDOWN_ACK_MS);
          onAck = () => {
            clearTimeout(t);
            resolve();
          };
          w.postMessage({ type: "shutdown" });
        });
        onAck = undefined;
        worker = null;
        settleAll();
        await w.terminate().catch(() => 0);
      }
      state = "stopped";
    },
  };
}
```

`src/searchFiles.ts`:

```ts
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export const SEARCH_FILE_RE = /^search\.(db|db-wal|db-shm|bak-.+|corrupt-.+)$/;

export interface PurgeDeps {
  readdir?: (dir: string) => Promise<string[]>;
  unlink?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  retryMs?: number;
  stepMs?: number;
}

const codeOf = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

export async function purgeSearchFiles(
  dir: string,
  deps: PurgeDeps = {},
): Promise<{ ok: boolean; remaining: string[] }> {
  const list = deps.readdir ?? ((d: string) => readdir(d));
  const remove = deps.unlink ?? unlink;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryMs = deps.retryMs ?? 5_000;
  const stepMs = deps.stepMs ?? 100;

  let remaining: string[];
  try {
    remaining = (await list(dir)).filter((n) => SEARCH_FILE_RE.test(n));
  } catch (err) {
    if (codeOf(err) === "ENOENT") return { ok: true, remaining: [] };
    throw err;
  }
  for (let waited = 0; ; waited += stepMs) {
    const locked: string[] = [];
    for (const name of remaining) {
      try {
        await remove(join(dir, name));
      } catch (err) {
        const code = codeOf(err);
        if (code === "ENOENT") continue;
        // Windows reports a file another process still holds as EBUSY or EPERM.
        if (code === "EBUSY" || code === "EPERM") locked.push(name);
        else throw err;
      }
    }
    remaining = locked;
    if (remaining.length === 0 || waited >= retryMs)
      return { ok: remaining.length === 0, remaining };
    await sleep(stepMs);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/searchHost.test.ts test/main/searchFiles.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/searchHost.ts src/searchFiles.ts test/main/searchHost.test.ts test/main/searchFiles.test.ts
git add src/searchHost.ts src/searchFiles.ts test/main/searchHost.test.ts test/main/searchFiles.test.ts
git commit -m "feat: supervise the search worker from main and purge its files on opt-out (#206)"
```

---

### Task 17: Wire search into IPC, preload and `main.ts`

**Files:**
- Modify: `src/ipcChannels.ts`, `src/ipcTypes.ts`, `src/ipc.ts`, `src/preload.ts`, `src/renderer/types/csm.d.ts`, `src/main.ts`, `electron-builder.yml`
- Modify: `src/searchHost.ts` (one export added)
- Test: `test/main/ipc.test.ts`
- Test: `test/main/packagingSearchWorker.test.ts`

**Interfaces:**
- Consumes: `SessionPrsResult` (Task 8); `resolveGhPath` (Task 13); `WorkerInit` (Task 15); `createSearchHost`, `SearchHost` (Task 16); `purgeSearchFiles` (Task 16); `isValidSessionId` from `src/terminalLauncher.ts`.
- Produces:
  - `CH.searchPrsFor = "search:prsFor"`, `CH.searchChanged = "search:changed"`, `CH.searchProgress = "search:progress"`.
  - In `src/ipcTypes.ts`: `export interface SearchChangedMessage { generation: number }`, `export interface SearchProgressMessage { done: number; total: number }`.
  - In `src/ipc.ts`: `export const MAX_PRS_FOR_IDS = 500;` and `IpcHandlerDeps.search: { requestIngest(): void; prsFor(sids: string[]): Promise<SessionPrsResult> }`.
  - `window.csm.search?: CsmSearch` with `CsmSearch { prsFor(ids: string[]): Promise<SessionPrsResult>; onChanged(cb: (generation: number) => void): () => void }`.

- [ ] **Step 1: Write the failing tests**

In `test/main/ipc.test.ts`:

1. Add `import type { SessionPrsResult } from "../../src/ipcTypes";` and add `MAX_PRS_FOR_IDS` to the `../../src/ipc` import: `import { MAX_PRS_FOR_IDS, registerIpcHandlers, type IpcHandlerDeps } from "../../src/ipc";`.
2. In `setup()`, after `const logError = vi.fn();` add:

```ts
  const search = {
    requestIngest: vi.fn(),
    prsFor: vi.fn<(sids: string[]) => Promise<SessionPrsResult>>(async () => ({})),
  };
```

3. Add `search,` to the `deps` object (after `logError,`) and to the returned object (after `logError,`).
4. Append:

```ts
// ---- search (#206) -----------------------------------------------------------

const SID_A = REQ.sessionId;

test("sessions:scan asks the search store to ingest", async () => {
  const { call, search } = setup();
  await call(CH.sessionsScan, "scan-s");
  expect(search.requestIngest).toHaveBeenCalledTimes(1);
});

test("an untrusted sessions:scan does not trigger an ingest", async () => {
  const { handlers, search } = setup();
  await handlers.get(CH.sessionsScan)!({ sender: { send: () => {} } }, "scan-u");
  expect(search.requestIngest).not.toHaveBeenCalled();
});

test("search:prsFor relays only valid session ids", async () => {
  const { call, search } = setup();
  search.prsFor.mockResolvedValueOnce({ [SID_A]: [] });
  await expect(call(CH.searchPrsFor, [SID_A, "not-a-uuid", 7])).resolves.toEqual({
    [SID_A]: [],
  });
  expect(search.prsFor).toHaveBeenCalledWith([SID_A]);
});

test.each([
  ["a non-array", "x"],
  ["no valid ids", ["nope"]],
  ["too many ids", Array.from({ length: MAX_PRS_FOR_IDS + 1 }, () => SID_A)],
])("search:prsFor with %s returns {} without asking the store", async (_label, arg) => {
  const { call, search } = setup();
  await expect(call(CH.searchPrsFor, arg)).resolves.toEqual({});
  expect(search.prsFor).not.toHaveBeenCalled();
});

test("search:prsFor from an untrusted sender returns {}", async () => {
  const { handlers, search } = setup();
  await expect(
    handlers.get(CH.searchPrsFor)!({ sender: { send: () => {} } }, [SID_A]),
  ).resolves.toEqual({});
  expect(search.prsFor).not.toHaveBeenCalled();
});

test("a failing search store logs and returns {}", async () => {
  const { call, search, logError } = setup();
  search.prsFor.mockRejectedValueOnce(new Error("boom"));
  await expect(call(CH.searchPrsFor, [SID_A])).resolves.toEqual({});
  expect(logError).toHaveBeenCalledWith("search:prsFor", expect.any(Error));
});
```

5. Create `test/main/packagingSearchWorker.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { workerBuildOptions } from "../../scripts/build-worker.mjs";
import { asarUnpackedPath } from "../../src/searchHost";

// Packaging is not in CI, so this is the only guard that the bundle, the unpack
// entry and main's path rewrite agree.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("packaged search worker", () => {
  test("electron-builder unpacks the worker bundle", () => {
    const yml = readFileSync(join(repoRoot, "electron-builder.yml"), "utf8");
    expect(yml).toMatch(/^asarUnpack:\s+-\s+dist\/searchWorker\.js\s*$/m);
  });

  test("the bundle is written where the unpack entry points", () => {
    expect(workerBuildOptions(repoRoot).outfile).toBe(
      join(repoRoot, "dist", "searchWorker.js"),
    );
  });

  test("a packaged path moves to app.asar.unpacked; a dev path is unchanged", () => {
    expect(
      asarUnpackedPath("C:\\x\\resources\\app.asar\\dist\\searchWorker.js", "\\"),
    ).toBe("C:\\x\\resources\\app.asar.unpacked\\dist\\searchWorker.js");
    expect(asarUnpackedPath("/x/Resources/app.asar/dist/searchWorker.js", "/")).toBe(
      "/x/Resources/app.asar.unpacked/dist/searchWorker.js",
    );
    expect(asarUnpackedPath("/repo/dist/searchWorker.js", "/")).toBe(
      "/repo/dist/searchWorker.js",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/ipc.test.ts`
Expected: FAIL — `CH.searchPrsFor` is undefined and `requestIngest` is never called.

- [ ] **Step 3: Implement**

`src/searchHost.ts` — add this export:

```ts
export function asarUnpackedPath(p: string, sep: string): string {
  return p.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`);
}
```

`src/ipcChannels.ts` — add inside `CH`, after `sessionGetFacts`:

```ts
  // Search store (#206). prsFor is request/response (the visible window's
  // sessionIds → their PR links); main pushes changed when stored data moved and
  // progress during an ingest pass.
  searchPrsFor: "search:prsFor",
  searchChanged: "search:changed",
  searchProgress: "search:progress",
```

`src/ipcTypes.ts` — append:

```ts
/** `search:changed` payload (#206). The generation rises by one per change. */
export interface SearchChangedMessage {
  generation: number;
}

/** `search:progress` payload (#206): transcripts ingested so far in this pass. */
export interface SearchProgressMessage {
  done: number;
  total: number;
}
```

`src/ipc.ts`:

1. Add imports: `import type { SessionPrsResult } from "./ipcTypes";` (merge into the existing `import type { … } from "./ipcTypes"` block) and `import { isValidSessionId } from "./terminalLauncher";`.
2. Below the imports add:

```ts
/** Upper bound on one `search:prsFor` request; the renderer asks for a visible
 * window of ~30 rows, so anything larger is a misbehaving caller. */
export const MAX_PRS_FOR_IDS = 500;
```

3. Add to `IpcHandlerDeps` after `logError`:

```ts
  /** The search store (#206), owned by main's worker host. Injected so the
   * handlers stay testable without a worker thread. */
  search: {
    requestIngest(): void;
    prsFor(sids: string[]): Promise<SessionPrsResult>;
  };
```

4. Add `search,` to the destructuring in `registerIpcHandlers`.
5. In the `CH.sessionsScan` handler, after the `const post = …;` block and before `try {`, add:

```ts
    // A rescan is the user asking for fresh data, so the search store catches up too.
    search.requestIngest();
```

6. After the `CH.sessionGetFacts` handler add:

```ts
  // prsFor (#206): PR links for the visible rows. Untrusted frame, malformed or
  // oversized input → {} (rows render without a chip). Ids are UUID-validated
  // here because they cross into the worker's SQL as bound parameters.
  ipcMain.handle(
    CH.searchPrsFor,
    async (event, ids): Promise<SessionPrsResult> => {
      if (
        !isTrustedSender(event.sender) ||
        !Array.isArray(ids) ||
        ids.length > MAX_PRS_FOR_IDS
      )
        return {};
      const valid = ids.filter(
        (x): x is string => typeof x === "string" && isValidSessionId(x),
      );
      if (valid.length === 0) return {};
      try {
        return await search.prsFor(valid);
      } catch (err) {
        logError("search:prsFor", err);
        return {};
      }
    },
  );
```

`src/preload.ts`:

1. Add `SearchChangedMessage` and `SessionPrsResult` to the `import type { … } from "./ipcTypes"` list.
2. Add after the `theme` block, inside `exposeInMainWorld`:

```ts
  // Search store (#206). prsFor fetches PR links for the visible rows; onChanged
  // fires when stored links or titles moved, so the renderer refetches its window.
  search: {
    prsFor: (ids: string[]): Promise<SessionPrsResult> =>
      ipcRenderer.invoke(CH.searchPrsFor, ids),
    onChanged: (cb: (generation: number) => void): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        msg: SearchChangedMessage,
      ): void => cb(msg.generation);
      ipcRenderer.on(CH.searchChanged, listener);
      return () => ipcRenderer.off(CH.searchChanged, listener);
    },
  },
```

`src/renderer/types/csm.d.ts`:

1. Add `SessionPrsResult` to the `import type { … } from "../../ipcTypes"` list.
2. Add before `export interface CsmBridge`:

```ts
/** The search store bridge (#206). Optional: absent in a plain browser or a unit
 * test without the preload. */
export interface CsmSearch {
  /** PR links per session id; ids with no links are absent from the result. */
  prsFor(ids: string[]): Promise<SessionPrsResult>;
  /** Subscribe to stored-data changes; returns an unsubscribe. */
  onChanged(cb: (generation: number) => void): () => void;
}
```

3. Add to `CsmBridge`, after `theme`:

```ts
  /** Optional: only present under the desktop preload. */
  readonly search?: CsmSearch;
```

`src/main.ts`:

1. Add imports:

```ts
import { Worker } from "node:worker_threads";
import { resolveGhPath } from "./search/ghClient";
import type { WorkerInit } from "./search/protocol";
import { asarUnpackedPath, createSearchHost } from "./searchHost";
import { purgeSearchFiles } from "./searchFiles";
```

2. Below `RENDERER_INDEX` add:

```ts
// Packaged builds load the worker from app.asar.unpacked (electron-builder.yml asarUnpack).
const SEARCH_WORKER = asarUnpackedPath(
  path.join(__dirname, "searchWorker.js"),
  path.sep,
);

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
```

3. Replace the block from `await sessionIndex.load();` through the closing `);` of the `app.on("before-quit", …)` call with:

```ts
    await sessionIndex.load();

    // Search store (#206). The same privacy opt-out as the session index: when
    // it is off, nothing is written and any earlier search files are removed.
    const userData = app.getPath("userData");
    const projectsRoot = defaultProjectsRoot();
    const searchHost = indexEnabled
      ? createSearchHost({
          createWorker: () =>
            new Worker(SEARCH_WORKER, {
              workerData: {
                dbDir: userData,
                projectsRoot,
                platform: process.platform,
                ghPath: resolveGhPath(process.env, process.platform, isFile) ?? null,
              } satisfies WorkerInit,
            }),
          emit: (e) => {
            const wc = mainWindow?.webContents;
            if (!wc || wc.isDestroyed()) return;
            if (e.type === "changed")
              wc.send(CH.searchChanged, { generation: e.generation });
            else wc.send(CH.searchProgress, { done: e.done, total: e.total });
          },
          log: (msg, err) => console.error(`[csm] ${msg}`, err ?? ""),
        })
      : null;
    if (!searchHost) {
      void purgeSearchFiles(userData)
        .then((r) => {
          if (!r.ok)
            console.error("[csm] could not remove search files:", r.remaining);
        })
        .catch((err: unknown) =>
          console.error("[csm] could not remove search files:", err),
        );
    }

    registerIpcHandlers({
      ipcMain,
      isTrustedSender: isMainWindowSender,
      // Bind the shared index into every store the bridge creates, so scan/getFacts
      // read and write the one persistent cache.
      createSessionStore: (root) =>
        createSessionStore(root, { index: sessionIndex }),
      settingsStore,
      reopen: reopenSession,
      newSession: launchNewSession,
      openTerminal: openTerminalHere,
      // Native directory picker (#165). Parented to the main window so it is
      // modal to the app; a destroyed window degrades to an unparented dialog.
      pickFolder: async () => {
        const opts = { properties: ["openDirectory" as const] };
        const result =
          mainWindow && !mainWindow.isDestroyed()
            ? await dialog.showOpenDialog(mainWindow, opts)
            : await dialog.showOpenDialog(opts);
        return result.canceled || result.filePaths.length === 0
          ? { canceled: true as const }
          : { canceled: false as const, path: result.filePaths[0] };
      },
      // The theme switch (#86) drives Electron's nativeTheme, which forces the
      // renderer's prefers-color-scheme (and native menus/dialogs) to the chosen
      // mode; injected here so ipc.ts stays Electron-free for unit tests.
      setNativeTheme: (source) => {
        nativeTheme.themeSource = source;
      },
      tempRoots: () => tempRoots(),
      // #83: a handler failure the renderer only sees as a code still has to be
      // diagnosable. stderr is what the dev launchers tee into
      // .dev-run/run-desktop.log, so this is the sink that makes a broken scan
      // self-evident instead of silent.
      logError: (context, err) =>
        console.error(`[csm] ${context} failed:`, err),
      search: searchHost ?? {
        requestIngest: () => {},
        prsFor: async () => ({}),
      },
      projectsRoot,
      platform: process.platform,
      now: () => Date.now(),
    });

    // Flush a dirty index and stop the search worker on quit. Electron does not
    // delay quit for a fire-and-forget async task, so intercept before-quit,
    // finish both, then re-quit. One handler: two would each re-quit on their own.
    app.on(
      "before-quit",
      createBeforeQuitHandler({
        isDirty: () =>
          sessionIndex.isDirty() ||
          searchHost?.state === "running" ||
          searchHost?.state === "starting",
        flush: async () => {
          await Promise.allSettled([sessionIndex.flush(), searchHost?.stop()]);
        },
        quit: () => app.quit(),
      }),
    );
```

4. Replace the final `return createWindow(devServerUrl);` in the `whenReady` callback with:

```ts
    await createWindow(devServerUrl);
    // After the first paint, so indexing never competes with startup.
    searchHost?.start();
```

`electron-builder.yml` — add after the `files:` list:

```yaml
# The search worker loads from a plain file; main.ts rewrites its path to
# app.asar.unpacked (guarded by test/main/packagingSearchWorker.test.ts).
asarUnpack:
  - dist/searchWorker.js
```

- [ ] **Step 4: Run tests and checks**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/ipc.test.ts test/main/packagingSearchWorker.test.ts`
Expected: PASS

Run: `npm run typecheck` (timeout 300000). Expected: exits 0.

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/ipcChannels.ts src/ipcTypes.ts src/ipc.ts src/preload.ts src/renderer/types/csm.d.ts src/main.ts electron-builder.yml test/main/ipc.test.ts src/searchHost.ts test/main/packagingSearchWorker.test.ts
git add src/ipcChannels.ts src/ipcTypes.ts src/ipc.ts src/preload.ts src/renderer/types/csm.d.ts src/main.ts electron-builder.yml test/main/ipc.test.ts src/searchHost.ts test/main/packagingSearchWorker.test.ts
git commit -m "feat: expose PR links over IPC and start the search worker from main (#206)"
```

---

### Task 18: Renderer data — `prChip` helpers and `useSessionPrs`

**Files:**
- Create: `src/prChip.ts`
- Create: `src/renderer/hooks/useSessionPrs.ts`
- Test: `test/main/prChip.test.ts`, `test/renderer/useSessionPrs.test.tsx`

**Interfaces:**
- Consumes: `SessionPrLink` (Task 8); `CsmBridge`, `CsmSearch` (Task 17); `currentBridge` from `src/renderer/bridge.ts`.
- Produces:
  - `src/prChip.ts`:
    - `export function primaryPr(links: readonly SessionPrLink[]): SessionPrLink | undefined` — among links the session created, the latest `firstSeen`; otherwise the latest `lastSeen`; ties go to the higher number; a null time sorts oldest.
    - `export type PrStateLabel = "open" | "draft" | "merged" | "closed";`
    - `export function prStateLabel(link: SessionPrLink): PrStateLabel | undefined` — `undefined` until enrichment has a state.
    - `export function orderedPrs(links: readonly SessionPrLink[]): SessionPrLink[]` — primary first, then the rest by number descending.
    - `export function prLinkSummary(link: SessionPrLink): string` — `"o/r#12 · open · Fix the parser"`, omitting missing parts.
    - `export function prTooltip(links: readonly SessionPrLink[]): string` — one summary per line, in `orderedPrs` order.
  - `src/renderer/hooks/useSessionPrs.ts`: `export function useSessionPrs(bridge?: CsmBridge): { prs: ReadonlyMap<string, SessionPrLink[]>; requestPrs: (ids: readonly string[]) => void }` — a requested id with no links maps to `[]`; a `search:changed` event refetches the last requested ids; earlier links stay displayed until the refetch lands.

- [ ] **Step 1: Write the failing tests**

`test/main/prChip.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import type { SessionPrLink } from "../../src/ipcTypes";
import {
  orderedPrs,
  primaryPr,
  prLinkSummary,
  prStateLabel,
  prTooltip,
} from "../../src/prChip";

const pr = (over: Partial<SessionPrLink> = {}): SessionPrLink => ({
  repo: "o/r",
  number: 12,
  url: "https://github.com/o/r/pull/12",
  title: "Fix the parser",
  state: "OPEN",
  isDraft: false,
  createdHere: false,
  firstSeen: 10,
  lastSeen: 20,
  ...over,
});

describe("primaryPr", () => {
  test("none for no links", () => {
    expect(primaryPr([])).toBeUndefined();
  });

  test("a PR the session created beats a more recently mentioned one", () => {
    const created = pr({ number: 3, createdHere: true, lastSeen: null });
    expect(primaryPr([pr({ number: 9, lastSeen: 99 }), created])).toBe(created);
  });

  test("among created PRs, the latest created wins", () => {
    const a = pr({ number: 3, createdHere: true, firstSeen: 5 });
    const b = pr({ number: 4, createdHere: true, firstSeen: 50 });
    expect(primaryPr([b, a])).toBe(b);
  });

  test("otherwise the most recently mentioned wins; ties go to the higher number", () => {
    const a = pr({ number: 3, lastSeen: 30 });
    const b = pr({ number: 4, lastSeen: 30 });
    const c = pr({ number: 5, lastSeen: null });
    expect(primaryPr([a, c, b])).toBe(b);
  });
});

test.each([
  [pr(), "open"],
  [pr({ isDraft: true }), "draft"],
  [pr({ state: "MERGED" }), "merged"],
  [pr({ state: "CLOSED" }), "closed"],
  [pr({ state: null }), undefined],
])("prStateLabel %#", (link, label) => {
  expect(prStateLabel(link)).toBe(label);
});

test("orderedPrs puts the primary first, then the rest by number descending", () => {
  const created = pr({ number: 2, createdHere: true });
  const links = [pr({ number: 5 }), created, pr({ number: 9 })];
  expect(orderedPrs(links).map((l) => l.number)).toEqual([2, 9, 5]);
});

test("prLinkSummary omits missing parts", () => {
  expect(prLinkSummary(pr())).toBe("o/r#12 · open · Fix the parser");
  expect(prLinkSummary(pr({ state: null, title: null }))).toBe("o/r#12");
});

test("prTooltip lists every link, primary first", () => {
  expect(
    prTooltip([pr({ number: 7, state: "MERGED", title: "Old" }), pr({ createdHere: true })]),
  ).toBe("o/r#12 · open · Fix the parser\no/r#7 · merged · Old");
});
```

`test/renderer/useSessionPrs.test.tsx`:

```tsx
import { expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSessionPrs } from "../../src/renderer/hooks/useSessionPrs";
import type { CsmBridge, CsmSearch } from "../../src/renderer/types/csm";
import type { SessionPrLink, SessionPrsResult } from "../../src/ipcTypes";

const link = (title: string | null = null): SessionPrLink => ({
  repo: "o/r",
  number: 1,
  url: "https://github.com/o/r/pull/1",
  title,
  state: null,
  isDraft: false,
  createdHere: false,
  firstSeen: null,
  lastSeen: 1,
});

function fakeSearch(impl: (ids: string[]) => Promise<SessionPrsResult>) {
  let changed: ((generation: number) => void) | undefined;
  const search: CsmSearch = {
    prsFor: vi.fn(impl),
    onChanged: vi.fn((cb: (generation: number) => void) => {
      changed = cb;
      return () => {
        changed = undefined;
      };
    }),
  };
  const bridge: CsmBridge = { ...window.csm!, search };
  return { bridge, search, fireChanged: (g: number) => changed?.(g) };
}

test("requested ids without links resolve to an empty list", async () => {
  const { bridge } = fakeSearch(async () => ({ a: [link()] }));
  const { result } = renderHook(() => useSessionPrs(bridge));
  act(() => result.current.requestPrs(["a", "b"]));
  await waitFor(() => expect(result.current.prs.get("b")).toEqual([]));
  expect(result.current.prs.get("a")).toEqual([link()]);
});

test("a loaded id is not requested again", async () => {
  const { bridge, search } = fakeSearch(async () => ({}));
  const { result } = renderHook(() => useSessionPrs(bridge));
  act(() => result.current.requestPrs(["a"]));
  await waitFor(() => expect(result.current.prs.has("a")).toBe(true));
  act(() => result.current.requestPrs(["a"]));
  expect(search.prsFor).toHaveBeenCalledTimes(1);
});

test("a change event refetches the last window and shows the new title", async () => {
  let title: string | null = null;
  const { bridge, search, fireChanged } = fakeSearch(async () => ({ a: [link(title)] }));
  const { result } = renderHook(() => useSessionPrs(bridge));
  act(() => result.current.requestPrs(["a"]));
  await waitFor(() => expect(result.current.prs.has("a")).toBe(true));
  title = "Fix it";
  act(() => fireChanged(2));
  await waitFor(() => expect(result.current.prs.get("a")?.[0].title).toBe("Fix it"));
  expect(search.prsFor).toHaveBeenLastCalledWith(["a"]);
});

test("a reply that started before a change event is dropped", async () => {
  const replies: ((r: SessionPrsResult) => void)[] = [];
  const { bridge, fireChanged } = fakeSearch(
    () => new Promise<SessionPrsResult>((resolve) => replies.push(resolve)),
  );
  const { result } = renderHook(() => useSessionPrs(bridge));
  act(() => result.current.requestPrs(["a"]));
  act(() => fireChanged(2));
  expect(replies).toHaveLength(2);
  await act(async () => replies[1]({ a: [link("new")] }));
  await act(async () => replies[0]({ a: [link("old")] }));
  expect(result.current.prs.get("a")?.[0].title).toBe("new");
});

test("without the search bridge requestPrs does nothing", () => {
  const { result } = renderHook(() => useSessionPrs({ ...window.csm! }));
  act(() => result.current.requestPrs(["a"]));
  expect(result.current.prs.size).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/prChip.test.ts test/renderer/useSessionPrs.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/prChip.ts`:

```ts
import type { SessionPrLink } from "./ipcTypes";

export type PrStateLabel = "open" | "draft" | "merged" | "closed";

export function primaryPr(
  links: readonly SessionPrLink[],
): SessionPrLink | undefined {
  const created = links.filter((l) => l.createdHere);
  const pool = created.length > 0 ? created : links;
  const time = (l: SessionPrLink): number =>
    (created.length > 0 ? l.firstSeen : l.lastSeen) ?? -1;
  let best: SessionPrLink | undefined;
  for (const l of pool) {
    if (
      !best ||
      time(l) > time(best) ||
      (time(l) === time(best) && l.number > best.number)
    )
      best = l;
  }
  return best;
}

export function prStateLabel(link: SessionPrLink): PrStateLabel | undefined {
  switch (link.state) {
    case "OPEN":
      return link.isDraft ? "draft" : "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return undefined;
  }
}

export function orderedPrs(links: readonly SessionPrLink[]): SessionPrLink[] {
  const primary = primaryPr(links);
  if (!primary) return [];
  const rest = links
    .filter((l) => l !== primary)
    .sort((a, b) => b.number - a.number);
  return [primary, ...rest];
}

export function prLinkSummary(link: SessionPrLink): string {
  return [`${link.repo}#${link.number}`, prStateLabel(link), link.title]
    .filter((part): part is string => !!part)
    .join(" · ");
}

export function prTooltip(links: readonly SessionPrLink[]): string {
  return orderedPrs(links).map(prLinkSummary).join("\n");
}
```

`src/renderer/hooks/useSessionPrs.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionPrLink } from "../../ipcTypes";
import type { CsmBridge } from "../types/csm";
import { currentBridge } from "../bridge";

// Windowed PR-link loader (#206), shaped like useSessionFacts. A search:changed
// event invalidates every loaded id and refetches the last requested window; the
// old links stay on screen until the new reply lands, so the chip never blinks.
export function useSessionPrs(
  bridge: CsmBridge | undefined = currentBridge(),
): {
  prs: ReadonlyMap<string, SessionPrLink[]>;
  requestPrs: (ids: readonly string[]) => void;
} {
  const [prs, setPrs] = useState<Map<string, SessionPrLink[]>>(new Map());
  const known = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const epoch = useRef(0);
  const lastIds = useRef<readonly string[]>([]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const requestPrs = useCallback(
    (ids: readonly string[]) => {
      const search = bridge?.search;
      if (!search) return;
      lastIds.current = ids;
      const seen = known.current;
      const flight = inFlight.current;
      const ep = epoch.current;
      const need = ids.filter((id) => !seen.has(id) && !flight.has(id));
      if (need.length === 0) return;
      need.forEach((id) => flight.add(id));
      void search
        .prsFor([...need])
        .then((res) => {
          need.forEach((id) => flight.delete(id));
          if (!mounted.current || ep !== epoch.current) return;
          need.forEach((id) => seen.add(id));
          setPrs((prev) => {
            const next = new Map(prev);
            for (const id of need) next.set(id, res[id] ?? []);
            return next;
          });
        })
        .catch(() => {
          need.forEach((id) => flight.delete(id));
        });
    },
    [bridge],
  );

  useEffect(() => {
    const search = bridge?.search;
    if (!search) return;
    return search.onChanged(() => {
      epoch.current++;
      known.current = new Set();
      inFlight.current = new Set();
      requestPrs(lastIds.current);
    });
  }, [bridge, requestPrs]);

  return { prs, requestPrs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/main/prChip.test.ts test/renderer/useSessionPrs.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/prChip.ts src/renderer/hooks/useSessionPrs.ts test/main/prChip.test.ts test/renderer/useSessionPrs.test.tsx
git add src/prChip.ts src/renderer/hooks/useSessionPrs.ts test/main/prChip.test.ts test/renderer/useSessionPrs.test.tsx
git commit -m "feat: load PR links for the visible session rows (#206)"
```

---

### Task 19: The PR chip on the session row and Shift+Enter

**Files:**
- Modify: `src/renderer/components/SessionRow.tsx`, `src/renderer/components/SessionRow.module.css`, `src/sessionListWindow.ts`, `src/renderer/components/SessionList.tsx`
- Test: `test/renderer/SessionRow.test.tsx`, `test/main/sessionListWindow.test.ts`, `test/renderer/SessionList.test.tsx`

**Interfaces:**
- Consumes: `primaryPr`, `prStateLabel`, `orderedPrs`, `prLinkSummary`, `prTooltip` (Task 18); `useSessionPrs` (Task 18); `SessionPrLink` (Task 8).
- Produces:
  - `SessionRow` props `prLinks?: SessionPrLink[]` and `onOpenPr?: (link: SessionPrLink) => void`.
  - `ListKeyAction` gains `{ type: "openPr"; index: number }`; `listKeyAction(key, focusedIndex, itemCount, modifiers: { shift?: boolean } = {})` returns it for Shift+Enter on a focused row.

- [ ] **Step 1: Write the failing tests**

Append to `test/renderer/SessionRow.test.tsx` (add `import type { SessionPrLink } from "../../src/ipcTypes";` to the imports):

```tsx
const pr = (over: Partial<SessionPrLink> = {}): SessionPrLink => ({
  repo: "o/r",
  number: 12,
  url: "https://github.com/o/r/pull/12",
  title: "Fix the parser",
  state: "OPEN",
  isDraft: false,
  createdHere: true,
  firstSeen: 1,
  lastSeen: 2,
  ...over,
});

test("the PR chip shows the primary PR, its state and how many more (#206)", () => {
  render(
    <SessionRow
      session={makeSession()}
      rowHeight={56}
      prLinks={[pr(), pr({ number: 9, state: "MERGED", createdHere: false })]}
    />,
  );
  const chip = screen.getByTestId("pr-chip");
  expect(chip.textContent).toBe("#12open+1");
  expect(chip.getAttribute("title")).toBe(
    "o/r#12 · open · Fix the parser\no/r#9 · merged · Fix the parser",
  );
  expect(chip.getAttribute("aria-label")).toBe(
    "Pull requests: o/r#12 · open · Fix the parser; o/r#9 · merged · Fix the parser",
  );
});

test("a draft PR reads draft, and an unenriched PR shows only its number", () => {
  const { rerender } = render(
    <SessionRow session={makeSession()} rowHeight={56} prLinks={[pr({ isDraft: true })]} />,
  );
  expect(screen.getByTestId("pr-chip").textContent).toBe("#12draft");
  rerender(<SessionRow session={makeSession()} rowHeight={56} prLinks={[pr({ state: null })]} />);
  expect(screen.getByTestId("pr-chip").textContent).toBe("#12");
});

test("a PR title is never parsed as markup", () => {
  const { container } = render(
    <SessionRow
      session={makeSession()}
      rowHeight={56}
      prLinks={[pr({ title: "<img src=x onerror=alert(1)>" })]}
    />,
  );
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByTestId("pr-chip").getAttribute("title")).toContain(
    "<img src=x onerror=alert(1)>",
  );
});

test("no links, no chip", () => {
  const { rerender } = render(<SessionRow session={makeSession()} rowHeight={56} />);
  expect(screen.queryByTestId("pr-chip")).toBeNull();
  rerender(<SessionRow session={makeSession()} rowHeight={56} prLinks={[]} />);
  expect(screen.queryByTestId("pr-chip")).toBeNull();
});

test("clicking the chip opens the primary PR without selecting or reopening the row", () => {
  const onSelect = vi.fn();
  const onOpen = vi.fn();
  const onOpenPr = vi.fn();
  render(
    <SessionRow
      session={makeSession()}
      rowHeight={56}
      prLinks={[pr()]}
      onSelect={onSelect}
      onOpen={onOpen}
      onOpenPr={onOpenPr}
    />,
  );
  const chip = screen.getByTestId("pr-chip");
  fireEvent.click(chip);
  fireEvent.doubleClick(chip);
  expect(onOpenPr).toHaveBeenCalledWith(pr());
  expect(onSelect).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
  expect(chip.tabIndex).toBe(-1);
});
```

Append to `test/main/sessionListWindow.test.ts`:

```ts
test("listKeyAction: Shift+Enter opens the focused row's PR (#206)", () => {
  expect(listKeyAction("Enter", 2, 5, { shift: true })).toEqual({ type: "openPr", index: 2 });
  expect(listKeyAction("Enter", 2, 5)).toEqual({ type: "open", index: 2 });
  expect(listKeyAction("Enter", -1, 5, { shift: true })).toBeNull();
});
```

Append to `test/renderer/SessionList.test.tsx`:

```tsx
test("Shift+Enter opens the focused session's primary PR (#206)", async () => {
  const sessions = makeSessions(3);
  const openExternal = vi.fn(async () => true);
  window.csm = {
    ...window.csm!,
    openExternal,
    search: {
      prsFor: vi.fn(async () => ({
        [sessions[0].sessionId]: [
          {
            repo: "o/r",
            number: 12,
            url: "https://github.com/o/r/pull/12",
            title: null,
            state: null,
            isDraft: false,
            createdHere: false,
            firstSeen: null,
            lastSeen: 1,
          },
        ],
      })),
      onChanged: vi.fn(() => () => {}),
    },
  };
  render(<SessionList sessions={sessions} />);
  await screen.findByTestId("pr-chip");
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter", shiftKey: true });
  expect(openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/12");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `& .\node_modules\.bin\vitest.cmd run test/renderer/SessionRow.test.tsx test/main/sessionListWindow.test.ts test/renderer/SessionList.test.tsx`
Expected: FAIL — no `pr-chip`, and `listKeyAction` returns `open` for Shift+Enter.

- [ ] **Step 3: Implement**

`src/sessionListWindow.ts`:

1. Change the union to:

```ts
export type ListKeyAction =
  | { type: "focus"; index: number }
  | { type: "open"; index: number }
  | { type: "openPr"; index: number };
```

2. Change the signature to `export function listKeyAction(key: string, focusedIndex: number, itemCount: number, modifiers: { shift?: boolean } = {}): ListKeyAction | null {`, add to its doc comment the line ` * Shift+Enter opens the focused row's primary PR (#206).`, and replace the `"Enter"` case body with:

```ts
      // Only a real, in-range focused row can be opened.
      if (focusedIndex < 0 || focusedIndex > last) return null;
      return {
        type: modifiers.shift ? "openPr" : "open",
        index: focusedIndex,
      };
```

`src/renderer/components/SessionRow.tsx`:

1. Add imports:

```ts
import type { SessionPrLink } from "../../ipcTypes";
import {
  orderedPrs,
  primaryPr,
  prLinkSummary,
  prStateLabel,
  prTooltip,
} from "../../prChip";
```

2. Add to `SessionRowProps`:

```ts
  /** PR links for this session (#206). Undefined or empty renders no chip. */
  prLinks?: SessionPrLink[];
  /** Opens a PR in the browser (#206). */
  onOpenPr?: (link: SessionPrLink) => void;
```

3. Add `prLinks,` and `onOpenPr,` to the destructured props, and below `const branchLabel = …;` add:

```ts
  const primary = prLinks ? primaryPr(prLinks) : undefined;
  const primaryState = primary ? prStateLabel(primary) : undefined;
  const morePrs = (prLinks?.length ?? 0) - 1;
```

4. Insert directly after the branch chip's closing `)}` and before the first `<span className={styles.sep} aria-hidden="true">`:

```tsx
          {primary && (
            <button
              type="button"
              className={styles.pr}
              data-testid="pr-chip"
              // Not a tab stop, like the Open button: Shift+Enter on the row opens it.
              tabIndex={-1}
              title={prTooltip(prLinks ?? [])}
              aria-label={`Pull requests: ${orderedPrs(prLinks ?? [])
                .map(prLinkSummary)
                .join("; ")}`}
              onClick={(e) => {
                e.stopPropagation();
                onOpenPr?.(primary);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              #{primary.number}
              {primaryState && (
                <span className={styles.prState} data-state={primaryState}>
                  {primaryState}
                </span>
              )}
              {morePrs > 0 && <span className={styles.prMore}>+{morePrs}</span>}
            </button>
          )}
```

`src/renderer/components/SessionRow.module.css` — append:

```css
/* PR chip (#206): the session's primary PR, outlined like the branch chip so it
   reads as information. Like the branch chip it may shrink, eliding the state
   label first, so a narrow pane keeps the row's time/id in view. */
.pr {
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 0.7rem;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
}

.pr:hover {
  border-color: var(--accent);
}

.prState,
.prMore {
  color: var(--text-muted);
}

.prState {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.prMore {
  flex: 0 0 auto;
}
```

`src/renderer/components/SessionList.tsx`:

1. Add imports:

```ts
import type { SessionPrLink } from "../../ipcTypes";
import { primaryPr } from "../../prChip";
import { currentBridge } from "../bridge";
import { useSessionPrs } from "../hooks/useSessionPrs";
```

2. Below `const onSelect = …;` add:

```ts
  const openPr = (link: SessionPrLink) => {
    void currentBridge()?.openExternal(link.url);
  };
```

3. In `onKeyDown`, change the first line to `const action = listKeyAction(e.key, focusedIndex, sessions.length, { shift: e.shiftKey });` and add after the `if (action.type === "open") { … }` block:

```ts
    if (action.type === "openPr") {
      const link = primaryPr(prs.get(sessions[action.index].sessionId) ?? []);
      if (link) openPr(link);
      return;
    }
```

4. Directly below `const { facts, requestFacts } = useSessionFacts();` add `const { prs, requestPrs } = useSessionPrs();` (`onKeyDown` reads `prs` only when a key is pressed, after render, so its earlier position is fine).
5. Change the visible-window effect to:

```ts
  useEffect(() => {
    if (visibleIds.length === 0) return;
    requestFacts(visibleIds);
    requestPrs(visibleIds);
    // visibleKey is the stable dependency; the ids array's identity changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, requestFacts, requestPrs]);
```

6. Pass two more props to `<SessionRow …>`:

```tsx
              prLinks={prs.get(session.sessionId)}
              onOpenPr={openPr}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `& .\node_modules\.bin\vitest.cmd run test/renderer/SessionRow.test.tsx test/main/sessionListWindow.test.ts test/renderer/SessionList.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write src/renderer/components/SessionRow.tsx src/renderer/components/SessionRow.module.css src/sessionListWindow.ts src/renderer/components/SessionList.tsx test/renderer/SessionRow.test.tsx test/main/sessionListWindow.test.ts test/renderer/SessionList.test.tsx
git add src/renderer/components/SessionRow.tsx src/renderer/components/SessionRow.module.css src/sessionListWindow.ts src/renderer/components/SessionList.tsx test/renderer/SessionRow.test.tsx test/main/sessionListWindow.test.ts test/renderer/SessionList.test.tsx
git commit -m "feat: show a PR chip on session rows and open it with Shift+Enter (#206)"
```

---

### Task 20: Prove `node:sqlite` + FTS5 under Electron in CI, then verify the slice

**Files:**
- Create: `scripts/sqlite-probe.mjs`, `scripts/run-sqlite-probe.mjs`
- Modify: `package.json` (scripts), `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run probe:sqlite` — exits 0 when the repo's Electron binary, run as Node, creates the FTS5 table with the production options and answers a prefix query; non-zero otherwise.

- [ ] **Step 1: Write the probe**

`scripts/sqlite-probe.mjs`:

```js
// Asserts the runtime executing this file ships node:sqlite with FTS5. The table
// options mirror FTS_DDL in src/search/searchDb.ts; keep the two in step.
import console from "node:console";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE turn (id INTEGER PRIMARY KEY, search_text TEXT NOT NULL);
  CREATE VIRTUAL TABLE fts USING fts5 (
    search_text, content='turn', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3', detail=column
  );
`);
db.prepare("INSERT INTO turn (search_text) VALUES (?)").run("rate limiter retries");
db.exec("INSERT INTO fts(fts) VALUES('rebuild')");
const hits = db.prepare("SELECT rowid FROM fts WHERE fts MATCH ?").all('"ra"*');
const { v } = db.prepare("SELECT sqlite_version() AS v").get();
db.close();

if (hits.length !== 1) {
  console.error(`sqlite-probe: expected 1 FTS5 hit, got ${hits.length}`);
  process.exit(1);
}
console.log(
  `sqlite-probe: ok (node ${process.versions.node}, sqlite ${v}, electron ${process.versions.electron ?? "none"})`,
);
```

`scripts/run-sqlite-probe.mjs`:

```js
// Runs sqlite-probe.mjs with the repo's Electron binary acting as Node, so CI
// checks the SQLite build the app actually ships rather than the runner's Node.
import console from "node:console";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Under plain Node the electron package exports the path to its binary.
const electronPath = require("electron");
const probe = fileURLToPath(new URL("./sqlite-probe.mjs", import.meta.url));
const r = spawnSync(electronPath, [probe], {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
if (r.error) {
  console.error(r.error);
  process.exit(1);
}
process.exit(r.status ?? 1);
```

In `package.json` `scripts`, add `"probe:sqlite": "node scripts/run-sqlite-probe.mjs",` after `test:e2e`.

- [ ] **Step 2: Run the probe locally**

Run: `npm run probe:sqlite` (timeout 300000)
Expected: `sqlite-probe: ok (node 24.x, sqlite 3.x, electron 43.x)` and exit 0.

To prove the probe can fail, temporarily change `'"ra"*'` to `'"zz"*'`, rerun, expect `expected 1 FTS5 hit, got 0` and a non-zero exit, then revert.

- [ ] **Step 3: Add the CI job**

In `.github/workflows/ci.yml`, add this job after `unit` (before the trailing comment block):

```yaml
  # node:sqlite + FTS5 must exist in the Electron runtime the app ships (#206).
  # Unit tests run on the runner's Node, so this job downloads the Electron
  # binary and runs the probe with it.
  sqlite-probe:
    name: node:sqlite + FTS5 under Electron (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    env:
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1"
    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Setup toolchain
        uses: ./.github/actions/setup-toolchain
      - name: Install dependencies
        run: npm ci
      - name: Probe node:sqlite + FTS5
        run: npm run probe:sqlite
```

- [ ] **Step 4: Full verification**

Run each, one at a time, timeout 300000:

1. `npm run lint` — expected: exits 0.
2. `npm run typecheck` — expected: exits 0.
3. `npm run build` — expected: exits 0; `dist/searchWorker.js` exists.
4. `npm test` — expected: every suite passes.
5. `npm run test:e2e` — expected: passes (it is local-only; check `main` first if it fails, per the repo's e2e note).

Manual checks:

- `npm start`: rows of sessions that opened PRs show the chip within a few seconds; hovering lists every PR; clicking opens the PR in the browser; Shift+Enter on a focused row does the same.
- In `%APPDATA%\csm` (Windows) or `~/Library/Application Support/csm` (macOS): `search.db`, `search.db-wal` exist after the first run.
- Rename `gh.exe` off `PATH` and restart: chips still show `#N` with no state, and the log shows `[csm search] gh enrichment: N batch(es) failed` and no other error.
- `npm run dist` then run the packaged app: chips appear (proves the unpacked worker path).
- Drag the sidebar to its widest: on rows with a PR chip and a branch chip, the time and id stay visible.

- [ ] **Step 5: Commit**

```powershell
& .\node_modules\.bin\prettier.cmd --write scripts/sqlite-probe.mjs scripts/run-sqlite-probe.mjs package.json
git add scripts/sqlite-probe.mjs scripts/run-sqlite-probe.mjs package.json .github/workflows/ci.yml
git commit -m "ci: probe node:sqlite and FTS5 under the shipped Electron runtime (#206)"
```
