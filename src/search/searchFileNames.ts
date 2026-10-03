export const SEARCH_DB_FILENAME = "search.db";

export const CORRUPT_COPY_RE = /^search\.corrupt-.+\.db$/;

export const SEARCH_FILE_RE = /^search\.(db|db-wal|db-shm|bak-.+|corrupt-.+)$/;

export const corruptCopyName = (now: number): string =>
  `search.corrupt-${now}.db`;
