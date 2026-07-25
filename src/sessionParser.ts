// Pure parser: one session JSONL file's TEXT -> a metadata object. Kept free of
// any `fs`/`child_process`/Electron import so it is unit-testable with fixtures
// under Vitest without booting the app (a hard CLAUDE.md constraint). `sessionStore`
// owns reading the file and passes the raw string here; line-splitting, JSON
// parsing, and malformed-line skipping live INSIDE this unit per the design spec
// (docs/specs/2026-06-30-csm-design.md §4.1, §12 fail-soft).

import { isRecord, isNonEmptyString } from "./typeGuards";

// The complete set of --permission-mode values the CLI accepts (CLAUDE.md; design
// spec §13). This is the "known CLI set" that gates pass-through: a recognized
// value is passed through unchanged, and only an absent/unrecognized value falls
// back to "default" (spec §4.1 — never coerce a recognized value). `auto` is
// common in real data (~100+ occurrences); `plan` is CLI-valid and kept here for
// completeness even though plan-ness usually rides the SEPARATE
// `{type:"mode","mode":"normal"|"plan"}` record — which is a different dimension
// and is NOT read for permissionMode.
export type PermissionMode =
  "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan";

// ReadonlySet so consumers (e.g. terminalLauncher's --permission-mode gate) can't
// mutate this load-bearing allowlist at runtime; the type blocks .add()/.delete().
export const KNOWN_PERMISSION_MODES: ReadonlySet<PermissionMode> =
  new Set<PermissionMode>([
    "default",
    "acceptEdits",
    "auto",
    "bypassPermissions",
    "dontAsk",
    "plan",
  ]);

// Prompt-derived titles are truncated to keep list rows uniform; ai-title /
// summary values are used verbatim (they are already short, curated strings).
export const TITLE_MAX_LENGTH = 120;

const CWD_FALLBACK = "(unknown)";
const TITLE_FALLBACK = "(untitled)";

// A user "prompt" that is really an injected wrapper, not something the human
// typed. Titles must skip these so injected text can't leak into the list (spec
// §4.1). Matched against the trimmed leading text of a user message.
//
// Deliberately an explicit allowlist rather than a generic `^<tag>` regex: a
// regex would misclassify legitimate prompts that genuinely open with a tag
// ("<div> how do I center this", "<Button> not firing") and drop them from the
// title. The cost is that a NEW Claude Code wrapper tag must be added here; that
// only affects a 3rd-tier fallback label, so an occasional miss is preferable to
// silently swallowing real user prompts.
const WRAPPER_PREFIXES = [
  "<system-reminder",
  "<command-name",
  "<command-message",
  "<command-args",
  "<local-command",
  "Caveat:",
  "Base directory for this skill:",
];

export interface SessionMetadata {
  sessionId: string;
  cwd: string;
  title: string;
  permissionMode: PermissionMode;
  lastActivity: string | null;
  /** Branch the session ran on (in-file `gitBranch`, last non-empty wins);
   *  `null` when no record carries one (e.g. a non-git cwd). */
  gitBranch: string | null;
  version?: string;
  messageCount?: number;
}

type Record_ = Record<string, unknown>;

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
// Returns the value UNTRIMMED — this is session metadata rendered as-is, unlike
// settingsStore's claudePath, which trims because it reaches spawn.
const asNonEmptyString = (v: unknown): string | undefined =>
  isNonEmptyString(v) ? v : undefined;

// Parse the JSONL body into records, skipping blank and malformed lines. A
// broken line is dropped, never fatal (spec §12): a partly-corrupt or entirely
// junk file still yields a well-formed metadata object built from fallbacks.
function parseRecords(content: string): Record_[] {
  const records: Record_[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (isRecord(parsed)) records.push(parsed);
  }
  return records;
}

// The human-typed text of a user record, or undefined if this record is not an
// eligible title source. `message.content` is EITHER a plain string (a real
// prompt) OR a block array (tool_result, or isMeta text wrappers) — verified
// against real data. isMeta / isVisibleInTranscriptOnly records and wrapper
// text are rejected here so only a genuine prompt can become the title.
function eligiblePromptText(rec: Record_): string | undefined {
  if (rec.type !== "user") return undefined;
  if (rec.isMeta === true || rec.isVisibleInTranscriptOnly === true)
    return undefined;

  const message = rec.message;
  if (!isRecord(message)) return undefined;
  const content = message.content;

  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // First text block, if any; a tool_result-only array has none -> not a prompt.
    for (const block of content) {
      if (isRecord(block) && block.type === "text") {
        text = asString(block.text);
        break;
      }
    }
  }

  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  if (WRAPPER_PREFIXES.some((p) => trimmed.startsWith(p))) return undefined;
  return trimmed;
}

// Truncate by CODE POINT, not UTF-16 code unit: spreading the string iterates
// whole code points, so a supplementary-plane character (emoji, some CJK) that
// straddles the limit is kept or dropped as a unit rather than being sliced into
// a lone, malformed surrogate. TITLE_MAX_LENGTH is thus a code-point budget.
function truncateTitle(text: string): string {
  const codePoints = [...text];
  return codePoints.length > TITLE_MAX_LENGTH
    ? codePoints.slice(0, TITLE_MAX_LENGTH).join("") + "…"
    : text;
}

// Value of `key` on records of `type`: the FIRST non-empty match by default, or
// the LAST when `{ last: true }`. The two modes exist because the title tiers
// disagree on which record wins. ai-title/summary never change value within a
// session (verified across a real corpus), so first-wins is correct and lets the
// scan short-circuit. A rename (`custom-title`) does repeat and CAN change value
// mid-session — one real session carries 47 custom-title records spanning two
// names — so the name the session ENDED on must win, the same last-wins rule
// `extractPermissionMode` applies for the same reason.
function fieldValue(
  records: Record_[],
  type: string,
  key: string,
  { last = false }: { last?: boolean } = {},
): string | undefined {
  let value: string | undefined;
  for (const r of records) {
    if (r.type !== type) continue;
    const v = asNonEmptyString(r[key]);
    if (!v) continue;
    if (!last) return v;
    value = v;
  }
  return value;
}

