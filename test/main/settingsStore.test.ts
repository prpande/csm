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

test("surrounding whitespace on a stored claudePath is trimmed on read", async () => {
  // A hand-edited settings.json value with leading/trailing spaces must not reach
  // spawn verbatim (it would fail to resolve). Internal spaces are preserved.
  writeSettings(
    JSON.stringify({ claudePath: "  C:\\Program Files\\claude.exe  " }),
  );
  const store = createSettingsStore(dir);
  expect(await store.getClaudePath()).toBe("C:\\Program Files\\claude.exe");
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

// The on-disk FORMAT, asserted on the raw bytes rather than through JSON.parse.
// §8 wants settings.json hand-editable and its tampering detectable, so the
// 2-space indent and the trailing newline are part of the contract, not
// incidental. Every other test here parses the file, so all of them would stay
// green if the indent or the newline were dropped — this is the only guard.
test("writes human-editable JSON: 2-space indent and a trailing newline", async () => {
  const store = createSettingsStore(dir);
  await store.setClaudePath("claude-x");

  const raw = readFileSync(join(dir, SETTINGS_FILE), "utf8");
  expect(raw).toBe('{\n  "claudePath": "claude-x"\n}\n');
});

test("every setter writes the same format, and only its own key", async () => {
  // One shape for all three setters: the write path must not diverge per key.
  const store = createSettingsStore(dir);
  await store.setTheme("dark");
  expect(readFileSync(join(dir, SETTINGS_FILE), "utf8")).toBe(
    '{\n  "theme": "dark"\n}\n',
  );

  await store.setIndexEnabled(false);
  expect(readFileSync(join(dir, SETTINGS_FILE), "utf8")).toBe(
    '{\n  "theme": "dark",\n  "indexEnabled": false\n}\n',
  );
});

test("overwriting a key keeps its position — it does not move to the end", async () => {
  // The load-bearing case for "no format change", and the only one where a
  // computed key `{...base, [key]: v}` could plausibly differ from the literal
  // `{...base, theme: v}` it replaced. Assigning an existing key updates it in
  // place, so `theme` must stay in slot 1 rather than being re-appended after
  // `indexEnabled`. Every other format test only ever ADDS a key, which cannot
  // observe this.
  writeSettings(JSON.stringify({ theme: "dark", terminalPreference: "iterm" }));
  const store = createSettingsStore(dir);
  await store.setTheme("light");

  expect(readFileSync(join(dir, SETTINGS_FILE), "utf8")).toBe(
    '{\n  "theme": "light",\n  "terminalPreference": "iterm"\n}\n',
  );
});

test("setClaudePath creates settings.json when the dir starts empty", async () => {
  expect(readdirSync(dir)).toEqual([]);
  const store = createSettingsStore(dir);
  await store.setClaudePath("claude-x");
  expect(readdirSync(dir)).toContain(SETTINGS_FILE);
  expect(await store.getClaudePath()).toBe("claude-x");
});

test("getTheme() defaults to 'system' when settings.json is absent", async () => {
  expect(await createSettingsStore(dir).getTheme()).toBe("system");
});

test("setTheme then getTheme round-trips through disk for every mode", async () => {
  const store = createSettingsStore(dir);
  for (const mode of ["light", "dark", "system"] as const) {
    await store.setTheme(mode);
    expect(await store.getTheme()).toBe(mode);
    // A fresh instance reads the same persisted value (no in-memory reliance).
    expect(await createSettingsStore(dir).getTheme()).toBe(mode);
  }
});

test("an unrecognized / non-string stored theme falls back to 'system'", async () => {
  const store = createSettingsStore(dir);
  for (const contents of [
    JSON.stringify({ theme: "solarized" }),
    JSON.stringify({ theme: "Dark" }), // wrong case — exact match only
    JSON.stringify({ theme: 42 }),
    JSON.stringify({ theme: null }),
  ]) {
    writeSettings(contents);
    await expect(store.getTheme()).resolves.toBe("system");
  }
});

test("setTheme preserves unknown keys and the stored claudePath", async () => {
  writeSettings(
    JSON.stringify({ claudePath: "keep-me", terminalPreference: "iterm" }),
  );
  const store = createSettingsStore(dir);
  await store.setTheme("dark");

  const persisted = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"));
  expect(persisted.theme).toBe("dark");
  expect(persisted.claudePath).toBe("keep-me");
  expect(persisted.terminalPreference).toBe("iterm");
});

test("getIndexEnabled() defaults to true when settings.json is absent", async () => {
  expect(await createSettingsStore(dir).getIndexEnabled()).toBe(true);
});

test("setIndexEnabled then getIndexEnabled round-trips through disk", async () => {
  const store = createSettingsStore(dir);
  await store.setIndexEnabled(false);
  expect(await store.getIndexEnabled()).toBe(false);
  // A fresh instance reads the same persisted value (no in-memory reliance).
  expect(await createSettingsStore(dir).getIndexEnabled()).toBe(false);
});

test("a non-boolean / garbage stored indexEnabled falls back to true", async () => {
  const store = createSettingsStore(dir);
  for (const contents of [
    JSON.stringify({ indexEnabled: "false" }), // string, not boolean
    JSON.stringify({ indexEnabled: 0 }),
    JSON.stringify({ indexEnabled: null }),
    "{ not json ",
  ]) {
    writeSettings(contents);
    await expect(store.getIndexEnabled()).resolves.toBe(true);
  }
});

test("setIndexEnabled preserves unknown keys and the stored claudePath", async () => {
  writeSettings(JSON.stringify({ claudePath: "keep-me", theme: "dark" }));
  const store = createSettingsStore(dir);
  await store.setIndexEnabled(false);
  const persisted = JSON.parse(readFileSync(join(dir, SETTINGS_FILE), "utf8"));
  expect(persisted.indexEnabled).toBe(false);
  expect(persisted.claudePath).toBe("keep-me");
  expect(persisted.theme).toBe("dark");
});
