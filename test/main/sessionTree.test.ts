import { test, expect } from "vitest";
import { buildTree, UNKNOWN_CWD, type FolderNode } from "../../src/sessionTree";
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
