import { test, expect, vi } from "vitest";
import { registerIpcHandlers, type IpcHandlerDeps } from "../../src/ipc";
import { CH } from "../../src/ipcChannels";
import {
  UnsupportedOsError,
  FolderMissingError,
  UnsafePathError,
  SpawnFailedError,
} from "../../src/reopenSession";
import type { ScanOptions, GroupedSessions } from "../../src/sessionStore";

// ipc.ts is the main-process bridge: it registers ipcMain handlers that fan the
// shipped units (sessionStore scan, reopenSession, settingsStore) out to the
// sandboxed renderer. Every effectful dep is injected, so the handlers are
// exercised here with a fake ipcMain (records handlers) + fake events
// ({ sender: { send } }) — no Electron runtime, no real fs/spawn.

interface FakeSender {
  send(channel: string, payload: unknown): void;
}
type Handler = (event: { sender: FakeSender }, ...args: unknown[]) => unknown;

function fakeIpc() {
  const handlers = new Map<string, Handler>();
  return {
    ipcMain: { handle: (ch: string, fn: Handler) => void handlers.set(ch, fn) },
    handlers,
  };
}

interface Sent {
  channel: string;
  payload: unknown;
}
function fakeSender() {
  const sent: Sent[] = [];
  return {
    sender: {
      send: (channel: string, payload: unknown) =>
        void sent.push({ channel, payload }),
    },
    sent,
  };
}

type ScanImpl = (opts: ScanOptions) => Promise<GroupedSessions>;
const emptyScan: ScanImpl = async () => ({ folders: [] });
// Zero-arg impl is assignable to the (rootDir) => … dep type; vi.fn still records
// the actual call args, so `toHaveBeenCalledWith(projectsRoot)` holds.
const makeCreateStore = (scan: ScanImpl) =>
  vi.fn(() => ({ scan: vi.fn(scan) }));

function setup(overrides: Partial<IpcHandlerDeps> = {}) {
  const { ipcMain, handlers } = fakeIpc();
  const { sender: trusted, sent } = fakeSender();
  const createSessionStore = makeCreateStore(emptyScan);
  const settingsStore = {
    getClaudePath: vi.fn(async () => "claude-configured"),
    setClaudePath: vi.fn(async () => {}),
    getTheme: vi.fn(async () => "dark" as const),
    setTheme: vi.fn(async () => {}),
  };
  const reopen = vi.fn(async () => {});
  const setNativeTheme = vi.fn();
  const deps: IpcHandlerDeps = {
    ipcMain,
    isTrustedSender: (s: unknown) => s === trusted,
    createSessionStore,
    settingsStore,
    reopen,
    setNativeTheme,
    projectsRoot: "/root/projects",
    platform: "win32",
    now: () => 1234,
    ...overrides,
  };
  registerIpcHandlers(deps);
  const call = (ch: string, ...args: unknown[]) =>
    handlers.get(ch)!({ sender: trusted }, ...args);
  return {
    handlers,
    trusted,
    sent,
    createSessionStore,
    settingsStore,
    reopen,
    setNativeTheme,
    call,
  };
}

const REQ = {
  cwd: "C:\\work\\proj",
  sessionId: "3b9f1c2a-1e2d-4a5b-8c7d-0f1e2d3c4b5a",
  mode: "default",
};

// ---- listSessions (sessions:scan) --------------------------------------------

test("sessions:scan streams a batch per onBatch then a done, all tagged with scanId", async () => {
  const scan: ScanImpl = async (opts) => {
    opts.onBatch?.([{ sessionId: "a" } as never]);
    opts.onBatch?.([{ sessionId: "b" } as never]);
    return { folders: [] };
  };
  const { call, sent } = setup({ createSessionStore: makeCreateStore(scan) });
  await call(CH.sessionsScan, "scan-1");
  expect(sent).toEqual([
    {
      channel: CH.sessionsBatch,
      payload: { scanId: "scan-1", sessions: [{ sessionId: "a" }] },
    },
    {
      channel: CH.sessionsBatch,
      payload: { scanId: "scan-1", sessions: [{ sessionId: "b" }] },
    },
    { channel: CH.sessionsDone, payload: { scanId: "scan-1" } },
  ]);
});

