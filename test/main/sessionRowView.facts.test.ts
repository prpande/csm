import { test, expect, describe } from "vitest";
import {
  formatModel,
  formatTokens,
  formatSpan,
  formatEdited,
  formatMessages,
  factSegments,
} from "../../src/sessionRowView";
import type { SessionFacts } from "../../src/sessionParser";

describe("fact formatters", () => {
  test("formatModel: known id, unknown strip+cap, +N, null", () => {
    expect(formatModel("claude-opus-4-8", 1)).toBe("Opus 4.8");
    expect(formatModel("claude-opus-4-8", 3)).toBe("Opus 4.8 +2");
    expect(formatModel("claude-future-xl-experimental-2027", 1)).toBe(
      "future-xl-experiment…",
    );
    expect(formatModel(null, 0)).toBeNull();
  });

  test("formatTokens buckets", () => {
    expect(formatTokens(999)).toBe("999 tok");
    expect(formatTokens(1000)).toBe("1k tok");
    expect(formatTokens(999999)).toBe("999k tok");
    expect(formatTokens(1000000)).toBe("1.0M tok");
    expect(formatTokens(1200000)).toBe("1.2M tok");
  });

  test("formatSpan: buckets, >24h cap, omitted when missing/single/degenerate", () => {
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T03:41:00Z")).toBe(
      "span 3h 41m",
    );
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T00:05:00Z")).toBe(
      "span 5m",
    );
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T00:00:30Z")).toBe(
      "span <1m",
    );
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-16T00:00:00Z")).toBe(
      "span >24h",
    );
    // A span just under 24h must not round up to "24h 0m" — it caps at >24h.
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T23:59:45Z")).toBe(
      "span >24h",
    );
    // 59m30s rounds to 60 minutes but renders "1h 0m", never "0h 60m".
    expect(formatSpan("2026-07-01T00:00:00Z", "2026-07-01T00:59:30Z")).toBe(
      "span 1h 0m",
    );
    expect(
      formatSpan("2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z"),
    ).toBeNull();
    // Reversed timestamps (last before first) yield no span.
    expect(
      formatSpan("2026-07-01T01:00:00Z", "2026-07-01T00:00:00Z"),
    ).toBeNull();
    expect(formatSpan(null, "2026-07-01T00:00:00Z")).toBeNull();
  });

  test("formatEdited and formatMessages", () => {
    expect(formatEdited(0)).toBe("read-only");
    expect(formatEdited(5)).toBe("5 edited");
    expect(formatMessages(42)).toBe("42 msgs");
  });

  test("factSegments omits null model/span without a dangling separator", () => {
    const base: SessionFacts = {
      sessionId: "s",
      messageCount: 42,
      firstActivity: "2026-07-01T00:00:00Z",
      lastActivity: "2026-07-01T03:41:00Z",
      editedFileCount: 5,
      firstModel: "claude-opus-4-8",
      distinctModelCount: 1,
      outputTokens: 1200000,
    };
    expect(factSegments(base)).toEqual([
      "42 msgs",
      "span 3h 41m",
      "5 edited",
      "Opus 4.8",
      "1.2M tok",
    ]);
    const bare: SessionFacts = {
      ...base,
      firstModel: null,
      firstActivity: null,
      lastActivity: null,
    };
    expect(factSegments(bare)).toEqual(["42 msgs", "5 edited", "1.2M tok"]);
  });
});
