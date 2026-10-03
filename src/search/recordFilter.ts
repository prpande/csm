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
    line.compare(TYPE_PREFIX, 0, TYPE_PREFIX.length, 0, TYPE_PREFIX.length) ===
      0
  ) {
    const close = line.indexOf(QUOTE, TYPE_PREFIX.length);
    if (close === -1) return false;
    return CONTRIBUTING.has(line.toString("latin1", TYPE_PREFIX.length, close));
  }
  if (line.length > BIG_LINE_BYTES)
    return MARKERS.some((m) => line.includes(m));
  return true;
}
