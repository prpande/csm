// @vitest-environment node
import { describe, expect, test } from "vitest";
import {
  MISSING_GRACE_MS,
  nextTombstone,
  presence,
} from "../../../src/search/tombstone";

describe("presence", () => {
  test("a successful stat is present", () => {
    expect(presence(undefined, "readable")).toBe("present");
  });
  test("ENOENT under a readable parent is absent", () => {
    expect(presence("ENOENT", "readable")).toBe("absent");
  });
  test("a missing parent folder under a readable root is absent", () => {
    expect(presence("ENOENT", "missing")).toBe("absent");
  });
  test("ENOENT under an unreadable parent counts as present", () => {
    expect(presence("ENOENT", "error")).toBe("present");
  });
  test.each(["EBUSY", "EPERM", "EACCES", "EMFILE", "EIO"])(
    "%s counts as present",
    (code) => {
      expect(presence(code, "readable")).toBe("present");
    },
  );
});

describe("nextTombstone", () => {
  const live = { missingSince: null, deletedAt: null };
  test("first absence sets missingSince only", () => {
    expect(nextTombstone(live, "absent", 1000)).toEqual({
      missingSince: 1000,
      deletedAt: null,
    });
  });
  test("absent again within 60 s is not tombstoned", () => {
    const s = { missingSince: 1000, deletedAt: null };
    expect(nextTombstone(s, "absent", 1000 + MISSING_GRACE_MS - 1)).toEqual(s);
  });
  test("absent again after 60 s is tombstoned", () => {
    expect(
      nextTombstone(
        { missingSince: 1000, deletedAt: null },
        "absent",
        1000 + MISSING_GRACE_MS,
      ),
    ).toEqual({ missingSince: 1000, deletedAt: 1000 + MISSING_GRACE_MS });
  });
  test("a tombstone stays put while absent", () => {
    const s = { missingSince: 1000, deletedAt: 70_000 };
    expect(nextTombstone(s, "absent", 999_999)).toEqual(s);
  });
  test("reappearing clears both", () => {
    expect(
      nextTombstone({ missingSince: 1000, deletedAt: 70_000 }, "present", 5),
    ).toEqual(live);
  });
});
