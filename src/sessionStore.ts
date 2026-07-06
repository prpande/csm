// I/O layer over the pure parser: walk a Claude projects root
// (<root>/<encoded-cwd>/<sessionId>.jsonl), read each file's TEXT, run it
// through `parseSession`, group by the AUTHORITATIVE in-file `cwd` (not the
// encoded folder name), and cache parsed metadata by filepath+mtime so a
// refresh only re-parses changed files. Reads are strictly read-only: this unit
// only ever readdir/stat/readFile — it never writes, moves, or deletes a
// session file (a hard CLAUDE.md constraint, asserted in tests). Design spec
// (docs/specs/2026-06-30-csm-design.md §5 module table, §6 tiered scan).

import { readdir, stat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  parseSession,
  extractSessionFacts,
  type SessionMetadata,
  type SessionFacts,
} from "./sessionParser";
import { isValidSessionId } from "./terminalLauncher";

export interface SessionFolder {
  cwd: string;
  sessions: SessionMetadata[];
}

export interface GroupedSessions {
  folders: SessionFolder[];
}

export interface ScanOptions {
  // Epoch ms "now", injected so tier boundaries are deterministic under test.
  now: number;
  // Called once per non-empty tier, newest tier first, before the next tier is
  // parsed and before the promise resolves. The IPC bridge (a later issue) maps
  // this to `sessions:batch` and the resolved value to `sessions:done`.
  onBatch?: (sessions: SessionMetadata[]) => void;
}

// The parser is injectable so tests can spy call counts (cache behaviour)
// without ESM module-mocking; defaults to the real pure parser.
export interface StoreDeps {
  parse?: (sessionId: string, content: string) => SessionMetadata;
  /** Injectable so tests can spy fact-parse call counts (cache behaviour). */
  extractFacts?: (sessionId: string, content: string) => SessionFacts;
}

// Session files. The match is case-sensitive: Claude always writes lowercase
// `.jsonl`, and this reads Claude's own files (spec §6) — a `.JSONL` from an
// external tool is out of scope and intentionally ignored.
const JSONL_EXT = ".jsonl";

// Age tiers by mtime (spec §6): <=1d, <=3d, <=7d, <=14d, <=30d, then a final
// "older than 30d" bucket. Newest tier is parsed and emitted first.
const DAY_MS = 86_400_000;
const TIER_BOUNDS_DAYS = [1, 3, 7, 14, 30];
const TIER_COUNT = TIER_BOUNDS_DAYS.length + 1;

// Tier index 0..5 for a file's age (now - mtime). A future mtime (negative age,
// e.g. clock skew on a live session) lands in the newest tier. Pure — unit-tested
// on its own.
export function tierIndex(ageMs: number): number {
  for (let i = 0; i < TIER_BOUNDS_DAYS.length; i++) {
    if (ageMs <= TIER_BOUNDS_DAYS[i] * DAY_MS) return i;
  }
  return TIER_BOUNDS_DAYS.length;
}

interface FileEntry {
  path: string;
  mtimeMs: number;
}

// Collect every *.jsonl one directory level below the root (the encoded-cwd
// folders). A missing/unreadable root or subdir is skipped, never fatal.
async function collectFiles(rootDir: string): Promise<FileEntry[]> {
  let subdirs: string[];
  try {
    const entries = await readdir(rootDir, { withFileTypes: true });
    subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const files: FileEntry[] = [];
  for (const sub of subdirs) {
    const dir = join(rootDir, sub);
    let names: string[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      // Require a non-empty stem: a file named exactly ".jsonl" would yield an
      // empty sessionId (basename(".jsonl", ".jsonl") === ""), leaking a bogus
      // un-reopenable session — skip it rather than emit it (fail-soft, §12).
      names = entries
        .filter(
          (e) =>
            e.isFile() &&
            e.name.endsWith(JSONL_EXT) &&
            e.name.length > JSONL_EXT.length,
        )
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      } catch {
        // Unreadable between readdir and stat (e.g. removed) — skip.
      }
    }
  }
  return files;
}

// `<sessionId>.jsonl` -> `<sessionId>`. The filename is the authoritative id
// (trusted over any in-file field), matching sessionParser's contract.
function sessionIdOf(filePath: string): string {
  return basename(filePath, JSONL_EXT);
}

