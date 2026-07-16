import { test, expect } from "vitest";
import {
  formatRelativeTime,
  chipVariant,
  shortSessionId,
  shouldShowGitBranch,
} from "../../src/sessionRowView";

// Fixed reference "now" so the relative-time buckets are deterministic.
const NOW = Date.parse("2026-06-30T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("formatRelativeTime: sub-45s reads 'just now'", () => {
  expect(formatRelativeTime(ago(0), NOW)).toBe("just now");
  expect(formatRelativeTime(ago(30 * SEC), NOW)).toBe("just now");
});

test("formatRelativeTime: minutes, singular and plural", () => {
  expect(formatRelativeTime(ago(60 * SEC), NOW)).toBe("1 minute ago");
  expect(formatRelativeTime(ago(5 * MIN), NOW)).toBe("5 minutes ago");
});

test("formatRelativeTime: hours", () => {
  expect(formatRelativeTime(ago(1 * HOUR), NOW)).toBe("1 hour ago");
  expect(formatRelativeTime(ago(3 * HOUR), NOW)).toBe("3 hours ago");
});

test("formatRelativeTime: days", () => {
  expect(formatRelativeTime(ago(1 * DAY), NOW)).toBe("1 day ago");
  expect(formatRelativeTime(ago(3 * DAY), NOW)).toBe("3 days ago");
});

test("formatRelativeTime: months and years", () => {
  expect(formatRelativeTime(ago(40 * DAY), NOW)).toBe("1 month ago");
  expect(formatRelativeTime(ago(400 * DAY), NOW)).toBe("1 year ago");
});

test("formatRelativeTime: a future timestamp (clock skew) reads 'just now'", () => {
  expect(formatRelativeTime(new Date(NOW + 10 * MIN).toISOString(), NOW)).toBe(
    "just now",
  );
});

test("formatRelativeTime: null / unparseable falls back to 'unknown'", () => {
  expect(formatRelativeTime(null, NOW)).toBe("unknown");
  expect(formatRelativeTime("not-a-date", NOW)).toBe("unknown");
});

test("chipVariant: risk-coded mapping (spec §9)", () => {
  expect(chipVariant("bypassPermissions")).toBe("bypass");
  expect(chipVariant("acceptEdits")).toBe("info");
  expect(chipVariant("auto")).toBe("info");
  expect(chipVariant("plan")).toBe("plan");
  expect(chipVariant("default")).toBe("default");
});

test("chipVariant: dontAsk / unrecognized / empty all fall to 'default'", () => {
  expect(chipVariant("dontAsk")).toBe("default");
  expect(chipVariant("something-new")).toBe("default");
  expect(chipVariant("")).toBe("default");
});

test("shortSessionId: first 8 chars", () => {
  expect(shortSessionId("abcdefgh-1234-5678")).toBe("abcdefgh");
  expect(shortSessionId("abc")).toBe("abc");
});

// ---- #110 git-branch noise rule ---------------------------------------------

test("shouldShowGitBranch: a non-default branch shows", () => {
  expect(shouldShowGitBranch("feature-x")).toBe(true);
  expect(shouldShowGitBranch("110-git-branch-rows")).toBe(true);
});

test("shouldShowGitBranch: absent or repo-default branches are suppressed", () => {
  // The chip only carries information when the branch ISN'T the default —
  // otherwise an all-main folder is a wall of identical chips (#110).
  expect(shouldShowGitBranch(null)).toBe(false);
  expect(shouldShowGitBranch("main")).toBe(false);
  expect(shouldShowGitBranch("master")).toBe(false);
});

test("shouldShowGitBranch: the match is case-sensitive, so 'Main' shows", () => {
  // Deliberate: git branch names ARE case-sensitive, so `Main` is a genuinely
  // different branch from `main`. A spurious chip is noise; a suppressed chip
  // is a lie — so err toward showing.
  expect(shouldShowGitBranch("Main")).toBe(true);
  expect(shouldShowGitBranch("MASTER")).toBe(true);
});

test("shouldShowGitBranch: a branch merely containing a default name shows", () => {
  // Exact match, not substring — `main` must not swallow real branch names.
  expect(shouldShowGitBranch("main-fix")).toBe(true);
  expect(shouldShowGitBranch("feature/main")).toBe(true);
  expect(shouldShowGitBranch("remaster")).toBe(true);
});
