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
  /** Display label. A single path segment ("src", "PRism") as built; a root node
   *  is a drive ("D:") or the POSIX root ("/"). After #77's `compactTree` a
   *  collapsed node's label is the joined path of the merged segments — the full
   *  path for a drive-rooted chain, a relative segment join ("a\\b\\c") below a
   *  branch. `path` (not `name`) is always the full absolute folder path. */
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
  /** For sessions folded in from `<repo>/.claude/worktrees/<name>` by
   *  `rollUpWorktrees`: `sessionId -> branch label` (the session's `gitBranch`,
   *  or the worktree folder name when absent). Empty for every node until the
   *  roll-up runs; consulted by the folder pane to tag worktree provenance. Those
   *  sessions are ALSO present in `sessions` (so counts / selection are unchanged
   *  for consumers), and only the ones in this map carry a chip. */
  worktreeBranches: ReadonlyMap<string, string>;
}

// Shared empty provenance map — reused for every non-rolled-up node so the common
// case allocates nothing (the map is read-only by type, safe to share).
const NO_WORKTREE_BRANCHES: ReadonlyMap<string, string> = new Map();

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
// A cwd/path uses a single separator throughout (buildTree joins with one), so
// the presence of a backslash identifies the OS convention. Single-sourced here
// and reused by compact() so the "\\" vs "/" rule lives in one place.
const sepOf = (path: string): string => (path.includes("\\") ? "\\" : "/");