// Separator between the user-assigned name and the derived descriptor. ` — `
// (spaced em dash) rather than the metadata line's `·`, so the composite title
// reads as one field and doesn't blur against the metadata beneath it.
const TITLE_SEPARATOR = " — ";

// Fuse the custom name (from /rename) with the derived descriptor into the row
// title. The name LEADS and always survives truncation; the descriptor absorbs
// the cut. The whole result obeys TITLE_MAX_LENGTH (code points), matching the
// tier-3 prompt budget so rows stay a uniform width.
//
// With no name this returns the descriptor unchanged (or the fallback) — the
// pre-#176 behavior byte-for-byte, so existing sessions are unaffected.
function composeTitle(
  name: string | undefined,
  descriptor: string | undefined,
): string {
  if (name === undefined) return descriptor ?? TITLE_FALLBACK;
  // A name that alone fills (or overflows) the budget leaves no room for a
  // descriptor: emit the truncated name with no dangling separator.
  if (
    descriptor === undefined ||
    [...name].length + TITLE_SEPARATOR.length >= TITLE_MAX_LENGTH
  ) {
    return truncateTitle(name);
  }
  return truncateTitle(name + TITLE_SEPARATOR + descriptor);
}

// The first eligible (human-typed, non-wrapper) user prompt, truncated for the
// list — the third title tier, which has its own predicate (eligiblePromptText).
function firstPromptTitle(records: Record_[]): string | undefined {
  for (const r of records) {
    const prompt = eligiblePromptText(r);
    if (prompt) return truncateTitle(prompt);
  }
  return undefined;
}

// Row title (spec §4.1). A user-assigned name (`custom-title`, set by /rename)
// LEADS when present; the derived descriptor — ai-title -> summary -> first
// eligible user prompt (truncated), read top to bottom as strict priority —
// follows it. Composed by composeTitle, which owns the budget and the edges
// (name-only, descriptor-only, over-budget). Falls back to "(untitled)" only
// when neither a name nor any descriptor exists.
function extractTitle(records: Record_[]): string {
  const name = fieldValue(records, "custom-title", "customTitle", {
    last: true,
  });
  const descriptor =
    fieldValue(records, "ai-title", "aiTitle") ??
    fieldValue(records, "summary", "summary") ??
    firstPromptTitle(records);
  return composeTitle(name, descriptor);
}

// LAST permission-mode record wins — a session can change mode mid-run, and the
// mode it ENDED in best represents how it was operating (spec §4.1). A recognized
// value passes through unchanged; an absent or unrecognized value falls back to
// "default" (never silently coerce a recognized value).
function extractPermissionMode(records: Record_[]): PermissionMode {
  let mode: PermissionMode = "default";
  for (const r of records) {
    if (r.type !== "permission-mode") continue;
    const value = asString(r.permissionMode);
    if (value && KNOWN_PERMISSION_MODES.has(value as PermissionMode)) {
      mode = value as PermissionMode;
    }
  }
  return mode;
}

/**
 * Parse a Claude Code session JSONL file's contents into session metadata.
 *
 * @param sessionId the session id from the filename — trusted over any in-file
 *   `sessionId` field, since the filename is the authoritative identifier.
 * @param content the raw JSONL file text (already read by the caller).
 */
export function parseSession(
  sessionId: string,
  content: string,
): SessionMetadata {
  const records = parseRecords(content);

  let cwd: string | undefined;
  let lastActivity: string | null = null;
  let gitBranch: string | null = null;
  let version: string | undefined;
  let messageCount: number | undefined;

  for (const r of records) {
    if (cwd === undefined) cwd = asNonEmptyString(r.cwd);
    if (version === undefined) version = asNonEmptyString(r.version);
    if (messageCount === undefined && typeof r.messageCount === "number") {
      messageCount = r.messageCount;
    }
    // Last record (in file order) that carries a timestamp wins; records without
    // one (e.g. a trailing permission-mode) must not clobber it.
    const ts = asString(r.timestamp);
    if (ts) lastActivity = ts;
    // Last non-empty gitBranch wins (a session can switch branches mid-run); a
    // blank/absent value is treated as "no info" and must not clobber a real one.
    const branch = asNonEmptyString(r.gitBranch);
    if (branch) gitBranch = branch;
  }

  const meta: SessionMetadata = {
    sessionId,
    cwd: cwd ?? CWD_FALLBACK,
    title: extractTitle(records),
    permissionMode: extractPermissionMode(records),
    lastActivity,
    gitBranch,
  };
  if (version !== undefined) meta.version = version;
  if (messageCount !== undefined) meta.messageCount = messageCount;
  return meta;
}

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
    (b) =>
      isRecord(b) &&
      b.type === "text" &&
      asNonEmptyString(b.text) !== undefined,
  );
}

/**
 * Extract the heavier per-session facts for the enriched row (spec §4). Shares the
 * record-walk with parseSession but is a SEPARATE entry point so the light list
 * path stays cheap. Pure and fail-soft: a junk file yields an all-fallback object.
 */
export function extractSessionFacts(
  sessionId: string,
  content: string,
): SessionFacts {
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
      if (typeof block.name !== "string" || !MUTATING_TOOLS.has(block.name))
        continue;
      const input = isRecord(block.input) ? block.input : undefined;
      const path = input
        ? (asNonEmptyString(input.file_path) ??
          asNonEmptyString(input.notebook_path))
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
