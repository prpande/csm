import { open } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

export const CHUNK_BYTES = 1024 * 1024;
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface LineRead {
  bytes: Buffer | null;
  end: number;
}

export interface ReadOptions {
  chunkBytes?: number;
  maxLineBytes?: number;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export async function* readCompleteLines(
  path: string,
  start: number,
  opts: ReadOptions = {},
): AsyncGenerator<LineRead> {
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const maxLineBytes = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const handle = await open(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(chunkBytes);
    let carry: Buffer[] = [];
    let carryLen = 0;
    let oversized = false;
    let pos = start;
    let lineStart = start;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkBytes, pos);
      if (bytesRead === 0) return;
      const buf = chunk.subarray(0, bytesRead);
      let from = 0;
      let nl: number;
      while ((nl = buf.indexOf(0x0a, from)) !== -1) {
        const end = pos + nl + 1;
        const piece = buf.subarray(from, nl);
        if (oversized || carryLen + piece.length > maxLineBytes) {
          yield { bytes: null, end };
        } else {
          let line = carryLen === 0 ? piece : Buffer.concat([...carry, piece]);
          if (lineStart === 0 && line.subarray(0, 3).equals(BOM))
            line = line.subarray(3);
          yield { bytes: line, end };
        }
        carry = [];
        carryLen = 0;
        oversized = false;
        lineStart = end;
        from = nl + 1;
      }
      const rest = buf.subarray(from);
      if (!oversized && rest.length > 0) {
        if (carryLen + rest.length > maxLineBytes) {
          oversized = true;
          carry = [];
          carryLen = 0;
        } else {
          // Copy: `chunk` is reused by the next read.
          carry.push(Buffer.from(rest));
          carryLen += rest.length;
        }
      }
      pos += bytesRead;
      await yieldToEventLoop();
    }
  } finally {
    await handle.close();
  }
}
