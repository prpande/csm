import { test, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultProjectsRoot } from "../../src/pathAdapter";

// pathAdapter is the OS seam that resolves the Claude projects root that
// sessionStore scans. `home` is injectable so per-OS resolution is asserted
// deterministically without mocking `os`; pure resolution (no fs) means these
// run without a fixture dir. `join` uses the platform separator, so case 1 is
// itself the per-OS assertion.

test("resolves <home>/.claude/projects under the injected home", () => {
  const home = join(tmpdir(), "csm-fake-home");
  expect(defaultProjectsRoot(home)).toBe(join(home, ".claude", "projects"));
});

test("defaults to os.homedir() when no home is given", () => {
  expect(defaultProjectsRoot()).toBe(join(homedir(), ".claude", "projects"));
});

test("is pure resolution — does not verify the home exists (no I/O)", () => {
  // Guards the intentional contract: a missing root is sessionStore's concern,
  // not this unit's — resolution must never stat/throw.
  const missing = join(tmpdir(), "csm-does-not-exist-xyz");
  expect(() => defaultProjectsRoot(missing)).not.toThrow();
});
