# App icons

Source icon assets for CSM (Claude Session Manager). The mark is a cream-tiled
dark terminal window with a session-history sidebar (clock/list/trash) and the
Claude sunburst badge — it depicts a session browser and shares the Clay
palette's warm-orange lean.

## Files

- `icon.png` — 1024×1024 master (also `png/icon_1024.png`).
- `icon.ico` — Windows multi-resolution icon.
- `icon.icns` — macOS icon bundle.
- `png/icon_<size>.png` — 16–1024 px rasters (favicons, in-app use, docs).

## Usage

These are the **source** assets. `electron-builder.yml` references `icon.ico`
(`win.icon`) and `icon.icns` (`mac.icon`) directly from this folder, so packaged
builds embed the CSM icon — no copies live under `build/`. The
`test/main/packagingIcons.test.ts` guard fails if a referenced path stops
resolving, so renaming or moving these files without updating the config is
caught in CI.
