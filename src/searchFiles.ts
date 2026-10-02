import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export const SEARCH_FILE_RE = /^search\.(db|db-wal|db-shm|bak-.+|corrupt-.+)$/;

export interface PurgeDeps {
  readdir?: (dir: string) => Promise<string[]>;
  unlink?: (path: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  retryMs?: number;
  stepMs?: number;
}

const codeOf = (err: unknown): unknown =>
  (err as { code?: unknown } | null)?.code;

export async function purgeSearchFiles(
  dir: string,
  deps: PurgeDeps = {},
): Promise<{ ok: boolean; remaining: string[] }> {
  const list = deps.readdir ?? ((d: string) => readdir(d));
  const remove = deps.unlink ?? unlink;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryMs = deps.retryMs ?? 5_000;
  const stepMs = deps.stepMs ?? 100;

  let remaining: string[];
  try {
    remaining = (await list(dir)).filter((n) => SEARCH_FILE_RE.test(n));
  } catch (err) {
    if (codeOf(err) === "ENOENT") return { ok: true, remaining: [] };
    throw err;
  }
  for (let waited = 0; ; waited += stepMs) {
    const locked: string[] = [];
    for (const name of remaining) {
      try {
        await remove(join(dir, name));
      } catch (err) {
        const code = codeOf(err);
        if (code === "ENOENT") continue;
        // Windows reports a file another process still holds as EBUSY or EPERM.
        if (code === "EBUSY" || code === "EPERM") locked.push(name);
        else throw err;
      }
    }
    remaining = locked;
    if (remaining.length === 0 || waited >= retryMs)
      return { ok: remaining.length === 0, remaining };
    await sleep(stepMs);
  }
}
