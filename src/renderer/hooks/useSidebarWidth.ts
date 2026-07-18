import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  restoreSidebarWidth,
  splitterKeyWidth,
} from "../../sidebarWidth";

// Resizable sidebar (#164). All the math is the pure sidebarWidth module; this
// hook owns the wiring only — state, listeners, and the splitter's pointer /
// keyboard handlers. Width is renderer view state (per-machine chrome), so it
// persists in localStorage — deliberately NOT settingsStore, which would cost
// an IPC round-trip per drag frame for a non-setting. windowWidth is state
// (not read ad hoc) so the separator's aria-valuemax re-announces when the
// window resizes.
export interface SidebarWidthControl {
  sidebarWidth: number;
  windowWidth: number;
  dragging: boolean;
  onSplitterPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onSplitterPointerMove: (e: PointerEvent) => void;
  /** Wire to BOTH pointerup and lostpointercapture (see the comment inside). */
  endSplitterDrag: (e: PointerEvent) => void;
  onSplitterKeyDown: (e: KeyboardEvent) => void;
  /** Double-click reset to the (clamped) default width. */
  resetSplitter: () => void;
}

export function useSidebarWidth(): SidebarWidthControl {
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    // Guarded: storage access can throw (disabled/blocked storage), and with
    // no ErrorBoundary above, an unguarded throw here would blank the app's
    // very first render. Fall back to the default width instead.
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    } catch {
      // unreadable storage — restore handles null with the default
    }
    return restoreSidebarWidth(stored, window.innerWidth);
  });
  const [dragging, setDragging] = useState(false);
  // The drag origin — deltas are computed against pointer-DOWN, not the
  // previous move, so a jittery pointer cannot accumulate rounding drift.
  // pointerId keys the whole state machine: a second concurrent pointer (a
  // stray touch on the widened hit area) must not hijack the origin or end
  // someone else's drag.
  const dragStart = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);

  useEffect(() => {
    const onResize = () => {
      setWindowWidth(window.innerWidth);
      setSidebarWidth((w) => clampSidebarWidth(w, window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Single persistence choke point: every width mutation — drag, keys,
  // double-click, resize re-clamp — funnels through this effect, so no path
  // can forget to persist. The per-frame setItem during a drag is a few-byte
  // string write; measured noise next to the layout reflow the drag causes.
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // quota/blocked storage — the width just won't persist this session
    }
  }, [sidebarWidth]);

  const onSplitterPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current) return; // a drag is active — ignore other pointers
    dragStart.current = {
      pointerId: e.pointerId,
      x: e.clientX,
      width: sidebarWidth,
    };
    setDragging(true);
    // Capture routes every move to the splitter even when the cursor outruns
    // the thin strip mid-drag. Guarded: jsdom has no pointer capture.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onSplitterPointerMove = (e: PointerEvent) => {
    const start = dragStart.current;
    if (!start || e.pointerId !== start.pointerId) return;
    setSidebarWidth(
      clampSidebarWidth(start.width + (e.clientX - start.x), windowWidth),
    );
  };
  // Shared by pointerup AND lostpointercapture: if the capture is torn away
  // (alt-tab, context menu), the drag must not keep tracking a phantom pointer.
  // Only the pointer that STARTED the drag may end it.
  const endSplitterDrag = (e: PointerEvent) => {
    const start = dragStart.current;
    if (!start || e.pointerId !== start.pointerId) return;
    dragStart.current = null;
    setDragging(false);
  };
  const onSplitterKeyDown = (e: KeyboardEvent) => {
    const next = splitterKeyWidth(e.key, sidebarWidth, windowWidth);
    if (next === null) return; // not ours — let Tab and friends through
    e.preventDefault();
    setSidebarWidth(next);
  };
  const resetSplitter = () =>
    setSidebarWidth(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, windowWidth));

  return {
    sidebarWidth,
    windowWidth,
    dragging,
    onSplitterPointerDown,
    onSplitterPointerMove,
    endSplitterDrag,
    onSplitterKeyDown,
    resetSplitter,
  };
}
