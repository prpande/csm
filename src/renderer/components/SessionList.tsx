import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { SessionMetadata } from "../../sessionParser";
import {
  computeWindow,
  scrollTopToReveal,
  listKeyAction,
  ROW_HEIGHT,
  OVERSCAN,
} from "../../sessionListWindow";
import { useSessionFacts } from "../hooks/useSessionFacts";
import { SessionRow } from "./SessionRow";
import styles from "./SessionList.module.css";

// Stable DOM id for a row's role="option", referenced by aria-activedescendant.
const optionId = (sessionId: string): string => `session-opt-${sessionId}`;

interface SessionListProps {
  /** The selected folder's sessions, already sorted newest-first (#64). */
  sessions: SessionMetadata[];
  /** Row open gesture (double-click → reopen, #67). */
  onOpen?: (session: SessionMetadata) => void;
  /** Provenance for sessions folded in from git worktrees (#101):
   *  `sessionId -> branch label`. A row whose id is present renders a branch
   *  chip; own sessions are absent from the map and render none. */
  worktreeBranches?: ReadonlyMap<string, string>;
}

// Windowed / virtualized session list (spec §6/§11). A folder can hold thousands
// of sessions, so only the rows in (and just around) the viewport are mounted:
// the scroll container reserves the full height via a spacer, and the visible
// slice — chosen by the pure `computeWindow` — is offset with translateY.
export function SessionList({
  sessions,
  onOpen,
  worktreeBranches,
}: SessionListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // The keyboard-active option (#70), held as a sessionId (not an index) so it
  // survives the row array being rebuilt between streaming batches — the same
  // reason the tree holds focus as a path. The index is derived per render.
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Measure the viewport height and keep it current on resize. ResizeObserver is
  // absent under jsdom (tests) — the guard falls back to a 0 height, which still
  // yields a bounded (overscan-only) window rather than mounting every row.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { startIndex, endIndex } = computeWindow(
    scrollTop,
    viewportHeight,
    ROW_HEIGHT,
    sessions.length,
    OVERSCAN,
  );
  const visible = sessions.slice(startIndex, endIndex);

  const focusedIndex =
    focusedId === null
      ? -1
      : sessions.findIndex((s) => s.sessionId === focusedId);

  // Seed the active option to the first row, and re-seed if the active row
  // disappears (aged out or folded away between batches). STATE only — this never
  // pulls DOM focus (the container keeps focus; the active option is virtual, via
  // aria-activedescendant), so unlike the tree there is no steal to guard against.
  useEffect(() => {
    setFocusedId((prev) => {
      if (sessions.length === 0) return null;
      if (prev !== null && sessions.some((s) => s.sessionId === prev))
        return prev;
      return sessions[0].sessionId;
    });
  }, [sessions]);

  // One handler on the listbox: keys bubble up from the container (which holds
  // real focus). The pure listKeyAction owns the semantics; this dispatches and,
  // for a move, reveals the target row BEFORE it becomes the active descendant —
  // a row outside the mounted window must exist in the DOM for aria-
  // activedescendant to resolve to it. flushSync commits the new window so the
  // row is mounted before we sync the real scrollbar position.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const action = listKeyAction(e.key, focusedIndex, sessions.length);
    if (!action) return; // not ours (Tab, etc.) — let it through
    e.preventDefault();
    if (action.type === "open") {
      onOpen?.(sessions[action.index]);
      return;
    }
    const target = sessions[action.index];
    const newScrollTop = scrollTopToReveal(
      action.index,
      scrollTop,
      viewportHeight,
      ROW_HEIGHT,
    );
    flushSync(() => {
      setScrollTop(newScrollTop);
      setFocusedId(target.sessionId);
    });
    // React state moved the windowed slice; also move the real scrollbar so the
    // revealed row is actually on screen (state alone doesn't scroll the div).
    if (scrollRef.current) scrollRef.current.scrollTop = newScrollTop;
  };

  // Only reference the active option when it is actually mounted: a dangling
  // aria-activedescendant (pointing at an id not in the DOM, e.g. after a mouse
  // scroll unmounts the active row) is an invalid reference. It resolves again on
  // the next arrow, which reveals the row.
  const activeMounted = focusedIndex >= startIndex && focusedIndex < endIndex;
  const activeDescendant =
    focusedId !== null && activeMounted ? optionId(focusedId) : undefined;

  const { facts, requestFacts } = useSessionFacts();
  // Request facts for the rows actually mounted (the window). Keyed on the id list
  // so a scroll into new rows fetches just the newly-visible, uncached ones.
  const visibleIds = visible.map((s) => s.sessionId);
  const visibleKey = visibleIds.join(",");
  useEffect(() => {
    if (visibleIds.length > 0) requestFacts(visibleIds);
    // visibleKey is the stable dependency; the ids array's identity changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, requestFacts]);

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      role="listbox"
      aria-label="Sessions"
      // Roving focus would put the single tab stop on an option — but the list is
      // virtualized, so that option unmounts when scrolled away and the pane
      // becomes keyboard-unreachable. The always-mounted container is the tab
      // stop instead, and the active option is virtual (aria-activedescendant) —
      // the standard APG pattern for a virtualized listbox. (The tree can use
      // roving tabindex because it never unmounts a visible node.)
      tabIndex={0}
      aria-activedescendant={activeDescendant}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      {/* The spacer/window wrappers carry no semantics — mark them presentation
          so the role="option" rows stay the direct a11y children of the
          role="listbox" container despite the intervening layout divs. */}
      <div
        className={styles.spacer}
        role="presentation"
        data-testid="session-list-spacer"
        style={{ height: sessions.length * ROW_HEIGHT }}
      >
        <div
          className={styles.window}
          role="presentation"
          style={{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }}
        >
          {visible.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              rowHeight={ROW_HEIGHT}
              id={optionId(session.sessionId)}
              active={session.sessionId === focusedId}
              onOpen={onOpen}
              worktreeBranch={worktreeBranches?.get(session.sessionId)}
              factState={facts.get(session.sessionId)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
