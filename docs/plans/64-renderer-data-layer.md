# Plan — #64 Renderer data layer: `useSessionScan` + pure folder-tree view-model

**Tier:** Standard (new pure module + new hook + tests). Touches
`src/sessionTree.ts` (new), `src/renderer/hooks/useSessionScan.ts` (new),
`test/main/sessionTree.test.ts` (new), `test/renderer/useSessionScan.test.tsx`
(new). Renderer-only consumer; **no** main-process or bridge changes.

## Goal

Turn the #59 bridge stream (`csm.listSessions()` → `sessions:batch` per tier →
`done`/`error`) into a hierarchical, selectable folder-tree view-model the UI
slices (#65–#70) render. No visual components here — the pure model plus the
thin hook that drives the bridge.

`sessionStore` emits flat, per-tier `SessionMetadata[]` batches; the tree, the
sort, and the `(unknown)`-pinning all belong to the renderer. This slice builds
and tests that model.

## Approach (chosen: A — recompute)

Flat accumulator + a single pure `buildTree(sessions[])` recomputed (memoized)
per batch. Batches are ≤6 (one per age tier) and n is a few thousand at most, so
a full O(n log n) rebuild ~6 times is single-digit ms — incremental tree
mutation (rejected approach B) would multiply the bug/test surface to optimize a
non-problem.

### Pure model — `src/sessionTree.ts` (no DOM, no node; `import type SessionMetadata`)

Placed beside `sessionParser`/`sessionStore` (not under `src/renderer/`) so its
tests run in the **node** tsconfig (`test/main/`) with real local signal, while
staying importable by the DOM-only renderer (it uses no platform APIs).

```ts
export interface FolderNode {
  name: string;                 // path segment ("src", "PRism"); root = drive/"/"
  path: string;                 // full path of this node (leaf === session cwd)
  sessions: SessionMetadata[];  // this folder's own sessions, newest-first
  children: FolderNode[];       // subfolders (synthesized intermediates: sessions=[])
  ownCount: number;             // sessions.length
  totalCount: number;           // own + all descendants
}
export interface SessionTree {
  roots: FolderNode[];          // top nodes (drives / POSIX root), sorted
  unknown: FolderNode | null;   // the "(unknown)" cwd group, pinned last by the UI
}
export function buildTree(sessions: SessionMetadata[]): SessionTree;
```

`buildTree` responsibilities (order-independent, pure):

1. **Dedup by `sessionId`** (last wins) — defensive against overlapping tiers /
   a re-scan; lets the hook simply concat batches and rebuild.
2. **Split known vs `(unknown)`** cwd (the sessionParser fallback). Unknown
   sessions become the `unknown` node (name `(unknown)`, no children), returned
   separately so the UI pins it after all roots (spec §9).
3. **Segment each cwd** into `root + segments`, tolerant of both `\` and `/`
   separators (sessions are local/same-OS, but the splitter stays robust):
   Windows `D:\src\csm` → root `D:`, `["src","csm"]`; POSIX `/Users/a/p` → root
   `/`, `["Users","a","p"]`. Node `path` is the reconstructed prefix using the
   cwd's own separator.
4. **Build the nested tree**, synthesizing intermediate no-session folders (e.g.
   `D:` and `src` when only `D:\src\csm` has sessions). A node may hold BOTH own
   sessions and children (a cwd that is an ancestor of another cwd).
5. **Sort sessions newest-first** within each folder by `lastActivity` (ISO;
   `null` sorts last).
6. **Sort sibling folders** deterministically — case-insensitive by `name`.
   (Recency-based folder ordering is a UI call; deferred to slice 2 if wanted.)
7. **Compute `ownCount` / `totalCount`** (descendant aggregate).

### Hook — `src/renderer/hooks/useSessionScan.ts` (thin; React + `window.csm`)

```ts
type ScanStatus = "scanning" | "done" | "error";
function useSessionScan(bridge = window.csm): {
  tree: SessionTree;            // useMemo(buildTree, [sessions])
  status: ScanStatus;
  refresh: () => void;
};
```

- On mount (and on `refresh()`), clear accumulated sessions, `status:"scanning"`,
  call `bridge.listSessions({ onBatch, onDone, onError })`.
- `onBatch(batch)` → `setSessions(prev => prev.concat(batch))` (buildTree dedups).
- `onDone` → `status:"done"`; `onError` → `status:"error"` (keep batches already
  shown — fail soft, spec §12).
- Cleanup: call the returned unsubscribe on unmount / before a refresh restart.
- **Bridge absent** (`window.csm` undefined — plain browser / non-desktop):
  `status:"error"`, empty tree, no throw. (`bridge` is injectable for tests.)

## Tests

### `test/main/sessionTree.test.ts` (node — runs locally, primary TDD signal)

1. Empty input → `{ roots: [], unknown: null }`.
2. Single session → root chain to a leaf holding it; counts correct.
3. Two sessions under a shared parent → intermediate parent synthesized,
   `ownCount 0`, `totalCount 2`, two children.
4. A cwd that is an ancestor of another cwd → node has own sessions AND children.
5. Sessions sorted newest-first within a folder; `lastActivity: null` sorts last.
6. `(unknown)` cwd → returned in `unknown`, never in `roots`, regardless of
   input order.
7. Dedup: duplicate `sessionId` → single entry (last wins).
8. Sibling folders sorted case-insensitively by name.
9. Windows (`D:\…`) and POSIX (`/…`) cwds both nest correctly (separator
   handling, root labeling).
10. `totalCount` aggregates descendants across depth.

### `test/renderer/useSessionScan.test.tsx` (renderer — CI-verified)

Uses a fake bridge (records the listener, returns a spy unsubscribe):
- Mount calls `listSessions`; a delivered batch appears in `tree`; `onDone` →
  `status:"done"`.
- Empty scan (`onDone`, no batch) → `done`, empty tree.
- `onError` → `status:"error"`.
- Unmount calls the unsubscribe.
- `refresh()` restarts (unsubscribes the prior scan, clears, re-invokes).
- `bridge` undefined → `status:"error"`, no throw.

## Out of scope (separate slices, already filed)

- Any visual component — sidebar tree / folder shell (#65), list + rows (#66).
- Reopen + bypass modal (#67), settings modal (#68).
- The default-on temp/worktree **filter** + toggle (#69) — placement is an open
  design decision; this slice deliberately does not filter.
- Virtualization (#66) and keyboard nav (#70).
