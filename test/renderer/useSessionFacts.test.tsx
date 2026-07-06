import { test, expect, describe, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSessionFacts } from "../../src/renderer/hooks/useSessionFacts";
import type { CsmBridge } from "../../src/renderer/types/csm";

const facts = (id: string) => ({
  sessionId: id,
  messageCount: 1,
  firstActivity: null,
  lastActivity: null,
  editedFileCount: 0,
  firstModel: null,
  distinctModelCount: 0,
  outputTokens: 0,
});

describe("useSessionFacts", () => {
  test("fetches uncached ids and exposes loaded/error entries", async () => {
    const getFacts = vi.fn(async (ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [id, id === "bad" ? { error: true } : facts(id)]),
      ),
    );
    const bridge = {
      isDesktop: true,
      platform: "win32",
      getFacts,
    } as unknown as CsmBridge;
    const { result } = renderHook(() => useSessionFacts(bridge));

    act(() => result.current.requestFacts(["a", "bad"]));
    await waitFor(() => expect(result.current.facts.size).toBe(2));
    expect(result.current.facts.get("a")).toEqual({
      status: "loaded",
      facts: facts("a"),
    });
    expect(result.current.facts.get("bad")).toEqual({ status: "error" });
  });

  test("does not re-request already-known or in-flight ids", async () => {
    const getFacts = vi.fn(async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, facts(id)])),
    );
    const bridge = {
      isDesktop: true,
      platform: "win32",
      getFacts,
    } as unknown as CsmBridge;
    const { result } = renderHook(() => useSessionFacts(bridge));

    act(() => result.current.requestFacts(["a"]));
    await waitFor(() => expect(result.current.facts.has("a")).toBe(true));
    act(() => result.current.requestFacts(["a"]));
    expect(getFacts).toHaveBeenCalledTimes(1);
  });
});
