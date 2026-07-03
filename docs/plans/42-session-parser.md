# Plan — `sessionParser` pure unit (#42)

**Tier:** Standard (new module + logic). p1 reflects core-MVP *importance*, not
risk: this is a pure, I/O-free function with no security surface, no session-file
mutation, and no launcher/spawn. Contract is already specified and reviewed in
[`docs/specs/2026-06-30-csm-design.md`](../specs/2026-06-30-csm-design.md) §4.1
and §5, so no new spec / doc-review is written — this plan references it.
(Deviation from the workflow's "p1 → high-risk" gate, documented here per the
"document plan deviations durably" rule.)

## What / why

`sessionParser` turns one Claude Code session JSONL file's contents into a
metadata object. It is the foundational Phase-A unit: `sessionStore` (scan),
the folder tree, the session list, and reopen all depend on its output. Keeping
it pure (input = already-read text, no `fs`) makes it unit-testable with
fixtures and no Electron runtime — a hard `CLAUDE.md` constraint.

## API (the one real design choice)

```ts
export interface SessionMetadata {
  sessionId: string;
  cwd: string;                 // "(unknown)" fallback
  title: string;               // "(untitled)" fallback
  permissionMode: PermissionMode;
  lastActivity: string | null; // last record ISO timestamp; null → caller uses mtime
  version?: string;
  messageCount?: number;
}
export type PermissionMode =
  | "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk";

export function parseSession(sessionId: string, content: string): SessionMetadata;
```

- **Input is the raw file text**, not pre-parsed records — so line-splitting,
  `JSON.parse`, and malformed-line skipping live *inside* the pure unit (spec
  §4.1 gotcha; §12 fail-soft). `sessionStore` will read the file and pass the
  string.
- `SessionMetadata` / `PermissionMode` are exported from the module for now;
  extract to a shared types file when `sessionStore`/IPC consume them.

## Field extraction (spec §4.1) — grounded in real data

Record shapes verified against real `~/.claude/projects/**` files:
- `{type:"ai-title", aiTitle}` — title primary source.
- `{type:"summary", summary}` — title 2nd fallback (rare; handled defensively).
- `{type:"permission-mode", permissionMode}` — the authoritative mode dimension.
- `{type:"mode", mode:"normal"|"plan"}` — a DIFFERENT dimension; **not** used.
- `user`/`system` records carry top-level `cwd`, `timestamp`, `version`,
  `sessionId`; a `system` record carries `messageCount`.
- `user.message.content` is EITHER a plain string (a real prompt) OR a block
  array (`tool_result`, or `isMeta:true` skill/command wrappers).

Extraction rules:
| Field | Rule |
|---|---|
| `sessionId` | the passed-in id (from filename); trusted over record fields |
| `cwd` | first record with a non-empty `cwd`; else `"(unknown)"` |
| `title` | first `ai-title`.aiTitle → first `summary`.summary → first *eligible* user prompt (truncated to 120 + ellipsis) → `"(untitled)"` |
| `permissionMode` | **last** `permission-mode`.permissionMode IF in the known set; else `"default"` |
| `lastActivity` | last record's `timestamp` (ISO) that has one; else `null` |
| `version` | first record `version` (optional) |
| `messageCount` | first record `messageCount` (optional) |

**Eligible user prompt** (title fallback) = a `user` record whose
`message.content` is a plain string (or a single `text` block) AND is not:
`isMeta===true`, `isVisibleInTranscriptOnly===true`, a `tool_result` block, or
text beginning with `<system-reminder>` / `<command-name>` / `<local-command-`
/ `Caveat:` / `Base directory for this skill:`. Trim before truncating.

**permissionMode:** iterate all `permission-mode` records, take the last;
pass through unchanged if in `{default,acceptEdits,auto,bypassPermissions,
dontAsk}`; otherwise `"default"`. Never coerce a recognized value; never read
the `{type:"mode"}` record.

**Fail-soft:** blank lines and lines that fail `JSON.parse` are skipped, not
fatal. A file of all-junk still returns a well-formed object with every
fallback applied.

## Files

- `src/sessionParser.ts` — the unit (dense explanatory comments, matching
  `src/urls.ts` house style).
- `test/sessionParser.test.ts` — Vitest, fixtures inline as JSONL strings.

## Test list (TDD — failing first)

1. Happy path: all fields present → exact object.
2. `cwd` fallback → `"(unknown)"` when no record has cwd.
3. title: ai-title wins over summary/prompt.
4. title: summary used when no ai-title.
5. title: first eligible user prompt used when no ai-title/summary; truncated at 120.
6. title: skips meta / `<system-reminder>` / command-wrapper / tool_result prompts.
7. title: `"(untitled)"` when nothing eligible.
8. permissionMode: **last** `permission-mode` wins over earlier ones.
9. permissionMode: each recognized value (esp. `auto`) passes through.
10. permissionMode: unrecognized/absent → `"default"`; `{type:"mode"}` ignored.
11. lastActivity: last timestamped record's ISO; `null` when none.
12. malformed/blank lines skipped; all-junk file → full-fallback object.
13. optional `version` / `messageCount` populated when present, absent otherwise.

## Out of scope (follow-on issues)

File reads, directory + tiered scan, mtime caching (`sessionStore`),
`pathAdapter`, IPC, renderer. `customTitle` handling is Phase C (custom labels).
