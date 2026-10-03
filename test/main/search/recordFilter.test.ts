// @vitest-environment node
import { describe, expect, test } from "vitest";
import { BIG_LINE_BYTES, shouldParse } from "../../../src/search/recordFilter";

const b = (s: string) => Buffer.from(s);
const pad = (n: number) => "z".repeat(n);

describe("shouldParse", () => {
  test.each([
    "user",
    "assistant",
    "pr-link",
    "custom-title",
    "ai-title",
    "summary",
  ])("a leading %s type is parsed", (type) => {
    expect(shouldParse(b(`{"type":"${type}","x":1}`))).toBe(true);
  });

  test.each(["file-history-snapshot", "queue-operation", "brand-new-thing"])(
    "a leading %s type is skipped",
    (type) => {
      expect(
        shouldParse(b(`{"type":"${type}","message":{"content":"x"}}`)),
      ).toBe(false);
    },
  );

  test("a record that puts parentUuid first is parsed", () => {
    expect(shouldParse(b('{"parentUuid":null,"type":"assistant"}'))).toBe(true);
  });

  test("a big line without a leading type needs a content marker", () => {
    expect(
      shouldParse(b(`{"parentUuid":"p","data":"${pad(BIG_LINE_BYTES)}"}`)),
    ).toBe(false);
    expect(
      shouldParse(
        b(
          `{"parentUuid":"p","content":[{"type":"text"}],"d":"${pad(BIG_LINE_BYTES)}"}`,
        ),
      ),
    ).toBe(true);
    expect(
      shouldParse(
        b(
          `{"parentUuid":"p","cmd":"gh pr create","d":"${pad(BIG_LINE_BYTES)}"}`,
        ),
      ),
    ).toBe(true);
  });

  test("a big line with a leading contributing type is parsed", () => {
    expect(
      shouldParse(b(`{"type":"assistant","d":"${pad(BIG_LINE_BYTES)}"}`)),
    ).toBe(true);
  });
});
