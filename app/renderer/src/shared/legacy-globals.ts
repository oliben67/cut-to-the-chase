// Ambient declarations for app.js globals that extracted modules read but
// don't own. Centralized here (rather than one `declare global` per module)
// because TypeScript doesn't allow the same ambient `const`/`let` declared
// in two different files -- unlike `interface`, these don't merge.
//
// Why bare identifiers work at all *once app.js has run*: its top-level
// `const`/`let` (unlike `var`/`function`) never attach to `window` -- but
// they DO live in the realm's shared global lexical environment, which
// every classic <script> tag in this document resolves bare identifiers
// against. Confirmed empirically -- see Step B's implementation notes.
//
// The catch: this bundle's script tag runs *before* app.js's, so NONE of
// this -- `const`/`let` *or* `function` declarations, e.g. hasDockerDaemon,
// post, $ -- exists yet at this bundle's own module-load
// time, no matter which kind of declaration it is; hoisting only applies
// within a script's own execution, not to a script that hasn't run yet.
// Every name below is safe to reference only from code that runs *later*
// (event handlers, functions called back in from app.js's own boot
// sequence) -- never at a module's own top level. `$` is the one exception
// worth calling out: it's used pervasively for top-level DOM wiring (ported
// straight from app.js, which safely runs after its own body has parsed),
// so rather than deferring every one of those call sites into a mount
// function, shared/dollar.ts exports a real, independent implementation --
// import that instead of relying on app.js's.
export {};
declare global {
  const state: {
    sources: Array<{
      id: string;
      path?: string;
      name?: string;
      live?: boolean;
      kind?: string;
      is_host?: boolean;
      [k: string]: unknown;
    }>;
    series?: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      services?: Array<{ sid: string; name: string; host?: boolean; [k: string]: any }>;
    };
    [k: string]: unknown;
  };
  const prefs: { get(key: string, dflt: unknown): unknown; set(key: string, val: unknown): void };
  const recording: { status: string };
  let statusBarClearSecs: number;
  let dockerPollIntervalSecs: number;
  const PORT: string;
  const POPOUT_KIND: string | null;

  function notifyEvent(text: string): void;
  function confirmAbandonRecordingIfAny(actionLabel: string): Promise<boolean>;
  function hasDockerDaemon(): boolean;
  function currentDockerHost(): string | null;
  function openPaths(): Set<string>;
  function normalizeDockerHost(raw: string): string | null;
  function setTrack(name: string, st: string): void;
  function refreshAll(): Promise<void>;
  function assignColorSlots(): void;
  function syncPanels(): void;
  function renderLegend(): void;
  function drawAll(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function post(path: string, body?: unknown): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function get(path: string): Promise<any>;
  function syncDockerDaemonButtons(): void;
  let refreshDockerHostPill: () => string | null;
  function prefillPreferencesPane(): void;
  const API: string;
  function authHeaders(extra?: Record<string, string>): Record<string, string>;
  function saveBinaryFile(name: string, bytes: Uint8Array): Promise<string | null>;
  function scheduleRefresh(): void;

  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cttc?: Record<string, any>;
  }
}
