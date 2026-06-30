import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isOpenableUrl,
  windowOpenDecision,
  navigationDecision,
} from "../src/urls";

test("isOpenableUrl allows only https", () => {
  assert.equal(isOpenableUrl("https://example.com"), true);
  assert.equal(isOpenableUrl("https://example.com/path?q=1#h"), true);

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
    assert.equal(isOpenableUrl(bad), false, `${bad} should be rejected`);
  }
});

test("windowOpenDecision always denies, opens only https in OS browser", () => {
  assert.deepEqual(windowOpenDecision("https://example.com"), {
    action: "deny",
    open: true,
  });
  assert.deepEqual(windowOpenDecision("http://example.com"), {
    action: "deny",
    open: false,
  });
  assert.deepEqual(windowOpenDecision("file:///etc/passwd"), {
    action: "deny",
    open: false,
  });
});

test("navigationDecision allows same-origin, blocks and routes the rest", () => {
  // Use an http origin for the core same/cross logic so the assertions are
  // deterministic and independent of file-URL origin quirks.
  const origin = "http://localhost:5173";

  // Same origin → allowed in-window, never routed out.
  assert.deepEqual(navigationDecision("http://localhost:5173/route", origin), {
    prevent: false,
    open: false,
  });

  // Cross-origin https → blocked in-window, routed to OS browser.
  assert.deepEqual(navigationDecision("https://example.com", origin), {
    prevent: true,
    open: true,
  });

  // Cross-origin non-https → blocked, not routed.
  assert.deepEqual(navigationDecision("http://evil.test", origin), {
    prevent: true,
    open: false,
  });

  // Unparseable → blocked, never opened.
  assert.deepEqual(navigationDecision("::::not a url", origin), {
    prevent: true,
    open: false,
  });

  // file:// pages have an opaque origin that Node serializes as the string
  // "null". CSM loads its UI via loadFile, so main.ts derives appOrigin the same
  // way and a local in-app hop is same-origin ("null" === "null") → allowed.
  const fileOrigin = new URL("file:///C:/app/index.html").origin;
  assert.deepEqual(
    navigationDecision("file:///C:/app/other.html", fileOrigin),
    {
      prevent: false,
      open: false,
    },
  );
});
