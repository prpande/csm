import { test, expect, describe } from "vitest";
import {
  buildTree,
  compactTree,
  findFolder,
  flattenVisible,
  isGitRepo,
  rollUpWorktrees,
  treeKeyAction,
  UNKNOWN_CWD,
  type FolderNode,
  type SessionTree,
} from "../../src/sessionTree";
import type { SessionMetadata } from "../../src/sessionParser";

// buildTree is a pure renderer-model builder (no DOM / no node runtime deps), so
// it is exercised here in the node tsconfig with plain fixtures. It turns the
// flat, per-tier SessionMetadata[] the #59 bridge streams into the hierarchical
// drive -> folder tree the UI renders: dedup, group, synthesize intermediate
// no-session folders, sort sessions newest-first, and split out the "(unknown)"
// group for the UI to pin last.

const s = (
  sessionId: string,
  cwd: string,
  lastActivity: string | null = null,
  extra: Partial<SessionMetadata> = {},
): SessionMetadata => ({
  sessionId,
  cwd,
  title: sessionId,
  permissionMode: "default",
  lastActivity,
  gitBranch: null,
  ...extra,
});

// Find a direct child by name (throws if absent -> a clear test failure).
const child = (node: FolderNode, name: string): FolderNode => {
  const found = node.children.find((c) => c.name === name);
  if (!found) throw new Error(`no child "${name}" under "${node.path}"`);
  return found;
};

test("empty input yields no roots and no unknown group", () => {
  expect(buildTree([])).toEqual({ roots: [], unknown: null });
});

test("a single session builds the full ancestor chain to a leaf holding it", () => {
  const { roots, unknown } = buildTree([s("a", "D:\\src\\csm")]);
  expect(unknown).toBeNull();
  expect(roots).toHaveLength(1);

  const drive = roots[0];
  expect(drive.name).toBe("D:");
  expect(drive.path).toBe("D:");
  expect(drive.ownCount).toBe(0);
  expect(drive.totalCount).toBe(1);

  const src = child(drive, "src");
  expect(src.path).toBe("D:\\src");
  expect(src.ownCount).toBe(0);
  expect(src.totalCount).toBe(1);

  const csm = child(src, "csm");
  expect(csm.path).toBe("D:\\src\\csm");
  expect(csm.ownCount).toBe(1);
  expect(csm.sessions.map((x) => x.sessionId)).toEqual(["a"]);
  expect(csm.children).toEqual([]);
});

test("sessions under a shared parent synthesize one intermediate folder", () => {
  const { roots } = buildTree([
    s("a", "D:\\src\\csm"),
    s("b", "D:\\src\\prism"),
  ]);
  const src = child(roots[0], "src");
  expect(src.ownCount).toBe(0);
  expect(src.totalCount).toBe(2);
  expect(src.children.map((c) => c.name)).toEqual(["csm", "prism"]);
});

test("a cwd that is an ancestor of another cwd holds both sessions and children", () => {
  const { roots } = buildTree([
    s("parent", "D:\\src"),
    s("nested", "D:\\src\\csm"),
  ]);
  const src = child(roots[0], "src");
  expect(src.ownCount).toBe(1);
  expect(src.sessions.map((x) => x.sessionId)).toEqual(["parent"]);
  expect(src.totalCount).toBe(2);
  expect(child(src, "csm").ownCount).toBe(1);
});

test("sessions within a folder are sorted newest-first, nulls last", () => {
  const { roots } = buildTree([
    s("mid", "D:\\p", "2026-07-02T00:00:00.000Z"),
    s("old", "D:\\p", "2026-07-01T00:00:00.000Z"),
    s("none", "D:\\p", null),
    s("new", "D:\\p", "2026-07-03T00:00:00.000Z"),
  ]);
  const p = child(roots[0], "p");
  expect(p.sessions.map((x) => x.sessionId)).toEqual([
    "new",
    "mid",
    "old",
    "none",
  ]);
});