test("an empty scan sends done with no batch", async () => {
  const { call, sent } = setup();
  await call(CH.sessionsScan, "scan-2");
  expect(sent).toEqual([
    { channel: CH.sessionsDone, payload: { scanId: "scan-2" } },
  ]);
});

test("a scan that throws sends error, not done", async () => {
  const scan: ScanImpl = async () => {
    throw new Error("disk gone");
  };
  const { call, sent } = setup({ createSessionStore: makeCreateStore(scan) });
  await call(CH.sessionsScan, "scan-3");
  expect(sent).toEqual([
    { channel: CH.sessionsError, payload: { scanId: "scan-3" } },
  ]);
});

test("sessions:scan from an untrusted sender runs no scan and sends nothing", async () => {
  const createSessionStore = makeCreateStore(emptyScan);
  const { handlers } = setup({ createSessionStore });
  const other = fakeSender();
  await handlers.get(CH.sessionsScan)!({ sender: other.sender }, "scan-x");
  expect(createSessionStore).not.toHaveBeenCalled();
  expect(other.sent).toEqual([]);
});

test("sessions:scan resolves projectsRoot and injects now() into the scan", async () => {
  const scanSpy = vi.fn(emptyScan);
  const createSessionStore = vi.fn(() => ({ scan: scanSpy }));
  const { call } = setup({
    createSessionStore,
    projectsRoot: "/root/projects",
    now: () => 999,
  });
  await call(CH.sessionsScan, "scan-4");
  expect(createSessionStore).toHaveBeenCalledWith("/root/projects");
  expect(scanSpy.mock.calls[0][0]).toMatchObject({ now: 999 });
});

test("sessions:scan ignores a non-string scanId", async () => {
  const createSessionStore = makeCreateStore(emptyScan);
  const { call, sent } = setup({ createSessionStore });
  await call(CH.sessionsScan, 42);
  expect(createSessionStore).not.toHaveBeenCalled();
  expect(sent).toEqual([]);
});

// ---- reopenSession (session:reopen) ------------------------------------------

test("session:reopen success returns { ok: true } and composes the request", async () => {
  const { call, reopen, settingsStore } = setup();
  const result = await call(CH.sessionReopen, REQ);
  expect(result).toEqual({ ok: true });
  expect(settingsStore.getClaudePath).toHaveBeenCalled();
  expect(reopen).toHaveBeenCalledWith({
    os: "win32",
    cwd: REQ.cwd,
    sessionId: REQ.sessionId,
    mode: REQ.mode,
    claudePath: "claude-configured",
  });
});

test("each typed reopen error maps to { ok: false, code } with no message leak", async () => {
  const cases: Array<[Error, string]> = [
    [new UnsupportedOsError("linux"), "UNSUPPORTED_OS"],
    [new FolderMissingError("C:\\gone"), "FOLDER_MISSING"],
    [new UnsafePathError("bad claudePath: C:\\a&b"), "UNSAFE_PATH"],
    [new SpawnFailedError(new Error("ENOENT")), "SPAWN_FAILED"],
  ];
  for (const [err, code] of cases) {
    const { call } = setup({
      reopen: vi.fn(async () => {
        throw err;
      }),
    });
    const result = await call(CH.sessionReopen, REQ);
    expect(result).toEqual({ ok: false, code });
    expect(result).not.toHaveProperty("message");
  }
});

test("an unexpected (untyped) reopen throw falls back to SPAWN_FAILED", async () => {
  const { call } = setup({
    reopen: vi.fn(async () => {
      throw new Error("kaboom C:\\secret\\path");
    }),
  });
  const result = await call(CH.sessionReopen, REQ);
  expect(result).toEqual({ ok: false, code: "SPAWN_FAILED" });
});

