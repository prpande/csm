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
    expect(await listTranscripts(join(root, "nope"))).toEqual({
      rootReadable: false,
      files: [],
    });
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
    expect(
      out.files.map((f) => ({ sid: f.sid, path: f.path, size: f.size })),
    ).toEqual([{ sid: "s1", path: join(root, "proj", "s1.jsonl"), size: 3 }]);
  });
});

test("newestPerSession keeps the newest copy of a sid", () => {
  const f = (path: string, mtimeMs: number, sid = "s"): TranscriptFile => ({
    sid,
    path,
    size: 1,
    mtimeMs,
  });
  const out = newestPerSession([
    f("/a/s.jsonl", 1),
    f("/b/s.jsonl", 3),
    f("/c/s.jsonl", 2),
    f("/a/t.jsonl", 1, "t"),
  ]);
  expect(out.get("s")?.path).toBe("/b/s.jsonl");
  expect(out.get("t")?.path).toBe("/a/t.jsonl");
});