test("(unknown)-cwd sessions go to the unknown group, never into roots, regardless of order", () => {
  const { roots, unknown } = buildTree([
    s("u", UNKNOWN_CWD),
    s("real", "D:\\src\\csm"),
  ]);
  expect(unknown).not.toBeNull();
  expect(unknown!.name).toBe(UNKNOWN_CWD);
  expect(unknown!.sessions.map((x) => x.sessionId)).toEqual(["u"]);
  expect(unknown!.ownCount).toBe(1);
  expect(roots.map((r) => r.name)).toEqual(["D:"]);
});

test("a duplicate sessionId across batches is deduped, last wins", () => {
  const { roots } = buildTree([
    s("dup", "D:\\p", "2026-07-01T00:00:00.000Z", { title: "first" }),
    s("dup", "D:\\p", "2026-07-02T00:00:00.000Z", { title: "second" }),
  ]);
  const p = child(roots[0], "p");
  expect(p.ownCount).toBe(1);
  expect(p.sessions[0].title).toBe("second");
});

test("sibling folders are sorted case-insensitively by name", () => {
  const { roots } = buildTree([
    s("b", "D:\\B"),
    s("a", "D:\\a"),
    s("c", "D:\\C"),
  ]);
  expect(roots[0].children.map((c) => c.name)).toEqual(["a", "B", "C"]);
});

test("POSIX absolute cwds nest under a '/' root", () => {
  const { roots } = buildTree([s("a", "/Users/x/proj")]);
  const root = roots[0];
  expect(root.name).toBe("/");
  expect(root.path).toBe("/");
  const users = child(root, "Users");
  expect(users.path).toBe("/Users");
  const proj = child(child(users, "x"), "proj");
  expect(proj.path).toBe("/Users/x/proj");
  expect(proj.ownCount).toBe(1);
});

test("totalCount aggregates sessions across the whole subtree depth", () => {
  const { roots } = buildTree([
    s("deep", "D:\\src\\csm\\sub"),
    s("side", "D:\\src\\other"),
    s("own", "D:\\src"),
  ]);
  const drive = roots[0];
  expect(drive.totalCount).toBe(3);
  const src = child(drive, "src");
  expect(src.totalCount).toBe(3);
  expect(src.ownCount).toBe(1);
  expect(child(src, "csm").totalCount).toBe(1);
});

// findFolder — the pure lookup the FolderBrowser container uses to resolve a
// persisted selectedPath back to a node against the current tree (so selection
// survives a rebuild, or self-clears when the folder disappears). Walks roots
// AND the pinned "(unknown)" group.

test("findFolder returns a root node by its path", () => {
  const tree = buildTree([s("a", "D:\\src\\csm")]);
  const hit = findFolder(tree, "D:");
  expect(hit?.name).toBe("D:");
});

test("findFolder returns a deeply nested node by its full path", () => {
  const tree = buildTree([s("a", "D:\\src\\csm")]);
  const hit = findFolder(tree, "D:\\src\\csm");
  expect(hit?.name).toBe("csm");
  expect(hit?.ownCount).toBe(1);
});

test("findFolder resolves the pinned (unknown) group", () => {
  const tree = buildTree([s("a", UNKNOWN_CWD)]);
  const hit = findFolder(tree, UNKNOWN_CWD);
  expect(hit?.name).toBe(UNKNOWN_CWD);
  expect(hit?.ownCount).toBe(1);
});

test("findFolder returns null when no node has the path", () => {
  const tree = buildTree([s("a", "D:\\src\\csm")]);
  expect(findFolder(tree, "D:\\nope")).toBeNull();
});

// compactTree — the pure #77 transform over buildTree output. It collapses a
// folder into its single child when the folder has zero own sessions and exactly
// one child, stopping at the first folder that owns sessions or branches. The
// merged node's label is the joined path of the absorbed segments; its identity
// (path, sessions, children, counts) is the deepest node's, so selection,
// expansion, and counts survive.