// Epoch ms for a lastActivity value, used only for sorting. The parser passes a
// record's `timestamp` through unvalidated, so precision may vary or the value
// may be junk; parsing to a number avoids the lexicographic pitfall (e.g.
// "…00Z" would sort AFTER "…00.500Z" as a string) and treats an unparseable
// value as oldest rather than corrupting the order.
function activityEpoch(lastActivity: string | null): number {
  const t = lastActivity ? Date.parse(lastActivity) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

export function createSessionStore(rootDir: string, deps: StoreDeps = {}) {
  const parse = deps.parse ?? parseSession;
  // Cache key: `filepath\0mtimeMs`. A changed file gets a new key (its stale
  // entry is simply never read again), so an unchanged file resolves instantly.
  const cache = new Map<string, SessionMetadata>();
  const extractFacts = deps.extractFacts ?? extractSessionFacts;
  // sessionId -> absolute path, captured during scan. The on-disk path is grouped
  // by ENCODED cwd, not the authoritative in-file cwd, so it is not derivable from
  // a session's cwd — it must be remembered here. Populated in scan(), read by getFacts().
  const pathById = new Map<string, string>();
  // Fact cache keyed by sessionId; value carries the mtime:size freshness key.
  // SUCCESS entries only — an error is returned transiently so it retries.
  const factCache = new Map<string, { key: string; facts: SessionFacts }>();

  async function readMetadata(
    entry: FileEntry,
  ): Promise<SessionMetadata | null> {
    const key = `${entry.path}\0${entry.mtimeMs}`;
    const cached = cache.get(key);
    if (cached) return cached;

    let content: string;
    try {
      content = await readFile(entry.path, "utf8");
    } catch {
      return null; // vanished/unreadable — skip this file, keep scanning.
    }

    const meta = parse(sessionIdOf(entry.path), content);
    // Parser returns null lastActivity when no record carried a timestamp; fall
    // back to the file's mtime so every session has an orderable time (spec §4.1).
    const withTime: SessionMetadata =
      meta.lastActivity === null
        ? { ...meta, lastActivity: new Date(entry.mtimeMs).toISOString() }
        : meta;
    cache.set(key, withTime);
    return withTime;
  }

  async function scan(opts: ScanOptions): Promise<GroupedSessions> {
    const { now, onBatch } = opts;
    const files = await collectFiles(rootDir);
    for (const f of files) pathById.set(sessionIdOf(f.path), f.path);

    // Bucket by tier; within a tier, newest file first.
    const tiers: FileEntry[][] = Array.from({ length: TIER_COUNT }, () => []);
    for (const f of files) tiers[tierIndex(now - f.mtimeMs)].push(f);
    for (const tier of tiers) tier.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // groups keyed by authoritative in-file cwd, insertion order preserved.
    const groups = new Map<string, SessionMetadata[]>();
    for (const tier of tiers) {
      const batch: SessionMetadata[] = [];
      for (const entry of tier) {
        const meta = await readMetadata(entry);
        if (!meta) continue;
        batch.push(meta);
        const list = groups.get(meta.cwd);
        if (list) list.push(meta);
        else groups.set(meta.cwd, [meta]);
      }
      if (batch.length > 0) onBatch?.(batch);
    }

    // Within each folder, sessions most-recent-first by activity time.
    const folders: SessionFolder[] = [];
    for (const [cwd, sessions] of groups) {
      sessions.sort(
        (a, b) => activityEpoch(b.lastActivity) - activityEpoch(a.lastActivity),
      );
      folders.push({ cwd, sessions });
    }
    // Folders themselves most-recent-first by their newest session, so the
    // folder used most recently sorts first. sessions[0] is that folder's newest
    // (sorted just above); a folder is never empty (only created on first push).
    folders.sort(
      (a, b) =>
        activityEpoch(b.sessions[0].lastActivity) -
        activityEpoch(a.sessions[0].lastActivity),
    );
    return { folders };
  }

  // Per-id worker. Returns the cached/fresh facts, or { error: true } for any
  // validation or I/O failure. Errors are never cached so transient failures retry.
  async function getOneFacts(
    id: string,
  ): Promise<SessionFacts | { error: true }> {
    // UUID gate BEFORE any path use — a hostile id can never reach the filesystem.
    if (!isValidSessionId(id)) return { error: true };
    const path = pathById.get(id);
    if (!path) return { error: true };

    let st;
    try {
      st = await stat(path);
    } catch {
      return { error: true };
    }

    const key = `${st.mtimeMs}:${st.size}`;
    const cached = factCache.get(id);
    if (cached && cached.key === key) return cached.facts;

    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return { error: true }; // NOT cached: a transient failure retries next call.
    }

    const facts = extractFacts(id, content);
    factCache.set(id, { key, facts });
    return facts;
  }

  async function getFacts(
    sessionIds: string[],
  ): Promise<Record<string, SessionFacts | { error: true }>> {
    const out: Record<string, SessionFacts | { error: true }> = {};
    for (const id of sessionIds) out[id] = await getOneFacts(id);
    return out;
  }

  return { scan, getFacts };
}
