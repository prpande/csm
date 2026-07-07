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
import {
  createSessionIndex,
  type IndexEntry,
  type IndexFacts,
  type SessionIndex,
} from "./sessionIndex";

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
  /** The persistent metadata/facts index (spec 2026-07-07). Defaults to a
   *  disabled in-memory index → today's ephemeral behaviour when none is
   *  injected (used by the many existing tests that construct a bare store). */
  index?: SessionIndex;
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
  size: number;
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
        const st = await stat(path);
        files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
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
  const extractFacts = deps.extractFacts ?? extractSessionFacts;
  // Disabled in-memory index when none injected: get/upsert work in memory,
  // load is empty, flush is a no-op — precisely today's ephemeral cache (§7.6).
  const index = deps.index ?? createSessionIndex({ dir: "", enabled: false });
  // sessionId -> absolute path, captured during scan. The on-disk path is grouped
  // by ENCODED cwd, not the authoritative in-file cwd, so it is not derivable from
  // a session's cwd — it must be remembered here. Populated in scan(), read by getFacts().
  const pathById = new Map<string, string>();
  // Sessions whose facts are being computed right now. De-dups a lazy getFacts
  // pull against the startBackfill() seam (Task 7 exposes this set).
  const inFlight = new Set<string>();

  // Rebuild a SessionMetadata from a persisted entry (the map key is the id, and
  // messageCount is intentionally not persisted — no consumer; the row uses
  // SessionFacts.messageCount, spec §5).
  function metaFromEntry(id: string, e: IndexEntry): SessionMetadata {
    return {
      sessionId: id,
      cwd: e.cwd,
      title: e.title,
      permissionMode: e.permissionMode,
      lastActivity: e.lastActivity,
      gitBranch: e.gitBranch,
      ...(e.version !== undefined ? { version: e.version } : {}),
    };
  }

  // SessionFacts reconstructed from a warm entry: firstActivity from facts,
  // lastActivity from the entry level (de-duped, spec §5).
  function factsFromEntry(id: string, e: IndexEntry): SessionFacts {
    const f = e.facts!;
    return {
      sessionId: id,
      messageCount: f.messageCount,
      firstActivity: f.firstActivity,
      lastActivity: e.lastActivity,
      editedFileCount: f.editedFileCount,
      firstModel: f.firstModel,
      distinctModelCount: f.distinctModelCount,
      outputTokens: f.outputTokens,
    };
  }

  // The persisted facts subset (drops sessionId → the map key, and lastActivity
  // → stored once at entry level).
  function toIndexFacts(f: SessionFacts): IndexFacts {
    return {
      messageCount: f.messageCount,
      firstActivity: f.firstActivity,
      editedFileCount: f.editedFileCount,
      firstModel: f.firstModel,
      distinctModelCount: f.distinctModelCount,
      outputTokens: f.outputTokens,
    };
  }

  async function readMetadata(
    entry: FileEntry,
  ): Promise<SessionMetadata | null> {
    const id = sessionIdOf(entry.path);
    const existing = index.get(id);
    // Hit: mtime AND size match the persisted freshness key → no read, no parse.
    if (
      existing &&
      existing.mtime === entry.mtimeMs &&
      existing.size === entry.size
    ) {
      return metaFromEntry(id, existing);
    }

    let content: string;
    try {
      content = await readFile(entry.path, "utf8");
    } catch {
      return null; // vanished/unreadable — skip this file, keep scanning.
    }

    const meta = parse(id, content);
    // Parser returns null lastActivity when no record carried a timestamp; fall
    // back to the file's mtime so every session has an orderable time (spec §4.1).
    const lastActivity =
      meta.lastActivity ?? new Date(entry.mtimeMs).toISOString();
    // Miss (new or changed key) → write the metadata tier. A changed key drops
    // any stale facts by replacing the whole entry (spec §7.2).
    index.upsert(id, {
      mtime: entry.mtimeMs,
      size: entry.size,
      cwd: meta.cwd,
      title: meta.title,
      permissionMode: meta.permissionMode,
      lastActivity,
      gitBranch: meta.gitBranch,
      ...(meta.version !== undefined ? { version: meta.version } : {}),
    });
    return metaFromEntry(id, index.get(id)!);
  }

  async function scan(opts: ScanOptions): Promise<GroupedSessions> {
    const { now, onBatch } = opts;
    await index.load(); // idempotent — reads disk at most once
    const files = await collectFiles(rootDir);
    // Rebuild the id->path map each scan so sessions deleted between scans
    // don't linger as stale entries (the map is exactly one scan's worth).
    pathById.clear();
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
    await finalizeScan(files);
    return { folders };
  }

  // The post-scan tail: prune stale entries then flush. Extracted so `scan` stays
  // under the cognitive-complexity threshold. Prune ONLY after a complete scan and
  // NEVER when zero files were observed (a missing/transient root returns []),
  // so a transient failure can't wipe the index (spec §7.2, §11).
  async function finalizeScan(files: FileEntry[]): Promise<void> {
    if (files.length > 0) {
      index.prune(new Set(pathById.keys()));
    }
    await index.flush();
  }

  // Read the file, compute facts, and persist them to the index when the
  // scan-time metadata version still matches (keyMatches). Returns null on I/O
  // failure so the caller can propagate { error: true } without persisting.
  async function computeAndPersistFacts(
    id: string,
    path: string,
    entry: IndexEntry | undefined,
    keyMatches: boolean,
  ): Promise<SessionFacts | null> {
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      return null; // NOT persisted: a transient failure retries.
    }
    const facts = extractFacts(id, content);
    // Persist facts ONLY when the scan-time metadata version still matches the
    // current file — so persisted facts always sit on fresh metadata. If the
    // file changed since scan (or has no entry yet), return transiently; the
    // next scan refreshes the entry and a later pull persists (spec §7.3).
    if (keyMatches) {
      index.upsert(id, { ...entry!, facts: toIndexFacts(facts) });
      return factsFromEntry(id, index.get(id)!);
    }
    return facts;
  }

  // Per-id worker. Returns cached/fresh facts, or { error: true } for any
  // validation or I/O failure. Errors are never persisted so transient failures
  // retry (the #115 rule).
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

    const entry = index.get(id);
    const keyMatches =
      entry !== undefined &&
      entry.mtime === st.mtimeMs &&
      entry.size === st.size;
    // Warm hit: fresh entry that already carries facts.
    if (keyMatches && entry!.facts) return factsFromEntry(id, entry!);

    inFlight.add(id);
    try {
      const facts = await computeAndPersistFacts(id, path, entry, keyMatches);
      return facts ?? { error: true };
    } finally {
      inFlight.delete(id);
    }
  }

  async function getFacts(
    sessionIds: string[],
  ): Promise<Record<string, SessionFacts | { error: true }>> {
    const out: Record<string, SessionFacts | { error: true }> = {};
    for (const id of sessionIds) out[id] = await getOneFacts(id);
    return out;
  }

  // Facts-completion seam (spec §7.4): compute + persist facts for every scanned
  // session that lacks warm facts, yielding to the event loop between files. BUILT
  // but NOT auto-invoked in #116 — the first consumer that needs guaranteed-complete
  // facts (faceting / #118) calls it on demand.
  async function startBackfill(): Promise<void> {
    await index.load();
    for (const id of [...pathById.keys()]) {
      const e = index.get(id);
      if (e?.facts) continue; // already warm
      if (inFlight.has(id)) continue; // a concurrent lazy pull owns it
      await getOneFacts(id); // computes + persists via the shared path
      await new Promise<void>((r) => setImmediate(r)); // cooperative yield
    }
    await index.flush();
  }

  return { scan, getFacts, startBackfill, inFlight };
}