describe("compactTree", () => {
  test("an unbroken single-child chain collapses to one node labelled with the full path", () => {
    const cwd = "C:\\Users\\praty\\AppData\\Local\\Temp\\worktrees\\42-hotfix";
    const { roots, unknown } = compactTree(buildTree([s("a", cwd)]));
    expect(unknown).toBeNull();
    expect(roots).toHaveLength(1);

    const node = roots[0];
    expect(node.name).toBe(cwd); // full path as the single label
    expect(node.path).toBe(cwd); // deepest node's identity preserved
    expect(node.children).toEqual([]);
    expect(node.ownCount).toBe(1); // owns sessions -> selectable
    expect(node.sessions.map((x) => x.sessionId)).toEqual(["a"]);
  });

  test("a branch point is preserved and stays expandable", () => {
    const { roots } = compactTree(
      buildTree([s("a", "D:\\src\\csm"), s("b", "D:\\src\\prism")]),
    );
    // D: -> src collapses (D: has one child, no own sessions), stopping at src,
    // which branches into two children.
    expect(roots).toHaveLength(1);
    const src = roots[0];
    expect(src.name).toBe("D:\\src");
    expect(src.path).toBe("D:\\src");
    expect(src.ownCount).toBe(0); // pure navigation node
    expect(src.children.map((c) => c.name)).toEqual(["csm", "prism"]);
  });

  test("a folder that owns sessions is never absorbed, even with a single child", () => {
    const { roots } = compactTree(
      buildTree([s("parent", "D:\\src"), s("nested", "D:\\src\\csm")]),
    );
    // D: (0 own, 1 child) collapses into src, but src owns a session so the
    // chain stops there — src is NOT absorbed into csm.
    expect(roots).toHaveLength(1);
    const src = roots[0];
    expect(src.name).toBe("D:\\src");
    expect(src.ownCount).toBe(1);
    expect(src.sessions.map((x) => x.sessionId)).toEqual(["parent"]);
    expect(src.children.map((c) => c.name)).toEqual(["csm"]);
    expect(child(src, "csm").ownCount).toBe(1);
  });

  test("a sub-chain below a branch collapses with a relative joined label", () => {
    const { roots } = compactTree(
      buildTree([s("flat", "D:\\src\\csm"), s("deep", "D:\\src\\a\\b\\c")]),
    );
    const src = roots[0];
    expect(src.name).toBe("D:\\src");
    // csm is a plain leaf; the a->b->c chain collapses to one relative-labelled
    // node whose identity is the deepest folder.
    expect(src.children.map((c) => c.name)).toEqual(["a\\b\\c", "csm"]);
    const abc = child(src, "a\\b\\c");
    expect(abc.path).toBe("D:\\src\\a\\b\\c");
    expect(abc.ownCount).toBe(1);
    expect(abc.sessions.map((x) => x.sessionId)).toEqual(["deep"]);
  });

  test("a drive that branches immediately keeps the bare drive as the root", () => {
    // The drive owns no sessions but has two immediate children, so it branches
    // at the root — it is NOT absorbed and its label stays the bare drive.
    const { roots } = compactTree(
      buildTree([s("a", "C:\\work"), s("b", "C:\\play")]),
    );
    expect(roots).toHaveLength(1);
    const drive = roots[0];
    expect(drive.name).toBe("C:");
    expect(drive.path).toBe("C:");
    expect(drive.ownCount).toBe(0);
    expect(drive.children.map((c) => c.name)).toEqual(["play", "work"]);
  });

  test("cross-drive / disjoint sessions produce multiple compact roots", () => {
    const { roots } = compactTree(
      buildTree([s("c", "C:\\work\\proj"), s("d", "D:\\src\\csm")]),
    );
    expect(roots).toHaveLength(2);
    expect(roots.map((r) => r.name)).toEqual([
      "C:\\work\\proj",
      "D:\\src\\csm",
    ]);
    for (const r of roots) {
      expect(r.ownCount).toBe(1);
      expect(r.children).toEqual([]);
    }
  });

  test("a POSIX single-child chain collapses with a '/'-joined label", () => {
    const { roots } = compactTree(buildTree([s("a", "/Users/x/proj")]));
    expect(roots).toHaveLength(1);
    const node = roots[0];
    expect(node.name).toBe("/Users/x/proj");
    expect(node.path).toBe("/Users/x/proj");
    expect(node.ownCount).toBe(1);
  });

  test("totalCount and subtree counts survive compaction", () => {
    const { roots } = compactTree(
      buildTree([s("deep", "D:\\src\\csm\\sub"), s("side", "D:\\src\\other")]),
    );
    const src = roots[0];
    expect(src.name).toBe("D:\\src"); // D: absorbed, branch at src
    expect(src.totalCount).toBe(2);
    expect(src.ownCount).toBe(0);
    // csm -> sub is a single-child chain: collapses to one "csm\\sub" leaf.
    expect(src.children.map((c) => c.name)).toEqual(["csm\\sub", "other"]);
    expect(child(src, "csm\\sub").totalCount).toBe(1);
    expect(child(src, "csm\\sub").path).toBe("D:\\src\\csm\\sub");
  });

  test("the (unknown) group passes through unchanged", () => {
    const { roots, unknown } = compactTree(
      buildTree([s("u", UNKNOWN_CWD), s("real", "D:\\src\\csm")]),
    );
    expect(unknown).not.toBeNull();
    expect(unknown!.name).toBe(UNKNOWN_CWD);
    expect(unknown!.ownCount).toBe(1);
    expect(roots[0].name).toBe("D:\\src\\csm"); // real chain still compacts
  });

  test("findFolder resolves a selectable leaf by its surviving path after compaction", () => {
    const tree = compactTree(buildTree([s("a", "D:\\src\\csm")]));
    // The absorbed intermediate paths (D:, D:\\src) are gone, but the deepest
    // node's path — the only selectable identity — survives.
    expect(findFolder(tree, "D:\\src\\csm")?.ownCount).toBe(1);
    expect(findFolder(tree, "D:")).toBeNull();
  });
});

