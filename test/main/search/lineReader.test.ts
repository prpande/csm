// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCompleteLines,
  type ReadOptions,
} from "../../../src/search/lineReader";

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
async function collect(
  path: string,
  start = 0,
  opts: ReadOptions = { chunkBytes: 4 },
) {
  const out: { text: string | null; end: number }[] = [];
  for await (const l of readCompleteLines(path, start, opts))
    out.push({
      text: l.bytes === null ? null : l.bytes.toString("utf8"),
      end: l.end,
    });
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
    expect(await collect(file("ab\ncd\n"), 3)).toEqual([
      { text: "cd", end: 6 },
    ]);
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
    const p = file(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}\n{}\n")]),
    );
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
