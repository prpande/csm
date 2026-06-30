# Plan — Issue #6: CI (setup-toolchain composite + cross-platform ci.yml)

**Tier:** Standard (multiple files, real CI logic; no security-invariant change).
**Branch:** `6-ci-toolchain`. **Closes #6.**

## What & why

CSM has gates (lint, typecheck, build, Vitest, Playwright/Electron e2e) that so far
only run locally. This issue makes them run on every PR and on `main`, across the
three OSes CSM must ship on (Windows + macOS + Linux). Mirrors PRism's CI, adapted:
no .NET, and cross-platform instead of Windows-only.

## Approach

### 1. `.nvmrc` — single source of truth for the Node version
- `24` (current LTS; matches the developer's local Node so CI mirrors dev;
  supported by Vite 6 / Vitest 3). Consumed by `setup-node` via
  `node-version-file`, so the toolchain version lives in one place rather than
  being duplicated across workflows.

### 2. `.github/actions/setup-toolchain/action.yml` — composite action
- `runs.using: composite`; one step: `actions/setup-node` with
  `node-version-file: .nvmrc`, `cache: npm`,
  `cache-dependency-path: package-lock.json`.
- `setup-node` is **SHA-pinned** with a `# vX.Y.Z` comment (acceptance criterion).

### 3. `.github/workflows/ci.yml`
- Triggers: `pull_request` + `push: branches: [main]`. `permissions: contents: read`.
  `concurrency` cancels superseded runs per ref.
- **Job `unit`** — matrix `[ubuntu-latest, windows-latest, macos-latest]`,
  `fail-fast: false`. Steps: checkout → setup-toolchain → `npm ci` → `npm run lint`
  → `npm run typecheck` → `npm run build` → `npm test` → `npm audit` (last).
  - Env `ELECTRON_SKIP_BINARY_DOWNLOAD=1` + `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`:
    lint/typecheck/build/Vitest need neither the Electron binary nor browsers
    (types come from the npm packages; Vitest uses jsdom). Faster `npm ci`, no
    display needed.
  - `npm audit --omit=dev --audit-level=high` — scoped to the production tree
    (react/react-dom), the surface actually shipped to users. The Electron
    framework (a devDependency, bundled at build time) and build tooling
    (electron-builder → tar → node-gyp) carry a perpetual advisory stream that a
    full blocking audit would use to redden every PR; dependabot keeps those
    devDependencies current instead. Verified: prod-only audit reports 0 high+.
- **Job `e2e`** — `ubuntu-latest`, runs in the **pinned Playwright container**
  `mcr.microsoft.com/playwright:v1.61.1-noble` (tag == locked `@playwright/test`
  `1.61.1`). Steps: checkout → setup-toolchain → `npm ci` (Electron binary NOT
  skipped — `_electron.launch` needs it) → `xvfb-run -a npm run test:e2e`
  (`pretest:e2e` builds first; xvfb provides the display).

### 4. SHA-pin all third-party actions (acceptance criterion)
- `actions/checkout@9c091bb…dddfe3e0 # v7.0.0`
- `actions/setup-node@48b55a01…ae4041e # v6.4.0`
- The Playwright image is pinned by its versioned tag. The local
  `./.github/actions/setup-toolchain` is first-party (no pin needed).

### 5. `.github/dependabot.yml`
- `github-actions` (dir `/`, weekly) — keeps the pinned SHAs current; also covers
  actions referenced inside `.github/actions/**`.
- `npm` (dir `/`, weekly).

## Decisions / deviations from the PRism pattern

- **Single `npm ci`, not "per-package".** CSM is a single root package (no
  workspaces); the per-package language in the issue is a PRism monorepo-ism.
- **Electron-in-container runs as root → `--no-sandbox` for the CI e2e only.**
  GitHub `container:` jobs run as root, and Chromium/Electron's setuid sandbox
  refuses to run as root regardless of the SUID bit, so the container path
  *requires* `--no-sandbox`. The e2e spec gains a `process.env.CI`-guarded
  `--no-sandbox` arg. Production is unchanged: `webPreferences.sandbox: true`
  stays set in `src/main.ts`; this switch only disables the OS-level zygote
  sandbox for the root CI container, and the smoke assertions (window loads,
  React mounts, heading renders, CSP applies) remain meaningful.

## Test / proof

CI config isn't unit-testable; the proof is the acceptance criterion itself —
**CI green on the PR across all three OSes** plus the e2e container job. Locally:
validate each workflow/action YAML parses, and confirm `npm run lint/typecheck/
build/test` (already green from #5) are the exact commands the matrix invokes.

## Files

- add `.nvmrc`
- add `.github/actions/setup-toolchain/action.yml`
- add `.github/workflows/ci.yml`
- add `.github/dependabot.yml`
- edit `e2e/app.smoke.spec.ts` (CI-guarded `--no-sandbox`)
