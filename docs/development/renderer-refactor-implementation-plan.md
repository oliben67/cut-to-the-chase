# Renderer refactor kickoff: Phase 1–2 (FMT, SBAR, GATE, DHOST, PREF, EVT) with Jotai + Preact

**Status:** approved, in progress. Implements Phase 1–2 of
[`../architecture/renderer-refactor-plan.md`](../architecture/renderer-refactor-plan.md).
Tracks execution as six atomic, independently-verified steps -- see that
document for the full 33-domain map and the later out-of-scope phases.

## Context

`docs/architecture/renderer-refactor-plan.md` proposed splitting `app.js`
(6,548 lines, one global `state` object, zero framework) into per-domain
modules, phased as a strangler-fig extraction rather than a rewrite — the
codebase carries 91 tracked bugs and 66 requirements against its exact
current behavior, so a big-bang rewrite would invalidate that history.

The user has now asked to actually start Phase 1 (`SBAR`, `FMT`) through
Phase 2 (`GATE`, `DHOST`, `PREF`, `EVT`), with Jotai for state and Preact
for rendering, and explicitly asked to go **as atomic as possible per
domain** — each domain its own independently-shippable, independently-
verified step, not one large push.

## The one fact that shapes everything else

Investigated directly (not assumed): the entire e2e suite
(`app/test/renderer-spec.js`, ~4,400 lines, 200+ tests) works by
`main.js:602`'s `win.webContents.executeJavaScript(specText)` injecting the
spec's raw text into the **same page realm** `app.js` already ran in
(`executeJavaScript` always targets the main world, unaffected by
`contextIsolation`). The spec has zero imports — it purely reassigns bare
global identifiers app.js's top-level declarations created (`post = ...`,
`pickRecordingFiles = ...`, `state.x`, confirmed at e.g.
`renderer-spec.js:322,1733,78`), because `renderer/index.html:761` loads
`app.js` as a plain classic `<script>` (no `type="module"`).

**Consequence:** app.js keeps loading as a classic script exactly as
today. Anything extracted into the new bundle must still land as a real
`window` global for every identifier a test currently touches by bare
name — a module-scoped export is invisible to the injected spec and
breaks that test silently (the reassignment creates a stray global
instead of shadowing the real one, so the mock is quietly never used).
Before each domain extraction below, I grep `renderer-spec.js` for every
bare identifier belonging to that domain and confirm the new bundle
re-exposes each one — not from memory, verified per step.

## Phase 0 — build scaffolding (one atomic step, no behavior change)

- Add devDependencies: `esbuild`, `typescript`, `preact`, `jotai`.
- New source root `app/renderer/src/` — `app/renderer/app.js` and every
  other existing file stay exactly where they are, untouched, for
  whatever isn't migrated yet.
- `app/renderer/src/tsconfig.json` scoped to this tree only.
- esbuild bundles `src/entry.ts` → `renderer/dist/modules.bundle.js`:
  - `format: iife` (not esm — must stay a classic script for the reason
    above)
  - `jsx: automatic`, `jsxImportSource: preact`
  - `alias: { react → preact/compat, react-dom → preact/compat,
    react/jsx-runtime → preact/jsx-runtime }` so Jotai's React-hook
    imports resolve to Preact without pulling in real React
  - esbuild transpiles TS but does not type-check; a separate
    `tsc --noEmit -p renderer/src` script is the real type gate
- `src/shared/store.ts`: one Jotai vanilla `createStore()` instance,
  exported, plus a small `<StoreProvider>` wrapping Jotai's `Provider`.
- `index.html`: add `<script src="dist/modules.bundle.js"></script>`
  **before** the existing `<script src="app.js"></script>` tag.
- New root `package.json` scripts: `build:renderer`, `watch:renderer`,
  `typecheck`; wire `build:renderer` as a `pre`-step for `start` and
  `test:e2e`, matching the existing `predist:*` convention already in
  `package.json:11-19`.
- **Verify:** `npm run typecheck`, `npm run test:unit`, `npm run
  test:e2e` all green (nothing behavior-visible changed yet — this step
  only proves the pipeline boots).

## Phase 1

### Step A — `FMT` → `shared/format/` (pure functions, zero state, lowest possible risk)

- Move the color/formatting helpers (`app.js` ~L248–391) into
  `src/shared/format/*.ts`, each still exported and re-assigned onto
  `window` for the identifiers `renderer-spec.js` touches.
