import { expect, test, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useSessionPrs } from "../../src/renderer/hooks/useSessionPrs";
import type { CsmBridge, CsmSearch } from "../../src/renderer/types/csm";
import type { SessionPrLink, SessionPrsResult } from "../../src/ipcTypes";

const link = (title: string | null = null): SessionPrLink => ({
  repo: "o/r",
  number: 1,
  url: "https://github.com/o/r/pull/1",
  title,
  state: null,
  isDraft: false,
  createdHere: false,
  firstSeen: null,
  lastSeen: 1,
});

function fakeSearch(impl: (ids: string[]) => Promise<SessionPrsResult>) {
  let changed: ((generation: number) => void) | undefined;
  const search: CsmSearch = {
    prsFor: vi.fn(impl),
    onChanged: vi.fn((cb: (generation: number) => void) => {
      changed = cb;
      return () => {
        changed = undefined;
      };
    }),
  };
  const bridge: CsmBridge = { ...window.csm!, search };
  return { bridge, search, fireChanged: (g: number) => changed?.(g) };
}

test("requested ids without links resolve to an empty list", async () => {
  const { bridge } = fakeSearch(async () => ({ a: [link()] }));
  const { result } = renderHook(() => useSessionPrs(bridge));
  act(() => result.current.requestPrs(["a", "b"]));
  await waitFor(() => expect(result.current.prs.get("b")).toEqual([]));
  expect(result.current.prs.get("a")).toEqual([link()]);
});

test("a loaded id is not requested again", async () => {
  const { bridge, search } = fakeSearch(async () => ({}));
  const { result } = renderHook(() => useSessionPrs(bridge));
  act(() => result.current.requestPrs(["a"]));
  await waitFor(() => expect(result.current.prs.has("a")).toBe(true));
  act(() => result.current.requestPrs(["a"]));
  expect(search.prsFor).toHaveBeenCalledTimes(1);
});

test("a change event refetches the last window and shows the new title", async () => {
  let title: string | null = null;
  const { bridge, search, fireChanged } = fakeSearch(async () => ({
    a: [link(title)],
  }));
  const { result } = renderHook(() => useSessionPrs(bridge));
  act(() => result.current.requestPrs(["a"]));
  await waitFor(() => expect(result.current.prs.has("a")).toBe(true));
  title = "Fix it";
  act(() => fireChanged(2));
  await waitFor(() =>
    expect(result.current.prs.get("a")?.[0].title).toBe("Fix it"),
  );
  expect(search.prsFor).toHaveBeenLastCalledWith(["a"]);
});

test("a reply that started before a change event is dropped", async () => {
  const replies: ((r: SessionPrsResult) => void)[] = [];
  const { bridge, fireChanged } = fakeSearch(
    () => new Promise<SessionPrsResult>((resolve) => replies.push(resolve)),
  );
  const { result } = renderHook(() => useSessionPrs(bridge));
  act(() => result.current.requestPrs(["a"]));
  act(() => fireChanged(2));
  expect(replies).toHaveLength(2);
  await act(async () => replies[1]({ a: [link("new")] }));
  await act(async () => replies[0]({ a: [link("old")] }));
  expect(result.current.prs.get("a")?.[0].title).toBe("new");
});

test("without the search bridge requestPrs does nothing", () => {
  const { result } = renderHook(() => useSessionPrs({ ...window.csm! }));
  act(() => result.current.requestPrs(["a"]));
  expect(result.current.prs.size).toBe(0);
});
