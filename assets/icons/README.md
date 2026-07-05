# App icons

Source icon assets for CSM (Claude Session Manager). The mark is an **open
rounded frame** (a workspace/session container) with a **terracotta tile lifting
back into the opening** — it depicts "reopen a closed session." No text. Clay
palette: terracotta `#d9622b`→`#e27a48`, charcoal-brown `#2a2420`, warm cream
tile `#f2ebe1`. Every asset is vector; the PNG/ICO/ICNS rasters are generated
from the SVG masters in `svg/`.

## Files

- `icon.png` — 1024×1024 master (also `png/icon_1024.png`).
- `icon.ico` — Windows multi-resolution icon (16–256).
- `icon.icns` — macOS icon bundle (16–1024).
- `png/icon_<size>.png` — 16–1024 px app-icon rasters (favicons, in-app use,
  docs). The 16/24 px rasters come from the `tile-sm` master so the mark stays
  crisp at small sizes.
- `svg/` — vector source of truth:
  - `mark.svg` — the bare mark on a transparent background (in-app UI on light
    surfaces).
  - `tile.svg` — the app-icon tile (cream squircle + depth) for launcher / Dock
    / taskbar.
  - `mono.svg` — a monochrome `currentColor` template (tray / menu-bar / inline).
  - `tile-sm.svg` / `mono-sm.svg` — size-tuned masters for the ≤24 px app-icon and
    tray rasters (mark fills more / thicker stroke).
- `png/tray-<size>.png` — monochrome (black + alpha) template rasters for a
  future system-tray / menu-bar icon. **Source-only — not wired yet** (CSM has no
  tray today).
- `react/CsmIcon.jsx` — `<CsmMark>` / `<CsmTile>` / `<CsmMono>` React components.
  **Source-only — not wired yet**; the in-app title-bar brand currently renders
  `png/icon_32.png` as an `<img>`.

## Usage

These are the **source** assets. `electron-builder.yml` references `icon.ico`
(`win.icon`) and `icon.icns` (`mac.icon`) directly from this folder, so packaged
builds embed the CSM icon — no copies live under `build/`. The
`test/main/packagingIcons.test.ts` guard fails if a referenced path stops
resolving, so renaming or moving these files without updating the config is
caught in CI. `src/appIcon.ts` loads `icon.ico` (Windows taskbar) and `icon.icns`
(macOS dock) at dev runtime, and `TitleBar.tsx` imports `png/icon_32.png` as the
in-app brand mark — keep those filenames stable, or update the references.

Everything raster is regenerable from the SVG masters; ≤24 px pulls from the
`-sm` masters so it stays crisp.
