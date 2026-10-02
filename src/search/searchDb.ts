// The only module that touches node:sqlite, so an API change or a move to
// utilityProcess stays contained here.
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PrLinkObs } from "./prExtractor";
import type { TombstoneState } from "./tombstone";
import type { SessionFields, TurnRow } from "./turnExtractor";

export const SEARCH_DB_FILENAME = "search.db";
export const SCHEMA_VERSION = 1;

type Row = Record<string, unknown>;

const SESSION_COLUMNS =
  "root, sid, cwd, branch, title, titles_text, custom_title, ai_title, summary_title, " +
  "first_prompt, last_activity, path, size, offset, head_len, head_hash, anchor_hash, " +
  "pending_pr_create, extract_version, missing_since, deleted_at";

const SCHEMA_V1 = `
CREATE TABLE session (
  root TEXT NOT NULL,
  sid TEXT NOT NULL,
  cwd TEXT,
  branch TEXT,
  title TEXT,
  titles_text TEXT,
  custom_title TEXT,
  ai_title TEXT,
  summary_title TEXT,
  first_prompt TEXT,
  last_activity INTEGER,
  path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0,
  head_len INTEGER NOT NULL DEFAULT 0,
  head_hash TEXT,
  anchor_hash TEXT,
  pending_pr_create TEXT,
  extract_version INTEGER NOT NULL DEFAULT 0,
  missing_since INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (root, sid)
);
CREATE TABLE turn (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL,
  sid TEXT NOT NULL,
  uuid TEXT,
  role TEXT NOT NULL,
  ts INTEGER,
  text TEXT NOT NULL,
  search_text TEXT NOT NULL,
  UNIQUE (root, sid, uuid)
);
CREATE INDEX turn_session ON turn (root, sid);
CREATE TABLE pr (
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  state TEXT,
  is_draft INTEGER,
  body TEXT,
  fetched_at INTEGER,
  fetch_error TEXT,
  PRIMARY KEY (repo, number)
);
CREATE TABLE session_pr (
  root TEXT NOT NULL,
  sid TEXT NOT NULL,
  repo TEXT NOT NULL COLLATE NOCASE,
  number INTEGER NOT NULL,
  created_here INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER,
  last_seen INTEGER,
  PRIMARY KEY (root, sid, repo, number)
);
CREATE INDEX session_pr_pr ON session_pr (repo, number);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

export const FTS_DDL = `CREATE VIRTUAL TABLE fts USING fts5 (
  search_text,
  content = 'turn', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3',
  detail = column
)`;

export interface OpenOptions {
  platform: NodeJS.Platform;
  ftsDdl?: string;
}

export interface SessionRow {
  root: string;
  sid: string;
  cwd: string | null;
  branch: string | null;
  title: string | null;
  titlesText: string | null;
  customTitle: string | null;
  aiTitle: string | null;
  summaryTitle: string | null;
  firstPrompt: string | null;
  lastActivity: number | null;
  path: string;
  size: number;
  offset: number;
  headLen: number;
  headHash: string | null;
  anchorHash: string | null;
  pendingPrCreate: string[];
  extractVersion: number;
  missingSince: number | null;
  deletedAt: number | null;
}

export interface CursorWrite {
  offset: number;
  headLen: number;
  headHash: string;
  anchorHash: string;
}

export interface ChunkWrite {
  root: string;
  sid: string;
  path: string;
  size: number;
  cursor: CursorWrite;
  fields: SessionFields;
  title: string;
  turns: TurnRow[];
  links: PrLinkObs[];
  pending: string[];
  extractVersion: number;
}

export interface SearchDb {
  readonly ftsOk: boolean;
  getSession(root: string, sid: string): SessionRow | undefined;
  listSessions(root: string): SessionRow[];
  writeChunk(w: ChunkWrite): { turnsInserted: number };
  resetSession(root: string, sid: string): void;
  setPath(root: string, sid: string, path: string): void;
  setTombstone(root: string, sid: string, t: TombstoneState): void;
  restampTitle(
    root: string,
    sid: string,
    title: string,
    extractVersion: number,
  ): void;
  getMeta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
  optimizeFts(): void;
  close(): void;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function parsePending(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function toSessionRow(r: Row): SessionRow {
  return {
    root: String(r.root),
    sid: String(r.sid),
    cwd: str(r.cwd),
    branch: str(r.branch),
    title: str(r.title),
    titlesText: str(r.titles_text),
    customTitle: str(r.custom_title),
    aiTitle: str(r.ai_title),
    summaryTitle: str(r.summary_title),
    firstPrompt: str(r.first_prompt),
    lastActivity: num(r.last_activity),
    path: String(r.path),
    size: num(r.size) ?? 0,
    offset: num(r.offset) ?? 0,
    headLen: num(r.head_len) ?? 0,
    headHash: str(r.head_hash),
    anchorHash: str(r.anchor_hash),
    pendingPrCreate: parsePending(r.pending_pr_create),
    extractVersion: num(r.extract_version) ?? 0,
    missingSince: num(r.missing_since),
    deletedAt: num(r.deleted_at),
  };
}

// SQLite creates the file with the process umask; create it owner-only first.
function ensurePrivateFile(file: string, platform: NodeJS.Platform): void {
  if (platform !== "win32" && !existsSync(file))
    closeSync(openSync(file, "a", 0o600));
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

function configure(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec("PRAGMA journal_size_limit = 67108864");
}

function migrate(db: DatabaseSync): void {
  const version = Number(
    (db.prepare("PRAGMA user_version").get() as Row).user_version,
  );
  if (version > SCHEMA_VERSION)
    throw new Error(
      `search.db schema ${version} is newer than this build (${SCHEMA_VERSION})`,
    );
  if (version === 0)
    inTransaction(db, () => {
      db.exec(SCHEMA_V1);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
}

function ensureFts(db: DatabaseSync, ddl: string): boolean {
  const wasOk =
    (
      db.prepare("SELECT value FROM meta WHERE key = 'fts_ok'").get() as
        Row | undefined
    )?.value === "1";
  const exists =
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fts'",
      )
      .get() !== undefined;
  let ok: boolean;
  try {
    if (!exists) db.exec(ddl);
    // Turns written while FTS5 was unavailable are missing from the index.
    if (!exists || !wasOk) db.exec("INSERT INTO fts(fts) VALUES('rebuild')");
    else db.prepare("SELECT rowid FROM fts LIMIT 0").all();
    ok = true;
  } catch {
    ok = false;
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('fts_ok', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(ok ? "1" : "0");
  return ok;
}

export function openSearchDb(dir: string, opts: OpenOptions): SearchDb {
  const file = join(dir, SEARCH_DB_FILENAME);
  ensurePrivateFile(file, opts.platform);
  const db = new DatabaseSync(file);
  let ftsOk: boolean;
  try {
    configure(db);
    migrate(db);
    ftsOk = ensureFts(db, opts.ftsDdl ?? FTS_DDL);
  } catch (err) {
    db.close();
    throw err;
  }

  const getSession = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE root = ? AND sid = ?`,
  );
  const listSessions = db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM session WHERE root = ? ORDER BY sid`,
  );
  const upsertSession = db.prepare(
    `INSERT INTO session (${SESSION_COLUMNS})
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)
     ON CONFLICT (root, sid) DO UPDATE SET
       cwd = excluded.cwd, branch = excluded.branch, title = excluded.title,
       titles_text = excluded.titles_text, custom_title = excluded.custom_title,
       ai_title = excluded.ai_title, summary_title = excluded.summary_title,
       first_prompt = excluded.first_prompt, last_activity = excluded.last_activity,
       path = excluded.path, size = excluded.size, offset = excluded.offset,
       head_len = excluded.head_len, head_hash = excluded.head_hash,
       anchor_hash = excluded.anchor_hash, pending_pr_create = excluded.pending_pr_create,
       extract_version = excluded.extract_version, missing_since = NULL, deleted_at = NULL`,
  );
  const insertTurn = db.prepare(
    `INSERT INTO turn (root, sid, uuid, role, ts, text, search_text) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT DO NOTHING RETURNING id`,
  );
  const ftsInsert = ftsOk
    ? db.prepare("INSERT INTO fts (rowid, search_text) VALUES (?, ?)")
    : null;
  const ftsDeleteSession = ftsOk
    ? db.prepare(
        `INSERT INTO fts (fts, rowid, search_text)
         SELECT 'delete', id, search_text FROM turn WHERE root = ? AND sid = ?`,
      )
    : null;
  const insertPr = db.prepare(
    "INSERT INTO pr (repo, number, url) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const upsertLink = db.prepare(
    `INSERT INTO session_pr (root, sid, repo, number, created_here, first_seen, last_seen)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (root, sid, repo, number) DO UPDATE SET
       created_here = max(created_here, excluded.created_here),
       first_seen = coalesce(min(first_seen, excluded.first_seen), first_seen, excluded.first_seen),
       last_seen = coalesce(max(last_seen, excluded.last_seen), last_seen, excluded.last_seen)`,
  );
  const deleteTurns = db.prepare("DELETE FROM turn WHERE root = ? AND sid = ?");
  const deleteLinks = db.prepare(
    "DELETE FROM session_pr WHERE root = ? AND sid = ?",
  );
  const rewind = db.prepare(
    `UPDATE session SET offset = 0, head_len = 0, head_hash = NULL, anchor_hash = NULL,
       pending_pr_create = '[]', title = NULL, titles_text = NULL, custom_title = NULL,
       ai_title = NULL, summary_title = NULL, first_prompt = NULL, cwd = NULL,
       branch = NULL, last_activity = NULL
     WHERE root = ? AND sid = ?`,
  );
  const setPath = db.prepare(
    "UPDATE session SET path = ? WHERE root = ? AND sid = ?",
  );
  const setTombstone = db.prepare(
    "UPDATE session SET missing_since = ?, deleted_at = ? WHERE root = ? AND sid = ?",
  );
  const restamp = db.prepare(
    "UPDATE session SET title = ?, extract_version = ? WHERE root = ? AND sid = ?",
  );
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );

  return {
    ftsOk,
    getSession(root, sid) {
      const r = getSession.get(root, sid) as Row | undefined;
      return r ? toSessionRow(r) : undefined;
    },
    listSessions(root) {
      return (listSessions.all(root) as Row[]).map(toSessionRow);
    },
    writeChunk(w) {
      const f = w.fields;
      return inTransaction(db, () => {
        upsertSession.run(
          w.root,
          w.sid,
          f.cwd,
          f.branch,
          w.title,
          f.titleValues.length > 0 ? f.titleValues.join("\n") : null,
          f.customTitle,
          f.aiTitle,
          f.summaryTitle,
          f.firstPrompt,
          f.lastActivity,
          w.path,
          w.size,
          w.cursor.offset,
          w.cursor.headLen,
          w.cursor.headHash,
          w.cursor.anchorHash,
          JSON.stringify(w.pending),
          w.extractVersion,
        );
        let turnsInserted = 0;
        for (const t of w.turns) {
          const r = insertTurn.get(
            w.root,
            w.sid,
            t.uuid,
            t.role,
            t.ts,
            t.text,
            t.searchText,
          ) as Row | undefined;
          if (!r) continue;
          turnsInserted++;
          ftsInsert?.run(Number(r.id), t.searchText);
        }
        for (const l of w.links) {
          insertPr.run(l.repo, l.number, l.url);
          upsertLink.run(
            w.root,
            w.sid,
            l.repo,
            l.number,
            l.createdHere ? 1 : 0,
            l.firstSeen,
            l.lastSeen,
          );
        }
        return { turnsInserted };
      });
    },
    resetSession(root, sid) {
      inTransaction(db, () => {
        ftsDeleteSession?.run(root, sid);
        deleteTurns.run(root, sid);
        deleteLinks.run(root, sid);
        rewind.run(root, sid);
      });
    },
    setPath(root, sid, path) {
      setPath.run(path, root, sid);
    },
    setTombstone(root, sid, t) {
      setTombstone.run(t.missingSince, t.deletedAt, root, sid);
    },
    restampTitle(root, sid, title, extractVersion) {
      restamp.run(title, extractVersion, root, sid);
    },
    getMeta(key) {
      return str((getMeta.get(key) as Row | undefined)?.value) ?? undefined;
    },
    setMeta(key, value) {
      setMeta.run(key, value);
    },
    optimizeFts() {
      if (ftsOk) db.exec("INSERT INTO fts(fts) VALUES('optimize')");
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
