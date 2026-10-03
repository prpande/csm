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
    "search.dbx",
    "research.db",
  ])
    writeFileSync(join(dir, n), "");
  expect(await purgeSearchFiles(dir)).toEqual({ ok: true, remaining: [] });
  expect(readdirSync(dir).sort()).toEqual([
    "research.db",
    "search.dbx",
    "searchy.db",
    "settings.json",
  ]);
});

test("a missing directory is already clean", async () => {
  expect(await purgeSearchFiles(join(dir, "nope"))).toEqual({
    ok: true,
    remaining: [],
  });
});

test("a busy file is retried until it unlocks", async () => {
  let busy = 2;
  const unlink = vi.fn(async () => {
    if (busy-- > 0) throw errno("EBUSY");
  });
  const sleep = vi.fn(async () => {});
  const r = await purgeSearchFiles(dir, {
    readdir: async () => ["search.db"],
    unlink,
    sleep,
  });
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
