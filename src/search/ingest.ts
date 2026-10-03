import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { composeTitleFrom } from "../sessionParser";
import { isRecord } from "../typeGuards";
import {
  anchorSpan,
  classifyFile,
  decideAppend,
  headSpan,
  verifySpans,
  type Span,
} from "./fileCursor";
import { readCompleteLines } from "./lineReader";
import { extractPrs, mergeLinkObs, type PrLinkObs } from "./prExtractor";
import { shouldParse } from "./recordFilter";
import type { CursorWrite, SearchDb, SessionRow } from "./searchDb";
import { nextTombstone, presence, type ParentState } from "./tombstone";
import {
  listTranscripts,
  newestPerSession,
  type TranscriptFile,
} from "./transcriptFiles";
import {
  emptySessionFields,
  extractTurn,
  mergeRecordFields,
  type SessionFields,
  type TurnRow,
} from "./turnExtractor";

// Bump whenever sessionParser's title or prompt rules change; closed transcripts are re-read only on a version change.
export const EXTRACT_VERSION = 1;
export const COMMIT_EVERY_BYTES = 4 * 1024 * 1024;

export interface PassResult {
  changed: boolean;
  rootReadable: boolean;
  filesIngested: number;
  invalidPrRefs: number;
  turnsInserted: number;
}

export interface IngestProgress {
  done: number;
  total: number;
}

export interface IngesterDeps {
  db: SearchDb;
  root: string;
  now: () => number;
  onProgress?: (p: IngestProgress) => void;
  log?: (msg: string, err?: unknown) => void;
  readLines?: typeof readCompleteLines;
}

interface Work {
  file: TranscriptFile;
  base: SessionRow | undefined;
  start: number;
  reset: boolean;
}

async function hashSpan(path: string, span: Span): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buf = Buffer.alloc(span.length);
    let read = 0;
    while (read < span.length) {
      const { bytesRead } = await handle.read(
        buf,
        read,
        span.length - read,
        span.start + read,
      );
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return createHash("sha1").update(buf.subarray(0, read)).digest("hex");
  } finally {
    await handle.close();
  }
}

async function cursorAt(path: string, offset: number): Promise<CursorWrite> {
  const head = headSpan(offset);
  return {
    offset,
    headLen: head.length,
    headHash: await hashSpan(path, head),
    anchorHash: await hashSpan(path, anchorSpan(offset)),
  };
}

function fieldsFromRow(row: SessionRow): SessionFields {
  return {
    cwd: row.cwd,
    branch: row.branch,
    lastActivity: row.lastActivity,
    customTitle: row.customTitle,
    aiTitle: row.aiTitle,
    summaryTitle: row.summaryTitle,
    firstPrompt: row.firstPrompt,
    titleValues: row.titlesText ? row.titlesText.split("\n") : [],
  };
}

function titleOf(f: SessionFields): string {
  return composeTitleFrom({
    customTitle: f.customTitle,
    aiTitle: f.aiTitle,
    summary: f.summaryTitle,
    firstPrompt: f.firstPrompt,
  });
}

async function statCode(path: string): Promise<string | undefined> {
  try {
    await stat(path);
    return undefined;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
  }
}

