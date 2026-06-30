# Plan — #5 Scaffold renderer (React 19 + Vite + Vitest + ESLint/Prettier)

**Tier:** Standard. **Issue:** #5 (`area:tree-ui`, p1).

## Why

The Electron shell (#4) loads a static placeholder. This stands up the real
renderer toolchain — React 19 + Vite + Vitest — so feature work (the file tree,
session list) has a tested UI foundation. Scaffold only: one sample component,
no product UI.

## Approach

Single root `package.json` (shared with main/preload from #4). Two compilation
domains kept separate so the Node/CommonJS main build and the DOM/ESM renderer
build never cross:

- **main/preload** — `src/*.ts` (CommonJS), built by `tsc` to `dist/` (unchanged
  from #4). The main `tsconfig.json` **excludes `src/renderer/`**.
- **renderer** — `src/renderer/**/*.{ts,tsx}` (ESM, `react-jsx`, DOM lib, bundler
  resolution), built by **Vite** to `dist/renderer/`. `tsc` is typecheck-only
  (`noEmit`) for the renderer; Vite owns the emit.

### Decisions (chosen with the owner)

- **No MSW.** CSM's renderer has no HTTP layer — it talks to main via the
  `window.csm` IPC bridge (#4). Tests mock `window.csm` directly with a plain
  Vitest stub. (Deviation from the issue's "mirror PRism"; PRism uses MSW because
  its renderer calls a sidecar over HTTP.)
- **Playwright e2e: minimal now.** Add `@playwright/test` config + one
  `_electron` smoke test (launch the app, assert the renderer rendered). Guard
  against the Windows install-hang with a generous timeout.
- **Dev load via runtime guard, not a `VITE_` build-time gate** (those are fragile
  on Windows CI). `main.ts` loads `http://localhost:5173` when `!app.isPackaged`
  and a dev-server env hint is present, else `loadFile(dist/renderer/index.html)`.
- **Styling:** plain CSS + CSS custom properties (theme tokens), via a single
  imported stylesheet for the sample. Full token system lands with the real UI.

### Layout

```
index.html                      # Vite entry (root), script → src/renderer/main.tsx
src/renderer/
  main.tsx                      # React root mount
  App.tsx                       # sample component (reads window.csm.platform)
  components/                   # <Feature>/ dirs (empty placeholder + .gitkeep)
  hooks/  pages/  styles/  types/  utils/
  types/csm.d.ts                # window.csm bridge typing (shared contract)
test/renderer/App.test.tsx      # Vitest + Testing Library, window.csm mocked
e2e/app.smoke.spec.ts           # Playwright _electron smoke
```

### tsconfig set (renderer project refs)

- `tsconfig.json` (existing main) — add `"exclude": ["src/renderer", ...]`.
- `tsconfig.renderer.json` — renderer app typecheck (jsx, DOM, bundler res, noEmit).
- `tsconfig.node.json` — for `vite.config.ts` / tooling.
- `tsconfig.eslint.json` — widen to span renderer + test + e2e.

### Vite / Vitest

- `vite.config.ts`: `@vitejs/plugin-react`; `build.outDir = "dist/renderer"`,
  `emptyOutDir` scoped to that subdir (never wipes `dist/main.js`); `base: "./"`
  so `loadFile` works with relative asset URLs.
- Vitest: `environment: "jsdom"`, `setupFiles` registering
  `@testing-library/jest-dom` and a default `window.csm` stub.

### main.ts integration

Replace the `public/index.html` placeholder load (and remove that file) with the
runtime-guarded renderer load. Keep all #4 hardening (CSP, will-navigate,
openExternal, single-instance) intact.

### package.json scripts

- `dev` → `vite` (serves renderer with HMR).
- `build` → `tsc -p tsconfig.json` (main/preload) + `vite build` (renderer).
- `test` / `test:unit` → `vitest run` (+ keep main's `node --test` for the pure
  urls module, or migrate it — TBD during impl, default: keep both).
- `test:e2e` → `playwright test`.
- `lint` → `eslint . && prettier --check .`.

## Test list

- `App.test.tsx` — renders the sample; shows `window.csm.platform` from the mocked
  bridge; asserts no crash when `window.csm` is the stub.
- `e2e/app.smoke.spec.ts` — Electron launches, window loads, sample text visible.
- Existing `urls` unit tests continue to pass.

## Acceptance (from #5)

- `npm run dev` serves the renderer; Electron loads the built bundle.
- `npm test` (vitest) and lint pass on the sample component.
- Plus: `npm run test:e2e` smoke passes; `npm run build` produces `dist/main.js`
  + `dist/renderer/index.html`.
