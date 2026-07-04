import { useLayoutEffect, useRef, useState } from "react";
import type { SessionMetadata } from "../../sessionParser";
import { computeWindow, ROW_HEIGHT, OVERSCAN } from "../../sessionListWindow";
import { SessionRow } from "./SessionRow";
import styles from "./SessionList.module.css";

interface SessionListProps {
  /** The selected folder's sessions, already sorted newest-first (#64). */
  sessions: SessionMetadata[];
  /** Row open gesture (double-click → reopen, #67). */
  onOpen?: (session: SessionMetadata) => void;
}

// Windowed / virtualized session list (spec §6/§11). A folder can hold thousands
// of sessions, so only the rows in (and just around) the viewport are mounted:
// the scroll container reserves the full height via a spacer, and the visible
// slice — chosen by the pure `computeWindow` — is offset with translateY.
export function SessionList({ sessions, onOpen }: SessionListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

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

  return (
    <div
      ref={scrollRef}
      className={styles.scroll}
      role="list"
      aria-label="Sessions"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      {/* The spacer/window wrappers carry no semantics — mark them presentation
          so the role="listitem" rows stay the direct a11y children of the
          role="list" container despite the intervening layout divs. */}
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
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
