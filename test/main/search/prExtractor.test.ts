// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  extractPrs,
  linkKey,
  mergeLinkObs,
  parsePrUrl,
  PENDING_CAP,
  validatePrRef,
  type PrLinkObs,
} from "../../../src/search/prExtractor";

const T1 = "2026-10-01T10:00:00.000Z";
const prLink = (repo: string, n: number, url: string, ts = T1) => ({
  type: "pr-link",
  sessionId: "s",
  prNumber: n,
  prRepository: repo,
  prUrl: url,
  timestamp: ts,
});
const createUse = (
  id: string,
  tool = "Bash",
  command = "gh pr create --fill",
) => ({
  type: "assistant",
  message: {
    content: [{ type: "tool_use", id, name: tool, input: { command } }],
  },
});
const result = (id: string, content: unknown, ts = T1) => ({
  type: "user",
  timestamp: ts,
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
});

describe("validatePrRef / parsePrUrl", () => {
  test("accepts a matching record, comparing repo case-insensitively", () => {
    expect(
      validatePrRef(
        "Owner/Repo.Name",
        12,
        "https://github.com/owner/repo.name/pull/12",
      ),
    ).toEqual({
      repo: "Owner/Repo.Name",
      number: 12,
      url: "https://github.com/owner/repo.name/pull/12",
    });
  });

  test("strips trailing segments, query and fragment", () => {
    expect(parsePrUrl("https://github.com/o/r/pull/7/files?x=1#y")).toEqual({
      repo: "o/r",
      number: 7,
      url: "https://github.com/o/r/pull/7",
    });
  });

  test.each([
    ["bad repo chars", "o/r;rm", 1, "https://github.com/o/r/pull/1"],
    ["number mismatch", "o/r", 2, "https://github.com/o/r/pull/1"],
    ["repo mismatch", "o/x", 1, "https://github.com/o/r/pull/1"],
    ["zero", "o/r", 0, "https://github.com/o/r/pull/0"],
    ["2^31", "o/r", 2 ** 31, `https://github.com/o/r/pull/${2 ** 31}`],
    ["http", "o/r", 1, "http://github.com/o/r/pull/1"],
    ["other host", "o/r", 1, "https://gitlab.com/o/r/pull/1"],
    ["string number", "o/r", "1", "https://github.com/o/r/pull/1"],
  ])("rejects %s", (_name, repo, n, url) => {
    expect(validatePrRef(repo, n, url)).toBeUndefined();
  });
});

describe("extractPrs", () => {
  test("a pr-link record yields a link seen at its timestamp", () => {
    const out = extractPrs(
      prLink("o/r", 5, "https://github.com/o/r/pull/5"),
      [],
    );
    expect(out.links).toEqual([
      {
        repo: "o/r",
        number: 5,
        url: "https://github.com/o/r/pull/5",
        createdHere: false,
        firstSeen: Date.parse(T1),
        lastSeen: Date.parse(T1),
      },
    ]);
    expect(out.invalid).toBe(0);
  });

  test("an invalid pr-link is counted, not stored", () => {
    const out = extractPrs(
      prLink("o/r", 5, "https://github.com/o/r/pull/6"),
      [],
    );
    expect(out.links).toEqual([]);
    expect(out.invalid).toBe(1);
  });

  test.each(["Bash", "PowerShell"])(
    "pairs a %s gh pr create with its result across calls",
    (tool) => {
      const a = extractPrs(createUse("t1", tool), []);
      expect(a.pending).toEqual(["t1"]);
      const b = extractPrs(
        result("t1", "https://github.com/o/r/pull/9\n"),
        a.pending,
      );
      expect(b.pending).toEqual([]);
      expect(b.links).toEqual([
        {
          repo: "o/r",
          number: 9,
          url: "https://github.com/o/r/pull/9",
          createdHere: true,
          firstSeen: Date.parse(T1),
          lastSeen: null,
        },
      ]);
    },
  );

  test("block-array tool results are read too", () => {
    const out = extractPrs(
      result("t1", [
        { type: "text", text: "Creating…\nhttps://github.com/o/r/pull/3" },
      ]),
      ["t1"],
    );
    expect(out.links.map((l) => l.number)).toEqual([3]);
  });

  test("a failed gh pr create is consumed without storing the existing PR it names", () => {
    const out = extractPrs(
      {
        type: "user",
        timestamp: T1,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content:
                'a pull request for branch "x" into branch "main" already exists:\nhttps://github.com/o/r/pull/9\n',
            },
          ],
        },
      },
      ["t1"],
    );
    expect(out.links).toEqual([]);
    expect(out.pending).toEqual([]);
  });

  test("grep-style lines never match", () => {
    const out = extractPrs(
      result("t1", "docs/x.md:12:https://github.com/o/r/pull/3"),
      ["t1"],
    );
    expect(out.links).toEqual([]);
    expect(out.pending).toEqual([]);
  });

  test("a result for an unknown tool_use id is ignored", () => {
    expect(
      extractPrs(result("zz", "https://github.com/o/r/pull/3"), ["t1"]).links,
    ).toEqual([]);
  });

  test("other tools and other commands are not pending", () => {
    expect(extractPrs(createUse("t1", "Read"), []).pending).toEqual([]);
    expect(
      extractPrs(createUse("t1", "Bash", "gh pr view 3"), []).pending,
    ).toEqual([]);
  });

  test("pending list is capped, oldest dropped", () => {
    let pending: string[] = [];
    for (let i = 0; i < PENDING_CAP + 3; i++)
      pending = extractPrs(createUse(`t${i}`), pending).pending;
    expect(pending).toHaveLength(PENDING_CAP);
    expect(pending[0]).toBe("t3");
  });
});

describe("mergeLinkObs", () => {
  test("collapses by case-insensitive repo and number", () => {
    const into = new Map<string, PrLinkObs>();
    const base = {
      repo: "O/R",
      number: 1,
      url: "https://github.com/O/R/pull/1",
    };
    mergeLinkObs(into, {
      ...base,
      createdHere: false,
      firstSeen: 20,
      lastSeen: 20,
    });
    mergeLinkObs(into, {
      ...base,
      repo: "o/r",
      createdHere: true,
      firstSeen: 10,
      lastSeen: null,
    });
    mergeLinkObs(into, {
      ...base,
      createdHere: false,
      firstSeen: 30,
      lastSeen: 30,
    });
    expect([...into.values()]).toEqual([
      { ...base, createdHere: true, firstSeen: 10, lastSeen: 30 },
    ]);
    expect(linkKey({ repo: "O/R", number: 1 })).toBe("o/r#1");
  });
});
