import type { SessionPrLink } from "./ipcTypes";

export type PrStateLabel = "open" | "draft" | "merged" | "closed";

export function primaryPr(
  links: readonly SessionPrLink[],
): SessionPrLink | undefined {
  const created = links.filter((l) => l.createdHere);
  const pool = created.length > 0 ? created : links;
  const time = (l: SessionPrLink): number =>
    (created.length > 0 ? l.firstSeen : l.lastSeen) ?? -1;
  let best: SessionPrLink | undefined;
  for (const l of pool) {
    if (
      !best ||
      time(l) > time(best) ||
      (time(l) === time(best) && l.number > best.number)
    )
      best = l;
  }
  return best;
}

export function prStateLabel(link: SessionPrLink): PrStateLabel | undefined {
  switch (link.state) {
    case "OPEN":
      return link.isDraft ? "draft" : "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return undefined;
  }
}

export function orderedPrs(links: readonly SessionPrLink[]): SessionPrLink[] {
  const primary = primaryPr(links);
  if (!primary) return [];
  const rest = links
    .filter((l) => l !== primary)
    .sort((a, b) => b.number - a.number);
  return [primary, ...rest];
}

export function prLinkSummary(link: SessionPrLink): string {
  return [`${link.repo}#${link.number}`, prStateLabel(link), link.title]
    .filter((part): part is string => !!part)
    .join(" · ");
}

export function popoverPlacement(
  anchor: { top: number; bottom: number },
  popoverHeight: number,
  viewportHeight: number,
  gap: number,
): "below" | "above" {
  const roomBelow = viewportHeight - anchor.bottom - gap;
  if (popoverHeight <= roomBelow) return "below";
  const roomAbove = anchor.top - gap;
  return roomAbove > roomBelow ? "above" : "below";
}

export type PrPopoverKeyAction =
  | { type: "move"; index: number }
  | { type: "open"; index: number }
  | { type: "close" };

export function prPopoverKey(
  key: string,
  index: number,
  count: number,
): PrPopoverKeyAction | null {
  const last = Math.max(count - 1, 0);
  switch (key) {
    case "ArrowDown":
      return { type: "move", index: Math.min(index + 1, last) };
    case "ArrowUp":
      return { type: "move", index: Math.max(index - 1, 0) };
    case "Home":
      return { type: "move", index: 0 };
    case "End":
      return { type: "move", index: last };
    case "Enter":
      return { type: "open", index };
    case "Escape":
      return { type: "close" };
    default:
      return null;
  }
}

export interface PrButtonLabel {
  number: number;
  state: PrStateLabel | undefined;
  more: number;
}

export function prButtonLabel(
  links: readonly SessionPrLink[],
): PrButtonLabel | undefined {
  const [primary] = orderedPrs(links);
  if (!primary) return undefined;
  return {
    number: primary.number,
    state: prStateLabel(primary),
    more: links.length - 1,
  };
}

export const prButtonId = (rowId: string): string => `${rowId}-pr`;
