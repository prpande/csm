import type { SessionPrsResult } from "../ipcTypes";

export interface WorkerInit {
  dbDir: string;
  projectsRoot: string;
  platform: NodeJS.Platform;
  ghPath: string | null;
}

export type HostToWorker =
  | { type: "ingest" }
  | { type: "prsFor"; id: number; sids: string[] }
  | { type: "shutdown" };

export type WorkerToHost =
  | { type: "ready"; ftsOk: boolean; recovered: boolean }
  | { type: "progress"; done: number; total: number }
  | { type: "changed" }
  | { type: "result"; id: number; ok: true; value: SessionPrsResult }
  | { type: "result"; id: number; ok: false }
  | { type: "shutdownAck" }
  | { type: "fatal"; code: "OPEN_FAILED" };
