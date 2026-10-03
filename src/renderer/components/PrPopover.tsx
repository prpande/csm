import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionPrLink } from "../../ipcTypes";
import {
  orderedPrs,
  popoverPlacement,
  prPopoverKey,
  prStateLabel,
} from "../../prChip";
import { ExternalLinkIcon } from "./ExternalLinkIcon";
import styles from "./PrPopover.module.css";

const GAP = 6;
const EDGE = 8;
const FALLBACK_WIDTH = 368;

export interface PrPopoverClose {
  keyboard: boolean;
}

interface PrPopoverProps {
  anchor: HTMLElement;
  sessionTitle: string;
  links: readonly SessionPrLink[];
  onOpenPr: (link: SessionPrLink) => void;
  onClose: (how: PrPopoverClose) => void;
  /** Called when the popover unmounts while it still holds DOM focus. */
  onFocusLost?: () => void;
}

interface Position {
  top: number;
  left: number;
  placement: "below" | "above";
}

export function PrPopover({
  anchor,
  sessionTitle,
  links,
  onOpenPr,
  onClose,
  onFocusLost,
}: PrPopoverProps) {
  const ordered = orderedPrs(links);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [rawIndex, setIndex] = useState(0);
  const [position, setPosition] = useState<Position | null>(null);
  const index = Math.min(rawIndex, Math.max(ordered.length - 1, 0));
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const focusLostRef = useRef(onFocusLost);
  focusLostRef.current = onFocusLost;

  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      if (root?.contains(document.activeElement)) focusLostRef.current?.();
    };
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const a = anchor.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    const height = box.height;
    const width = box.width || FALLBACK_WIDTH;
    const viewport = window.innerHeight;
    const placement = popoverPlacement(a, height, viewport, GAP);
    const rawTop =
      placement === "below" ? a.bottom + GAP : a.top - GAP - height;
    const top = Math.max(EDGE, Math.min(rawTop, viewport - height - EDGE));
    const left = Math.max(
      EDGE,
      Math.min(a.right - width, window.innerWidth - width - EDGE),
    );
    setPosition({ top, left, placement });
  }, [anchor, ordered.length]);

  useEffect(() => {
    itemRefs.current[index]?.focus();
  }, [index, ordered.length]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target) || anchor.contains(target)) return;
      closeRef.current({ keyboard: false });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [anchor]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Tab") {
      e.preventDefault();
      const count = ordered.length;
      if (count === 0) return;
      setIndex((index + (e.shiftKey ? count - 1 : 1)) % count);
      return;
    }
    const action = prPopoverKey(e.key, index, ordered.length);
    if (!action) return;
    e.preventDefault();
    if (action.type === "move") setIndex(action.index);
    else if (action.type === "open") {
      const link = ordered[action.index];
      if (link) onOpenPr(link);
    } else onClose({ keyboard: true });
  };

  const count = ordered.length;
  return createPortal(
    <div
      ref={rootRef}
      className={styles.popover}
      role="dialog"
      aria-label={`Pull requests for ${sessionTitle}`}
      data-placement={position?.placement}
      style={{
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      onKeyDown={onKeyDown}
    >
      <div className={styles.header}>
        <span className={styles.heading}>
          {count} {count === 1 ? "pull request" : "pull requests"}
        </span>
        <span className={styles.hint}>Enter opens · Esc closes</span>
      </div>
      <div className={styles.list}>
        {ordered.map((link, i) => {
          const state = prStateLabel(link);
          return (
            <button
              key={`${link.repo}#${link.number}`}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              className={styles.item}
              tabIndex={i === index ? 0 : -1}
              onFocus={() => setIndex(i)}
              onClick={() => {
                setIndex(i);
                onOpenPr(link);
              }}
            >
              <span className={styles.line1}>
                {state && (
                  <span className={styles.pill} data-state={state}>
                    {state}
                  </span>
                )}
                <span className={styles.number}>#{link.number}</span>
                <span className={styles.title}>
                  {link.title ?? "Title unavailable"}
                </span>
                <ExternalLinkIcon className={styles.icon} size={14} />
              </span>
              <span className={styles.line2}>
                <span>{link.repo}</span>
                {link.createdHere && (
                  <span className={styles.here}>opened here</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