// rollUpWorktrees — folds each `<repo>/.claude/worktrees/<name>` session into the
// owning project node (the node before `.claude`), tagged with its branch, and
// prunes the worktree subtree. Runs BEFORE compactTree. Pure, node-safe.
describe("rollUpWorktrees", () => {
  const WT = "D:\\src\\csm\\.claude\\worktrees\\icon-rebrand";
  // The owning project node in an un-compacted D:\src\<name> tree.
  const csmOf = (tree: SessionTree): FolderNode =>
    child(child(tree.roots[0], "src"), "csm");

  test("folds a .claude/worktrees session into the owning project node", () => {
    const tree = rollUpWorktrees(
      buildTree([
        s("own", "D:\\src\\csm", "2026-07-01T00:00:00.000Z"),
        s("wt", WT, "2026-07-02T00:00:00.000Z", { gitBranch: "feature-x" }),
      ]),
    );
    const csm = csmOf(tree);
    // worktree subtree removed
    expect(csm.children.find((c) => c.name === ".claude")).toBeUndefined();
    // both sessions belong to the owning node, newest-first
    expect(csm.sessions.map((x) => x.sessionId)).toEqual(["wt", "own"]);
    expect(csm.ownCount).toBe(2);
    // provenance: only the worktree session is tagged, with its gitBranch
    expect(csm.worktreeBranches.get("wt")).toBe("feature-x");
    expect(csm.worktreeBranches.has("own")).toBe(false);
  });

  test("branch label falls back to the worktree folder name when gitBranch is null", () => {
    const csm = csmOf(rollUpWorktrees(buildTree([s("wt", WT)])));
    expect(csm.worktreeBranches.get("wt")).toBe("icon-rebrand");
  });

  test("synthesizes a selectable owning node for a worktree-only project", () => {
    const csm = csmOf(
      rollUpWorktrees(buildTree([s("wt", WT, null, { gitBranch: "b" })])),
    );
    expect(csm.ownCount).toBe(1); // now selectable
    expect(csm.sessions[0].sessionId).toBe("wt");
    expect(csm.children).toHaveLength(0); // .claude chain gone
  });

  test("a deeper worktree cwd (subdir) still rolls up under the folder-name branch", () => {
    const csm = csmOf(
      rollUpWorktrees(buildTree([s("wt", WT + "\\packages\\app")])),
    );
    expect(csm.sessions.map((x) => x.sessionId)).toEqual(["wt"]);
    expect(csm.worktreeBranches.get("wt")).toBe("icon-rebrand");
  });

  test("prunes only the worktrees subtree, keeping other .claude children", () => {
    const tree = rollUpWorktrees(
      buildTree([s("wt", WT), s("o", "D:\\src\\csm\\.claude\\projects\\p")]),
    );
    const csm = csmOf(tree);
    const claude = csm.children.find((c) => c.name === ".claude");
    expect(claude).toBeDefined();
    expect(claude!.children.map((c) => c.name)).toEqual(["projects"]);
    expect(csm.worktreeBranches.get("wt")).toBe("icon-rebrand");
  });

  test("keeps a session whose cwd is the .claude dir itself while draining its worktrees sibling", () => {
    // Corner case: a session launched from `<repo>/.claude` gives that node its
    // own sessions, and if `worktrees` is its ONLY child the drain must not prune
    // the node out from under those sessions (silent data loss).
    const CC = "D:\\src\\csm\\.claude";
    const tree = rollUpWorktrees(
      buildTree([s("wt", WT, null, { gitBranch: "b" }), s("cc", CC)]),
    );
    const csm = csmOf(tree);
    // The worktree session still rolls up to the owning project node...
    expect(csm.sessions.map((x) => x.sessionId)).toEqual(["wt"]);
    expect(csm.worktreeBranches.get("wt")).toBe("b");
    // ...but the `.claude`-cwd session survives on a kept `.claude` node.
    const claude = csm.children.find((c) => c.name === ".claude");
    expect(claude).toBeDefined();
    expect(claude!.sessions.map((x) => x.sessionId)).toEqual(["cc"]);
    expect(claude!.children).toHaveLength(0); // worktrees subtree drained
    // No session dropped: wt + cc = 2.
    expect(csm.totalCount).toBe(2);
  });

  test("keeps a session whose cwd is the worktrees dir itself (no <name> segment)", () => {
    // Corner case one level below the `.claude`-self case: a session launched from
    // `<repo>/.claude/worktrees` (no worktree-name segment) lands as an own-session
    // ON the `worktrees` node. It is not inside a named worktree, so it has no
    // branch to tag and must not be rolled up — but draining must not prune it out
    // from under itself (silent data loss). It survives on a kept `worktrees` node.
    const WTS = "D:\\src\\csm\\.claude\\worktrees";
    const tree = rollUpWorktrees(
      buildTree([s("wt", WT, null, { gitBranch: "b" }), s("bare", WTS)]),
    );
    const csm = csmOf(tree);
    // The named-worktree session still rolls up to the owning project node...
    expect(csm.sessions.map((x) => x.sessionId)).toEqual(["wt"]);
    expect(csm.worktreeBranches.get("wt")).toBe("b");
    // ...the bare `worktrees`-cwd session is NOT rolled up (no branch tag)...
    expect(csm.worktreeBranches.has("bare")).toBe(false);
    // ...it survives on a kept `worktrees` node under `.claude`.
    const claude = csm.children.find((c) => c.name === ".claude");
    expect(claude).toBeDefined();
    const worktrees = claude!.children.find((c) => c.name === "worktrees");
    expect(worktrees).toBeDefined();
    expect(worktrees!.sessions.map((x) => x.sessionId)).toEqual(["bare"]);
    expect(worktrees!.children).toHaveLength(0); // named-worktree subtree drained
    // No session dropped: wt + bare = 2.
    expect(csm.totalCount).toBe(2);
  });

  test("leaves a non-worktree tree structurally unchanged with empty provenance", () => {
    const tree = rollUpWorktrees(
      buildTree([s("a", "D:\\src\\csm"), s("b", "D:\\src\\other\\sub")]),
    );
    expect(csmOf(tree).worktreeBranches.size).toBe(0);
    expect(csmOf(tree).ownCount).toBe(1);
    expect(child(child(tree.roots[0], "src"), "other").totalCount).toBe(1);
  });

  test("conserves the total count and composes under compactTree", () => {
    const built = buildTree([
      s("own", "D:\\src\\csm"),
      s("wt", WT, null, { gitBranch: "b" }),
    ]);
    const before = built.roots[0].totalCount; // own + wt = 2
    const rolled = rollUpWorktrees(built);
    expect(rolled.roots[0].totalCount).toBe(before);
    // compaction then collapses D: -> src -> csm to one node, provenance intact
    const top = compactTree(rolled).roots[0];
    expect(top.name).toBe("D:\\src\\csm");
    expect(top.ownCount).toBe(2);
    expect(top.worktreeBranches.get("wt")).toBe("b");
  });

  test("the (unknown) group passes through unchanged", () => {
    const tree = rollUpWorktrees(buildTree([s("u", UNKNOWN_CWD)]));
    expect(tree.unknown?.ownCount).toBe(1);
  });
});

