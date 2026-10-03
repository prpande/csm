// Anything matched against the FTS index must fold and split text exactly as ingest does.

const TOKEN_RE = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;
const CAMEL_RE =
  /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?[\p{Ll}\p{N}]+|\p{Lu}+\p{N}*/gu;

export interface Token {
  text: string;
  start: number;
  end: number;
}

export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
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
