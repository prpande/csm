# Session Search and PR Links — Design Spec

- **Tracking issue:** [#205](https://github.com/prpande/csm/issues/205)
- **Slices:** [#206](https://github.com/prpande/csm/issues/206) engine + ingest +
  `gh` enrichment + PR chip, [#207](https://github.com/prpande/csm/issues/207)
  PR view, [#208](https://github.com/prpande/csm/issues/208) search query
  engine + UI.
- **Epic:** [#88](https://github.com/prpande/csm/issues/88). Supersedes #117.
- **Builds on:** the persistent metadata index (#116,
  `docs/specs/2026-07-07-persistent-metadata-index-design.md`) and the
  session-row title composition (#176).

## 1. Goal

Answer "which session worked on which PR, or on which topic" from inside CSM,
without resuming sessions to ask Claude. Three user-visible pieces:

1. **PR links on session rows.** Each session row shows the GitHub PR it worked
   on, with title and state, and opens it in the browser.
2. **PR view.** A `Sessions | PRs` toggle. The folder tree lists folders with
   PRs; a folder lists its PRs newest-first, each opening in the browser or
   reopening the session that worked on it.
3. **As-you-type search.** The title-bar search box filters one combined list of
   PRs and sessions across all folders, over session titles, folders, branches,
   PR number/repo/title/description, and conversation text.

All three read from a new persisted search store, `search.db`, owned by a
worker thread. The existing browse path (`session-index.json`, tree, rows,
facts line) is unchanged.

## 2. Context and measured ground truth

Measured on the owner's machine, 2026-10-02 (Electron 43.1.1, Node 24.18,
SQLite 3.53.1, Windows):

- **Corpus:** 189 top-level transcripts, 1.24 GB. File size p50 0.8 MB,
  p95 20 MB, max 305 MB. Longest single line 7.6 MB; 5 lines exceed 1 MB.
  History before 2026-08-19 was deleted by Claude Code's `cleanupPeriodDays`
  before it was raised.
- **Native PR record.** Claude Code appends
  `{type:"pr-link", sessionId, prNumber, prUrl, prRepository, timestamp}`.
  All ~15.9k records have exactly these keys; `prRepository` is `owner/repo`;
  `sessionId` always equals the file's id.
  - Present in 25 of the 62 sessions that mention a GitHub PR anywhere.
    Emission is conditional and not version-gated; the trigger is unknown.
  - Re-appended about 88 times per PR (up to ~6k records in one file).
  - Re-appends come in per-PR runs while that PR is being worked on: in every
    multi-PR session each `pr-link` timestamp carries one PR and each PR's last
    record time is distinct, so the latest `pr-link` time ranks PRs within a
    session.
  - Lists every PR the session created via `gh pr create` (20 of 20 sessions),
    and in 6 of 20 also PRs the session only viewed or pushed to.
  - Never observed for Azure DevOps PRs. Out of scope: PRs are GitHub only.
- **PRs per session and sessions per PR** (from `pr-link`): 87 distinct PRs;
  76 linked to one session, 10 to two, 1 to three; 84 of 87 from one cwd.
  12 of 25 `pr-link` sessions link one PR, 13 link two or more.
- **Noise.** A raw PR-URL scan of the whole transcript finds 28 sessions with
  6+ distinct PRs, mostly from `gh pr list` output and review sweeps. Raw
  substring search over all bytes takes 3.8 s and hits 51 sessions for
  "rate limit"; restricted to prompts and assistant text it hits 13.
- **Conversation text** (real user prompts + assistant text blocks) is
  16.8–31.8 MB depending on the filter; 18,909 turns. Plan capacity for 32 MB
  and growing.
- **Transcript quirks.** Record `uuid`s repeat across files (resume/fork
  replay; 211 seen). `timestamp` goes backwards within a file 6,595 times, so
  the last record's timestamp is not the latest. First-line record type varies
  (`last-prompt`, `ai-title`, `mode`, `custom-title`, `queue-operation`).
- **Engine probe.** `node:sqlite` loads with no flag and no warning in
  Electron 43. `ENABLE_FTS5` is compiled in; unicode61, trigram and porter
  tokenizers, prefix indexes, `bm25`, `snippet` and `highlight` all run. It
  works in the main process, `worker_threads` and `utilityProcess`, including
  from inside an asar. macOS arm64 and Linux x64 binaries were checked
  statically only (FTS5 symbols present; Node's `deps/sqlite/unofficial.gni`
  enables FTS5 unconditionally).
- **FTS5 on the turn corpus** (`unicode61 remove_diacritics 2`,
  `prefix='2 3'`, `detail=column`): 10.3 MB index over 22.2 MB of text, built
  in about 3–4 s. Whole-word queries 0.1–1 ms; grouped 2-character prefix
  queries 55–80 ms; a 1-character prefix with `snippet()` over 30 rows took
  388 ms. `detail=column` rejects phrase and `NEAR` queries.
- **Current scanner.** `sessionStore` reads whole files with
  `readFile(path,'utf8')` and `split('\n')` on every cache miss; a live session
  is re-read whole on each append. The 305 MB file is about 1.7x below V8's
  maximum string length and peaks above 600 MB of heap. Tracked separately in
  #210.

## 3. Owner decisions

These were decided with the owner during design and are not open:

1. **One primary PR per session row** (the newest PR created in the session,
   else the PR it most recently touched), a `+N` count, the rest in the tooltip.
   Search matches all linked PRs.
2. **PR sources:** `pr-link` records plus the URL printed by `gh pr create` in
   the session's own tool output. No raw URL scan, no branch-based inference.
3. **`gh` is assumed installed and authenticated.** It fetches PR title, state
   and description. A minimal failure floor is in scope (§8.3); richer handling
   of a missing or unauthenticated `gh` is deferred until it happens.
4. **PR view** per folder via the existing tree, PRs sorted by the owner's
   latest activity on them, each with "Open PR" and "Open session".
5. **Multi-session PR:** "Open session" opens the newest linked session; a
   `+N sessions` popover lists the rest.
6. **Conversation text is persisted** in `userData`, built in the background on
   launch, cumulative and incremental. This reverses #116's "the index stores no
   conversation text" decision (§11).
7. **Deleted transcripts are kept**, marked "transcript deleted", reopen
   disabled.
8. **As-you-type search, no Enter.** While a query is active the results view
   is one combined list of PRs and sessions, each row tagged with pills, sorted
   by last activity regardless of type.
9. **Weak-match filter on**, recency sort kept.
10. **Exact identifiers are pinned** above the recency order under an
    "Exact match" divider (PR number, PR URL, `owner/repo#N`, session id).
11. **Search covers auto-generated titles and summaries** (`ai-title`,
    `summary`, `custom-title`), every distinct value, untruncated.
12. **Architecture option 1:** a separate `search.db` beside the existing
    index; moving browse onto it is follow-up #209.
13. **No PR file cap for CSM** (agent-reviewed); slice by milestone.

## 4. Scope

### In scope

- `searchWorker` and `search.db`: schema, migrations, FTS5 self-test.
- Incremental ingest with byte offsets, rewrite detection and tombstones.
- PR extraction and `gh` enrichment.
- PR chip on session rows (Sessions view).
- PR view mode.
- Query engine and as-you-type combined search UI.
- `indexEnabled` integration and a "Remove deleted sessions from search"
  action.

### Out of scope

- Azure DevOps or GitLab PRs.
- Branch-to-PR inference via `gh pr list --head` (attaches reused-branch PRs
  to the wrong session).
- Live-tail refresh of open sessions (owned by #120).
- A read-only view of a deleted transcript's conversation (#103).
- Moving browse onto `search.db` (#209); streaming the existing scanner (#210).
- Typo-tolerant or semantic search; tool output and thinking-block search.
- Settings UI for `indexEnabled` (#134).

## 5. Architecture

```
Renderer ──preload IPC──► main (relay, sender-guarded) ──postMessage──► searchWorker
                                                                         ├─ ingest (stat, read appended bytes, extract)
                                                                         ├─ gh enrichment (spawn gh, shell:false)
                                                                         ├─ queries
                                                                         └─ search.db (WAL)  in userData
```

- **`searchWorker`** is a `worker_threads` worker started after the main window
  is created. It is the only code that opens `search.db`, through one
  connection shared by ingest, enrichment and queries. Every statement runs
  synchronously on the worker thread and each ingest chunk commits in one
  synchronous transaction, so a query never runs inside an open write
  transaction; a second connection would add nothing. Main never opens the
  database. It relays requests, forwards progress events, and owns the worker
  lifecycle (start, restart with backoff, stop on quit or opt-out).
- **Change events.** After each ingest pass that committed any row change, and
  after each enrichment run that wrote rows, the worker posts `changed`. Main
  relays each one, and the worker's `ready`, to the renderer as
  `search:changed {generation}`, a counter main increments. Counting `ready`
  makes a warm start that ingests nothing still refresh the renderer.
- **Bundling.** The worker entry is bundled with esbuild into one file the same
  way the preload is (`build:worker`). That file is listed in `asarUnpack` and
  main starts it from `app.asar.unpacked`, so the packaged worker loads from a
  plain file and does not depend on asar support inside `worker_threads`.
  `node:sqlite` is a built-in.
- **Shared pure units** (no I/O, unit-tested, used by the worker):
  - `sessionParser` (existing): exports `eligiblePromptText` and a pure
    `composeTitleFrom({customTitle, aiTitle, summary, firstPrompt})`, which
    `extractTitle` also uses, so browse and search titles cannot drift. Today
    these helpers are module-private.
  - `turnExtractor`: record → conversation turns and title values.
  - `prExtractor`: records → `pr-link` refs and `gh pr create` result URLs.
  - `fileCursor`: the offset/anchor change-detection decision.
  - `tombstone`: the deletion state machine (§7.5).
  - `searchText`: folding and camel/snake splitting shared by ingest and query.
  - `parseQuery`, `quickMatch`, `mergeResults`, `highlightSegments`
    (slice 3).
- **A single `searchDb` module** wraps every SQL statement and the
  `node:sqlite` API, so a `node:sqlite` API change or a swap to
  `utilityProcess` stays contained.

Why a worker thread rather than `utilityProcess`: both run `node:sqlite`; the
worker is simpler to bundle and message. The cost is that a native SQLite crash
would take the app down with it. The `searchDb` boundary keeps a later move to
`utilityProcess` contained.

## 6. Data model

`search.db` in `app.getPath("userData")`. Every session key includes the
projects root so multiple accounts (#87) need no key migration.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 2000;
PRAGMA journal_size_limit = 67108864;

CREATE TABLE session (
  root           TEXT NOT NULL,
  sid            TEXT NOT NULL,
  cwd            TEXT,
  branch         TEXT,
  title          TEXT,          -- composeTitleFrom(custom_title, ai_title, summary_title, first_prompt)
  titles_text    TEXT,          -- all distinct custom-title/ai-title/summary values, newline-joined
  custom_title   TEXT,          -- last non-empty custom-title (last-wins)
  ai_title       TEXT,          -- first ai-title (first-wins)
  summary_title  TEXT,          -- first summary (first-wins)
  first_prompt   TEXT,          -- first eligible prompt, truncated as in sessionParser
  last_activity  INTEGER,       -- max timestamp seen (ms), never "last record's"
  path           TEXT NOT NULL,
  size           INTEGER NOT NULL DEFAULT 0,
  offset         INTEGER NOT NULL DEFAULT 0,  -- byte after the last complete line ingested
  head_len       INTEGER NOT NULL DEFAULT 0,  -- bytes covered by head_hash
  head_hash      TEXT,          -- hash of the first head_len bytes; head_len = min(offset, 4096) at the last ingest
  anchor_hash    TEXT,          -- hash of the min(offset, 256) bytes ending at offset
  pending_pr_create TEXT,       -- JSON array of unmatched gh pr create tool_use ids
  extract_version INTEGER NOT NULL DEFAULT 0,  -- EXTRACT_VERSION the rows were built with
  missing_since  INTEGER,       -- first pass time (ms) the transcript was confirmed absent
  deleted_at     INTEGER,       -- set when the transcript is confirmed gone
  PRIMARY KEY (root, sid)
);

CREATE TABLE turn (
  id          INTEGER PRIMARY KEY,
  root        TEXT NOT NULL,
  sid         TEXT NOT NULL,
  uuid        TEXT,
  role        TEXT NOT NULL,   -- 'user' | 'assistant'
  ts          INTEGER,
  text        TEXT NOT NULL,   -- original, for snippets
  search_text TEXT NOT NULL,   -- folded + identifier-split, what FTS indexes
  UNIQUE (root, sid, uuid)
);
CREATE INDEX turn_session ON turn (root, sid);

CREATE VIRTUAL TABLE fts USING fts5 (
  search_text,
  content = 'turn', content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3',
  detail = column
);

CREATE TABLE pr (
  repo        TEXT NOT NULL COLLATE NOCASE,  -- owner/repo, validated
  number      INTEGER NOT NULL,
  url         TEXT NOT NULL,   -- validated https://github.com/<repo>/pull/<n>
  title       TEXT,
  state       TEXT,            -- OPEN | MERGED | CLOSED | NULL (unfetched)
  is_draft    INTEGER,
  body        TEXT,            -- capped at 64 KB
  fetched_at  INTEGER,
  fetch_error TEXT,
  PRIMARY KEY (repo, number)
);

CREATE TABLE session_pr (
  root         TEXT NOT NULL,
  sid          TEXT NOT NULL,
  repo         TEXT NOT NULL COLLATE NOCASE,
  number       INTEGER NOT NULL,
  created_here INTEGER NOT NULL DEFAULT 0,
  first_seen   INTEGER,        -- min pr-link/gh-create timestamp in this session
  last_seen    INTEGER,        -- max pr-link timestamp in this session; NULL when the link came only from gh pr create
  PRIMARY KEY (root, sid, repo, number)
);
CREATE INDEX session_pr_pr ON session_pr (repo, number);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- e.g. fts_ok, last_full_pass
```

- **Repo case.** `repo` keeps the case first seen, which is used for display
  and as the `gh` variables. Comparisons and keys are case-insensitive because
  GitHub owner and repo names are (15.4k of 15.9k `pr-link` records carry
  uppercase).
- **FTS maintenance.** Turn inserts and deletes write the external-content FTS
  table in the same transaction (`INSERT INTO fts(rowid, search_text)` and the
  FTS5 `'delete'` command with the old values). After the cold build:
  `INSERT INTO fts(fts) VALUES('optimize')`; later `'merge'` opportunistically.
  `optimize`, `merge` and `VACUUM` run only when no query has arrived for about
  2 s, because they are synchronous on the worker thread that also serves
  queries. The pre-migration `VACUUM INTO` backup ships with the first
  migration past `user_version` 1.
- **Migrations.** `PRAGMA user_version` with forward-only migrations. A
  migration may never drop `session`, `turn` or `session_pr` rows of tombstoned
  sessions, because their source no longer exists. A tokenizer or FTS-layout
  change rebuilds `fts` from the stored `turn` rows
  (`INSERT INTO fts(fts) VALUES('rebuild')`), never from the JSONL. Before any
  migration the worker takes a file backup with
  `VACUUM INTO search.bak-<user_version>.db`, keeping only the newest
  `search.bak-*` file.
- **Extraction version.** A change to turn extraction, PR extraction or title
  composition bumps the code constant `EXTRACT_VERSION`, not `user_version`.
  Sessions built with an older version are re-ingested (§7.2).
- **Two retention rules, kept apart.** `session-index.json` stays a disposable
  cache (schema bump discards it). `search.db` is never discarded wholesale
  except by the user's opt-out (§11).

## 7. Ingestion

### 7.1 When it runs

- On worker start (app launch), after serving any cached data.
- Whenever the renderer runs the existing scan (initial load and Refresh): main
  sends the worker an ingest request as it starts the browse scan.
- Live-tail refresh of open sessions is #120's; this design does not poll
  transcripts.
- Passes are single-flight. A trigger that arrives while a pass runs sets a
  rerun flag, and exactly one more pass runs after the current one finishes.

### 7.2 One pass

1. `readdir` each project folder under the projects root and `stat` each
   top-level `*.jsonl` (subagent folders are excluded, as in the browse scan).
2. Classify each file with `fileCursor` against its `session` row:
   - **Stale:** a live file whose `extract_version` differs from the code's
     `EXTRACT_VERSION` → treated as Rewritten. Tombstoned sessions keep their
     rows; only `title` is recomposed from the stored title columns.
   - **Unchanged:** `size == offset` → skip.
   - **Appended:** `size > offset`, and the current file's first `head_len`
     bytes and its bytes ending at `offset` still hash to `head_hash` and
     `anchor_hash` → ingest bytes `[offset, size)`.
   - **Rewritten:** either hash differs, or `size < offset` → delete the
     session's turns, links and FTS rows, and re-ingest from byte 0.
   - **New:** no row → ingest from byte 0.

   After a successful ingest, `head_len`, `head_hash` and `anchor_hash` are
   recomputed against the new `offset`.
3. Queue changed files newest-mtime first. Emit progress
   `{done, total}` where `total` counts only changed files.
4. Tombstone bookkeeping for files not seen this pass (§7.5).

### 7.3 Reading one file

- Open read-only (`fs.open(path, 'r')`), read 1 MB chunks into a reused
  `Buffer`, split on byte `0x0A`, carry the partial line across chunks.
- Stop at the last complete line. `offset` advances only to the byte after the
  last `\n`; an unterminated tail is re-read next pass.
- **Pre-filter before `JSON.parse`:** if a line begins with `{"type":"<x>"`
  and `<x>` is not a contributing type (`user`, `assistant`, `pr-link`,
  `custom-title`, `ai-title`, `summary`), skip it unparsed. This covers every
  bookkeeping type, current and future. All other lines are parsed, including
  those beginning with `{"parentUuid"` (user, assistant, attachment and system
  records put a nested `"type"` first). The type is never inferred from a
  `"type":` found anywhere else in the line. Exception: a line over 256 KB that
  does not begin with a contributing type is skipped unparsed unless it
  contains `"type":"text"`, `"content":"` or `gh pr create`.
- **Line cap:** a line longer than 16 MB (the measured maximum is 7.6 MB) is
  discarded without buffering further, and the offset still advances past it.
- A complete line that fails to parse is skipped and the offset still advances.
- Yield to the event loop between chunks so query messages are served promptly.
- Close the handle as soon as the file is done.

### 7.4 What one file contributes

From `turnExtractor` and `prExtractor`:

- **Turns.**
  - `user` records whose prompt passes `sessionParser`'s existing eligibility
    rules (not `isMeta`, not a wrapper prefix, real prompt text) → one `user`
    turn.
  - `assistant` records with at least one non-empty `text` block → one
    `assistant` turn of those blocks joined. Records with only `thinking` or
    `tool_use` produce no turn. Claude Code writes one content block per
    record, so a single reply interrupted by tool calls becomes several turns.
    `thinking`, `tool_use` and `tool_result` content is excluded.
  - `search_text = searchText.fold(text)` plus identifier expansions
    (`getUserName` also yields `get user name`, `snake_case` yields
    `snake case`).
  - A turn with a `uuid` already present for that session is skipped (replayed
    records).
- **Titles:** every distinct `custom-title.customTitle`, `ai-title.aiTitle`
  and `summary.summary`, appended to `titles_text`. Each chunk also merges into
  the four title columns (`custom_title` takes the chunk's last value; the
  other three are set only while still NULL). `title` is then recomposed with
  `composeTitleFrom` from those columns, never from `titles_text`.
- **cwd and branch:** first `cwd`, last non-empty `gitBranch`, as in
  `sessionParser`.
- **last_activity:** the maximum record timestamp seen, merged with the stored
  value.
- **PRs:**
  - Each `pr-link` record → `(repo, number, url)` after validation (§8.1),
    upserted into `session_pr` with `first_seen`/`last_seen` from its
    timestamp. Duplicates collapse on the primary key.
  - A `tool_use` named `Bash` or `PowerShell` whose `input.command` string
    contains `gh pr create` (47 of the 77 such calls in the corpus run through
    PowerShell), followed by its matching `tool_result` (by `tool_use_id`) →
    the PR URL in that result, with `created_here = 1`. The URL is taken only
    from a result line that consists solely of the URL (how `gh pr create`
    prints it); grep-style output (`path:line:text`) never matches. A pairing
    sets `first_seen` (the tool_result's timestamp) and leaves `last_seen`
    unchanged.
  - `prExtractor` takes and returns the pending tool_use id list, so a
    `tool_result` in a later chunk or pass still pairs. The list is written in
    the same transaction as `offset`. An entry is consumed when its result is
    seen, and the list is capped at 20 entries, oldest dropped. A `pr-link` and
    a later pairing for the same PR, in either order, end with
    `created_here = 1` (the upsert takes the max).
  - Every new `(repo, number)` gets a `pr` row with `state = NULL` so
    enrichment picks it up.
- **Write:** all rows for the chunk batch and the new `offset`, `size`,
  `head_len`, `head_hash`, `anchor_hash`, `pending_pr_create` and
  `extract_version` in one transaction.

### 7.5 Tombstones

- Absence is judged by `sid` within the root, not by `path`. A sid found under
  a different project folder (EnterWorktree moves transcripts and writes a
  `relocated` record) updates `path` and goes through `fileCursor`; a moved
  file whose head hash matches is not re-ingested.
- A sid absent from a pass counts as absent only when its old path's stat
  error is `ENOENT` **and** its parent folder is either still readable or
  itself gone (`ENOENT`) under the readable projects root; a deleted project
  folder is a definite absence. Any other error (`EBUSY`, `EPERM`, `EACCES`,
  `EMFILE`, `EIO`, on the file or its parent) counts as present.
- The first absence sets `missing_since`. A later pass that also finds it
  absent, at least 60 s after `missing_since`, sets `deleted_at`. Rows are
  kept. (A time floor rather than a pass count, because two passes can run
  seconds apart at launch.)
- A file that reappears clears `deleted_at` and `missing_since`, then goes
  through `fileCursor` as usual (a different head hash means rewritten).
- A pass that cannot read the projects root at all records nothing.

## 8. PRs: extraction, enrichment, chip

### 8.1 Validation (untrusted input)

`prRepository` and `prUrl` come from transcript text. Before storing:

- `repo` must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
- `url` must match `^https://github\.com/<repo>/pull/<number>$` (trailing
  path segments or query strings are stripped first), and its repo and number
  must agree with the record's fields (repo compared case-insensitively).
- `number` must be a positive integer below 2^31.

Rows failing validation are dropped and counted in the worker's diagnostics.

### 8.2 `gh` enrichment

- Runs in the worker after each ingest pass and on a 10-minute timer while the
  worker runs (the timer run does enrichment only and reads no transcripts),
  for PRs that are due. `fetched_at` is the time of the last attempt, success
  or failure:
  - never attempted (`fetched_at IS NULL`);
  - `state IS NULL` (no successful fetch yet) and the last attempt older than
    10 minutes;
  - `OPEN` and `fetched_at` older than 10 minutes;
  - `CLOSED` and older than 24 hours (closed PRs can be reopened);
  - `MERGED` is final and never refetched.
- **Resolving `gh`.** Each time main starts the worker it resolves an absolute
  `ghPath` and passes it in. It searches `process.env.PATH` for `gh` (on
  Windows only `gh.exe`: `shell: false` cannot run a `.cmd` shim). On darwin,
  if that finds nothing, it tries `/opt/homebrew/bin/gh` and then
  `/usr/local/bin/gh`, because an app launched from the Dock or Finder gets
  launchd's minimal PATH. On darwin the child's `env.PATH` has the resolved
  directory prepended. If nothing resolves, every batch takes the `ENOENT`
  failure path in §8.3.
- One `gh api graphql` call per repo with up to 50 PRs per call, spawned with
  `child_process.spawn(ghPath, args, { shell: false })`. The query uses aliased
  `pullRequest(number: $nK)` fields; owner and name are passed as raw strings
  (`-f owner=… -f name=…`) and the numbers as typed integers (`-F n0=…`),
  never interpolated into the query string (`-F` would turn a numeric name
  such as `2048` into an Int). Fields: `number title state isDraft body url`.
- `body` is truncated to 64 KB before storage.
- At most 2 calls in flight; each times out after 20 s and is killed.
- Results write `title`, `state`, `is_draft`, `body`, `fetched_at`, and clear
  `fetch_error`. A batch that writes rows emits `search:changed` (§5).

### 8.3 Failure floor

- **Always parse stdout first.** `gh api` exits non-zero when any alias
  errors (a deleted or forbidden PR) but still prints the partial response. If
  stdout is JSON with a `data` object, whatever the exit code, apply every
  non-null alias and set `fetch_error = 'not-returned'` on each alias that is
  null or named in `errors[].path` (a deleted PR, or a SAML-SSO org that
  withholds data); an alias named in `errors[].path` counts as not returned
  even if `data` carries a value for it. Do not clear an existing title and do
  not back off the repo.
- **Batch failure** applies only to `ENOENT`, a timeout, or stdout that is
  missing or is not JSON with `data`: record `fetch_error` on each PR in the
  batch, back off that repo for 15 minutes, and keep the existing title/state
  if any.
- The renderer shows `#212` with no title for unfetched PRs, and the PR view
  header shows one line, "GitHub details unavailable: <reason>", when the
  latest batch for any visible repo failed.
- No prompts, no retries storm, no blocking of ingest or queries.

### 8.4 PR chip on session rows (Sessions view)

- Placed after the branch chip on the row's meta line, following the branch
  chip pattern. It shows `#212`, a text state label (open, draft, merged,
  closed; nothing while unfetched), and `+N` when more PRs are linked.
- **Primary PR:** among the session's linked PRs, the `created_here = 1` one
  with the latest `first_seen`; otherwise the one with the latest `last_seen`.
  Remaining ties break on PR number descending.
- Tooltip and accessible name list every linked PR, primary first, as
  `owner/repo#N · state · title` (missing parts omitted).
- The chip is a `tabIndex=-1` button (same pattern as the row's Open button);
  click opens the primary PR via the existing `csm.openExternal`. Keyboard:
  Shift+Enter on the row.
- **Data:** `search:prsFor(sessionIds[])`, requested for the visible window the
  same way the facts line is, cached per folder view until the next
  `search:changed`; on that event the hook drops its cached entries and
  re-requests the visible window. Ids are UUID-validated in main before relay,
  and a request carries at most 500 ids.
- The chip renders only text nodes; state colors pass the existing AA rules
  and are never the only signal.

## 9. PR view (#207)

- **Toggle.** A `Sessions | PRs` segmented control in the `FolderTree` header
  next to the declutter toggle. The last choice is remembered in settings
  (`viewMode`).
- **Tree in PR mode.** Built from `search:prFolders`, which returns every cwd
  with at least one linked PR, including cwds whose transcripts were all
  deleted. It returns `{cwd, prKeys[]}` per cwd, where a PR key is
  `repo#number` with the repo lowercased. The renderer runs one synthetic
  entry per cwd (session id = the cwd) through the same `buildTree` →
  `rollUpWorktrees` → `compactTree` pipeline, so worktree folders roll up into
  their repo folder. A folder's displayed count is the size of the union of
  the `prKeys` of every entry beneath it after roll-up, not
  `FolderNode.totalCount`, which would count a PR once per folder it was
  linked from. The declutter filter applies as it does in Sessions mode.
- **List.** Selecting a folder calls `search:folderPrs(folderPath)` and lists
  each distinct PR linked to a session in that folder or beneath it once,
  sorted by the owner's latest activity: the max, over its linked sessions
  within the folder, of `session_pr.last_seen`, or of the session's
  `last_activity` where `last_seen` is NULL; ties break on PR number
  descending. On `search:changed` the PR view re-requests `search:prFolders`
  and the open `search:folderPrs` list, keeping the tree selection and the
  list cursor by PR key. Rows are 76 px:
  - Line 1: `#212`, title (or "Title unavailable"), state pill.
  - Line 2: repo, relative last-worked time, `N sessions`.
- **Actions.**
  - **Open PR** (Enter, or its button) → `csm.openExternal(url)`.
  - **Open session** (Shift+Enter, or its button) → reopen the newest linked
    session whose transcript still exists, through the existing reopen flow
    (bypass confirmation included). Disabled with a tooltip when none exists.
  - **`+N sessions`** (Alt+Enter, or its button, shown when N > 1) → a popover
    listing each linked session: title, relative time, `transcript deleted`
    pill where set, and an Open button. Esc closes it and returns focus to the
    list.
- **States.**
  - Ingest running and no PR folders yet: the tree area shows "Indexing
    sessions… 12/40" from the same progress event as the search header.
  - Ingest finished and no PR folders: "No PRs found in your sessions".
  - A folder with no PRs beneath it is never listed, because the tree is built
    only from PR folders.
  - `indexEnabled` false: the `Sessions | PRs` toggle stays visible, the PRs
    segment is disabled with the tooltip "Turn on the search index to see
    PRs", and a persisted `viewMode` of PRs falls back to Sessions.
  - Worker error: the tree area shows the error with Retry, as the search
    empty state does.
- The list reuses the virtual listbox (`aria-activedescendant`, one tab stop),
  and the buttons inside rows are `tabIndex=-1`, as in `SessionRow`.

## 10. Search (#208)

### 10.1 Query parsing (`parseQuery`, pure)

- Input is NFKD-normalized, lowercased, and stripped of combining marks — the
  same `searchText.fold` used at ingest.
- **Exact forms**, recognized first and pinned (§10.3):
  - `#212` or a bare `212` → PR number;
  - `owner/repo#212` → one PR;
  - a pasted PR URL (`https://github.com/o/r/pull/212`, trailing `/files`,
    `/commits`, `?…`, `#…` trimmed) → one PR;
  - a session UUID → one session.

  A bare number also searches as plain text, so "404" still finds
  conversations. A bare `owner/repo` is not an exact form; it matches PRs
  through the quick tier's `repo` field and sorts by recency.
- **Terms:** split the folded input on whitespace; all terms must match (AND).
  Each term is then split into tokens with the unicode61 rule (maximal runs of
  Unicode letters and digits; every other character, `_` included, is a
  separator). Each token becomes its own double-quoted FTS operand, joined with
  `AND`. Only the final token of the last term carries `*`, and only while that
  term is still being typed (no trailing space). A final prefix token shorter
  than 2 characters is left out of the FTS MATCH for that keystroke, because
  the `prefix='2 3'` index cannot serve it (a 1-character prefix measured
  388 ms); when its term is a phrase, phrase verification still applies it as
  a prefix. If no token remains, the conversation tier is skipped for that
  keystroke. The quick tier still uses the full term. A term that produced two or
  more tokens (`rate-limit`, `sessionStore.ts`, `node:sqlite`) is an implicit
  phrase and is verified exactly as a quoted phrase is. A term that produced no
  tokens (pure punctuation) is dropped from the conversation tier but still
  applies to the quick tier.
- **Quoted phrases:** `"git worktree"` is an exact phrase. Because
  `detail=column` cannot match phrases, the FTS query is the AND of the tokens
  and the phrase is verified in JS by token adjacency: the candidate turn's
  `search_text` is tokenized with the same rule and the phrase tokens must
  appear consecutively (the last one as a prefix if it carries `*`).
- Query length is capped at 256 characters in main.

### 10.2 Tiers

All tiers run on every query and merge into one list.

1. **Exact.** PR number, `owner/repo#N`, PR URL or session id against `pr`,
   `session_pr` and `session`.
2. **Quick** (from the first character). A substring match in JS over an
   in-memory snapshot the worker keeps of these fields (PR bodies are capped
   at 64 KB each):
   - sessions: `titles_text`, `title`, `cwd`, `branch`;
   - PRs: `title`, `body`, `repo`, `#number`.

   The snapshot is refreshed after each ingest pass and enrichment batch. The
   matcher is a pure shared module, `quickMatch(terms, items)`, where items are
   `{key, kind, title, titlesText?, cwd?, branch?, prTitle?, body?, repo?,
   number?}`, used by both the worker and the renderer (§11).
3. **Conversation** (from 2 characters). FTS5 over `turn`:
   ```sql
   SELECT t.root, t.sid, t.id FROM fts JOIN turn t ON t.id = fts.rowid
   WHERE fts MATCH ?   -- '"rate" AND "limi"*': alphanumeric tokens only, always a bound parameter
   ```
   grouped by session. **Weak-match filter:** a session qualifies only if one
   of its turns contains every term (the FTS match is per turn, so this holds
   by construction); for assistant text the unit is one record's text, usually
   one paragraph run between tool calls. Phrase terms are re-verified in JS.

   **Metadata terms.** A term that a session's own quick-tier fields already
   match (`title`, `titles_text`, `cwd`, `branch`) need not appear in the turn:
   the session qualifies if one of its turns contains every remaining term.
   The worker groups quick-tier sessions by the set of terms their metadata
   leaves unmatched and, beside the full-term query, runs one FTS query per
   distinct non-empty remaining set, restricted to that group's sessions
   through a bound `json_each` list; at most 4 such sets run per keystroke,
   largest groups first. So `csm rate limit` finds a session under a `csm`
   folder whose turn mentions "rate limit". Such a row's matched-in pill is
   conversation, with `+N` for the metadata fields.

The worker checks for a newer query `seq` between tiers and abandons stale
work.

### 10.3 Merge and sort (`mergeResults`, pure)

- **One row per object:** one row per session, one row per PR. A session and
  its PR may both appear.
- **Matched-in field** (strongest wins): sessions — title (a `titles_text`
  match is labeled title), branch, folder, conversation; PRs — number, title,
  repo, description. Shown as one pill, plus `+N` when several fields matched.
- **Order:** exact-tier rows first under an "Exact match" divider, ordered by
  last activity descending; then every other row by last activity descending,
  regardless of type. A session's time is `last_activity`; a PR's is the max,
  over its linked sessions, of `session_pr.last_seen`, or of the session's
  `last_activity` where `last_seen` is NULL.
  Ties break on the row key so rows don't swap between keystrokes.
- **Cap:** 200 rows returned, plus the true total.

### 10.4 Snippets

- For conversation and description matches: about 120 characters around the
  first match in the best matching turn (the one with the most distinct
  terms), cut at word boundaries, `…` at cuts.
- For every other match (title, a `titles_text` value, branch, folder, PR
  title, repo), line 2 shows that field's own text cut around the match with
  the same ranges; for a `titles_text` match it is the matching historical
  title value, so a row whose displayed title lacks the query still shows why
  it matched. Exact-tier rows show the matched identifier.
- Computed in the worker in JS (FTS5 `snippet()` is not used). Returned as
  `{text, ranges: [start, end][]}`; no HTML ever crosses IPC.
- Ranges are found on the original `text`: it is tokenized with the unicode61
  rule, each token and its camel/snake parts (with their offsets) are folded
  with `searchText.fold` and compared with the query tokens, so ranges are
  always in original-text coordinates and no offset map from `search_text` is
  kept.
- `highlightSegments(text, ranges)` (pure) turns this into segments the
  renderer renders as `<mark>` elements with text-node children.

### 10.5 Responsiveness

- No debounce. The renderer sends `search:query {seq, q}` on every input
  change; main relays; the worker keeps at most one query running and the
  latest one pending, and drops anything older.
- The renderer discards any response whose `seq` is not the latest sent, and
  renders results through `useDeferredValue` into a memoized list.
- Budget: under 50 ms for typical queries (measured 0.1–80 ms). If grouped
  2-character prefix queries exceed 150 ms as the corpus grows, the minimum
  length for the conversation tier rises to 3; this is a constant, not a
  setting.
- On `search:changed` while a query is active, the renderer re-sends the
  current query with a new `seq`. This is not a keystroke, so the cursor stays
  held by row key (§10.6).
- **FTS5 unavailable** (startup self-test fails, `meta.fts_ok = 0`): the
  conversation tier is disabled. Turns are still ingested into `turn` so
  `rebuild` can restore FTS later. The exact and quick tiers keep working, and
  the results header shows `· conversation search unavailable`. The CI probe
  (§14) is what prevents shipping such a build.

### 10.6 Search UI

- **Input.** The disabled title-bar input becomes an APG editable combobox:
  `role="combobox"`, `aria-expanded` true while results show,
  `aria-controls`, `aria-autocomplete="list"`, and `aria-activedescendant` on
  the input. DOM focus stays in the input.
- **Keys.**
  - Ctrl+K (Cmd+K on macOS) and Ctrl/Cmd+F focus and select the input; ignored
    while any modal is open (the existing mutual-exclusion gates).
  - ArrowUp/Down move the result cursor; Ctrl+Home/End jump.
  - Session row: Enter reopens; Shift+Enter opens its primary PR.
  - PR row: Enter opens the PR; Shift+Enter reopens its newest session;
    Alt+Enter opens the `+N sessions` popover.
  - A `transcript deleted` session row: Enter shows a "This transcript was
    deleted; it can't be reopened" toast.
  - A row with no counterpart (a session with no linked PR; a PR with no
    linked session whose transcript still exists) shows its counterpart button
    disabled with the §9 tooltip, and Shift+Enter shows a toast in the same
    style ("No linked PR" / "No session with a transcript to reopen").
    Alt+Enter on a PR row with one linked session does nothing. Reopen from
    any search row goes through the existing reopen flow, bypass confirmation
    included.
  - Esc clears the query; Esc on an empty query leaves search and returns
    focus to the element focused before search. With the `+N sessions`
    popover open, Esc closes the popover first and returns focus to the input.
  - Mouse mirrors the keys: a click moves the cursor to the row, a
    double-click runs the primary action, and the row buttons (`tabIndex=-1`)
    run their own action, as in `SessionRow` and the §9 PR rows.
  - Shift+Enter consistently means "open the linked counterpart" (a
    session's PR, a PR's session).
- **"Exact match" divider** is `role="presentation"` and excluded from
  `aria-setsize`/`aria-posinset`; `<mark>` highlight colors meet the existing
  AA rules in both themes.
- **State.** Query state lives in a `useSearch` hook consumed by `TitleBar`
  and `SearchResultsPane`, not in `FolderBrowser`, so keystrokes don't
  re-render the tree or splitter.
- **Results pane.** While the query is non-empty, `SearchResultsPane` replaces
  `FolderPane`; the tree stays visible and keeps its selection. Clearing the
  query restores the previous folder view. Search is always global and never
  scoped by the tree. Selecting a tree folder, or changing `Sessions | PRs`,
  while a query is active clears the query and shows that folder's view. The
  declutter toggle does not filter search results.
- **Rows.** A generic virtual listbox extracted from `SessionList` (same
  `computeWindow`, `scrollTopToReveal`, `listKeyAction`) renders
  `SessionResultRow` and `PrResultRow`, both 76 px:
  - Line 1: type pill (`Session` / `PR`), title.
  - Line 2: matched-in pill, one-line snippet (ellipsis).
  - Line 3: folder or repo, relative time, PR state pill or
    `transcript deleted` pill.
- **Cursor rules.** While typing, the cursor stays on row 1. Once the user
  moves it, it is held by row key across updates; if that row disappears, it
  moves to the nearest surviving neighbour. A new keystroke re-pins row 1.
  Scroll position is kept unless the cursor row leaves the viewport.
- **Header** (fixed height): `N results` (or `200 of 412 — refine your
  search`), plus `· indexing 12/40 changed` while ingest runs, plus
  `· conversation search unavailable` when the FTS5 self-test failed.
- **Live region.** One `role="status"` element, present from load, announces
  settled counts about 500 ms after typing stops.
- **Empty states:** query too short for conversations ("Type 2+ characters to
  search conversations"); no results while indexing ("No results yet — still
  indexing 12/40"); no results; conversation and PR search off
  (`indexEnabled` false: "Conversation and PR search are off"); worker error,
  with Retry.

## 11. Privacy and retention

- `search.db` deliberately stores user prompts and assistant replies,
  including text whose transcript Claude Code has since deleted. This reverses
  the #116 rule that the index stores no conversation text. Anything a user
  pasted into a prompt (including secrets) is retained until purged.
- `userData` can be swept into OneDrive, iCloud or a roaming profile. CSM never
  transmits `search.db`; the only network access in this feature is `gh`,
  which sends repo names and PR numbers, never transcript text.
- **`indexEnabled = false`:** main sends the worker `shutdown`; the worker
  closes its connections and acks (main terminates it after 2 s without an
  ack). Only then does main delete `search.db`, `-wal`, `-shm`, and every
  `search.bak-*` and `search.corrupt-*` file. Unlinks failing with
  EBUSY/EPERM are retried for about 5 s; anything left is reported as a
  failed purge.
  Session-metadata search still works: `useSearch` does not call
  `search:query` and instead runs `quickMatch` in the renderer over the scanned
  `SessionMetadata[]` (composed `title`, `cwd`, `branch`; there is no
  `titles_text`). It returns session rows only. PR chips, the PR view and
  conversation search are unavailable, and the UI says so (§9, §10.6).
  Turning it back on rebuilds from the transcripts that still exist.
- **"Remove deleted sessions from search"** (Settings): deletes every row of
  tombstoned sessions and their now-orphaned PRs, then runs FTS `optimize`
  (deleted tokens otherwise stay in older FTS segments), `VACUUM` and
  `PRAGMA wal_checkpoint(TRUNCATE)`. It also deletes every `search.bak-*` and
  `search.corrupt-*` file.
- **File permissions.** On macOS and Linux the worker creates `search.db` (and
  every backup) with mode 0600 before SQLite opens it; SQLite gives
  `-wal`/`-shm` the same mode.
- **CSM's own "delete session" (Phase B)** purges that session's rows and
  queues the same `optimize`, `VACUUM` and checkpoint through idle-gated
  maintenance; until it runs, the deleted text remains in free pages, FTS
  segments and the WAL.

## 12. Failure handling

- **Worker crash or exit:** main restarts it with backoff (1 s, 5 s, 30 s, then
  stop and surface an error state). It resumes from stored offsets.
- **`SQLITE_CORRUPT` / `SQLITE_NOTADB` on open:** close the connection, then
  rename the file to
  `search.corrupt-<timestamp>.db`, create a fresh database, copy out what can
  still be read of tombstoned sessions' rows from the corrupt copy (best
  effort: tables that read cleanly are copied, the rest skipped), then
  re-ingest live transcripts. One `search.corrupt-*` file is kept and older
  ones are deleted, best effort: a locked copy stays until a later recovery
  or purge removes it.
- **Projects root unreadable:** the pass records nothing (no tombstones).
- **Second app instance:** prevented by the existing
  `requestSingleInstanceLock`; the worker also keeps WAL-mode single-writer
  discipline (one connection).
- **IPC:** every new handler checks `isTrustedSender`, validates its arguments
  (UUIDs, folder paths as strings, query length), and returns errors as codes.

## 13. Security and read-only invariants

- Transcripts are opened read-only; the worker never writes, moves or deletes
  under the projects root. A test asserts source bytes and mtimes are
  unchanged after ingest.
- `gh` is spawned with `shell:false` and an argument array; repo and numbers
  are validated (§8.1) and passed as GraphQL variables.
- Every `searchDb` statement uses bound parameters; no user text is
  concatenated into SQL. The FTS MATCH string is built only from alphanumeric
  tokens, so FTS5 operators and column filters in user input are never
  interpreted.
- PR URLs open only through `csm.openExternal`, which is https-only and
  sender-guarded; only validated `https://github.com/.../pull/N` URLs are
  stored.
- All transcript-derived text (titles, snippets, PR titles and bodies) renders
  as text nodes; highlights are ranges, never HTML.

## 14. Testing

- **Pure units** (`test/main`): `turnExtractor`; `prExtractor` (dedupe,
  validation, `gh pr create` pairing for Bash and PowerShell tools, tool_use
  and tool_result in different passes, `created_here`, a pairing leaves
  `last_seen` NULL); `fileCursor`
  (unchanged, appended, rewritten head, rewritten middle via anchor,
  truncated, new, stale `extract_version`, a file ingested below 4096 bytes
  that grows past 4096 is Appended, not Rewritten); `tombstone` (ENOENT twice
  within 60 s is not tombstoned, again after 60 s is, EBUSY, parent
  unreadable, reappear, file moved to another project folder); `searchText`
  (folding, identifier splitting); `composeTitleFrom` (matches
  `parseSession`'s title on the #176 fixtures, including a rename back to an
  earlier name split across two appends); `parseQuery` (including
  `rate-limit`, `sessionStore.ts`, `node:sqlite`, `snake_case`, a lone `"`,
  `a*b`, `col:x`, `-x`, `50%`, and a lowercased `owner/repo#N` matching a
  stored `Owner/Repo.Name`); `quickMatch`; `mergeResults` (exact pin, recency,
  tie-break, one row per object, matched-in priority, a PR's time from its own
  `last_seen` rather than its session's activity); `highlightSegments`.
- **Query engine:** a folder term plus a conversation term finds the session;
  a term matched by neither metadata nor the turn still excludes it.
- **Ingest integration** against temp-dir JSONL fixtures, each one built to
  exercise its claimed behaviour: append-then-ingest-only-tail, half-written
  final line, in-place rewrite, truncation, replayed `uuid`, backwards
  timestamps, a >1 MB line, repeated `pr-link`, bookkeeping lines skipped, an
  assistant record whose `"type":"assistant"` sits after a large `message`, and
  an unknown leading bookkeeping type.
- **SQLite integration** under vitest on Node 24 (the `.nvmrc` runtime, whose
  `node:sqlite` also compiles FTS5; the CI unit job skips the Electron binary
  download), with the Electron-runtime difference covered by the CI probe
  below: schema creation, FTS round-trip, migration preserves
  tombstoned rows, `rebuild` from `turn`, corruption recovery, opt-out deletes
  files only after the worker has closed its connections, and opt-out and
  purge delete backup and corrupt copies.
- **CI:** a step on all three OSes asserts `node:sqlite` loads and an FTS5
  table can be created under the pinned Electron.
- **`gh`:** a fake `gh` executable on `PATH` per test covering success,
  missing binary, non-zero exit, exit 1 with partial `data` plus `errors[]`
  (the good aliases are applied), timeout, partial (null) results, malformed
  JSON, and a PATH that omits `gh` while a darwin fallback location holds the
  fake binary; asserts the argument array never contains interpolated query
  text, that owner and name are passed with `-f` (raw strings), and that no
  `-F` value starts with `@` (gh reads `@file` values from disk).
- **Renderer:** PR chip (primary selection, `+N`, tooltip, text-only, a chip
  whose title appears after a `search:changed` event with no folder switch),
  PR view (toggle, list order, actions, popover, disabled open, a PR linked
  from both a main-checkout and a worktree session counted once), search
  combobox keys, cursor rules, pills, live region, empty states.
- **Local `_electron` smoke test** extended to type a query and see a result.

## 15. Delivery

| Slice | Issue | Contents |
|---|---|---|
| 1 | #206 | `searchDb`, `searchWorker`, `build:worker`, ingest (§7), PR extraction and enrichment (§8.1–8.3), PR chip (§8.4), `search:prsFor`, `indexEnabled` deletion, FTS5 CI probe, this spec and the plan |
| 2 | #207 | PR view (§9), `search:prFolders`, `search:folderPrs`, `viewMode` setting |
| 3 | #208 | Query engine (§10.1–10.5), search UI (§10.6), "Remove deleted sessions from search" |

## 16. Follow-ups

- #209 — move the browse path onto `search.db`.
- #210 — stream the existing scanner's file reads.
- #103 — read-only view of a deleted transcript's stored conversation.
- #134 — settings UI for `indexEnabled`.
- #120 — live-tail refresh, which would also keep `search.db` current for open
  sessions.