// isGitRepo (#111) — a folder whose sessions carry a gitBranch WAS a git working
// tree at session time. Derived on read from the node's own sessions: no fs, no
// .git probe, no git subprocess — which is why it still answers for a folder
// that has since been deleted.
describe("isGitRepo", () => {
  const at = (tree: SessionTree, ...names: string[]): FolderNode =>
    names.reduce((n, name) => child(n, name), tree.roots[0]);

  test("false when none of the folder's own sessions carry a branch", () => {
    const tree = buildTree([s("a", "D:\\scratch\\notes")]);
    expect(isGitRepo(at(tree, "scratch", "notes"))).toBe(false);
  });

  test("true when at least one own session carries a branch", () => {
    const tree = buildTree([
      s("a", "D:\\src\\csm", null, { gitBranch: "feature-x" }),
    ]);
    expect(isGitRepo(at(tree, "src", "csm"))).toBe(true);
  });

  test("a mix of branch-carrying and branchless sessions is still a repo", () => {
    // `some`, not `every`: older sessions predating the gitBranch field must not
    // mask a repo that later sessions prove.
    const tree = buildTree([
      s("old", "D:\\src\\csm", "2026-07-01T00:00:00.000Z"),
      s("new", "D:\\src\\csm", "2026-07-02T00:00:00.000Z", {
        gitBranch: "main",
      }),
    ]);
    expect(isGitRepo(at(tree, "src", "csm"))).toBe(true);
  });

  test("`main` counts — the repo marker is not the row's noise rule", () => {
    // #110 suppresses a `main` CHIP as noise; being on main still makes the
    // folder a repo. The two rules must not be conflated.
    const tree = buildTree([
      s("a", "D:\\src\\csm", null, { gitBranch: "main" }),
    ]);
    expect(isGitRepo(at(tree, "src", "csm"))).toBe(true);
  });

  test("an intermediate nav folder is not a repo, even above a repo child", () => {
    // D:\src owns no sessions; its child does. Own sessions only — a parent
    // directory of a repo is not itself a repo.
    const tree = buildTree([
      s("a", "D:\\src\\csm", null, { gitBranch: "feature-x" }),
    ]);
    const src = child(tree.roots[0], "src");
    expect(src.ownCount).toBe(0);
    expect(isGitRepo(src)).toBe(false);
    expect(isGitRepo(child(src, "csm"))).toBe(true);
  });

  test("a roll-up owner is a repo via its folded-in worktree sessions", () => {
    // The project owns the worktrees, so branch-carrying sessions arriving by
    // #101 roll-up legitimately mark it — including when the owner node was
    // synthesized and has no sessions of its own.
    const tree = rollUpWorktrees(
      buildTree([
        s("wt", "D:\\src\\csm\\.claude\\worktrees\\icon-rebrand", null, {
          gitBranch: "feature-x",
        }),
      ]),
    );
    expect(isGitRepo(child(child(tree.roots[0], "src"), "csm"))).toBe(true);
  });

  test("a compacted chain follows the merged leaf's sessions", () => {
    // #77 collapses D:\src\csm to one node; the marker must survive that
    // rewrite rather than be lost with the intermediate nodes.
    const tree = compactTree(
      buildTree([s("a", "D:\\src\\csm", null, { gitBranch: "feature-x" })]),
    );
    expect(isGitRepo(tree.roots[0])).toBe(true);
  });

  test("the (unknown) group is not a repo, even holding a branch-carrying session", () => {
    // NOT a vacuous case. parseSession resolves cwd and gitBranch in
    // independent passes — cwd from the first record carrying one (else the
    // "(unknown)" fallback), gitBranch from the last non-empty one — so a file
    // whose records carry a gitBranch but never a cwd genuinely lands in this
    // bucket WITH a branch. (The parser suite builds exactly that record shape.)
    // "(unknown)" is a bucket, not a working tree, and must never claim to be.
    const tree = buildTree([s("u", UNKNOWN_CWD, null, { gitBranch: "main" })]);
    // Precondition: the branch really did survive into the bucket. Without this
    // the assertion below could pass for the wrong reason — which is exactly how
    // the first version of this test passed while the defect was live.
    expect(tree.unknown!.sessions[0].gitBranch).toBe("main");
    expect(isGitRepo(tree.unknown!)).toBe(false);
  });
});

