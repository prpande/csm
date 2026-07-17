// Persistence layer for CSM's OWN settings (never Claude's session files). Reads
// and writes settings.json in a directory the caller injects — main passes
// Electron `app.getPath('userData')`; the injected dir keeps this unit testable
// against a real temp dir without an Electron runtime. Imports only node fs/path.
// Design spec §5 (module table), §8 (Settings); plan docs/plans/58-settings-store.md.
//
// Read-through (no in-memory cache): getClaudePath reads settings.json on each
// call. The file is tiny; reading fresh keeps external edits visible (§8 wants
// settings.json tampering to be detectable) and avoids stale-cache bugs. Every
// read is fail-soft (§12): a missing, empty, non-object, or unparseable file is
// treated as {} and yields the default — never throws to the caller.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { THEME_PREFERENCES, type ThemePreference } from "./ipcTypes";
import { isRecord, isNonEmptyString } from "./typeGuards";

const SETTINGS_FILENAME = "settings.json";
// The product-wide default Claude executable (spec §8). Exported so the IPC
// bridge's untrusted-sender fallback returns the same default instead of
// re-hardcoding the literal.
export const DEFAULT_CLAUDE_PATH = "claude";
// Default theme when none is stored (or a stored value is unrecognized): follow
// the OS. Exported so the IPC bridge's untrusted fallback returns the same value.
export const DEFAULT_THEME: ThemePreference = "system";
// The privacy opt-out default (spec §8): indexing is ON unless explicitly disabled.
export const DEFAULT_INDEX_ENABLED = true;

// The settings CSM knows how to write. Private: it types the write helper's
// key/value pair against each other so `writeSetting("theme", 42)` cannot
// compile. It is deliberately NOT the shape of settings.json — the file may hold
// unknown keys from a newer build, which reads tolerate and writes preserve.
interface KnownSettings {
  claudePath: string;
  theme: ThemePreference;
  indexEnabled: boolean;
}

export function createSettingsStore(dir: string) {
  const file = join(dir, SETTINGS_FILENAME);

  // Current settings as a plain object, or {} for any absent/corrupt/non-object
  // file. Used both for reads and as the merge base of a write (so unknown future
  // keys survive — §8 extensibility).
  async function readSettings(): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {}; // absent, unreadable, or unparseable → default
    }
  }

  // Read → merge one key → write, the single write path for every setter.
  //
  // The re-read on each write is what preserves unknown keys (§8): the merge base
  // is always the file's current contents, so a key written by a newer build (or
  // by hand) survives a write from this one. The 2-space indent and trailing
  // newline keep the file hand-editable per §8 and are part of its contract.
  async function writeSetting<K extends keyof KnownSettings>(
    key: K,
    value: KnownSettings[K],
  ): Promise<void> {
    const next = { ...(await readSettings()), [key]: value };
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  async function getClaudePath(): Promise<string> {
    const v = (await readSettings()).claudePath;
    // Honor only a non-blank string, and return it TRIMMED — the value flows to
    // spawn as the `file` argument, and surrounding whitespace (from a hand-edited
    // settings.json) would otherwise fail to resolve as an executable. Absent /
    // blank / non-string → default.
    return isNonEmptyString(v) ? v.trim() : DEFAULT_CLAUDE_PATH;
  }

  async function setClaudePath(value: string): Promise<void> {
    await writeSetting("claudePath", value);
  }

  async function getTheme(): Promise<ThemePreference> {
    const v = (await readSettings()).theme;
    // Honor only a value in the allowlist; anything else (absent, a stale/unknown
    // string, a hand-edited typo, a non-string) → default 'system'. The value
    // reaches nativeTheme.themeSource, so it must be exactly one of the three.
    return (THEME_PREFERENCES as readonly string[]).includes(v as string)
      ? (v as ThemePreference)
      : DEFAULT_THEME;
  }

  async function setTheme(value: ThemePreference): Promise<void> {
    await writeSetting("theme", value);
  }

  async function getIndexEnabled(): Promise<boolean> {
    const v = (await readSettings()).indexEnabled;
    // Honor only a real boolean; anything else (absent, a hand-edited string,
    // a number, null, a corrupt file) → default true.
    return typeof v === "boolean" ? v : DEFAULT_INDEX_ENABLED;
  }

  async function setIndexEnabled(value: boolean): Promise<void> {
    await writeSetting("indexEnabled", value);
  }

  return {
    getClaudePath,
    setClaudePath,
    getTheme,
    setTheme,
    getIndexEnabled,
    setIndexEnabled,
  };
}