async function parentState(
  dir: string,
  cache: Map<string, ParentState>,
): Promise<ParentState> {
  const hit = cache.get(dir);
  if (hit) return hit;
  let state: ParentState;
  try {
    await readdir(dir);
    state = "readable";
  } catch (err) {
    state =
      (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
  }
  cache.set(dir, state);
  return state;
}

function mergeResults(a: PassResult, b: PassResult): PassResult {
  return {
    changed: a.changed || b.changed,
    rootReadable: b.rootReadable,
    filesIngested: a.filesIngested + b.filesIngested,
    invalidPrRefs: a.invalidPrRefs + b.invalidPrRefs,
    turnsInserted: a.turnsInserted + b.turnsInserted,
  };
}

interface FileTally {
  turns: number;
  invalid: number;
  advanced: boolean;
}

export function createIngester(deps: IngesterDeps): {
  runPass(): Promise<PassResult>;
} {
  const { db, root } = deps;
  const readLines = deps.readLines ?? readCompleteLines;

  async function ingestFile(w: Work, tally: FileTally): Promise<void> {
    const { file } = w;
    const fields = w.base ? fieldsFromRow(w.base) : emptySessionFields();
    let pending = w.base ? [...w.base.pendingPrCreate] : [];
    let turns: TurnRow[] = [];
    let links = new Map<string, PrLinkObs>();
    let offset = w.start;
    let sinceCommit = 0;
    let invalid = 0;

    const commit = async (): Promise<void> => {
      const cursor = await cursorAt(file.path, offset);
      tally.turns += db.writeChunk({
        root,
        sid: file.sid,
        path: file.path,
        size: Math.max(file.size, offset),
        cursor,
        fields,
        title: titleOf(fields),
        turns,
        links: [...links.values()],
        pending,
        extractVersion: EXTRACT_VERSION,
      }).turnsInserted;
      tally.advanced = true;
      tally.invalid = invalid;
      turns = [];
      links = new Map();
      sinceCommit = 0;
    };

    for await (const line of readLines(file.path, w.start)) {
      sinceCommit += line.end - offset;
      offset = line.end;
      if (line.bytes && shouldParse(line.bytes)) {
        let rec: unknown;
        try {
          rec = JSON.parse(line.bytes.toString("utf8"));
        } catch {
          rec = undefined;
        }
        if (isRecord(rec)) {
          mergeRecordFields(fields, rec);
          const turn = extractTurn(rec);
          if (turn) turns.push(turn);
          const prs = extractPrs(rec, pending);
          pending = prs.pending;
          invalid += prs.invalid;
          for (const l of prs.links) mergeLinkObs(links, l);
        }
      }
      if (sinceCommit >= COMMIT_EVERY_BYTES) await commit();
    }
    // An append that read no complete line (an unterminated tail) has nothing to commit.
    const advanced = !w.base || offset > w.start;
    if (advanced) await commit();
  }

  async function settleAbsent(
    rows: Map<string, SessionRow>,
    seen: Map<string, TranscriptFile>,
  ): Promise<boolean> {
    let changed = false;
    const now = deps.now();
    const parents = new Map<string, ParentState>();
    for (const row of rows.values()) {
      if (seen.has(row.sid)) continue;
      if (row.deletedAt !== null) {
        if (row.extractVersion !== EXTRACT_VERSION) {
          db.restampTitle(
            root,
            row.sid,
            titleOf(fieldsFromRow(row)),
            EXTRACT_VERSION,
          );
          changed = true;
        }
        continue;
      }
      const p = presence(
        await statCode(row.path),
        await parentState(dirname(row.path), parents),
      );
      const next = nextTombstone(row, p, now);
      if (
        next.missingSince !== row.missingSince ||
        next.deletedAt !== row.deletedAt
      ) {
        db.setTombstone(root, row.sid, next);
        if (next.deletedAt !== row.deletedAt) changed = true;
      }
    }
    return changed;
  }

  async function pass(): Promise<PassResult> {
    const result: PassResult = {
      changed: false,
      rootReadable: true,
      filesIngested: 0,
      invalidPrRefs: 0,
      turnsInserted: 0,
    };
    const listing = await listTranscripts(root);
    if (!listing.rootReadable) return { ...result, rootReadable: false };
    const seen = newestPerSession(listing.files);
    const rows = new Map(db.listSessions(root).map((r) => [r.sid, r]));

    const work: Work[] = [];
    for (const file of seen.values()) {
      let row = rows.get(file.sid);
      if (row && row.path !== file.path) {
        db.setPath(root, file.sid, file.path);
        row = { ...row, path: file.path };
        result.changed = true;
      }
      if (row && (row.missingSince !== null || row.deletedAt !== null)) {
        db.setTombstone(root, file.sid, {
          missingSince: null,
          deletedAt: null,
        });
        result.changed = true;
      }
      const plan = classifyFile(row, file.size, EXTRACT_VERSION);
      if (plan.kind === "unchanged") continue;
      if (plan.kind === "new" || !row) {
        work.push({ file, base: undefined, start: 0, reset: false });
        continue;
      }
      if (plan.kind === "verify") {
        const spans = verifySpans(row);
        try {
          const head = await hashSpan(file.path, spans.head);
          const anchor = await hashSpan(file.path, spans.anchor);
          if (decideAppend(row, head, anchor) === "appended") {
            work.push({ file, base: row, start: row.offset, reset: false });
            continue;
          }
        } catch (err) {
          deps.log?.("search: could not verify a transcript", err);
          continue;
        }
      }
      work.push({ file, base: undefined, start: 0, reset: true });
    }

    work.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
    deps.onProgress?.({ done: 0, total: work.length });
    for (const [i, w] of work.entries()) {
      const tally: FileTally = { turns: 0, invalid: 0, advanced: false };
      try {
        if (w.reset) {
          db.resetSession(root, w.file.sid);
          result.changed = true;
        }
        await ingestFile(w, tally);
      } catch (err) {
        deps.log?.("search: could not ingest a transcript", err);
      }
      if (tally.advanced) {
        result.filesIngested++;
        result.turnsInserted += tally.turns;
        result.invalidPrRefs += tally.invalid;
        result.changed = true;
      }
      deps.onProgress?.({ done: i + 1, total: work.length });
    }

    try {
      if (await settleAbsent(rows, seen)) result.changed = true;
      if (db.pruneOrphanPrs() > 0) result.changed = true;
    } catch (err) {
      deps.log?.("search: could not settle missing transcripts", err);
    }
    if (result.invalidPrRefs > 0)
      deps.log?.(
        `search: dropped ${result.invalidPrRefs} invalid PR references`,
      );
    return result;
  }

  let running: Promise<PassResult> | null = null;
  let rerun = false;

  async function loop(): Promise<PassResult> {
    try {
      rerun = false;
      let merged = await pass();
      while (rerun) {
        rerun = false;
        merged = mergeResults(merged, await pass());
      }
      return merged;
    } finally {
      running = null;
    }
  }

  return {
    runPass() {
      if (running) {
        rerun = true;
        return running;
      }
      running = loop();
      return running;
    },
  };
}
