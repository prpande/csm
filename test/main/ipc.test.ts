import { describe, test, expect, vi } from "vitest";
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
  vi.fn(() => ({ scan: vi.fn(scan), getFacts: vi.fn(async () => ({})) }));

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
  const newSession = vi.fn(async () => {});
  const openTerminal = vi.fn(async () => {});
  const pickFolder = vi.fn(async () => ({
    canceled: false as const,
    path: "C:\\picked",
  }));
  const setNativeTheme = vi.fn();
  const tempRoots = vi.fn(() => ["C:\\Users\\p\\AppData\\Local\\Temp"]);
  const logError = vi.fn();
  const deps: IpcHandlerDeps = {
    ipcMain,
    isTrustedSender: (s: unknown) => s === trusted,
    createSessionStore,
    settingsStore,
    reopen,
    newSession,
    openTerminal,
    pickFolder,
    setNativeTheme,
    tempRoots,
    logError,
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
    newSession,
    openTerminal,
    pickFolder,
    setNativeTheme,
    tempRoots,
    logError,
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

// ---- #83 observability: a scan failure must not be silent in main ------------

test("a scan that throws logs the real error in the main process (#83)", async () => {
  // The #81 regression was invisible in the launcher log because this catch
  // discarded `err`. The thrown error itself — not a stringified stand-in —
  // must reach the injected sink, so a stack trace survives to the log.
  const boom = new Error("disk gone");
  const scan: ScanImpl = async () => {
    throw boom;
  };
  const { call, logError } = setup({
    createSessionStore: makeCreateStore(scan),
  });
  await call(CH.sessionsScan, "scan-log");

  expect(logError).toHaveBeenCalledTimes(1);
  expect(logError).toHaveBeenCalledWith("sessions:scan", boom);
});

test("a scan that throws still leaks no error message to the renderer (#83)", async () => {
  // Guards the no-message-leak invariant against the new logging path: the
  // detail goes to the main-process log, NEVER over IPC. A scan error can embed
  // an untrusted cwd, so the renderer payload stays scanId-only.
  const scan: ScanImpl = async () => {
    throw new Error("C:\\secret\\path exploded");
  };
  const { call, sent } = setup({ createSessionStore: makeCreateStore(scan) });
  await call(CH.sessionsScan, "scan-leak");

  expect(sent).toEqual([
    { channel: CH.sessionsError, payload: { scanId: "scan-leak" } },
  ]);
  expect(JSON.stringify(sent)).not.toContain("secret");
});

test("a successful scan logs nothing (#83)", async () => {
  const { call, logError } = setup();
  await call(CH.sessionsScan, "scan-ok");
  expect(logError).not.toHaveBeenCalled();
});

test("sessions:scan from an untrusted sender runs no scan and sends nothing", async () => {
  const scanSpy = vi.fn(emptyScan);
  const createSessionStore = vi.fn(() => ({
    scan: scanSpy,
    getFacts: vi.fn(async () => ({})),
  }));
  const { handlers } = setup({ createSessionStore });
  const other = fakeSender();
  await handlers.get(CH.sessionsScan)!({ sender: other.sender }, "scan-x");
  // store is created once at registration (hoisted); the scan itself must not run
  expect(scanSpy).not.toHaveBeenCalled();
  expect(other.sent).toEqual([]);
});

test("sessions:scan resolves projectsRoot and injects now() into the scan", async () => {
  const scanSpy = vi.fn(emptyScan);
  const createSessionStore = vi.fn(() => ({
    scan: scanSpy,
    getFacts: vi.fn(async () => ({})),
  }));
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
  const scanSpy = vi.fn(emptyScan);
  const createSessionStore = vi.fn(() => ({
    scan: scanSpy,
    getFacts: vi.fn(async () => ({})),
  }));
  const { call, sent } = setup({ createSessionStore });
  await call(CH.sessionsScan, 42);
  // store is created once at registration (hoisted); the scan itself must not run
  expect(scanSpy).not.toHaveBeenCalled();
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

test("a reopen that throws logs the real error in the main process (#147)", async () => {
  // The mirror of the scan sink above. SPAWN_FAILED is also the catch-all bucket
  // for an unexpected throw, so it is exactly the case where a maintainer needs
  // the cause — and the code alone cannot carry it. The thrown error itself, not
  // a stringified stand-in, must reach the sink so the stack survives.
  const boom = new Error("spawn ENOENT C:\\bad\\claude.exe");
  const { call, logError } = setup({
    reopen: vi.fn(async () => {
      throw boom;
    }),
  });
  await call(CH.sessionReopen, REQ);

  expect(logError).toHaveBeenCalledTimes(1);
  expect(logError).toHaveBeenCalledWith("session:reopen", boom);
});

test("a typed reopen error is logged too — the code alone loses the cause", async () => {
  // A typed error already carries a precise code across IPC, but its own detail
  // (SpawnFailedError's wrapped cause) still only exists in the main process.
  const cause = new Error("EACCES");
  const err = new SpawnFailedError(cause);
  const { call, logError } = setup({
    reopen: vi.fn(async () => {
      throw err;
    }),
  });
  await call(CH.sessionReopen, REQ);

  expect(logError).toHaveBeenCalledWith("session:reopen", err);
});

test("the logged reopen error never leaks into the ReopenResult (#147)", async () => {
  // The invariant #147 must not break: `err` goes to the main-process log ONLY.
  // cwd and claudePath are untrusted and must never cross IPC — so the result
  // must stay code-only even though the same error was just logged in full.
  const secret = new Error("failed at C:\\Users\\me\\secret-project");
  const { call, logError } = setup({
    reopen: vi.fn(async () => {
      throw secret;
    }),
  });
  const result = await call(CH.sessionReopen, REQ);

  expect(result).toEqual({ ok: false, code: "SPAWN_FAILED" });
  expect(JSON.stringify(result)).not.toContain("secret-project");
  // The detail exists — it just went to the log, not to the renderer.
  expect(logError).toHaveBeenCalledWith("session:reopen", secret);
});

test("a successful reopen logs nothing", async () => {
  const { call, logError } = setup();
  await expect(call(CH.sessionReopen, REQ)).resolves.toEqual({ ok: true });
  expect(logError).not.toHaveBeenCalled();
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

test("paths:getTempRoots returns the resolved roots when trusted, [] when not", async () => {
  const { handlers, call, tempRoots } = setup();
  expect(await call(CH.tempRoots)).toEqual([
    "C:\\Users\\p\\AppData\\Local\\Temp",
  ]);
  expect(tempRoots).toHaveBeenCalledTimes(1);

  tempRoots.mockClear();
  const other = fakeSender();
  expect(await handlers.get(CH.tempRoots)!({ sender: other.sender })).toEqual(
    [],
  );
  expect(tempRoots).not.toHaveBeenCalled();
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

// ---- session:getFacts --------------------------------------------------------

describe("session:getFacts handler", () => {
  test("delegates valid ids to store.getFacts for a trusted sender", async () => {
    const getFacts = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { error: true as const }])),
    );
    const createSessionStore = vi.fn(() => ({
      scan: vi.fn(emptyScan),
      getFacts,
    }));
    const { handlers, trusted } = setup({ createSessionStore });
    const res = await handlers.get(CH.sessionGetFacts)!({ sender: trusted }, [
      "a",
      5,
      "b",
    ]);
    expect(getFacts).toHaveBeenCalledWith(["a", "b"]); // non-strings filtered out
    expect(res).toEqual({ a: { error: true }, b: { error: true } });
  });

  test("returns {} for an untrusted sender without calling the store", async () => {
    const getFacts = vi.fn();
    const createSessionStore = vi.fn(() => ({
      scan: vi.fn(emptyScan),
      getFacts,
    }));
    const { handlers } = setup({ createSessionStore });
    const other = fakeSender();
    expect(
      await handlers.get(CH.sessionGetFacts)!({ sender: other.sender }, ["a"]),
    ).toEqual({});
    expect(getFacts).not.toHaveBeenCalled();
  });

  test("returns {} when args is not an array", async () => {
    const { handlers, trusted } = setup();
    expect(
      await handlers.get(CH.sessionGetFacts)!({ sender: trusted }, "nope"),
    ).toEqual({});
  });
});

// ---- new-session launcher (#165): session:new / terminal:openHere / pickFolder

describe("session:new handler", () => {
  const DTO = { cwd: "C:\\work\\proj", mode: "plan", rawArgs: "--model opus" };

  test("success composes the request from platform + settingsStore", async () => {
    const { call, newSession, settingsStore } = setup();
    const result = await call(CH.sessionNew, DTO);
    expect(result).toEqual({ ok: true });
    expect(settingsStore.getClaudePath).toHaveBeenCalled();
    expect(newSession).toHaveBeenCalledWith({
      os: "win32",
      cwd: DTO.cwd,
      mode: DTO.mode,
      rawArgs: DTO.rawArgs,
      claudePath: "claude-configured",
    });
  });

  test("a non-string rawArgs degrades to empty, not a crash", async () => {
    const { call, newSession } = setup();
    await call(CH.sessionNew, { cwd: "C:\\w", mode: "default", rawArgs: 42 });
    expect(newSession).toHaveBeenCalledWith(
      expect.objectContaining({ rawArgs: "" }),
    );
  });

  test("INVALID_ARGS surfaces code AND display-safe detail, nothing else", async () => {
    const err = Object.assign(new Error("invalid arguments: bad&token"), {
      code: "INVALID_ARGS",
      detail: "argument contains a cmd.exe metacharacter: bad&token",
    });
    const { call, logError } = setup({
      newSession: vi.fn(async () => {
        throw err;
      }),
    });
    const result = await call(CH.sessionNew, DTO);
    expect(result).toEqual({
      ok: false,
      code: "INVALID_ARGS",
      detail: "argument contains a cmd.exe metacharacter: bad&token",
    });
    expect(logError).toHaveBeenCalledWith("session:new", err);
  });

  test("typed launch errors map to bare codes with no detail or message", async () => {
    const { call } = setup({
      newSession: vi.fn(async () => {
        throw new FolderMissingError("C:\\gone\\secret");
      }),
    });
    const result = await call(CH.sessionNew, DTO);
    expect(result).toEqual({ ok: false, code: "FOLDER_MISSING" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("an unexpected throw buckets to SPAWN_FAILED", async () => {
    const { call } = setup({
      newSession: vi.fn(async () => {
        throw new Error("surprise");
      }),
    });
    expect(await call(CH.sessionNew, DTO)).toEqual({
      ok: false,
      code: "SPAWN_FAILED",
    });
  });

  test("an untrusted sender gets a failure and no launch", async () => {
    const { handlers, newSession } = setup();
    const other = fakeSender();
    expect(
      await handlers.get(CH.sessionNew)!({ sender: other.sender }, DTO),
    ).toEqual({ ok: false, code: "SPAWN_FAILED" });
    expect(newSession).not.toHaveBeenCalled();
  });
});

describe("terminal:openHere handler", () => {
  test("success passes platform + cwd through", async () => {
    const { call, openTerminal } = setup();
    expect(await call(CH.terminalOpenHere, "C:\\work\\proj")).toEqual({
      ok: true,
    });
    expect(openTerminal).toHaveBeenCalledWith({
      os: "win32",
      cwd: "C:\\work\\proj",
    });
  });

  test("a typed error maps to its code; an untrusted sender launches nothing", async () => {
    const { call } = setup({
      openTerminal: vi.fn(async () => {
        throw new FolderMissingError("C:\\gone");
      }),
    });
    expect(await call(CH.terminalOpenHere, "C:\\gone")).toEqual({
      ok: false,
      code: "FOLDER_MISSING",
    });

    const { handlers, openTerminal } = setup();
    const other = fakeSender();
    expect(
      await handlers.get(CH.terminalOpenHere)!({ sender: other.sender }, "C:"),
    ).toEqual({ ok: false, code: "SPAWN_FAILED" });
    expect(openTerminal).not.toHaveBeenCalled();
  });
});

describe("dialog:pickFolder handler", () => {
  test("returns the injected picker's result for a trusted sender", async () => {
    const { call } = setup();
    expect(await call(CH.dialogPickFolder)).toEqual({
      canceled: false,
      path: "C:\\picked",
    });
  });

  test("a picker throw degrades to canceled and is logged", async () => {
    const boom = new Error("dialog broke");
    const { call, logError } = setup({
      pickFolder: vi.fn(async () => {
        throw boom;
      }),
    });
    expect(await call(CH.dialogPickFolder)).toEqual({ canceled: true });
    expect(logError).toHaveBeenCalledWith("dialog:pickFolder", boom);
  });

  test("an untrusted sender gets canceled and no OS dialog", async () => {
    const { handlers, pickFolder } = setup();
    const other = fakeSender();
    expect(
      await handlers.get(CH.dialogPickFolder)!({ sender: other.sender }),
    ).toEqual({ canceled: true });
    expect(pickFolder).not.toHaveBeenCalled();
  });
});
