// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BODY_MAX_BYTES,
  buildGraphqlArgs,
  ghEnv,
  parseGraphqlOutput,
  resolveGhPath,
  runGhBatch,
  truncateUtf8,
  type GhRunner,
} from "../../../src/search/ghClient";

const FAKE_GH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-gh.mjs",
);

describe("resolveGhPath", () => {
  test("finds gh.exe on a Windows Path", () => {
    const isFile = (p: string) => p === "C:\\b\\gh.exe";
    expect(resolveGhPath({ Path: "C:\\a;C:\\b" }, "win32", isFile)).toBe(
      "C:\\b\\gh.exe",
    );
  });

  test("ignores a gh.cmd shim on Windows", () => {
    const isFile = (p: string) => p === "C:\\a\\gh.cmd";
    expect(resolveGhPath({ PATH: "C:\\a" }, "win32", isFile)).toBeUndefined();
  });

  test("finds gh on a POSIX PATH", () => {
    const isFile = (p: string) => p === "/y/gh";
    expect(resolveGhPath({ PATH: "/x:/y" }, "linux", isFile)).toBe("/y/gh");
  });

  test("falls back to Homebrew locations on darwin only", () => {
    const isFile = (p: string) => p === "/usr/local/bin/gh";
    expect(resolveGhPath({ PATH: "/usr/bin" }, "darwin", isFile)).toBe(
      "/usr/local/bin/gh",
    );
    expect(
      resolveGhPath({ PATH: "/usr/bin" }, "linux", isFile),
    ).toBeUndefined();
  });

  test("skips relative PATH entries", () => {
    const isFile = (p: string) => p === "gh.exe" || p === "C:\\b\\gh.exe";
    expect(resolveGhPath({ Path: ".;C:\\b" }, "win32", isFile)).toBe(
      "C:\\b\\gh.exe",
    );
    expect(resolveGhPath({ PATH: "bin" }, "linux", () => true)).toBeUndefined();
  });
});

test("ghEnv prepends gh's directory on darwin only", () => {
  expect(
    ghEnv({ PATH: "/usr/bin" }, "darwin", "/opt/homebrew/bin/gh").PATH,
  ).toBe("/opt/homebrew/bin:/usr/bin");
  expect(ghEnv({ PATH: "C:\\x" }, "win32", "C:\\gh\\gh.exe").PATH).toBe(
    "C:\\x",
  );
});

describe("buildGraphqlArgs", () => {
  const args = buildGraphqlArgs("Owner/2048", [5, 7]);

  test("passes owner and name as raw -f strings and numbers as -F ints", () => {
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args).toEqual(expect.arrayContaining(["--hostname", "github.com"]));
    expect(args).toEqual(
      expect.arrayContaining(["-f", "owner=Owner", "-f", "name=2048"]),
    );
    expect(args).toEqual(expect.arrayContaining(["-F", "n0=5", "-F", "n1=7"]));
  });

  test("never interpolates input into the query or passes an @file value", () => {
    const query = args[args.indexOf("-f") + 1];
    expect(query.startsWith("query=")).toBe(true);
    expect(query).not.toContain("Owner");
    expect(query).not.toContain("2048");
    const fValues = args.filter((_, i) => args[i - 1] === "-F");
    expect(fValues.every((v) => !v.startsWith("@"))).toBe(true);
  });
});

describe("parseGraphqlOutput", () => {
  test("maps aliases back to numbers and nulls errored aliases", () => {
    const out = parseGraphqlOutput(
      JSON.stringify({
        data: {
          repository: {
            p0: { title: "A", state: "MERGED", isDraft: false, body: "x" },
            p1: { title: "B", state: "OPEN", isDraft: true, body: null },
          },
        },
        errors: [{ path: ["repository", "p1"] }],
      }),
      [5, 7],
    );
    expect(out).toEqual({
      kind: "data",
      byNumber: new Map([
        [5, { title: "A", state: "MERGED", isDraft: false, body: "x" }],
        [7, null],
      ]),
    });
  });

  test("an unknown state is treated as not returned", () => {
    const out = parseGraphqlOutput(
      JSON.stringify({
        data: { repository: { p0: { title: "A", state: "WEIRD" } } },
      }),
      [5],
    );
    expect(out).toEqual({ kind: "data", byNumber: new Map([[5, null]]) });
  });

  test.each(["", "not json", "{}", '{"data":null}', "[]"])(
    "%j is bad output",
    (stdout) => {
      expect(parseGraphqlOutput(stdout, [1])).toEqual({
        kind: "failed",
        reason: "bad-output",
      });
    },
  );
});

