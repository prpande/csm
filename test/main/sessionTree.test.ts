import { test, expect, describe } from "vitest";
import {
  buildTree,
  compactTree,
  findFolder,
  rollUpWorktrees,
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
