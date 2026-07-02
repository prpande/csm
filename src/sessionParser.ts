// Pure parser: one session JSONL file's TEXT -> a metadata object. Kept free of
// any `fs`/`child_process`/Electron import so it is unit-testable with fixtures
// under Vitest without booting the app (a hard CLAUDE.md constraint). `sessionStore`
// owns reading the file and passes the raw string here; line-splitting, JSON
// parsing, and malformed-line skipping live INSIDE this unit per the design spec
// (docs/specs/2026-06-30-csm-design.md §4.1, §12 fail-soft).

// The CLI-valid permission modes, verified against real session data. `auto` is
// common (~100+ occurrences observed) and must not be dropped. This is a
// SEPARATE dimension from the `{type:"mode","mode":"normal"|"plan"}` record,
// which is NOT used for --permission-mode.
export type PermissionMode =
  "default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk";

const KNOWN_PERMISSION_MODES = new Set<PermissionMode>([
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
]);

// Prompt-derived titles are truncated to keep list rows uniform; ai-title /
// summary values are used verbatim (they are already short, curated strings).
export const TITLE_MAX_LENGTH = 120;

const CWD_FALLBACK = "(unknown)";
const TITLE_FALLBACK = "(untitled)";

// A user "prompt" that is really an injected wrapper, not something the human
// typed. Titles must skip these so injected text can't leak into the list (spec
// §4.1). Matched against the trimmed leading text of a user message.
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
  version?: string;
  messageCount?: number;
}

type Record_ = { [k: string]: unknown };

const isRecord = (v: unknown): v is Record_ =>
  typeof v === "object" && v !== null;
const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const asNonEmptyString = (v: unknown): string | undefined => {
  const s = asString(v);
  return s && s.trim() ? s : undefined;
};

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

function truncateTitle(text: string): string {
  return text.length > TITLE_MAX_LENGTH
    ? text.slice(0, TITLE_MAX_LENGTH) + "…"
    : text;
}

// Title fallback chain (spec §4.1): ai-title -> summary -> first eligible user
// prompt (truncated) -> "(untitled)". Each tier scans in file order for the
// first hit.
function extractTitle(records: Record_[]): string {
  for (const r of records) {
    if (r.type === "ai-title") {
      const t = asNonEmptyString(r.aiTitle);
      if (t) return t;
    }
  }
  for (const r of records) {
    if (r.type === "summary") {
      const t = asNonEmptyString(r.summary);
      if (t) return t;
    }
  }
  for (const r of records) {
    const prompt = eligiblePromptText(r);
    if (prompt) return truncateTitle(prompt);
  }
  return TITLE_FALLBACK;
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
  }

  const meta: SessionMetadata = {
    sessionId,
    cwd: cwd ?? CWD_FALLBACK,
    title: extractTitle(records),
    permissionMode: extractPermissionMode(records),
    lastActivity,
  };
  if (version !== undefined) meta.version = version;
  if (messageCount !== undefined) meta.messageCount = messageCount;
  return meta;
}
