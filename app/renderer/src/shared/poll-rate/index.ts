import "../legacy-globals";

// cRate: how often the client actually re-fetches data in response to a
// server push (SSE) notification. Kept as a throttle on the *existing*
// SSE-triggered refresh (es.onmessage -> connectSSE in app.js), not a
// replacement interval-poll loop -- SSE still drives *when* something
// might have changed; this only bounds *how often* that's allowed to
// actually trigger a real refresh, since polling faster than the server's
// own sRate (how often it flushes new data to Redis, see redis_log.py)
// can never see anything new anyway.

const RATE_POLL_MS = 30_000;
// Low-frequency safety net for learning the server's current sRate --
// the real-time path is the "rate" SSE event (server.py's
// route_logs_rate_set broadcasts one on every successful POST /logs/rate),
// which this only backs up in case a broadcast was dropped (state.
// broadcast() silently drops on a full per-listener queue) or missed
// during a reconnect gap.

// Conservative default (matches redis_log.py's own DEFAULT_FLUSH_INTERVAL_
// SECONDS) until the first GET /logs/rate resolves -- see mountPollRate.
let knownServerRateSecs = 1;
// Real persisted value is only read once mountPollRate() runs (called back
// in from app.js's own boot sequence) -- `prefs` doesn't exist yet at this
// module's own load time (this bundle's script tag runs before app.js's,
// see shared/legacy-globals.ts), so this can't be a top-level `prefs.get(...)`
// initializer without crashing the whole bundle's own module evaluation
// before any of it gets a chance to run.
let clientRateSecs = 1;
let lastWarnedEffectiveSecs: number | null = null;
let lastFireMs = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function effectiveClientRateSecs(): number {
  // cRate must never be shorter than sRate (spec: "polling faster than the
  // server samples yields no new data and wastes cycles") -- clamp up,
  // never down, so a configured cRate slower than sRate is always honored
  // as-is.
  return Math.max(clientRateSecs, knownServerRateSecs);
}

function warnIfClamped(): void {
  const effective = effectiveClientRateSecs();
  if (effective === lastWarnedEffectiveSecs) return; // edge-detect -- don't renotify every poll
  lastWarnedEffectiveSecs = effective;
  if (effective > clientRateSecs) {
    notifyEvent(
      `refresh rate clamped to ${effective}s (server buffers new data every ${knownServerRateSecs}s) -- ` +
        "refreshing faster wouldn't show anything new",
    );
  }
}

// Wired into connectSSE's es.onmessage in place of a bare scheduleRefresh()
// call (see app.js) -- guarantees at most one refreshAll() per
// effectiveClientRateSecs() window, always firing on the trailing edge (a
// burst of SSE messages within one window still triggers exactly one
// refresh once it elapses, not zero).
export function throttledScheduleRefresh(): void {
  const intervalMs = effectiveClientRateSecs() * 1000;
  const now = Date.now();
  const elapsed = now - lastFireMs;
  if (elapsed >= intervalMs) {
    lastFireMs = now;
    scheduleRefresh();
    return;
  }
  if (pendingTimer == null) {
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      lastFireMs = Date.now();
      scheduleRefresh();
    }, intervalMs - elapsed);
  }
}

export function setClientRateSecs(v: number): void {
  const secs = Math.max(1, Math.floor(Number(v)) || 1);
  clientRateSecs = secs;
  prefs.set("clientRateSecs", secs);
  warnIfClamped();
}

async function refreshKnownServerRate(): Promise<void> {
  try {
    const { seconds } = await get("/logs/rate");
    if (typeof seconds === "number" && seconds !== knownServerRateSecs) {
      knownServerRateSecs = seconds;
      warnIfClamped();
    }
  } catch {
    // server unreachable -- connectSSE's own onerror already surfaces this
  }
}

// Called from app.js's connectSSE whenever a {"type": "rate", ...} SSE
// event arrives -- near-instant reactive re-clamp for every connected
// client, not just whichever one made the POST /logs/rate change.
export function onServerRateEvent(seconds: number): void {
  if (typeof seconds === "number" && seconds !== knownServerRateSecs) {
    knownServerRateSecs = seconds;
    warnIfClamped();
  }
}

// Called back in from app.js's own boot sequence (see entry.ts) -- this
// bundle's script tag runs before app.js's, so prefs/get/notifyEvent don't
// exist yet at this module's own load time.
export function mountPollRate(): void {
  clientRateSecs = prefs.get("clientRateSecs", 1) as number;
  refreshKnownServerRate();
  setInterval(refreshKnownServerRate, RATE_POLL_MS);
}
