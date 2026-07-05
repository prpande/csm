// Presentation helper for #77 compacted folder labels. A collapsed single-child
// chain carries the full joined path as its label (e.g.
// "C:\\Users\\praty\\AppData\\Local\\Temp\\worktrees\\42-hotfix"). In the
// fixed-width (~260px) sidebar a plain end-ellipsis would hide the leaf — the one
// segment the user actually navigates to — so we middle-truncate instead, keeping
// the drive/root head AND the leaf visible and eliding whole middle segments:
// "C:\\Users\\praty\\AppData\\…\\42-hotfix". The full path always remains in the
// row's title tooltip, and TreeNode's CSS end-ellipsis backstops the rare label
// still too wide after truncation.
//
// Width is approximated by a character budget (the sidebar is fixed-width); this
// stays a pure, DOM-free, unit-testable string transform rather than measuring
// rendered pixels.
const DEFAULT_MAX = 36;
const ELLIPSIS = "…";

export function truncatePathLabel(label: string, max = DEFAULT_MAX): string {
  if (label.length <= max) return label;
  const sep = label.includes("\\") ? "\\" : "/";
  const segments = label.split(sep);
  // "root + leaf" (or a bare segment) has no middle to elide — leave it for the
  // CSS end-ellipsis rather than emit a "root…leaf" with nothing dropped.
  if (segments.length <= 2) return label;

  const leaf = segments[segments.length - 1];
  // Elide the middle: keep the root head and the leaf, joined by an ellipsis
  // segment ("C:\\Users\\…\\42-hotfix"). Grow the head one whole segment at a
  // time while the fully rendered result still fits the budget; measuring the
  // rendered string keeps the layout defined in exactly one place.
  const rendered = (head: string) => head + sep + ELLIPSIS + sep + leaf;
  let head = segments[0];
  for (let i = 1; i < segments.length - 1; i++) {
    const candidate = head + sep + segments[i];
    if (rendered(candidate).length > max) break;
    head = candidate;
  }
  return rendered(head);
}
