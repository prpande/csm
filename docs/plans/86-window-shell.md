# Plan — #86 Custom frameless title bar + traffic-light window controls (PRism parity) + brand icon

## Why

CSM ships the default Electron chrome (native title bar, menu bar, OS min/max/close).
The scaffold deferred the custom shell (`main.ts`: *"the custom full-width title bar
with our own window controls is deferred to a later phase"*). This lands it, mirroring
the sibling **PRism** tool (`D:/src/PRism`) so we inherit the usability fixes it already
paid for, and surfaces the app brand icon in the title bar.

## Reference

PRism: `desktop/src/{main,preload,menu}.ts`, `frontend/src/components/Header/*`,
`docs/specs/2026-06-02-electron-desktop-shell-design.md`. Replicate its documented
gotcha mitigations (see Risks).

## Approach

Additive — CSM already has the seams (a `TitleBar` component, a narrow `window.csm`
bridge, `CH` channel constants, sender-guarded IPC, `setWindowOpenHandler` +
`will-navigate`).

### Main process
- `src/main.ts` `createWindow`: add `titleBarStyle: "hidden"` (keep OS resize borders +
  shadow; **no** `frame:false`, **no** `titleBarOverlay`). On darwin call
  `setWindowButtonVisibility(false)` (native traffic lights still show under `"hidden"`).
  Add a `dom-ready` handler that injects `document.documentElement.dataset.shell =
  "desktop"` (NOT the preload — a preload DOM write races document-start). Wire the two
  window→renderer maximize events: `mainWindow.on("maximize"/"unmaximize", …send(
  CH.windowMaximizedChanged, bool))`. Register window-control channels via
  `registerWindowControls`.
- `src/menu.ts` (new): `applicationMenuTemplate(platform)` returns `null` off-darwin
  (→ `Menu.setApplicationMenu(null)` = no menu bar); on darwin returns a minimal
  role-based template (`appMenu` + `editMenu` + `windowMenu`) so ⌘C/⌘V/⌘A/⌘Q keep
  working in inputs. Pure — unit-tested.
- `src/windowControls.ts` (new): `registerWindowControls({ ipcMain, isTrustedSender,
  getWindow })` wires `window:minimize` / `:toggle-maximize` / `:close` (`ipcMain.on`)
  and `window:is-maximized` (`ipcMain.handle`). Every handler sender-guards. DI'd
  `ipcMain` + `getWindow` → unit-tested with fakes (toggle picks unmaximize-when-
  maximized; untrusted sender is a no-op / returns false).
- `src/ipcChannels.ts`: add `windowMinimize`, `windowToggleMaximize`, `windowClose`,
  `windowIsMaximized`, `windowMaximizedChanged`.

### Preload + contract
- `src/preload.ts`: extend the `csm` bridge with `windowControls: { minimize,
  toggleMaximize, close, isMaximized(): Promise<boolean>, onMaximizedChange(cb): () =>
  void }`.
- `src/renderer/types/csm.d.ts`: add the `CsmWindowControls` interface to `CsmBridge`.
- `src/renderer/types/assets.d.ts` (new): `declare module "*.png"` for the icon import.

### Renderer
- `src/renderer/components/WindowControls.tsx` (+ `.module.css`, new): three custom
  buttons (min / maximize-restore / close), inline **SVG** glyphs (not Unicode dingbats),
  macOS-palette dots, Windows order min→max→close. Self-gates on
  `window.csm?.windowControls` → renders `null` when absent (plain browser / vitest).
  Tracks maximized state via `isMaximized()` + `onMaximizedChange`; maximize button
  aria-label + glyph swap to Restore when maximized.
- `src/renderer/components/TitleBar.tsx`: add the brand icon (`assets/icons/png/
  icon_32.png`, imported → bundled under app origin, satisfies CSP `img-src 'self'`;
  rendered as `<img>`, never innerHTML) and `<WindowControls />` at the trailing edge.
- `TitleBar.module.css`: gate `-webkit-app-region: drag` on `:global([data-shell=
  'desktop'])`; reset interactive children to `no-drag` via
  `:where(a,button,input,select,textarea,[role='button'],[tabindex])`.

## Tests (TDD)
- `test/main/menu.test.ts` — null off-darwin; role template on darwin.
- `test/main/windowControls.test.ts` — minimize/close call through; toggle picks
  unmaximize when maximized else maximize; is-maximized reflects window; untrusted
  sender is a no-op and is-maximized → false.
- `test/renderer/WindowControls.test.tsx` — renders nothing without the bridge; renders
  3 buttons with it; clicks invoke minimize/toggleMaximize/close; maximize→restore label
  swap on `onMaximizedChange`.
- `test/renderer/TitleBar.test.tsx` — brand icon `<img>` present with alt; window
  controls present; refresh still wired.
- Existing main + renderer suites still pass.

## Non-goals (match PRism)
- Window size/position persistence — deferred (fixed launch size). Follow-up if wanted.

## Risks / gotchas (from PRism, mitigated above)
1. Preload DOM writes race document-start → own `data-shell` from main `dom-ready`.
2. Drag region swallows child clicks → reset every interactive child to `no-drag`.
3. macOS native traffic lights persist under `"hidden"` → `setWindowButtonVisibility(false)`.
4. Nulling the macOS menu kills ⌘C/⌘V/⌘A/⌘Q → keep a native Edit menu on darwin only.
5. Unicode caption glyphs render inconsistently → inline SVG.
6. **macOS unverifiable from Windows** — darwin behavior is code-review-verified only
   (cf. #36 dmg-icon note); no packaged-mac screenshot.