// flattenVisible (#70) — the visible row order, for keyboard traversal. Must
// mirror TreeNode's render EXACTLY (roots in order, unknown pinned last, and
// children only when expanded), because arrow keys walk this array while the
// user sees the render. Any divergence is an off-by-one the user feels.
describe("flattenVisible", () => {
  const paths = (tree: SessionTree, expanded: string[]) =>
    flattenVisible(tree, new Set(expanded)).map((f) => f.node.path);

  test("an empty tree flattens to nothing", () => {
    expect(flattenVisible(buildTree([]), new Set())).toEqual([]);
  });

  test("a collapsed node's children are excluded", () => {
    // Mirrors the render: a collapsed node does not mount its child <ul> at all,
    // so those rows must not be arrow-reachable either.
    const tree = buildTree([s("a", "D:\\src\\csm"), s("b", "D:\\src\\prism")]);
    expect(paths(tree, [])).toEqual(["D:"]);
  });

  test("expanding walks children in render order, depth-first", () => {
    const tree = buildTree([s("a", "D:\\src\\csm"), s("b", "D:\\src\\prism")]);
    expect(paths(tree, ["D:", "D:\\src"])).toEqual([
      "D:",
      "D:\\src",
      "D:\\src\\csm",
      "D:\\src\\prism",
    ]);
  });

  test("a partially expanded subtree stops at the collapsed node", () => {
    const tree = buildTree([s("a", "D:\\src\\csm\\deep"), s("b", "D:\\other")]);
    // D: expanded, src expanded, csm NOT expanded -> deep is not reachable.
    expect(paths(tree, ["D:", "D:\\src"])).toEqual([
      "D:",
      "D:\\other",
      "D:\\src",
      "D:\\src\\csm",
    ]);
  });

  test("the (unknown) group is pinned last, after every root", () => {
    // FolderTree renders roots then unknown; traversal must agree or Down from
    // the last root would jump somewhere the user isn't looking.
    const tree = buildTree([s("u", UNKNOWN_CWD), s("a", "D:\\proj")]);
    expect(paths(tree, [])).toEqual(["D:", UNKNOWN_CWD]);
  });

  test("depth and parentPath describe each row's place in the tree", () => {
    const tree = buildTree([s("a", "D:\\src\\csm"), s("b", "D:\\src\\prism")]);
    const flat = flattenVisible(tree, new Set(["D:", "D:\\src"]));
    expect(flat.map((f) => [f.node.path, f.depth, f.parentPath])).toEqual([
      ["D:", 0, null],
      ["D:\\src", 1, "D:"],
      ["D:\\src\\csm", 2, "D:\\src"],
      ["D:\\src\\prism", 2, "D:\\src"],
    ]);
  });

  test("a root's parentPath is null, so Left from a root goes nowhere", () => {
    const tree = buildTree([s("u", UNKNOWN_CWD), s("a", "D:\\proj")]);
    expect(flattenVisible(tree, new Set()).map((f) => f.parentPath)).toEqual([
      null,
      null,
    ]);
  });

  test("expanding a path that isn't in the tree changes nothing", () => {
    const tree = buildTree([s("a", "D:\\src\\csm")]);
    expect(paths(tree, ["D:\\nope"])).toEqual(["D:"]);
  });
});

