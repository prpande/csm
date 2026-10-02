// Asserts the runtime executing this file ships node:sqlite with FTS5. The table
// options mirror FTS_DDL in src/search/searchDb.ts; keep the two in step.
import console from "node:console";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE turn (id INTEGER PRIMARY KEY, search_text TEXT NOT NULL);
  CREATE VIRTUAL TABLE fts USING fts5 (
    search_text, content='turn', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2', prefix='2 3', detail=column
  );
`);
db.prepare("INSERT INTO turn (search_text) VALUES (?)").run(
  "rate limiter retries",
);
db.exec("INSERT INTO fts(fts) VALUES('rebuild')");
const hits = db.prepare("SELECT rowid FROM fts WHERE fts MATCH ?").all('"ra"*');
const { v } = db.prepare("SELECT sqlite_version() AS v").get();
db.close();

if (hits.length !== 1) {
  console.error(`sqlite-probe: expected 1 FTS5 hit, got ${hits.length}`);
  process.exit(1);
}
console.log(
  `sqlite-probe: ok (node ${process.versions.node}, sqlite ${v}, electron ${process.versions.electron ?? "none"})`,
);
