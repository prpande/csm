import { test, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useReopen } from "../../src/renderer/hooks/useReopen";
import { DOWNGRADE_MODE } from "../../src/reopenView";
import type { SessionMetadata } from "../../src/sessionParser";

const makeSession = (over: Partial<SessionMetadata> = {}): SessionMetadata => ({
  sessionId: "abcdefgh-1111-2222-3333-444455556666",
  cwd: "D:\\src\\csm",
  title: "Refactor the parser",
  permissionMode: "default",
  lastActivity: null,
  gitBranch: null,
  ...over,
});

test("a non-bypass session reopens immediately with the passthrough mode", async () => {
  const reopen = vi.fn(async () => ({ ok: true as const }));
  window.csm!.reopenSession = reopen;
  const { result } = renderHook(() => useReopen());

  await act(async () => {
    await result.current.requestReopen(makeSession({ permissionMode: "plan" }));
  });

  expect(reopen).toHaveBeenCalledTimes(1);
  expect(reopen).toHaveBeenCalledWith({
    cwd: "D:\\src\\csm",
    sessionId: "abcdefgh-1111-2222-3333-444455556666",
    mode: "plan",
  });
  expect(result.current.pendingBypass).toBe(null);
  expect(result.current.toast).toBe(null);
});

test("a bypassPermissions session defers to the confirm modal without calling the bridge", async () => {
  const reopen = vi.fn(async () => ({ ok: true as const }));
  window.csm!.reopenSession = reopen;
  const { result } = renderHook(() => useReopen());
  const session = makeSession({ permissionMode: "bypassPermissions" });

  await act(async () => {
    await result.current.requestReopen(session);
  });

  expect(reopen).not.toHaveBeenCalled();
  expect(result.current.pendingBypass).toBe(session);
});

test("confirming the modal with the bypass mode reopens with bypassPermissions", async () => {
  const reopen = vi.fn(async () => ({ ok: true as const }));
  window.csm!.reopenSession = reopen;
  const { result } = renderHook(() => useReopen());
  const session = makeSession({ permissionMode: "bypassPermissions" });

  await act(async () => {
    await result.current.requestReopen(session);
  });
  await act(async () => {
    await result.current.confirmReopen("bypassPermissions");
  });

  expect(reopen).toHaveBeenCalledWith({
    cwd: session.cwd,
    sessionId: session.sessionId,
    mode: "bypassPermissions",
  });
  expect(result.current.pendingBypass).toBe(null);
});

test("confirming the modal with the downgrade reopens with acceptEdits", async () => {
  const reopen = vi.fn(async () => ({ ok: true as const }));
  window.csm!.reopenSession = reopen;
  const { result } = renderHook(() => useReopen());
  const session = makeSession({ permissionMode: "bypassPermissions" });

  await act(async () => {
    await result.current.requestReopen(session);
  });
  await act(async () => {
    await result.current.confirmReopen(DOWNGRADE_MODE);
  });

  expect(reopen).toHaveBeenCalledWith({
    cwd: session.cwd,
    sessionId: session.sessionId,
    mode: "acceptEdits",
  });
  expect(result.current.pendingBypass).toBe(null);
});

test("cancelling the modal clears the pending session and never calls the bridge", async () => {
  const reopen = vi.fn(async () => ({ ok: true as const }));
  window.csm!.reopenSession = reopen;
  const { result } = renderHook(() => useReopen());

  await act(async () => {
    await result.current.requestReopen(
      makeSession({ permissionMode: "bypassPermissions" }),
    );
  });
  act(() => {
    result.current.cancelReopen();
  });

  expect(reopen).not.toHaveBeenCalled();
  expect(result.current.pendingBypass).toBe(null);
});

test("a FOLDER_MISSING failure surfaces the specific folder-gone toast", async () => {
  window.csm!.reopenSession = vi.fn(async () => ({
    ok: false as const,
    code: "FOLDER_MISSING" as const,
  }));
  const { result } = renderHook(() => useReopen());

  await act(async () => {
    await result.current.requestReopen(makeSession());
  });

  expect(result.current.toast?.message.toLowerCase()).toContain("folder");
});

test("any other failure surfaces the generic reopen-failed toast", async () => {
  window.csm!.reopenSession = vi.fn(async () => ({
    ok: false as const,
    code: "SPAWN_FAILED" as const,
  }));
  const { result } = renderHook(() => useReopen());

  await act(async () => {
    await result.current.requestReopen(makeSession());
  });

  expect(result.current.toast?.message.toLowerCase()).toContain("reopen");
});

test("a missing bridge fails soft to a toast without throwing", async () => {
  // Simulate a plain browser with no preload bridge (csm is optional).
  window.csm = undefined;
  const { result } = renderHook(() => useReopen());

  await act(async () => {
    await result.current.requestReopen(makeSession());
  });

  expect(result.current.toast).not.toBe(null);
});

test("an in-flight reopen ignores a concurrent second request (no double launch)", async () => {
  // One shared deferred so the first reopen is still pending when the second
  // gesture arrives — the busy guard must drop the second.
  let release!: () => void;
  const pending = new Promise<{ ok: true }>((resolve) => {
    release = () => resolve({ ok: true });
  });
  const reopen = vi.fn(() => pending);
  window.csm!.reopenSession = reopen;
  const { result } = renderHook(() => useReopen());
  const session = makeSession({ permissionMode: "plan" });

  await act(async () => {
    // First fire is left pending (not awaited); the second overlaps it.
    void result.current.requestReopen(session);
    await result.current.requestReopen(session);
  });

  // Only the first launch happened; the overlapping one was dropped.
  expect(reopen).toHaveBeenCalledTimes(1);

  // Resolve the in-flight call so the guard clears cleanly.
  await act(async () => {
    release();
  });
  expect(reopen).toHaveBeenCalledTimes(1);
});

test("dismissToast clears the toast", async () => {
  window.csm!.reopenSession = vi.fn(async () => ({
    ok: false as const,
    code: "SPAWN_FAILED" as const,
  }));
  const { result } = renderHook(() => useReopen());

  await act(async () => {
    await result.current.requestReopen(makeSession());
  });
  expect(result.current.toast).not.toBe(null);
  act(() => {
    result.current.dismissToast();
  });
  expect(result.current.toast).toBe(null);
});
