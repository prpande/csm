import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

// Case-sensitive: Claude always writes lowercase `.jsonl`; anything else is not
// one of its transcripts.
export const JSONL_EXT = ".jsonl";

export interface TranscriptFile {
  sid: string;
  path: string;
  size: number;
  mtimeMs: number;
}

export interface TranscriptListing {
  rootReadable: boolean;
  files: TranscriptFile[];
}

export async function listTranscripts(
  root: string,
): Promise<TranscriptListing> {
  let folders: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    folders = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { rootReadable: false, files: [] };
  }
  const files: TranscriptFile[] = [];
  for (const folder of folders) {
    const dir = join(root, folder);
    let names: string[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
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
        files.push({
          sid: basename(name, JSONL_EXT),
          path,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // Removed between readdir and stat.
      }
    }
  }
  return { rootReadable: true, files };
}

export function newestPerSession(
  files: readonly TranscriptFile[],
): Map<string, TranscriptFile> {
  const out = new Map<string, TranscriptFile>();
  for (const f of files) {
    const prev = out.get(f.sid);
    if (!prev || f.mtimeMs > prev.mtimeMs) out.set(f.sid, f);
  }
  return out;
}
