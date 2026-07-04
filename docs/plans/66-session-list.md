# Plan — #66 Renderer: virtualized session list + session rows

Slice 3 of the Phase-A renderer UI. Fills the right-pane body that #65 stubbed
(`FolderPane` `listPlaceholder`) with the **virtualized session list** and the
**session rows**. This is the one spec-mandated performance requirement
(design spec §6 / §11).

## What / why

A selected folder's `sessions` (already sorted newest-first by the #64 data
layer, `length === ownCount`) render as a scrollable list. A folder can hold
thousands of sessions (local Temp has 2,500+), so mounting every row freezes the
renderer. The list MUST window — fixed row height, only visible rows mounted
(§6).

## Approach (Decision: hand-rolled windowing)

Chosen over pulling in a virtualization library (`react-window` /
`@tanstack/react-virtual`). Fixed row height makes the window pure math, so:

- **`computeWindow(scrollTop, viewportHeight, rowHeight, itemCount, overscan)`**
  → `{ startIndex, endIndex }` is a **pure function** unit-tested in `test/main`
  with **no DOM** — the deterministic proof of the virtualization requirement.
- Keeps the deliberately lean dependency tree (only `react` + `react-dom` ship);
  smaller supply-chain surface for a desktop app.
- Full control of the list/row a11y roles that slice #70 (keyboard nav) builds
  on.
- The library's extra capabilities (variable heights, scroll-to-index) are YAGNI
  here — the spec mandates fixed row height. If variable heights are ever needed,
  that is a separate scoped issue.

### Modules

Pure (DOM-free, `src/`, tested in `test/main` like `sessionTree`):

- **`src/sessionListWindow.ts`** — `computeWindow(...)` + exported `ROW_HEIGHT`,
  `OVERSCAN` constants. Clamps negative/overrun scroll, zero viewport → overscan
  window only (the jsdom-with-no-layout case is still bounded).
- **`src/sessionRowView.ts`** — `formatRelativeTime(iso, nowMs)`,
  `chipVariant(mode)`, `shortSessionId(id)`. All pure. `chipVariant` maps any
  string (including `dontAsk` / unrecognized / absent) to a variant, defaulting
  to `default` — never throws (AC 3).

Components (`src/renderer/components/`, tested in `test/renderer`, plain
matchers only — no jest-dom, per the local-caveat):

- **`SessionRow.tsx`** — presentational. Title via `{session.title}` text node
  (never `innerHTML`, §9). `permission-mode chip · relative time · short id`.
  Chip label is the raw mode string (text node); its class comes from
  `chipVariant`.
- **`SessionList.tsx`** — the windowing shell. Measures viewport height via a ref
  + `ResizeObserver` (guarded — absent in jsdom → height 0 → overscan-only
  window, still bounded); tracks `scrollTop` from the scroll handler; slices
  `sessions` by `computeWindow` inside a full-height spacer offset by
  `translateY`. `role="list"` / rows `role="listitem"` (listbox/option selection
  semantics arrive with reopen in #67).

### Chip color map (§9), tokens for both themes in `global.css`

| mode | variant | colour |
| --- | --- | --- |
| `bypassPermissions` | `bypass` | amber / warning |
| `acceptEdits`, `auto` | `info` | blue |
| `plan` | `plan` | neutral, distinct hue |
| `default`, `dontAsk`, anything else | `default` | grey |

### Wiring

`FolderPane` replaces its `listPlaceholder` div with
`<SessionList sessions={selected.sessions} />` (only rendered when a folder with
`ownCount > 0` is selected).

## Test list

- `test/main/sessionListWindow.test.ts` — window at top, mid-scroll slide,
  overscan applied, negative/overrun scroll clamped, zero viewport bounded, empty
  list.
- `test/main/sessionRowView.test.ts` — relative-time buckets (just now →
  minutes → hours → days → months → years, singular/plural, null → fallback,
  future clock-skew → just now); `chipVariant` for every known mode +
  `dontAsk`/unknown → `default`; `shortSessionId` = first 8 chars.
- `test/renderer/SessionRow.test.tsx` — renders title/chip/time/id; title with
  `<img>` renders literally (`querySelector("img") === null`); chip carries the
  variant class + raw-mode label.
- `test/renderer/SessionList.test.tsx` — **bounded mounted-row count** on a 2,500
  fixture (§11); window **slides** when a scroll event sets `scrollTop` (index 0
  gone, deep index present).
- Update `FolderPane`/`FolderBrowser` tests for the wired list.

## Out of scope (filed / owned by later slices)

- Row **single-click selection highlight** + **double-click reopen** + the
  `bypassPermissions` confirmation modal → #67 (slice 4). Rows are purely
  presentational here.
- **Keyboard navigation** (Up/Down within the list, focus ring) → #70 (slice 7);
  the `list`/`listitem` roles are the scaffold it upgrades.

## Constraints honoured

- Titles/ids/mode text are user-prompt-derived → inserted as **text nodes**,
  never `innerHTML` (§9). Covered by an explicit XSS-shaped test.
- Claude session files are read-only (this slice only consumes the already-parsed
  `SessionMetadata`).
