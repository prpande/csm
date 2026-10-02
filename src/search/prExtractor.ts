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
    .filter(
      (b) => isRecord(b) && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

function contentBlocks(rec: Record<string, unknown>): unknown[] {
  const message = rec.message;
  return isRecord(message) && Array.isArray(message.content)
    ? message.content
    : [];
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
    if (ref)
      links.push({ ...ref, createdHere: false, firstSeen: ts, lastSeen: ts });
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
      if (b.is_error === true) continue;
      // gh pr create prints the URL alone on a line; anything else is not its output.
      for (const line of toolResultText(b.content).split(/\r?\n/)) {
        const ref = exactPrUrl(line.trim());
        if (ref)
          links.push({
            ...ref,
            createdHere: true,
            firstSeen: ts,
            lastSeen: null,
          });
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

export function mergeLinkObs(
  into: Map<string, PrLinkObs>,
  link: PrLinkObs,
): void {
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
