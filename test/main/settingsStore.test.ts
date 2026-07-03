import { test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore } from "../../src/settingsStore";

// settingsStore is the persistence layer for CSM's own settings.json under the
// Electron userData dir. Tested against a real temp fixture dir (no Electron, no
// fs mocking): the injected dir is the ONLY location it ever touches, so the
// "never write ~/.claude" invariant is exercised structurally.

const SETTINGS_FILE = "settings.json";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "csm-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeSettings = (contents: string): void =>
  writeFileSync(join(dir, SETTINGS_FILE), contents);

test("getClaudePath() defaults to 'claude' when settings.json is absent", async () => {
  const store = createSettingsStore(dir);
  expect(await store.getClaudePath()).toBe("claude");
});

test("setClaudePath then getClaudePath round-trips through disk", async () => {
  const store = createSettingsStore(dir);
  await store.setClaudePath("/opt/homebrew/bin/claude");
  expect(await store.getClaudePath()).toBe("/opt/homebrew/bin/claude");
  // A fresh store instance reads the same persisted value (no in-memory reliance).
  expect(await createSettingsStore(dir).getClaudePath()).toBe(
    "/opt/homebrew/bin/claude",
  );
});

test("corrupt / non-JSON settings.json falls back to default without throwing", async () => {
  writeSettings("{ this is not json ");
  const store = createSettingsStore(dir);
  await expect(store.getClaudePath()).resolves.toBe("claude");
});

test("non-object JSON (array / string / number / null) falls back to default", async () => {
  const store = createSettingsStore(dir);
  for (const contents of ["[]", '"claudePath"', "42", "null"]) {
    writeSettings(contents);
    await expect(store.getClaudePath()).resolves.toBe("claude");
  }
});

test("blank / whitespace-only stored claudePath resolves to default", async () => {
  const store = createSettingsStore(dir);
  for (const blank of ["", "   ", "\t"]) {
    writeSettings(JSON.stringify({ claudePath: blank }));
    await expect(store.getClaudePath()).resolves.toBe("claude");
  }
});

test("unknown keys are preserved across a setClaudePath write", async () => {
  writeSettings(
    JSON.stringify({ claudePath: "old", terminalPreference: "iterm" }),
  );
  const store = createSettingsStore(dir);
  await store.setClaudePath("new");

  const persisted = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"));
  expect(persisted.claudePath).toBe("new");
  expect(persisted.terminalPreference).toBe("iterm");
});

test("only settings.json is written under the injected dir (never escapes it)", async () => {
  const store = createSettingsStore(dir);
  await store.setClaudePath("claude");
  expect(readdirSync(dir)).toEqual([SETTINGS_FILE]);
});

test("setClaudePath creates settings.json when the dir starts empty", async () => {
  expect(readdirSync(dir)).toEqual([]);
  const store = createSettingsStore(dir);
  await store.setClaudePath("claude-x");
  expect(readdirSync(dir)).toContain(SETTINGS_FILE);
  expect(await store.getClaudePath()).toBe("claude-x");
});