// treeKeyAction (#70) — the whole key map, pure. Kept out of the component so it
// is testable with no DOM, and so FolderTree stays a dispatcher.
describe("treeKeyAction", () => {
  // D: > src > {csm (1 session), prism (1 session)} — a nav chain over two leaves.
  const tree = buildTree([s("a", "D:\\src\\csm"), s("b", "D:\\src\\prism")]);
  const OPEN = new Set(["D:", "D:\\src"]);
  const act = (
    key: string,
    focused: string | null,
    expanded: ReadonlySet<string> = OPEN,
  ) => treeKeyAction(key, flattenVisible(tree, expanded), focused, expanded);

  test("Down/Up step through the visible rows", () => {
    expect(act("ArrowDown", "D:")).toEqual({ type: "focus", path: "D:\\src" });
    expect(act("ArrowUp", "D:\\src")).toEqual({ type: "focus", path: "D:" });
  });

  test("the ends of the list are dead-stops, not wraps", () => {
    // Wrapping would silently teleport the user across the whole sidebar.
    expect(act("ArrowUp", "D:")).toEqual({ type: "focus", path: "D:" });
    expect(act("ArrowDown", "D:\\src\\prism")).toEqual({
      type: "focus",
      path: "D:\\src\\prism",
    });
  });

  test("Down from nothing-focused lands on the first row, not the second", () => {
    // The fallback treats "no focus" as index 0; it must not then step off it,
    // or the very first keypress would skip a row.
    expect(act("ArrowDown", null)).toEqual({ type: "focus", path: "D:" });
  });

  test("a focused path that vanished mid-scan falls back to the first row", () => {
    expect(act("ArrowDown", "D:\\gone")).toEqual({ type: "focus", path: "D:" });
  });

  test("Right opens a closed node in place, then descends once open", () => {
    expect(act("ArrowRight", "D:", new Set())).toEqual({
      type: "toggle",
      path: "D:",
    });
    expect(act("ArrowRight", "D:\\src")).toEqual({
      type: "focus",
      path: "D:\\src\\csm",
    });
  });

  test("Right on a leaf does nothing", () => {
    expect(act("ArrowRight", "D:\\src\\csm")).toBeNull();
  });

  test("Left closes an open node in place, then ascends once closed", () => {
    expect(act("ArrowLeft", "D:\\src")).toEqual({
      type: "toggle",
      path: "D:\\src",
    });
    expect(act("ArrowLeft", "D:\\src\\csm")).toEqual({
      type: "focus",
      path: "D:\\src",
    });
  });

  test("Left on a collapsed root does nothing — there is nowhere further out", () => {
    expect(act("ArrowLeft", "D:", new Set())).toBeNull();
  });

  test("Enter and Space select a folder that owns sessions", () => {
    for (const key of ["Enter", " "]) {
      const a = act(key, "D:\\src\\csm");
      expect(a?.type).toBe("select");
      expect(a?.type === "select" && a.node.path).toBe("D:\\src\\csm");
    }
  });

  test("Enter on a pure nav folder toggles instead of selecting", () => {
    // Mirrors the mouse: a 0-session folder isn't selectable, so it expands.
    expect(act("Enter", "D:\\src")).toEqual({
      type: "toggle",
      path: "D:\\src",
    });
  });

  test("an unhandled key returns null so the tree doesn't swallow it", () => {
    // Tab in particular MUST pass through — it's how focus leaves the pane.
    expect(act("Tab", "D:")).toBeNull();
    expect(act("a", "D:")).toBeNull();
    expect(act("Escape", "D:")).toBeNull();
  });

  test("an empty tree yields no action for any key", () => {
    const empty = buildTree([]);
    expect(
      treeKeyAction(
        "ArrowDown",
        flattenVisible(empty, new Set()),
        null,
        new Set(),
      ),
    ).toBeNull();
  });
});
