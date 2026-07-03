// The main-process IPC bridge (spec §5 `ipc` module): registers the ipcMain
// handlers that fan the shipped units — sessionStore scan, reopenSession,
// settingsStore — out to the sandboxed renderer through the narrow `csm` preload
// surface. Every effectful dependency is INJECTED (matching the factory-DI
// convention of sessionStore / reopenSession / settingsStore) so the handlers are
// unit-testable with a fake ipcMain + fake events, no Electron runtime.
//
// Two invariants run through every handler:
//  - Sender guard: only the main window's webContents may call (defense in depth,
//    mirroring main.ts's shell:open-external guard).
//  - No message leak: a reopen error crosses IPC only as its stable `code`, never
//    error.message (which may embed an untrusted cwd/claudePath).

import type { ScanOptions, GroupedSessions } from "./sessionStore";
import type { ReopenRequest } from "./reopenSession";
import type { LaunchOS } from "./terminalLauncher";
import type {
  ReopenErrorCode,
  ReopenResult,
  ReopenRequestDto,
} from "./ipcTypes";
import { REOPEN_ERROR_CODES } from "./ipcTypes";
import { DEFAULT_CLAUDE_PATH } from "./settingsStore";
import { CH } from "./ipcChannels";

/** The minimal renderer target the streaming scan pushes to (WebContents.send). */
interface RendererTarget {
  send(channel: string, payload: unknown): void;
}
interface IpcEventLike {
  sender: RendererTarget;
}
type IpcListener = (event: IpcEventLike, ...args: unknown[]) => unknown;

export interface IpcHandlerDeps {
  ipcMain: { handle(channel: string, listener: IpcListener): void };
  /** True only for the main window's webContents. Receives `event.sender`. */
  isTrustedSender: (sender: unknown) => boolean;
  createSessionStore: (rootDir: string) => {
    scan(opts: ScanOptions): Promise<GroupedSessions>;
  };
  settingsStore: {
    getClaudePath(): Promise<string>;
    setClaudePath(value: string): Promise<void>;
  };
  reopen: (req: ReopenRequest) => Promise<void>;
  projectsRoot: string;
  platform: NodeJS.Platform;
  now: () => number;
}

// Map a thrown reopen error to its stable code; an unexpected (non-typed) throw
// is bucketed as SPAWN_FAILED. error.message is deliberately never read.
function reopenCodeOf(err: unknown): ReopenErrorCode {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" &&
    (REOPEN_ERROR_CODES as readonly string[]).includes(code)
    ? (code as ReopenErrorCode)
    : "SPAWN_FAILED";
}

export function registerIpcHandlers(deps: IpcHandlerDeps): void {
  const {
    ipcMain,
    isTrustedSender,
    createSessionStore,
    settingsStore,
    reopen,
    projectsRoot,
    platform,
    now,
  } = deps;

  // listSessions: streaming scan. The renderer mints scanId; we push a batch per
  // non-empty tier then a single done. scan is fail-soft (a missing projects root
  // resolves to empty folders), so an empty scan yields done-with-no-batch; error
  // is reserved for an unexpected throw.
  ipcMain.handle(CH.sessionsScan, async (event, scanId) => {
    if (!isTrustedSender(event.sender) || typeof scanId !== "string") return;
    const { sender } = event;
    try {
      const store = createSessionStore(projectsRoot);
      await store.scan({
        now: now(),
        onBatch: (sessions) =>
          sender.send(CH.sessionsBatch, { scanId, sessions }),
      });
      sender.send(CH.sessionsDone, { scanId });
    } catch {
      sender.send(CH.sessionsError, { scanId });
    }
  });

  // reopen: os is process.platform passed through unchanged (reopenSession itself
  // raises UNSUPPORTED_OS for a non win32/darwin host); claudePath comes from
  // settingsStore; mode/permissionMode is passed through untouched.
  ipcMain.handle(
    CH.sessionReopen,
    async (event, req): Promise<ReopenResult> => {
      if (!isTrustedSender(event.sender))
        return { ok: false, code: "SPAWN_FAILED" };
      const { cwd, sessionId, mode } = req as ReopenRequestDto;
      const claudePath = await settingsStore.getClaudePath();
      try {
        await reopen({
          os: platform as LaunchOS,
          cwd,
          sessionId,
          mode,
          claudePath,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, code: reopenCodeOf(err) };
      }
    },
  );

  // settings: an untrusted frame gets the benign default (get) / a no-op (set) —
  // only the main window's preload can legitimately reach these.
  ipcMain.handle(CH.settingsGet, async (event) => {
    if (!isTrustedSender(event.sender)) return DEFAULT_CLAUDE_PATH;
    return settingsStore.getClaudePath();
  });

  ipcMain.handle(CH.settingsSet, async (event, value) => {
    if (!isTrustedSender(event.sender) || typeof value !== "string") return;
    await settingsStore.setClaudePath(value);
  });
}