test("session:reopen resolves (never rejects) on a malformed req from a trusted sender", async () => {
  // A null/undefined req throws at destructuring (inside the guard-scoped try);
  // the handler must map that to a ReopenResult, not reject the invoke — the
  // renderer relies on reopenSession always resolving.
  const { call, reopen } = setup();
  for (const bad of [null, undefined]) {
    await expect(call(CH.sessionReopen, bad)).resolves.toEqual({
      ok: false,
      code: "SPAWN_FAILED",
    });
  }
  expect(reopen).not.toHaveBeenCalled();
});

test("session:reopen from an untrusted sender never calls reopen", async () => {
  const reopen = vi.fn(async () => {});
  const { handlers } = setup({ reopen });
  const other = fakeSender();
  const result = await handlers.get(CH.sessionReopen)!(
    { sender: other.sender },
    REQ,
  );
  expect(reopen).not.toHaveBeenCalled();
  expect(result).toMatchObject({ ok: false });
});

// ---- settings ----------------------------------------------------------------

test("settings:getClaudePath returns the store value when trusted, default when not", async () => {
  const { handlers, call, settingsStore } = setup();
  expect(await call(CH.settingsGet)).toBe("claude-configured");

  settingsStore.getClaudePath.mockClear();
  const other = fakeSender();
  expect(await handlers.get(CH.settingsGet)!({ sender: other.sender })).toBe(
    "claude",
  );
  expect(settingsStore.getClaudePath).not.toHaveBeenCalled();
});

test("settings:setClaudePath delegates when trusted, no-ops for untrusted or non-string", async () => {
  const { handlers, call, settingsStore } = setup();
  await call(CH.settingsSet, "/opt/claude");
  expect(settingsStore.setClaudePath).toHaveBeenCalledWith("/opt/claude");

  settingsStore.setClaudePath.mockClear();
  const other = fakeSender();
  await handlers.get(CH.settingsSet)!({ sender: other.sender }, "/evil/claude");
  await call(CH.settingsSet, 42);
  expect(settingsStore.setClaudePath).not.toHaveBeenCalled();
});

// ---- theme -------------------------------------------------------------------

test("settings:getTheme returns the store value when trusted, default 'system' when not", async () => {
  const { handlers, call, settingsStore } = setup();
  expect(await call(CH.themeGet)).toBe("dark");

  settingsStore.getTheme.mockClear();
  const other = fakeSender();
  expect(await handlers.get(CH.themeGet)!({ sender: other.sender })).toBe(
    "system",
  );
  expect(settingsStore.getTheme).not.toHaveBeenCalled();
});

test("settings:setTheme persists and applies nativeTheme for each allowed mode", async () => {
  const { call, settingsStore, setNativeTheme } = setup();
  for (const mode of ["light", "dark", "system"] as const) {
    await call(CH.themeSet, mode);
    expect(settingsStore.setTheme).toHaveBeenCalledWith(mode);
    expect(setNativeTheme).toHaveBeenCalledWith(mode);
  }
});

test("settings:setTheme drops an out-of-allowlist or non-string value (no disk / no nativeTheme write)", async () => {
  const { call, settingsStore, setNativeTheme } = setup();
  for (const bad of ["solarized", "Dark", 1, null, undefined, {}]) {
    await call(CH.themeSet, bad);
  }
  expect(settingsStore.setTheme).not.toHaveBeenCalled();
  expect(setNativeTheme).not.toHaveBeenCalled();
});

test("settings:setTheme from an untrusted sender never persists or applies", async () => {
  const { handlers, settingsStore, setNativeTheme } = setup();
  const other = fakeSender();
  await handlers.get(CH.themeSet)!({ sender: other.sender }, "dark");
  expect(settingsStore.setTheme).not.toHaveBeenCalled();
  expect(setNativeTheme).not.toHaveBeenCalled();
});
