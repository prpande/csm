// Persistence layer for the session-metadata index (spec 2026-07-07 §5–§7). Owns
// a single session-index.json in a caller-injected dir (main passes Electron
// app.getPath('userData')); the injected dir keeps this unit testable against a
// real temp dir without an Electron runtime. Imports only node fs/path + a type.
//
// The index is a REBUILDABLE CACHE over strictly read-only source .jsonl files:
// never authoritative, so on any version mismatch or corruption it loads empty
// and the next scan repopulates it (§6). Writes are single-writer + atomic
// (unique temp + rename) + debounced (§7.5). Disabled mode (indexEnabled=false)
// keeps the in-memory map live but never touches disk (§7.6).

import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode } from "./sessionParser";

export const INDEX_FILENAME = "session-index.json";
export const INDEX_SCHEMA_VERSION = 1;

const DEFAULT_DEBOUNCE_MS = 500;

/** The lazy facts tier (spec §5). Absent on an entry until a getFacts pull
 *  computes it. `lastActivity` lives at entry level, not here (de-duped). */
export interface IndexFacts {
  messageCount: number;
  firstActivity: string | null;
  editedFileCount: number;
  firstModel: string | null;
  distinctModelCount: number;
  outputTokens: number;
}

/** One session's entry. `mtime`+`size` is the freshness key for the WHOLE entry. */
export interface IndexEntry {
  mtime: number;
  size: number;
  cwd: string;
  title: string;
  permissionMode: PermissionMode;
  lastActivity: string | null;
  gitBranch: string | null;
  version?: string;
  facts?: IndexFacts;
}

export interface SessionIndexDeps {
  dir: string;
  enabled: boolean;
  /** Flush debounce (ms). Injectable so tests can force immediate writes. */
  debounceMs?: number;
}

export interface SessionIndex {
  load(): Promise<void>;
  get(id: string): IndexEntry | undefined;
  upsert(id: string, entry: IndexEntry): void;
  prune(observedIds: Set<string>): void;
  flush(): Promise<void>;
  isDirty(): boolean;
}

// Minimal guard: JSON.parse yields any type; null/array/primitive must not be
// treated as the index object (mirrors settingsStore.isRecord).
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createSessionIndex(deps: SessionIndexDeps): SessionIndex {
  const { dir, enabled } = deps;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const file = join(dir, INDEX_FILENAME);

  const entries = new Map<string, IndexEntry>();
  let loaded = false;

  async function load(): Promise<void> {
    if (loaded) return; // idempotent — read disk at most once per instance
    loaded = true;
    if (!enabled) return; // disabled: stay empty, never read disk (§7.6)
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return; // absent / unreadable / unparseable → empty (fail-soft, §6)
    }
    if (!isRecord(parsed)) return; // array / primitive / null → empty
    if (parsed.schemaVersion !== INDEX_SCHEMA_VERSION) {
      // Rebuild, not migrate (§6): discard + log a diagnostic signal.
      console.warn(
        `[CSM] session index schemaVersion ${String(
          parsed.schemaVersion,
        )} != ${INDEX_SCHEMA_VERSION}; discarding and rebuilding`,
      );
      return;
    }
    if (!isRecord(parsed.entries)) return;
    for (const [id, e] of Object.entries(parsed.entries)) {
      // A non-object entry is dropped; the next scan's mtime:size miss refills it.
      if (isRecord(e)) entries.set(id, e as unknown as IndexEntry);
    }
  }

  function get(id: string): IndexEntry | undefined {
    return entries.get(id);
  }

  function upsert(id: string, entry: IndexEntry): void {
    entries.set(id, entry);
    markDirty();
  }

  function prune(observedIds: Set<string>): void {
    let removed = false;
    for (const id of entries.keys()) {
      if (!observedIds.has(id)) {
        entries.delete(id);
        removed = true;
      }
    }
    if (removed) markDirty();
  }

  let dirty = false;
  let flushing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tmpCounter = 0;

  function markDirty(): void {
    if (!enabled) return; // disabled: nothing to persist (§7.6)
    dirty = true;
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    }
  }

  function cancelDebounce(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function serialize(): string {
    // Built synchronously (before any await) so the written bytes are a
    // consistent snapshot even if the map mutates during the async write.
    return (
      JSON.stringify(
        {
          schemaVersion: INDEX_SCHEMA_VERSION,
          entries: Object.fromEntries(entries),
        },
        null,
        2,
      ) + "\n"
    );
  }

  async function writeAtomic(json: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    // Per-flush UNIQUE temp path so two writers can never collide on it, and a
    // crash/concurrent-read never sees a half-written target (§7.5).
    const tmp = join(dir, `${INDEX_FILENAME}.${++tmpCounter}.tmp`);
    try {
      await writeFile(tmp, json, "utf8");
      await rename(tmp, file);
    } catch (err) {
      await unlink(tmp).catch(() => {}); // best-effort temp cleanup
      throw err;
    }
  }

  async function flush(): Promise<void> {
    if (!enabled) return; // disabled: no-op (§7.6)
    cancelDebounce();
    if (flushing) {
      // A write is mid-flight; do not start a second concurrent writer. Wait for
      // it, then re-flush iff new dirty state accumulated during that write.
      await flushing;
      if (dirty) await flush();
      return;
    }
    if (!dirty) return;
    dirty = false; // claim the current dirty state; new upserts re-set it
    const json = serialize();
    flushing = writeAtomic(json);
    try {
      await flushing;
    } catch (err) {
      dirty = true; // write failed → stay dirty so the next flush retries (§11)
      console.warn(`[CSM] session index flush failed: ${String(err)}`);
    } finally {
      flushing = null;
    }
  }

  function isDirty(): boolean {
    return dirty || flushing !== null;
  }

  return { load, get, upsert, prune, flush, isDirty };
}
