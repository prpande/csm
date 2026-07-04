// Pure renderer-model builder: turns the flat, per-tier `SessionMetadata[]` the
// #59 IPC bridge streams (`sessions:batch`) into the hierarchical drive -> folder
// tree the UI renders. No DOM and no node runtime deps — it type-imports only
// `SessionMetadata` from the pure sessionParser — so it is unit-tested in the
// node tsconfig (test/main) yet safe to import from the DOM-only renderer.
//
// Approach A (see docs/plans/64-renderer-data-layer.md): the hook accumulates
// batches and calls `buildTree` over the whole set on each batch. Batches are <=6
// (one per age tier) and n is a few thousand at most, so a full rebuild is cheap
// and keeps this a single order-independent pure function instead of an
// incremental tree-mutation with its larger bug surface.

import type { SessionMetadata } from "./sessionParser";

// Must match sessionParser's private CWD fallback (its `CWD_FALLBACK`). Sessions
// with no resolvable cwd land here and the UI pins the group to the bottom of the
// tree (spec §9). Kept as a local literal to keep this slice renderer-scoped; if
// a third copy appears, promote to a shared constant (cf. #61).
export const UNKNOWN_CWD = "(unknown)";

export interface FolderNode {
  /** Path segment for display ("src", "PRism"); a root node is a drive ("D:")
   *  or the POSIX root ("/"). */
  name: string;
  /** Full path of this node; a leaf's path equals the session `cwd`. */
  path: string;
  /** This folder's own sessions, newest-first. */
  sessions: SessionMetadata[];
  /** Subfolders — includes synthesized intermediates (sessions === []). */
  children: FolderNode[];
  /** sessions.length at this node. */
  ownCount: number;
  /** own + all descendant sessions. */
  totalCount: number;
}

export interface SessionTree {
  /** Top nodes (drives / POSIX root), sorted case-insensitively by name. */
  roots: FolderNode[];
  /** The "(unknown)" cwd group, or null when none; the UI pins it after roots. */
  unknown: FolderNode | null;
}

// Mutable node used while building; frozen into FolderNode shape on the way out.
interface Building {
  name: string;
  path: string;
  sessions: SessionMetadata[];
  children: Map<string, Building>;
}

const makeNode = (name: string, path: string): Building => ({
  name,
  path,
  sessions: [],
  children: new Map(),
});

// Split a cwd into its root label and remaining segments, tolerant of both
// separators (sessions are same-OS, but staying robust is cheap):
//   "D:\\src\\csm"  -> { root: "D:", sep: "\\", segments: ["src", "csm"] }
//   "/Users/x/proj" -> { root: "/",  sep: "/",  segments: ["Users","x","proj"] }
// Anything else (relative / UNC / bare) falls back to first-segment-as-root.
function splitPath(cwd: string): {
  root: string;
  sep: string;
  segments: string[];
} {
  const sep = cwd.includes("\\") ? "\\" : "/";
  const drive = /^([A-Za-z]:)(.*)$/.exec(cwd);
  if (drive) {
    return { root: drive[1], sep, segments: splitSegments(drive[2], sep) };
  }
  if (cwd.startsWith("/")) {
    return { root: "/", sep: "/", segments: splitSegments(cwd.slice(1), "/") };
  }
  const parts = splitSegments(cwd, sep);
  return { root: parts[0] ?? cwd, sep, segments: parts.slice(1) };
}

const splitSegments = (s: string, sep: string): string[] =>
  s.split(sep).filter((seg) => seg.length > 0);

// Append a child segment to a running path, honoring the root's own separator
// (a POSIX root already ends in "/", so it takes no extra separator).
const joinPath = (base: string, sep: string, seg: string): string =>
  base.endsWith(sep) ? base + seg : base + sep + seg;

// Epoch ms for sorting; null or an unparseable timestamp sinks to the bottom.
// Mirrors sessionStore.activityEpoch — kept local because sessionStore is
// node-coupled (node:fs) and this module stays renderer-safe.
const activityEpoch = (lastActivity: string | null): number => {
  if (!lastActivity) return -Infinity;
  const t = Date.parse(lastActivity);
  return Number.isNaN(t) ? -Infinity : t;
};

// One collator reused across every folder sort — constructing an Intl.Collator
// per comparison is the slow path. Case-insensitive by name.
const collator = new Intl.Collator(undefined, { sensitivity: "base" });
const byNameCaseInsensitive = (a: FolderNode, b: FolderNode): number =>
  collator.compare(a.name, b.name);

// Recursively freeze a Building into a FolderNode: sort sessions and children,
// compute counts bottom-up.
function finalize(node: Building): FolderNode {
  const children = [...node.children.values()]
    .map(finalize)
    .sort(byNameCaseInsensitive);
  // Decorate-sort-undecorate: compute each session's epoch once (not on every
  // O(n log n) comparison), sort newest-first, tie-break by sessionId for a
  // deterministic order independent of dedup/input ordering.
  const sessions = node.sessions
    .map((s) => ({ s, t: activityEpoch(s.lastActivity) }))
    .sort((a, b) =>
      a.t !== b.t
        ? b.t - a.t
        : a.s.sessionId < b.s.sessionId
          ? -1
          : a.s.sessionId > b.s.sessionId
            ? 1
            : 0,
    )
    .map((w) => w.s);
  const ownCount = sessions.length;
  const totalCount =
    ownCount + children.reduce((sum, c) => sum + c.totalCount, 0);
  return {
    name: node.name,
    path: node.path,
    sessions,
    children,
    ownCount,
    totalCount,
  };
}

// Resolve a full path back to its node, walking the roots and the pinned
// "(unknown)" group. The FolderBrowser holds selection as a path (not a node
// reference) so it survives a `buildTree` rebuild; this recovers the live node
// for the right pane, and returns null when the folder no longer exists (the
// selection then self-clears). A plain recursive walk — the tree is a few
// thousand nodes at most and this only runs on a selection, so pruning by path
// prefix earns nothing and just adds a path-boundary edge case to reason about.
export function findFolder(tree: SessionTree, path: string): FolderNode | null {
  if (tree.unknown && tree.unknown.path === path) return tree.unknown;
  const search = (nodes: FolderNode[]): FolderNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      const hit = search(node.children);
      if (hit) return hit;
    }
    return null;
  };
  return search(tree.roots);
}

export function buildTree(sessions: SessionMetadata[]): SessionTree {
  // Dedup by sessionId, last wins (defensive against overlapping tiers / rescan).
  const deduped = new Map<string, SessionMetadata>();
  for (const s of sessions) deduped.set(s.sessionId, s);

  const roots = new Map<string, Building>();
  let unknown: Building | null = null;

  for (const session of deduped.values()) {
    if (session.cwd === UNKNOWN_CWD) {
      unknown ??= makeNode(UNKNOWN_CWD, UNKNOWN_CWD);
      unknown.sessions.push(session);
      continue;
    }
    const { root, sep, segments } = splitPath(session.cwd);
    let node = roots.get(root);
    if (!node) {
      node = makeNode(root, root);
      roots.set(root, node);
    }
    for (const seg of segments) {
      const path = joinPath(node.path, sep, seg);
      let next = node.children.get(seg);
      if (!next) {
        next = makeNode(seg, path);
        node.children.set(seg, next);
      }
      node = next;
    }
    node.sessions.push(session);
  }

  return {
    roots: [...roots.values()].map(finalize).sort(byNameCaseInsensitive),
    unknown: unknown ? finalize(unknown) : null,
  };
}
