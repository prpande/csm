import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionScan } from "../../src/renderer/hooks/useSessionScan";
import type { SessionsListener } from "../../src/ipcTypes";
import type { SessionMetadata } from "../../src/sessionParser";
import type { CsmBridge } from "../../src/renderer/types/csm";

// The hook is thin plumbing over the #59 streaming bridge (the tree logic is
// tested purely in test/main/sessionTree.test.ts). Here a fake bridge captures
// the listener so a test can drive onBatch/onDone/onError and assert on the
// hook's returned { tree, status, refresh } — no jest-dom matchers, so these
// assertions hold regardless of the local jest-dom-matcher artifact.

const session = (id: string, cwd: string): SessionMetadata => ({
  sessionId: id,
  cwd,
  title: id,
  permissionMode: "default",
  lastActivity: null,
  gitBranch: null,
});

function fakeBridge() {
  const unsubscribe = vi.fn();
  let listener: SessionsListener | undefined;
  const listSessions = vi.fn((l: SessionsListener) => {
    listener = l;
    return unsubscribe;
  });
  const bridge = {
    isDesktop: true,
    platform: "win32",
    openExternal: vi.fn(async () => true),
    listSessions,
    reopenSession: vi.fn(async () => ({ ok: true as const })),
    getClaudePath: vi.fn(async () => "claude"),
    setClaudePath: vi.fn(async () => {}),
    getTempRoots: vi.fn(async () => []),
    getFacts: vi.fn(async () => ({})),
  } satisfies CsmBridge;
  return {
    bridge,
    unsubscribe,
    listSessions,
    emit: (): SessionsListener => {
      if (!listener) throw new Error("listSessions was not called");
      return listener;
    },
  };
}

describe("useSessionScan", () => {
  it("subscribes on mount, accumulates a batch into the tree, and completes on done", () => {
    const { bridge, listSessions, emit } = fakeBridge();
    const { result } = renderHook(() => useSessionScan(bridge));

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("scanning");

    act(() => emit().onBatch([session("a", "D:\\src\\csm")]));
    // The hook composes buildTree with the #77 compactTree, so the single
    // unbroken chain collapses to one root labelled with the full path.
    expect(result.current.tree.roots[0].name).toBe("D:\\src\\csm");
    expect(result.current.tree.roots[0].totalCount).toBe(1);

    act(() => emit().onDone());
    expect(result.current.status).toBe("done");
  });

  it("treats an empty scan as done with an empty tree", () => {
    const { bridge, emit } = fakeBridge();
    const { result } = renderHook(() => useSessionScan(bridge));

    act(() => emit().onDone());
    expect(result.current.status).toBe("done");
    expect(result.current.tree).toEqual({ roots: [], unknown: null });
  });

  it("surfaces a scan error as status 'error'", () => {
    const { bridge, emit } = fakeBridge();
    const { result } = renderHook(() => useSessionScan(bridge));

    act(() => emit().onError());
    expect(result.current.status).toBe("error");
  });

  it("unsubscribes on unmount", () => {
    const { bridge, unsubscribe } = fakeBridge();
    const { unmount } = renderHook(() => useSessionScan(bridge));

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("refresh() tears down the prior scan and starts a new one", () => {
    const { bridge, unsubscribe, listSessions } = fakeBridge();
    const { result } = renderHook(() => useSessionScan(bridge));

    act(() => result.current.refresh());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("scanning");
  });

  it("fails soft to 'error' when the bridge is absent", () => {
    // Real non-desktop case: no preload, so window.csm is undefined and the
    // hook's default resolves to no bridge. (Passing `undefined` explicitly
    // would instead trigger the default param and pick up window.csm.)
    window.csm = undefined;
    const { result } = renderHook(() => useSessionScan());
    expect(result.current.status).toBe("error");
    expect(result.current.tree).toEqual({ roots: [], unknown: null });
  });
});