- Delete the moved definitions from `app.js` — a real move, not a copy,
  so there's exactly one implementation.
- **Verify:** full unit + e2e suite green.

### Step B — `SBAR` → `modules/status-bar/` (first real Preact component)

- Preact component(s) mounted via `render()` **into the existing status
  bar DOM containers** — same ids/classes, so `style.css` needs no
  changes. This is progressive enhancement, not a markup rewrite.
- `SBAR` genuinely owns no state (it's pure derived UI, per the domain
  doc) — its own local bits (e.g. history-panel open/closed) become real
  atoms; the gateway/docker-host/recording status it *displays* isn't
  ownable yet (those domains haven't moved), so for this step the same
  legacy sync functions (`syncRecordingMenu`, `syncDockerDaemonButtons`,
  the gateway-switch handler) keep running in `app.js` exactly as today,
  except their DOM-writing body is replaced with one `render(<StatusBar
  .../>, container)` call. Called out explicitly as a bridge — the
  gateway/docker-host portion becomes true atom subscription once Steps
  C–D land later in this same kickoff; the recording portion stays
  bridged until `REC` migrates in a later, out-of-scope phase.
- **Verify:** full unit + e2e suite green.

## Phase 2

Each of the four remaining steps follows the same shape: Jotai atoms for
the domain's list + active/derived state, actions as atom setters
replacing today's imperative dialog-submit logic, and Preact components
mounted **into the existing `<dialog>` elements already in
`index.html`** — the outer `<dialog id="...">` and its id are kept as-is;
only the inner markup becomes a mount point. This avoids doing a CSS
rewrite and a JS architecture change at the same time.

### Step C — `GATE` → `modules/gateway/`

- Atoms: `gatewaysAtom`, `activeGatewayAtom` (derived).
- Actions replace `openNewGatewayDialog`/`openEditGatewaysDialog`/
  `openUninstallGatewayDialog`/`gw-form` submit/the gateway-dropdown
  switch handler.
- Mounts into `<dialog id="dlg-gateway-setup">` (`index.html:608`) and
  `<dialog id="dlg-gateway-uninstall">` (`index.html:378`).
- The two Gateway-side call sites of `confirmAbandonRecordingIfAny`
  (`REQ-0066`) move into this module's actions as part of the extraction
  — same behavior, real home instead of an inline call.
- **Verify:** full unit + e2e suite green, including every Gateway-domain
  test unmodified.

### Step D — `DHOST` → `modules/docker-host/`

- Same shape: `savedDaemonsAtom`/`activeHostKeyAtom`, actions for
  set/edit/disconnect/remove, mounts into `<dialog id="dlg-set">`
  (`index.html:306`) and `<dialog id="dlg-remove-daemon">`
  (`index.html:363`).
- The other two `confirmAbandonRecordingIfAny` call sites move here.
- **Verify:** full unit + e2e suite green.

### Step E — `PREF` → `modules/preferences/`

- One atom per preference, backed by the existing `prefs` localStorage
  wrapper (already close to atom-shaped) — the atom's setter still
  writes through to `localStorage`, so persistence behavior is
  unchanged.
- Mounts into `<dialog id="dlg-preferences">` (`index.html:473`).
- **Verify:** full unit + e2e suite green.

### Step F — `EVT` → `modules/events/`

- Largest single step (`app.js` ~L5035–5753, ~718 lines, includes the
  UI-hosted event evaluation engine, not just the CRUD dialogs). Atoms:
  `eventsAtom`, per-event condition-eval derived atoms. Mounts into
  `<dialog id="dlg-event-form">` (`index.html:413`) and `<dialog
  id="dlg-event-list">` (`index.html:458`).
- If this turns out too large for one clean diff once underway, it's the
  one candidate to split further (e.g. CRUD dialogs vs. the evaluation
  engine) — decide that at the time, not preemptively.
- **Verify:** full unit + e2e suite green.

## Explicitly out of scope for this kickoff

`REC`, `LIVE`, `CHART`, `LOGP`, `EXPORT`, `BOOT`, `SIDE` stay in `app.js`
untouched (Phase 3+ in the architecture doc). `SBAR`'s recording-status
display stays bridged (imperative, not atom-subscribed) until `REC`
eventually migrates.

## Verification, every step

From `app/`: `npm run typecheck && npm run test:unit && npm run
test:e2e`. Each step is its own diff; move to the next only once this is
green. Nothing gets committed unless asked, per session norms.
