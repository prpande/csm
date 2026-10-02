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