function splitPath(cwd: string): {
  root: string;
  sep: string;
  segments: string[];
} {
  const sep = sepOf(cwd);
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

// Decorate-sort-undecorate: compute each session's epoch once (not on every
// O(n log n) comparison), sort newest-first, tie-break by sessionId for a
// deterministic order independent of dedup/input ordering. Shared by finalize
// and rollUpWorktrees (which re-sorts a node's own + folded-in sessions).
function sortSessionsNewestFirst(
  sessions: SessionMetadata[],
): SessionMetadata[] {
  return sessions
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
}

// Recursively freeze a Building into a FolderNode: sort sessions and children,
// compute counts bottom-up.
function finalize(node: Building): FolderNode {
  const children = [...node.children.values()]
    .map(finalize)
    .sort(byNameCaseInsensitive);
  const sessions = sortSessionsNewestFirst(node.sessions);
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
    worktreeBranches: NO_WORKTREE_BRANCHES,
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

/** One row of the tree as it is actually on screen (#70). */
export interface FlatNode {
  node: FolderNode;
  /** Nesting depth (0 = root) — the same value TreeNode indents by. */
  depth: number;
  /** The path of the row above this one in the hierarchy; null for a root, so
   *  Left-from-a-root has nowhere to go. */
  parentPath: string | null;
}

/** The visible rows, top to bottom, for keyboard traversal (#70).
 *
 *  MUST mirror FolderTree/TreeNode's render exactly: roots in order, the
 *  "(unknown)" group pinned last, and children only for an expanded node — a
 *  collapsed node renders no child `<ul>` at all, so its subtree must not be
 *  arrow-reachable either. Arrow keys walk this array while the user watches the
 *  render; any divergence between the two is an off-by-one the user feels.
 *
 *  Derived here rather than by walking the DOM so there is ONE definition of
 *  "what's on screen", and so navigation stays pure and testable without a DOM. */
export function flattenVisible(
  tree: SessionTree,
  expandedPaths: ReadonlySet<string>,
): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (node: FolderNode, depth: number, parentPath: string | null) => {
    out.push({ node, depth, parentPath });
    // Mirrors TreeNode: `hasChildren && expandedPaths.has(path)`.
    if (node.children.length > 0 && expandedPaths.has(node.path)) {
      for (const child of node.children) walk(child, depth + 1, node.path);
    }
  };
  for (const root of tree.roots) walk(root, 0, null);
  if (tree.unknown) walk(tree.unknown, 0, null);
  return out;
}

/** What a key should do to the tree (#70). The component dispatches it; null
 *  means "not ours" — leave the event alone rather than swallowing it. */
export type TreeKeyAction =
  | { type: "focus"; path: string }
  | { type: "toggle"; path: string }
  | { type: "select"; node: FolderNode };

/** The focused row plus the facts each key handler needs about it. */
interface KeyContext {
  at: FlatNode;
  /** Index of `at` within the visible rows. */
  cur: number;
  /** True when nothing was focused yet — the arrows land on row 0 rather than
   *  stepping off it. */
  unfocused: boolean;
  hasChildren: boolean;
  isExpanded: boolean;
  /** Focus a row by index, clamped, so the ends of the list are dead-stops
   *  rather than wraps. */
  focusAt: (i: number) => TreeKeyAction;
}
type KeyHandler = (c: KeyContext) => TreeKeyAction | null;

// APG treeview: Right opens a closed node in place, then steps INTO it once open.
const openOrDescend: KeyHandler = (c) => {
  if (!c.hasChildren) return null; // a leaf has nothing to open or step into
  if (c.isExpanded) return c.focusAt(c.cur + 1);
  return { type: "toggle", path: c.at.node.path };
};

// APG treeview: Left closes an open node in place, then walks OUT to the parent.
const closeOrAscend: KeyHandler = (c) => {
  if (c.isExpanded) return { type: "toggle", path: c.at.node.path };
  if (c.at.parentPath === null) return null; // a root: nowhere further out
  return { type: "focus", path: c.at.parentPath };
};

// A tree item is not a session, so the issue's "Enter opens the session" AC does
// not apply here — Enter and Space mirror the row's click instead.
const activate: KeyHandler = (c) => {
  if (c.at.node.ownCount > 0) return { type: "select", node: c.at.node };
  return c.hasChildren ? { type: "toggle", path: c.at.node.path } : null;
};

// The key map, as a map. An absent key resolves to null, so the tree only ever
// swallows the events it actually handles.
const TREE_KEYS: Record<string, KeyHandler> = {
  ArrowDown: (c) => c.focusAt(c.unfocused ? 0 : c.cur + 1),
  ArrowUp: (c) => c.focusAt(c.unfocused ? 0 : c.cur - 1),
  ArrowRight: openOrDescend,
  ArrowLeft: closeOrAscend,
  " ": activate,
  Enter: activate,
};

/** Resolve a keypress against the visible rows (#70) — pure, so the whole key
 *  map is unit-testable with no DOM and the component stays a dispatcher.
 *  Returns null when the key isn't ours, so the caller leaves the event alone.
 *
 *  A `focusedPath` that isn't in `flat` (nothing focused yet, or the focused
 *  folder vanished between scan batches) resolves to the first row rather than
 *  to nothing, so the first keypress is never a dead one. */
export function treeKeyAction(
  key: string,
  flat: readonly FlatNode[],
  focusedPath: string | null,
  expandedPaths: ReadonlySet<string>,
): TreeKeyAction | null {
  const handler = TREE_KEYS[key];
  if (!handler || flat.length === 0) return null;

  const found = flat.findIndex((f) => f.node.path === focusedPath);
  const cur = found === -1 ? 0 : found;
  const at = flat[cur];
  const hasChildren = at.node.children.length > 0;
  return handler({
    at,
    cur,
    unfocused: found === -1,
    hasChildren,
    isExpanded: hasChildren && expandedPaths.has(at.node.path),
    focusAt: (i) => ({
      type: "focus",
      path: flat[Math.max(0, Math.min(flat.length - 1, i))].node.path,
    }),
  });
}

/** Whether this folder was a git working tree at session time (#111) — true when
 *  any of its OWN sessions carries a `gitBranch`. Derived on read rather than
 *  stored on the node: `buildTree`, `compactTree` and `rollUpWorktrees` each
 *  rebuild nodes, so a field would be three chances to drift out of sync with
 *  `sessions`, while a predicate reads the same array every consumer already
 *  trusts for `ownCount`.
 *
 *  Needs no fs, no `.git` probe and no git subprocess, which is exactly why it
 *  still answers for a folder that has since been deleted (a removed worktree),
 *  where an on-disk check is impossible. A repo whose sessions all predate the
 *  `gitBranch` field reads as false — absence of evidence, and the safe
 *  direction: a missing marker is a non-event, marking a non-repo would be a lie.
 *  A live probe could later enrich this (#91). */
export function isGitRepo(node: FolderNode): boolean {
  // "(unknown)" is not a folder — it is the bucket for sessions whose cwd never
  // resolved, and it CAN hold branch-carrying sessions: parseSession reads cwd
  // and gitBranch from independent passes, so a file whose records carry a
  // gitBranch but never a cwd lands here WITH a branch. Excluded at the
  // predicate rather than at the marker, because "a bucket is not a working
  // tree" is a fact about the data that every consumer needs, not a rendering
  // detail.
  if (node.path === UNKNOWN_CWD) return false;
  return node.sessions.some((s) => s.gitBranch !== null);
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

// #77: collapse pure single-child pass-through folders so the tree starts at the
// largest common parent per cluster instead of the drive root. A `C:\…\Temp\
// worktrees\42-hotfix` chain — seven navigation rows that own nothing — becomes a
// single node. Kept a separate pure transform over `buildTree`'s output (not
// folded into buildTree, not in the render layer) so grouping and compaction stay
// independently DOM-free-unit-testable, matching the sessionTree convention;
// `useSessionScan` composes them as the outermost transform, so compaction runs
// on the post-filter tree once #69's temp/worktree filter lands.
//
// Rule: merge a folder into its single child iff it owns no sessions
// (`ownCount === 0`) AND has exactly one child. Stop at the first folder that
// owns sessions or branches (`> 1` child). The survivor keeps the *deepest*
// folder's identity — `path`, `sessions`, `children`, and both counts — so
// selection, expansion, and counts are unchanged; only its `name` becomes the
// joined path of the absorbed segments (the full path for a chain rooted at the
// drive, a relative segment join for a chain below a branch).
function compact(node: FolderNode): FolderNode {
  if (node.children.length === 0) return node; // a leaf can't collapse further
  // Children keep finalize's order — sorted by each folder's own (first-segment)
  // name. A merged child's label gains a collapsed-path suffix ("app" -> "app\\src"),
  // but that suffix is display decoration and deliberately does NOT re-sort it: the
  // node still represents the "app" folder and should sit where "app" sorts among
  // its siblings, not get bumped past "app-v2" by the trailing "\\src".
  const children = node.children.map(compact);
  if (node.ownCount === 0 && children.length === 1) {
    const only = children[0];
    // The separator lives in the child's path — a drive root's own path ("D:")
    // carries none — so infer it there. `joinPath` handles the POSIX root, whose
    // path already ends in "/".
    const sep = sepOf(only.path);
    return { ...only, name: joinPath(node.name, sep, only.name) };
  }
  return { ...node, children };
}

// Apply single-child chain compaction across the whole tree. The "(unknown)"
// group is a childless owning node, so it never collapses and is passed through.
export function compactTree(tree: SessionTree): SessionTree {
  return {
    roots: tree.roots.map(compact),
    unknown: tree.unknown,
  };
}

// #101/#69: fold worktree sessions into their owning project. A session under
// `<repo>/.claude/worktrees/<name>/...` belongs, logically, to `<repo>` — the
// node that owns the `.claude` directory. This transform re-homes every such
// session onto that node (so selecting the project surfaces its worktree work
// without drilling in) and prunes the `.claude/worktrees` subtree from the tree,
// which is the display half of #69's default hide-worktree filter. Recognizes
// only the `.claude/worktrees` path convention (pure, no I/O) — generic git
// worktrees need a git-common-dir probe and are deferred to #56/#91.
//
// Provenance rides in `worktreeBranches` (sessionId -> branch), the branch taken
// from the session's own `gitBranch` (historical, accurate even for a since-
// deleted worktree) and falling back to the `<name>` worktree folder. Folded
// sessions are also merged into the owner's `sessions` so counts, selectability,
// and the tree row are unchanged; only the mapped ones carry a chip.
//
// Run BEFORE `compactTree`: it operates on the un-collapsed `.claude` ->
// `worktrees` -> `<name>` chain, and the owning node it produces then compacts
// normally.
const CLAUDE_DIR = ".claude";
const WORKTREES_DIR = "worktrees";

// All sessions in a subtree (this node plus every descendant), order-agnostic.
function collectSessions(node: FolderNode, out: SessionMetadata[]): void {
  out.push(...node.sessions);
  for (const c of node.children) collectSessions(c, out);
}

// Recompute counts after a subtree edit; other fields (path/name/sessions/
// worktreeBranches) are carried through by the caller's spread.
function recount(node: FolderNode): FolderNode {
  const ownCount = node.sessions.length;
  const totalCount =
    ownCount + node.children.reduce((sum, c) => sum + c.totalCount, 0);
  return { ...node, ownCount, totalCount };
}

// Drain every session under one `worktrees` node's `<name>` children into
// `rolled` + `branches`, tagging each with its gitBranch (or the `<name>` folder
// as fallback). Returns the `worktrees` node rebuilt with its children removed,
// or null when nothing remains. It survives (childless) only if it carries its
// OWN sessions — a session whose cwd is literally `<repo>/.claude/worktrees`,
// with no `<name>` segment. Such a session is not inside a named worktree (no
// branch to tag), so it is kept in place rather than rolled up; dropping it would
// be silent data loss, the same class as the `.claude`-self case in drainClaudeDir.
function drainWorktreesDir(
  worktreesNode: FolderNode,
  rolled: SessionMetadata[],
  branches: Map<string, string>,
): FolderNode | null {
  for (const worktree of worktreesNode.children) {
    const wtSessions: SessionMetadata[] = [];
    collectSessions(worktree, wtSessions);
    for (const sess of wtSessions) {
      rolled.push(sess);
      branches.set(sess.sessionId, sess.gitBranch ?? worktree.name);
    }
  }
  return worktreesNode.sessions.length > 0
    ? recount({ ...worktreesNode, children: [] })
    : null;
}

// Process one `.claude` node: drain its `worktrees` child into `rolled`/`branches`
// and return the `.claude` node rebuilt with its OTHER children (e.g. `projects`)
// kept, or null when nothing remains under it.
function drainClaudeDir(
  claudeNode: FolderNode,
  rolled: SessionMetadata[],
  branches: Map<string, string>,
): FolderNode | null {
  const kept: FolderNode[] = [];
  for (const grandchild of claudeNode.children) {
    if (grandchild.name === WORKTREES_DIR) {
      const keptWorktrees = drainWorktreesDir(grandchild, rolled, branches);
      if (keptWorktrees) kept.push(keptWorktrees);
    } else {
      kept.push(rollUpNode(grandchild));
    }
  }
  // Prune the `.claude` node only when nothing remains under it. It survives if
  // it keeps a non-worktrees child OR carries its own sessions (a session whose
  // cwd is literally `<repo>/.claude`) — dropping it then would lose those.
  return kept.length > 0 || claudeNode.sessions.length > 0
    ? recount({ ...claudeNode, children: kept })
    : null;
}

function rollUpNode(node: FolderNode): FolderNode {
  const keptChildren: FolderNode[] = [];
  const branches = new Map<string, string>();
  const rolled: SessionMetadata[] = [];

  for (const childNode of node.children) {
    if (childNode.name === CLAUDE_DIR) {
      const keptClaude = drainClaudeDir(childNode, rolled, branches);
      if (keptClaude) keptChildren.push(keptClaude);
    } else {
      keptChildren.push(rollUpNode(childNode));
    }
  }

  if (branches.size === 0) {
    // Nothing rolled up here; just carry the (possibly rewritten) children.
    return recount({ ...node, children: keptChildren });
  }
  return recount({
    ...node,
    sessions: sortSessionsNewestFirst([...node.sessions, ...rolled]),
    children: keptChildren,
    worktreeBranches: branches,
  });
}

export function rollUpWorktrees(tree: SessionTree): SessionTree {
  // The "(unknown)" group holds no `.claude` chain, so pass it through untouched.
  return {
    roots: tree.roots.map(rollUpNode),
    unknown: tree.unknown,
  };
}
