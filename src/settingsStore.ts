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

// Local minimal guard: JSON.parse can yield any type; `null`/array/primitive must
// not be spread or property-accessed as settings. (A shared type-guard util with
// sessionParser's equivalents is a possible future extraction, not this slice —
// see the plan.)
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

  async function getClaudePath(): Promise<string> {
    const v = (await readSettings()).claudePath;
    // Honor only a non-blank string, and return it TRIMMED — the value flows to
    // spawn as the `file` argument, and surrounding whitespace (from a hand-edited
    // settings.json) would otherwise fail to resolve as an executable. Absent /
    // blank / non-string → default.
    const trimmed = typeof v === "string" ? v.trim() : "";
    return trimmed !== "" ? trimmed : DEFAULT_CLAUDE_PATH;
  }

  async function setClaudePath(value: string): Promise<void> {
    // Spread-merge onto current settings so unknown keys are preserved.
    const next = { ...(await readSettings()), claudePath: value };
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
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
    // Spread-merge so unknown keys (e.g. claudePath) are preserved.
    const next = { ...(await readSettings()), theme: value };
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  async function getIndexEnabled(): Promise<boolean> {
    const v = (await readSettings()).indexEnabled;
    // Honor only a real boolean; anything else (absent, a hand-edited string,
    // a number, null, a corrupt file) → default true.
    return typeof v === "boolean" ? v : DEFAULT_INDEX_ENABLED;
  }

  async function setIndexEnabled(value: boolean): Promise<void> {
    // Spread-merge so unknown keys (claudePath, theme) are preserved.
    const next = { ...(await readSettings()), indexEnabled: value };
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(next, null, 2) + "\n", "utf8");
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