test("truncateUtf8 never splits a character", () => {
  expect(truncateUtf8("aé", 2)).toBe("a");
  expect(truncateUtf8("aé", 3)).toBe("aé");
  expect(truncateUtf8("abc", 10)).toBe("abc");
});

describe("runGhBatch with a fake gh", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "csm-gh-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const runner = (mode: string, timeoutMs = 10_000): GhRunner => ({
    ghPath: process.execPath,
    prefixArgs: [FAKE_GH],
    env: {
      ...process.env,
      FAKE_GH_MODE: mode,
      FAKE_GH_ARGS_FILE: join(dir, "args.json"),
    },
    timeoutMs,
  });

  test("success returns every PR and passes the argument array unchanged", async () => {
    const out = await runGhBatch(runner("ok"), "o/r", [5, 7]);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.byNumber.get(5)).toEqual({
      title: "PR 5",
      state: "OPEN",
      isDraft: false,
      body: "body",
    });
    const args = JSON.parse(
      readFileSync(join(dir, "args.json"), "utf8"),
    ) as string[];
    expect(args).toEqual(buildGraphqlArgs("o/r", [5, 7]));
  });

  test("exit 1 with partial data still applies the good aliases", async () => {
    const out = await runGhBatch(runner("partial-exit1"), "o/r", [5, 7]);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.byNumber.get(5)?.title).toBe("PR 5");
    expect(out.byNumber.get(7)).toBeNull();
  });

  test("a withheld repository returns every PR as not returned", async () => {
    const out = await runGhBatch(runner("null-repo"), "o/r", [5]);
    expect(out).toEqual({ kind: "data", byNumber: new Map([[5, null]]) });
  });

  test.each(["malformed", "no-data"])(
    "%s output is a batch failure",
    async (mode) => {
      expect(await runGhBatch(runner(mode), "o/r", [5])).toEqual({
        kind: "failed",
        reason: "bad-output",
      });
    },
  );

  test("a hung gh is killed at the timeout", async () => {
    const pidFile = join(dir, "pid.txt");
    const r = runner("hang", 5_000);
    r.env = { ...r.env, FAKE_GH_PID_FILE: pidFile };
    expect(await runGhBatch(r, "o/r", [5])).toEqual({
      kind: "failed",
      reason: "timeout",
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    const isAlive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + 2_000;
    while (isAlive() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(isAlive()).toBe(false);
  }, 20_000);

  test("output over the stdout cap is a batch failure", async () => {
    const r = { ...runner("big-body"), maxStdoutBytes: 1_000 };
    expect(await runGhBatch(r, "o/r", [5])).toEqual({
      kind: "failed",
      reason: "bad-output",
    });
  });

  test("a spawn that throws resolves as a failure instead of rejecting", async () => {
    expect(await runGhBatch(runner("ok"), "o/r\u0000", [5])).toEqual({
      kind: "failed",
      reason: "bad-output",
    });
  });

  test("a missing gh is ENOENT", async () => {
    expect(
      await runGhBatch({ ghPath: undefined, env: process.env }, "o/r", [5]),
    ).toEqual({
      kind: "failed",
      reason: "ENOENT",
    });
    expect(
      await runGhBatch(
        { ghPath: join(dir, "no-such-gh"), env: process.env },
        "o/r",
        [5],
      ),
    ).toEqual({ kind: "failed", reason: "ENOENT" });
  });

  test("a long body is capped at 64 KB", async () => {
    const out = await runGhBatch(runner("big-body"), "o/r", [5]);
    if (out.kind !== "data") throw new Error("expected data");
    const body = out.byNumber.get(5)?.body ?? "";
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(BODY_MAX_BYTES);
    expect(body.length).toBeGreaterThan(30_000);
  });
});
