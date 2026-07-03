import { test, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { defaultProjectsRoot } from "../../src/pathAdapter";

// pathAdapter is the OS seam that resolves the Claude projects root
// (<root>/<encoded-cwd>/<id>.jsonl) that sessionStore scans. `homedir` is
// injectable so per-OS resolution is asserted deterministically without mocking
// `os`. Pure resolution only — no fs — so these run without a fixture dir.

test("appends .claude/projects under the injected home with platform separators", () => {
  const home = join(tmpdir(), "csm-fake-home");
  expect(defaultProjectsRoot(home)).toBe(join(home, ".claude", "projects"));
});

test("appends exactly the .claude then projects segments under the home", () => {
  // Same test file runs on all 3 CI OSes. `path.relative` + the platform `sep`
  // make this deterministic per-OS: it proves the two appended segments without
  // hardcoding a separator, and (unlike a POSIX literal) won't be mangled by
  // Windows `join` normalizing a foreign home.
  const home = join(tmpdir(), "csm-fake-home");
  const segments = relative(home, defaultProjectsRoot(home)).split(sep);
  expect(segments).toEqual([".claude", "projects"]);
});

test("defaults to os.homedir() when no home is given", () => {
  expect(defaultProjectsRoot()).toBe(join(homedir(), ".claude", "projects"));
});

test("is pure resolution — returns a path for a non-existent home without touching disk", () => {
  const missing = join(tmpdir(), "csm-does-not-exist-xyz");
  expect(() => defaultProjectsRoot(missing)).not.toThrow();
  expect(defaultProjectsRoot(missing)).toBe(
    join(missing, ".claude", "projects"),
  );
});
