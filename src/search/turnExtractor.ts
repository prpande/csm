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
    if (
      isRecord(block) &&
      block.type === "text" &&
      isNonEmptyString(block.text)
    )
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
