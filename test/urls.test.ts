import { test, expect } from "vitest";
import {
  isOpenableUrl,
  windowOpenDecision,
  navigationDecision,
} from "../src/urls";

test("isOpenableUrl allows only https", () => {
  expect(isOpenableUrl("https://example.com")).toBe(true);
  expect(isOpenableUrl("https://example.com/path?q=1#h")).toBe(true);

  for (const bad of [
    "http://example.com",
    "file:///C:/Windows/system32",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "smb://server/share",
    "mailto:a@b.com",
    "not a url",
    "",
  ]) {
    expect(isOpenableUrl(bad), `${bad} should be rejected`).toBe(false);
  }
});

test("windowOpenDecision always denies, opens only https in OS browser", () => {
  expect(windowOpenDecision("https://example.com")).toEqual({
    action: "deny",
    open: true,
  });
  expect(windowOpenDecision("http://example.com")).toEqual({
    action: "deny",
    open: false,
  });
  expect(windowOpenDecision("file:///etc/passwd")).toEqual({
    action: "deny",
    open: false,
  });
});

test("navigationDecision allows same-origin, blocks and routes the rest", () => {
  // Use an http origin for the core same/cross logic so the assertions are
  // deterministic and independent of file-URL origin quirks.
  const origin = "http://localhost:5173";

  // Same origin → allowed in-window, never routed out.
  expect(navigationDecision("http://localhost:5173/route", origin)).toEqual({
    prevent: false,
    open: false,
  });

  // Cross-origin https → blocked in-window, routed to OS browser.
  expect(navigationDecision("https://example.com", origin)).toEqual({
    prevent: true,
    open: true,
  });

  // Cross-origin non-https → blocked, not routed.
  expect(navigationDecision("http://evil.test", origin)).toEqual({
    prevent: true,
    open: false,
  });

  // Unparseable → blocked, never opened.
  expect(navigationDecision("::::not a url", origin)).toEqual({
    prevent: true,
    open: false,
  });

  // file:// pages have an opaque origin that Node serializes as the string
  // "null". CSM loads its UI via loadFile, so main.ts derives appOrigin the same
  // way and a local in-app hop is same-origin ("null" === "null") → allowed.
  const fileOrigin = new URL("file:///C:/app/index.html").origin;
  expect(navigationDecision("file:///C:/app/other.html", fileOrigin)).toEqual({
    prevent: false,
    open: false,
  });
});
