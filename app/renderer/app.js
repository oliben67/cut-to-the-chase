"use strict";

/* ── server connection ──────────────────────────────────────────────────── */

const PORT = new URLSearchParams(location.search).get("port") || "8765";
// 127.0.0.1 covers embedded/local-container mode; main.js passes the actual
// server host for "remote" mode (client talks directly over HTTP -- no ssh
// tunnel/port-forward, see docs/architecture/remote-server.md).
const HOST = new URLSearchParams(location.search).get("host") || "127.0.0.1";
const API = `http://${HOST}:${PORT}`;
// The shared-secret this gateway's own HTTP API requires (as X-CTTC-Token)
// once one is configured server-side (br-NET-004) -- main.js passes it the
// same synchronous way as host/port above, generated/persisted at
// provision time (see lib/api-token.js). Empty for the bare/native
// 127.0.0.1-only embedded path, which was never network-reachable and so
// never needed one -- server.py itself skips the check entirely then, so
// sending no header (rather than an empty one) is exactly correct either way.
// `let`, not `const`: reassigned by renderer-spec.js to exercise
// authHeaders()/get()/post() with a token present without needing a real
// token-gated server for the e2e run itself.
let API_TOKEN = new URLSearchParams(location.search).get("token") || null;
function authHeaders(extra) {
  return API_TOKEN ? { "X-CTTC-Token": API_TOKEN, ...extra } : { ...extra };
}

// a window can either be the main window (POPOUT_KIND == null) or a panel
// popped out into its own window: "telemetry" (the chart area) or "log"
// (a single log panel, identified by POPOUT_ID = source id).
const POPOUT_KIND = new URLSearchParams(location.search).get("popout") || null;
const POPOUT_ID = new URLSearchParams(location.search).get("id") || null;

// Mirrors main-process logging (including the server subprocess's own
// stdout/stderr, piped through main.js) into this window's own DevTools
// console (Help > Developer Tools) -- the one place logs are visible
// regardless of how the app was launched (double-clicked, no terminal
// attached, ...). See main.js's mainLog/mainError/broadcastLog.
window.cttc?.onMainLog?.(({ level, text }) => {
  (level === "error" ? console.error : console.log)(`[main] ${text}`);
});

// Default ceiling for get()/post() below -- generous enough for a large
// export/date-range query on localhost or over an ssh tunnel, but finite:
// without this, a stalled server (e.g. mid-recovery) leaves fetch() pending
// forever and the caller's UI hangs with no error (see the "Export metrics
// hangs" regression this default was added to fix).
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

// GET path (relative to the CTTC server, never the docker/ssh target -- see
// normalizeDockerHost below) -> parsed JSON body. Throws on any non-2xx or
// if the server never responds within timeoutMs.
async function get(path, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  let r;
  try {
    r = await fetch(API + path, { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === "TimeoutError") throw new Error(`${path}: no response within ${timeoutMs}ms`);
    throw err;
  }
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function post(path, body, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      method: "POST",
      body: JSON.stringify(body || {}),
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === "TimeoutError") throw new Error(`${path}: no response within ${timeoutMs}ms`);
    throw err;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || `${path}: ${r.status}`);
    e.log = j.log; // docker/ps failures carry the attempted commands (see renderActivityLog)
    // true iff the CTTC server itself sent this response (any non-2xx with
    // a body) -- distinct from fetch() rejecting outright (server
    // unreachable/reset/no response at all), which never reaches this line
    // and so never sets this flag. Needed because a real server-side error
    // can still have no .log (e.g. a plain 500, not a DockerPsError).
    e.serverResponded = true;
    throw e;
  }
  return j;
}

// ssh is the only remote transport CTTC supports, so a Docker host string
// with no scheme (e.g. "user@other-server", exactly what you'd type after
// `ssh `) is unambiguous shorthand for ssh://user@other-server -- without
// this, that shorthand silently fell through to the local daemon instead
// (docker -H user@host isn't a valid endpoint, and HostStatsSource/etc all
// gate their ssh handling on an explicit "ssh://" prefix).
function normalizeDockerHost(raw) {
  const host = (raw || "").trim();
  if (!host) return null;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host) ? host : `ssh://${host}`;
}

/* ── persisted UI preferences ───────────────────────────────────────────── */

const prefs = {
  get(k, dflt) {
    try {
      const v = localStorage.getItem("cttc-" + k);
      return v == null ? dflt : JSON.parse(v);
    } catch { return dflt; }
  },
  set(k, v) { localStorage.setItem("cttc-" + k, JSON.stringify(v)); },
};

/* ── state ──────────────────────────────────────────────────────────────── */

const state = {
  sources: [],            // /sources payload
  range: null,            // {min_ts, max_ts} global
  view: null,             // {t0, t1} visible window (ms)
  // Whether the view auto-follows real time (see followNow()/goLive()) --
  // true by default; any user-initiated pan/zoom (drag, nav thumb,
  // right-click zoom) turns it off via setView's own
  // default behavior, since at that point the user is deliberately looking
  // at a fixed window, not "now". Explicitly turned back on by goLive()
  // (the nav's "now" label) and resetZoom() staying off on purpose --
  // "fit all data" and "keep following now" are different intents.
  live: true,
  cursorT: null,          // clicked time
  // whether cursorT above was set by Live tracking's own auto-click
  // (liveTrackTick) rather than a manual click -- drawn/highlighted in
  // liveTrackColor instead of the normal accent/hl color, see drawVerticals
  // and Panel.render.
  liveTrackCursor: false,
  hoverX: null,           // crosshair pixel x (plot coords) or null
  hoverStrip: null,
  windowMs: 5000,
  series: null,           // /series payload for current view
  ticks: new Map(),       // log source id -> counts[]
  visible: new Map(),     // series name -> bool
  // Which one loaded .cttc-metric/.cttc-record file is the active view --
  // exactly one file's data is ever visible/interactive at a time (see
  // setActiveView), not the multi-select show/hide toggle this used to be
  // (state.hiddenSamples, a Set of *hidden* paths -- any subset could be
  // shown together). null until something is actually loaded, or once the
  // active file's last source closes (see refreshAll's self-heal).
  activeSamplePath: null,
  // Whole-app "analysis" mode -- true whenever a loaded
  // sample/recording should take over the display: the Recording/
  // Frequency/Live tracking toolbar group and every *live* source's
  // graphs/logs hide (see isLiveDataHidden), replaced by one "Back to live
  // tracking" button. Session-only (not persisted): set automatically the
  // moment a metric/recording finishes loading (see btn-load-sample/
  // openRecording), cleared by that button without discarding the sample,
  // so it can flip back and forth as long as the sample stays loaded.
  liveHidden: false,
  hoverGroup: "svc",      // strip group under the pointer: "svc" | "host"
  chartStyle: prefs.get("chartStyle", { svc: "lines", host: "lines" }), // per graph: "lines" | "bars"
  showHost: prefs.get("showHost", true),
  showLanes: prefs.get("showLanes", false), // per-log-source "entry occurred here" bars, between telemetry and host
  track: prefs.get("track", {}),           // series name -> "sel" | "mut" | "hid"
  showOthers: prefs.get("showOthers", true), // list not-selected containers in legend
  poppedOut: new Set(),   // "telemetry" and/or log source ids moved to their own window
  // log source name -> stable position among sibling panels, assigned once
  // per name and kept forever after -- lets a panel hidden (legend
  // click/close) or popped-out-then-brought-back land back in the exact
  // slot it had before instead of wherever syncPanels() happens to (re)add
  // it. Keyed by name (not the ephemeral per-session source id) so it
  // survives the source itself being closed and reopened, same as
  // state.track/state.visible above.
  panelOrder: prefs.get("panelOrder", {}),
  // Which connected Docker host's telemetry/containers are actually shown
  // -- multiple hosts can be collected concurrently server-side (New Docker
  // Host never disconnects a previous one, and lastDockerSessions replays
  // every remembered host on launch), but the graph/snapshot/exports only
  // ever show one at a time (see isOtherDockerHostHidden). "local" or a
  // full "ssh://user@host[:port]" string -- set whenever a host is
  // connected/edited (Set/Edit Docker Host's dlg-ok), self-healed in
  // refreshAll() if it stops matching anything currently open.
  activeDockerHost: prefs.get("activeDockerHost", "local"),
};
// Migrates a pre-per-graph "chartStyle" pref (a bare "lines"/"bars" string,
// applied to every graph at once) to the {svc, host} shape -- carries the
// old single value over to both graphs rather than silently resetting
// anyone's saved preference.
if (typeof state.chartStyle === "string") {
  state.chartStyle = { svc: state.chartStyle, host: state.chartStyle };
  prefs.set("chartStyle", state.chartStyle);
}

/* Tracking states: "sel" plots + normal legend entry; "mut" (not selected)
   listed disabled, not plotted; "hid" filtered out of the legend entirely.
   Series from docker stats collectors default to "mut" (docker stats reports
   every container on the host); series from opened files default to "sel". */
function trackStateOf(s) {
  const t = state.track[s.name];
  if (t) return t;
  const src = state.sources.find((x) => x.id === s.sid);
  return src && String(src.path).startsWith("docker://") ? "mut" : "sel";
}
function setTrack(name, st) {
  state.track[name] = st;
  prefs.set("track", state.track);
}

const ROWH = 22;
const PAGE = 200;
const STRIPS = [
  { key: "cpu", title: "CPU %", fmt: (v) => v.toFixed(1) + "%" },
  { key: "mem", title: "MEM %", fmt: (v) => v.toFixed(1) + "%" },
  { key: "net", title: "NET", fmt: fmtBytes },
];
// NET's byte-rate axis labels ("999.9 GB/s") are the widest text any
// strip ever draws (percentages top out at "100.0%") -- measured here
// once, rather than guessed, so a wide value can never silently clip off
// the left edge of the chart the way a too-small fixed constant did.
const MARGIN_L = (() => {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = "10px system-ui, sans-serif";
  return Math.ceil(ctx.measureText("999.9 GB/s").width) + 8;
})();
const MARGIN_R = 8, AXIS_H = 20;
const STRIP_MIN_H = 44;
// Per-strip height -- no longer a fixed/dragged value: each group (svc,
// host) auto-fits its own strips to whatever vertical room its container
// (#charts/#host-charts) actually has, shrinking or growing with it rather
// than staying a constant pixel height regardless of available space.
// Recomputed per group right before that group's own drawStrip() calls
// (see drawAll()) -- read by drawStrip() as a plain module variable since
// strips within one group always draw synchronously, back to back.
let stripH = 96;
function computeStripH(containerEl) {
  const avail = containerEl.clientHeight - AXIS_H;
  return Math.max(STRIP_MIN_H, avail / STRIPS.length);
}

// "now" line (Preferences > Appearance > "Now" line) -- a marker for the
// actual current time, distinct from the cursor/selection accent line.
const DEFAULT_NOW_COLOR = "#14b8a6";
const DEFAULT_NOW_STYLE = "dotted";
const NOW_LINE_DASHES = { dotted: [2, 4], dashed: [8, 5], solid: [] };
let nowLineColor = prefs.get("nowLineColor", DEFAULT_NOW_COLOR);
let nowLineStyle = prefs.get("nowLineStyle", DEFAULT_NOW_STYLE);

// Live tracking (Preferences > Appearance > "Live tracking", and the
// toolbar/Settings "Live tracking" seconds field): while the view is
// following live (state.live), every refresh simulates a click at
// now + this many seconds (negative looks slightly into the past instead
// of ahead) -- see liveTrackTick(), called from refreshAll(). Rendered as
// a green bar (see drawVerticals) distinct from a manual click's thin
// accent cursor line, and the same color highlights matching log rows
// (see Panel.render's "hl-live" class) -- distinct from the ordinary
// selection highlight color so an auto-tracked position reads differently
// from one the user picked themselves.
const DEFAULT_LIVE_TRACK_COLOR = "#22c55e";
let liveTrackColor = prefs.get("liveTrackColor", DEFAULT_LIVE_TRACK_COLOR);

// Recording capture-range bands (Preferences > Appearance > "Recording
// capture", see drawVerticals and ui-REC-004) -- previously a fixed
// themeVar("--warning"), now user-configurable like the other canvas-drawn
// markers above. Default matches --warning's own value (style.css) so
// existing installs see no change until they actually pick a color.
const DEFAULT_RECORDING_COLOR = "#fab219";
let recordingBandColor = prefs.get("recordingBandColor", DEFAULT_RECORDING_COLOR);
// Film-strip-style perforations along the top/bottom edge of the same
// band (see drawVerticals) -- purely decorative, so on by default but
// toggleable off (Preferences > Appearance > "Recording capture") for
// anyone who finds them distracting against dense chart data.
let recordingSprocketHoles = prefs.get("recordingSprocketHoles", true);
// Offset (seconds, never positive -- see setLiveTrackSecs) added to
// Date.now() on every refresh while live; see liveTrackTick() in
// the refresh/SSE section below.
let liveTrackSecs = prefs.get("liveTrackSecs", 0);
// On by default (per the feature's own spec) -- the toolbar/Settings
// switch turns it off entirely, independent of the seconds offset above.
let liveTrackEnabled = prefs.get("liveTrackEnabled", true);
// How long a double-click recenter pauses live-follow before it resumes on
// its own (seconds). 0 disables auto-resume -- stays paused until the user
// clicks "now" themselves, matching drag/context-menu zoom.
let dblclickResumeSecs = prefs.get("dblclickResumeSecs", 10);
// How long a non-persistent bottom status-bar message (notifyEvent) stays
// before auto-clearing (seconds) -- see notifyEvent/scheduleStatusBarClear.
let statusBarClearSecs = prefs.get("statusBarClearSecs", 5);

// FMT domain (fmtBytes, fmtClock, colorFor, generatedSlotColor, themeVar,
// sampleSlot, hexToRgb, grayedColor, hatchPattern) now lives in
// src/shared/format/ -- see entry.ts, which assigns each back onto window
// since this file still calls them by bare identifier as a classic script.

/* ── sample vs. live styling ───────────────────────────────────────────────
   ui-CHART-026 (see stay-the-course/sampled-vs-live-data.md, updated):
   a loaded .cttc-metric/.cttc-record sample's data is exactly as real as
   live data, just not still updating -- the main charts (lines/bars) draw
   it identically to live data, full color/saturation, no dashing. Log
   density lanes (a different, auxiliary chart element -- see
   ui-CHART-009) still hatch sample-sourced lanes; each *sample file*
   (source id) still gets its own gray level there so several loaded
   samples stay visually distinguishable from each other. */

// A source is "live" (still being tailed/polled) unless the server marked
// it live:false, which only happens for sources restored from a loaded
// .cttc-metric/.cttc-record file (see State.load_sample in server.py) --
// everything else
// (opened files, docker/ssh collectors) stays live.
function isLiveSid(sid) {
  const src = state.sources.find((s) => s.id === sid);
  return !src || src.live !== false; // source unknown yet -> assume live
}
function basename(p) {
  return String(p || "").split("/").pop();
}
// group every non-live source by its originating .cttc-metric/.cttc-record
// file, so the whole
// file's data can be shown/hidden with one click
function sampleFileGroups() {
  const byPath = new Map();
  for (const s of state.sources) {
    if (s.live !== false) continue;
    if (!byPath.has(s.path)) byPath.set(s.path, { path: s.path, ids: new Set() });
    byPath.get(s.path).ids.add(s.id);
  }
  return [...byPath.values()];
}
// true if this source belongs to a loaded .cttc-metric/.cttc-record file
// that shouldn't be shown right now: either it isn't the active view's own
// file (see setActiveView), or we're not even in analysis mode at all.
// Extremely hard rule: live view and analysis view never share data in
// either direction -- Back to Live (setLiveHidden(false)) deliberately
// never clears state.activeSamplePath (loaded samples aren't closed, so
// Opened Data can still list them), so the `!state.liveHidden` check here
// is what actually hides a just-left sample's data once back in live view;
// without it this only ever compared *which* sample, never *whether* one
// should be showing at all. Checked everywhere a sample-sourced
// series/lane/panel might need hiding.
function isSampleHidden(sid) {
  const src = state.sources.find((s) => s.id === sid);
  return !!(src && src.live === false && (!state.liveHidden || src.path !== state.activeSamplePath));
}
// The inverse of isSampleHidden: true for a *live* source while the app is
// in analysis mode (state.liveHidden) -- checked
// everywhere isSampleHidden is, so live and sample data hide symmetrically
// depending on which one the toolbar is currently focused on.
function isLiveDataHidden(sid) {
  return state.liveHidden && isLiveSid(sid);
}
// true if this source is live docker telemetry/logs from a Docker host
// other than the currently active one (state.activeDockerHost) -- multiple
// hosts can be collected concurrently in the background (see New Docker
// Host's own docstring), but only the active host's data is ever shown.
// Orthogonal to isSampleHidden/isLiveDataHidden: a loaded/uploaded sample
// (live === false) is never host-scoped, so this only ever applies to a
// live docker:// source.
function isOtherDockerHostHidden(sid) {
  const src = state.sources.find((s) => s.id === sid);
  if (!src || src.live !== true || !/^docker:\/\//.test(src.path || "")) return false;
  return (src.host || "local") !== (state.activeDockerHost || "local");
}
/* ── layout references ──────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const chartsEl = $("charts"), lanesEl = $("lanes"), legendEl = $("legend");
const panelsEl = $("panels"), tooltipEl = $("tooltip");
const hostChartsEl = $("host-charts"), hostBlockEl = $("host-block");
const chartNav = attachTimelineNav($("chart-nav"));
const hostNav = attachTimelineNav($("host-nav"));

/* ── instant hover hints ── every titled element gets its tooltip text shown
   right away next to the cursor, instead of waiting for the browser's native
   (and comparatively slow) title-attribute delay. We swap the real "title"
   out while hovering so the native tooltip never gets a chance to appear. */
const hintEl = $("hint");
let hintTarget = null;

function positionHint(e) {
  const pad = 14;
  hintEl.style.left = Math.max(4, Math.min(e.clientX + pad, innerWidth - hintEl.offsetWidth - 4)) + "px";
  hintEl.style.top = Math.max(4, Math.min(e.clientY + pad, innerHeight - hintEl.offsetHeight - 4)) + "px";
}
function hideHint() {
  if (hintTarget) {
    hintTarget.setAttribute("title", hintTarget.dataset.hintTitle);
    delete hintTarget.dataset.hintTitle;
    hintTarget = null;
  }
  hintEl.hidden = true;
}
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest("[title]");
  if (!el || el === hintTarget || !el.getAttribute("title")) return;
  hideHint();
  hintTarget = el;
  el.dataset.hintTitle = el.getAttribute("title");
  el.removeAttribute("title");
  // native <dialog> elements paint in the browser's top layer, above any
  // z-index in the regular DOM -- reparent the hint into the open dialog
  // (if any) so it isn't hidden underneath it.
  const dlg = el.closest("dialog[open]");
  (dlg || document.body).appendChild(hintEl);
  hintEl.textContent = hintTarget.dataset.hintTitle;
  hintEl.hidden = false;
  positionHint(e);
});
document.addEventListener("mousemove", (e) => {
  if (!hintTarget) return;
  if (!hintTarget.isConnected) { hideHint(); return; }
  positionHint(e);
});
document.addEventListener("mouseout", (e) => {
  if (hintTarget && (!e.relatedTarget || !hintTarget.contains(e.relatedTarget))) hideHint();
});
document.addEventListener("mousedown", hideHint);

// this window is itself a popped-out panel: show only that panel, full-size.
if (POPOUT_KIND === "telemetry") document.body.classList.add("popout-telemetry");
if (POPOUT_KIND === "log") document.body.classList.add("popout-log");
if (POPOUT_KIND === "host") document.body.classList.add("popout-host");
// a single container/series in its own window: same layout as the telemetry
// popout, but every chart is filtered down to that one series
if (POPOUT_KIND === "series") {
  document.body.classList.add("popout-series");
  document.title = `${POPOUT_ID} — CTTC`;
  document.querySelector("#chart-head span").textContent = POPOUT_ID;
}

// True platform distinction (Cmd vs Ctrl, menu label glyphs) -- NOT the
// same question as which side the OS's window-control buttons are on
// (see controlsSide, defined below panels/Panel since it needs to walk
// existing panels): macOS traffic lights are always left, an OS
// constant, but Windows/Linux control-button position genuinely varies
// by theme/DE and can't be inferred from the platform alone.
const IS_MAC = navigator.platform.toUpperCase().includes("MAC");

// in the main window, hide whichever panels have been popped out elsewhere.
function applyPopoutLayout() {
  if (POPOUT_KIND) return; // popout windows have a fixed single-panel layout
  $("chart-block").hidden = state.poppedOut.has("telemetry");
}
$("btn-popout-telemetry").hidden = !window.cttc?.popout || POPOUT_KIND != null;
$("btn-popout-host").hidden = !window.cttc?.popout || POPOUT_KIND != null;

// inside a popped-out panel window, replace the pop-out button with a
// "pop back" button that just closes this window (the opener reintegrates
// the panel once it sees the window close, via onPopoutClosed below).
for (const kind of ["telemetry", "host"]) {
  const b = $(`btn-popback-${kind}`);
  b.hidden = POPOUT_KIND !== kind;
  b.onclick = () => window.close();
}
// a series popout reuses the telemetry header's pop-back button
if (POPOUT_KIND === "series") $("btn-popback-telemetry").hidden = false;

/* ── time/pixel mapping ─────────────────────────────────────────────────── */

// Plottable width in CSS pixels, i.e. canvas width minus the left axis-label
// margin and right padding -- every x<->t conversion below goes through
// this, so it's the one place that'd need to change if the margins did.
function plotWidth() {
  // svc and host strips share the same geometry; fall back to whichever
  // container is actually visible (a host-only popout hides #charts).
  const el = chartsEl.clientWidth > 0 ? chartsEl : hostChartsEl;
  return Math.max(50, el.clientWidth - MARGIN_L - MARGIN_R);
}
// CSS-pixel x (within a strip canvas) -> epoch ms, linear over state.view.
function xToT(x) {
  const { t0, t1 } = state.view;
  return t0 + ((x - MARGIN_L) / plotWidth()) * (t1 - t0);
}
// epoch ms -> CSS-pixel x -- the inverse of xToT(), same linear mapping.
function tToX(t) {
  const { t0, t1 } = state.view;
  return MARGIN_L + ((t - t0) / (t1 - t0)) * plotWidth();
}

/* ── charts ─────────────────────────────────────────────────────────────── */

const stripCanvases = [];
const hostCanvases = [];

function buildStrips() {
  chartsEl.innerHTML = "";
  hostChartsEl.innerHTML = "";
  stripCanvases.length = 0;
  hostCanvases.length = 0;
  for (const [arr, parent, group] of [[stripCanvases, chartsEl, "svc"], [hostCanvases, hostChartsEl, "host"]]) {
    STRIPS.forEach((_, i) => {
      const c = document.createElement("canvas");
      c.className = "strip";
      c.dataset.strip = i;
      c.dataset.group = group;
      c.title = "Click: move cursor  ·  Drag: zoom to selection  ·  Right-click: capture/snapshot menu";
      parent.appendChild(c);
      arr.push(c);
    });
  }
  attachChartEvents();
}

// Sizes a canvas to its parent's current CSS width x the given CSS height,
// backed by a devicePixelRatio-scaled bitmap so lines/text stay crisp on
// HiDPI screens, then returns a 2D context pre-scaled back to CSS-pixel
// coordinates -- every drawStrip()/drawLane() call can then just draw in
// plain CSS pixels without worrying about the underlying pixel density.
// Called on every redraw (not cached), since the canvas's CSS size can
// change (window resize, splitter drag) between draws.
function sizeCanvas(c, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.parentElement.clientWidth;
  c.style.height = cssH + "px";
  c.width = Math.round(w * dpr);
  c.height = Math.round(cssH * dpr);
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function seriesOf(group, respectVisibility = true) {
  return (state.series?.services || []).filter((s) => {
    if (!!s.host !== (group === "host")) return false;
    if (group === "svc" && POPOUT_KIND === "series") {
      // a series popout shows exactly its one series, whatever its track state
      return s.name === POPOUT_ID && !isSampleHidden(s.sid) && !isLiveDataHidden(s.sid) && !isOtherDockerHostHidden(s.sid);
    }
    if (group === "svc" && trackStateOf(s) !== "sel") return false;
    if (isSampleHidden(s.sid) || isLiveDataHidden(s.sid) || isOtherDockerHostHidden(s.sid)) return false;
    return !respectVisibility || state.visible.get(s.name) !== false;
  });
}

function allSvcSeries() {
  return (state.series?.services || []).filter((s) => !s.host);
}

// "Host telemetry" on its own doesn't say *which* host -- server.py names
// the host-stats source "host@<hostname>" (bare hostname, no user@, see
// HostStatsSource) specifically so the client can pull it back out here.
function hostTelemetryLabel() {
  const src = state.sources.find((s) => s.kind === "stats" && s.is_host && !isOtherDockerHostHidden(s.id));
  const name = String(src?.name || "");
  const host = name.startsWith("host@") ? name.slice("host@".length) : "";
  if (!host || host === "local") return "Host telemetry — localhost";
  return `Host telemetry — ${host}`;
}

function drawAll() {
  if (!state.view) return;
  const hasHost = seriesOf("host", false).length > 0;
  // a host-telemetry source was added but hasn't produced any samples yet
  // (docker stats / the ssh poller need a beat to report the first reading)
  const hostLoading = !hasHost && state.sources.some((s) => s.kind === "stats" && s.is_host);
  const hostPoppedOut = !POPOUT_KIND && state.poppedOut.has("host");
  // a "telemetry"/"log" popout only ever shows containers, never the host.
  hostBlockEl.hidden = POPOUT_KIND === "host" ? false : (POPOUT_KIND != null || !(hasHost || hostLoading) || hostPoppedOut);
  if (!hostBlockEl.hidden) $("host-title").textContent = hostTelemetryLabel();
  const showingHostArea = !hostBlockEl.hidden && state.showHost;
  $("host-loading").hidden = !(showingHostArea && hostLoading);
  hostChartsEl.hidden = !showingHostArea || hostLoading;
  $("host-nav").hidden = !showingHostArea || hostLoading;
  $("btn-host-toggle").textContent = state.showHost ? "\u25be" : "\u25b8";
  $("btn-host-toggle").title = state.showHost ? "Hide host telemetry" : "Show host telemetry";
  lanesEl.hidden = !state.showLanes;
  $("btn-lanes-toggle").textContent = state.showLanes ? "\u25be" : "\u25b8";
  $("btn-lanes-toggle").title = state.showLanes ? "Hide log entry markers" : "Show log entry markers";
  stripH = computeStripH(chartsEl);
  STRIPS.forEach((spec, i) => drawStrip(stripCanvases[i], spec, "svc", i === 0, i === STRIPS.length - 1));
  if (hasHost && state.showHost && !hostBlockEl.hidden) {
    stripH = computeStripH(hostChartsEl);
    STRIPS.forEach((spec, i) => drawStrip(hostCanvases[i], spec, "host", i === 0, i === STRIPS.length - 1));
  }
  if (state.showLanes) drawLanes();
  updateTimelineNav(chartNav);
  updateTimelineNav(hostNav);
}

function drawStrip(c, spec, group, isFirst, isLast) {
  if (!c) return;
  const h = stripH + (isLast ? AXIS_H : 0);
  const ctx = sizeCanvas(c, h);
  const w = c.clientWidth, pw = plotWidth();
  ctx.clearRect(0, 0, w, h);
  drawHighlightBands(ctx, h, isFirst, isLast, true);

  const services = seriesOf(group);
  let max = spec.key === "net" ? 1 : 100;
  for (const s of services) for (const v of s[spec.key]) if (v != null && v > max) max = v;
  max *= 1.05;

  const y = (v) => stripH - 6 - (v / max) * (stripH - 22);

  // grid + y labels
  ctx.strokeStyle = themeVar("--grid");
  ctx.fillStyle = themeVar("--muted");
  ctx.font = "10px system-ui, sans-serif";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  for (const frac of [0.5, 1]) {
    const v = (max / 1.05) * frac;
    const yy = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(MARGIN_L, yy);
    ctx.lineTo(MARGIN_L + pw, yy);
    ctx.stroke();
    ctx.fillText(spec.fmt(v), MARGIN_L - 5, yy + 3);
  }
  // baseline
  ctx.strokeStyle = themeVar("--baseline");
  ctx.beginPath();
  ctx.moveTo(MARGIN_L, stripH - 5.5);
  ctx.lineTo(MARGIN_L + pw, stripH - 5.5);
  ctx.stroke();

  // strip title
  ctx.textAlign = "left";
  ctx.fillStyle = themeVar("--text-secondary");
  ctx.font = "600 10px system-ui, sans-serif";
  ctx.fillText(spec.title, MARGIN_L + 4, 12);

  const px = state.series?.px || pw;
  if (state.chartStyle[group] === "bars") {
    // histogram: one bar per non-empty bucket, translucent so overlapping
    // series stay readable. Sample-sourced series render identically to
    // live ones (ui-CHART-026) -- a loaded .cttc-metric/.cttc-record
    // file's data is exactly as real as live data, just not still updating.
    const bw = Math.max(1, pw / px - 0.5);
    for (const s of services) {
      ctx.globalAlpha = services.length > 1 ? 0.55 : 0.85;
      ctx.fillStyle = colorFor(s.name);
      const arr = s[spec.key];
      for (let b = 0; b < arr.length; b++) {
        if (arr[b] == null) continue;
        const x = MARGIN_L + (b / px) * pw;
        ctx.fillRect(x, y(arr[b]), bw, stripH - 6 - y(arr[b]));
      }
    }
    ctx.globalAlpha = 1;
  } else {
    // series lines. Buckets are sparse when zoomed out (one sample every
    // N pixels), so connect across gaps up to ~4x the typical sample spacing
    // and render truly isolated samples as dots. Sample-sourced series
    // render as full, solid, full-saturation lines, same as live ones (see
    // the bars branch above for why).
    for (const s of services) {
      const arr = s[spec.key];
      const pts = [];
      for (let b = 0; b < arr.length; b++)
        if (arr[b] != null) pts.push([b, arr[b]]);
      if (!pts.length) continue;
      const spacing = Math.max(1, px / pts.length);
      const gapLimit = spacing * 4;
      const color = colorFor(s.name);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.lineJoin = "round";
      ctx.beginPath();
      let runLen = 0;
      for (let k = 0; k < pts.length; k++) {
        const [b, v] = pts[k];
        const x = MARGIN_L + (b / px) * pw + 0.5;
        const broke = k === 0 || pts[k][0] - pts[k - 1][0] > gapLimit;
        if (broke) {
          if (runLen === 1) dot(ctx, prevX, prevY);
          ctx.moveTo(x, y(v));
          runLen = 1;
        } else {
          ctx.lineTo(x, y(v));
          runLen++;
        }
        var prevX = x, prevY = y(v);
      }
      if (runLen === 1) dot(ctx, prevX, prevY);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // time axis on last strip
  if (isLast) {
    ctx.fillStyle = themeVar("--muted");
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "center";
    const { t0, t1 } = state.view;
    const nTicks = Math.max(2, Math.floor(pw / 110));
    for (let k = 0; k <= nTicks; k++) {
      const t = t0 + ((t1 - t0) * k) / nTicks;
      const x = tToX(t);
      ctx.fillText(fmtClock(t), Math.min(Math.max(x, MARGIN_L + 24), w - 30), stripH + 13);
      ctx.strokeStyle = themeVar("--grid");
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, stripH - 5);
      ctx.lineTo(Math.round(x) + 0.5, stripH);
      ctx.stroke();
    }
  }

  // crosshair (hover) + cursor (clicked)
  drawVerticals(ctx, h);
}

// A small filled circle marking a truly isolated data point (no neighbor
// within the line-drawing gap limit to connect to) -- appends to the
// caller's already-open path; caller is responsible for stroke()/fill().
function dot(ctx, x, y) {
  ctx.moveTo(x + 1.5, y);
  ctx.arc(x, y, 1.5, 0, Math.PI * 2);
}

// Highlight bands (drag selection + persistent recording capture-range) --
// drawn first, before the grid/data/labels above them, so a highlight
// always reads as "behind" the chart, never obscuring it. drawVerticals
// (below) handles the cursor/crosshair/"now" line instead: those are
// interactive overlay indicators, not highlights, and stay on top on
// purpose so they're never hidden by the chart they're pointing at.
function drawHighlightBands(ctx, h, isFirst = false, isLast = false, isStrip = false) {
  // active drag selection band (zoom = accent, sample = warning)
  if (dragStart != null && dragX != null && Math.abs(dragX - dragStart) > 2) {
    ctx.fillStyle = themeVar(dragIsSample ? "--warning" : "--accent");
    ctx.globalAlpha = 0.15;
    ctx.fillRect(Math.min(dragStart, dragX), 0, Math.abs(dragX - dragStart), h);
    ctx.globalAlpha = 1;
  }
  // While a recording session is running (or paused mid-session), band
  // every range that's actually been/being captured -- same color/alpha as
  // a "capture metrics" drag selection (--warning), just persistent
  // instead of only shown mid-drag, so it reads as "this is what's being
  // saved" across every chart strip and log density lane alike (both draw
  // through this same function). Drawn as one rect per completed segment
  // (recording.segments, each finalized by a Pause) plus, while actually
  // recording, one more live rect for the in-progress segment -- NOT one
  // single rect from the session's first Start to now, which would wrongly
  // paint straight through a pause's gap as if it had been captured too.
  // One known exception (ui-REC-019/br-ORPHAN-005, REQ-0067): a segment
  // resumed via the crash-recovery prompt's "Resume from the interruption
  // point" option can span real dead time if the *gateway process itself*
  // (not just the app UI) was down during part of it -- this band has no
  // sub-range awareness, so that stretch still paints as fully captured
  // even though the underlying data genuinely has a gap in it. Accepted
  // for now: fixing it needs a new sub-range data shape plus an eager
  // Redis query, disproportionate to what this pass needed.
  if ((recording.status === "recording" || recording.status === "paused") && state.view) {
    const ranges = recording.segments.slice();
    if (recording.status === "recording" && recording.segmentStart != null) {
      ranges.push({ from: recording.segmentStart, to: Date.now() });
    }
    ctx.fillStyle = recordingBandColor;
    for (const { from, to } of ranges) {
      const xLo = Math.max(MARGIN_L, Math.min(MARGIN_L + plotWidth(), tToX(from)));
      const xHi = Math.max(MARGIN_L, Math.min(MARGIN_L + plotWidth(), tToX(to)));
      if (xHi <= xLo) continue;
      ctx.globalAlpha = 0.15;
      ctx.fillRect(xLo, 0, xHi - xLo, h);
      // Film-strip-style decoration, purely cosmetic (toggle: Preferences >
      // Appearance > "Recording capture" > Sprocket holes). Two parts,
      // sharing one x-cadence (holeW/spacing/inset) so they line up:
      if (recordingSprocketHoles && isStrip) {
        const holeW = 15, holeH = 9, holeR = 3, spacing = 22, inset = 7;
        // 1. Perforations -- rounded-rect sprocket holes, like a real 35mm
        // strip's edge. Bookends the whole CPU/MEM/NET strip group rather
        // than repeating per strip: only the first strip (CPU) gets the top
        // row, only the last (NET) gets the bottom row, so a 3-strip group
        // shows exactly one of each, not three. Never drawn for density
        // lanes (isStrip is false there).
        if (isFirst || isLast) {
          // True cutouts (erase, not another shade of the band color) --
          // real film perforations let light straight through, so these
          // punch back to the strip's own background rather than painting
          // a darker patch of recordingBandColor on top of it.
          ctx.globalCompositeOperation = "destination-out";
          ctx.globalAlpha = 1;
          for (let x = xLo + inset; x <= xHi - inset - holeW; x += spacing) {
            if (isFirst) {
              ctx.beginPath();
              ctx.roundRect(x, inset, holeW, holeH, holeR);
              ctx.fill();
            }
            if (isLast) {
              ctx.beginPath();
              ctx.roundRect(x, h - inset - holeH, holeW, holeH, holeR);
              ctx.fill();
            }
          }
          ctx.globalCompositeOperation = "source-over";
        }
        // 2. Frame-division lines -- one faint vertical every third
        // perforation's gap (centered between two holes, never crossing
        // one), spanning this strip's own full height. Unlike the
        // perforations, drawn on *every* strip in the group -- including
        // MEM, which gets no holes -- so the lines land at identical x
        // positions on each strip's own canvas (same view, same tToX) and
        // read as one continuous line once the group is stacked, the way a
        // real frame line runs the full height between the two perforation
        // rows rather than just bookending the strip.
        ctx.globalAlpha = 0.25;
        ctx.strokeStyle = recordingBandColor;
        ctx.lineWidth = 1;
        let i = 0;
        for (let x = xLo + inset; x <= xHi - inset - holeW; x += spacing, i++) {
          if (i % 3 !== 0) continue;
          const lineX = Math.round(x + holeW + (spacing - holeW) / 2) + 0.5;
          ctx.beginPath();
          ctx.moveTo(lineX, 0);
          ctx.lineTo(lineX, h);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }
}

function drawVerticals(ctx, h) {
  if (state.cursorT != null && state.view) {
    const x = tToX(state.cursorT);
    if (x >= MARGIN_L && x <= MARGIN_L + plotWidth()) {
      if (state.liveTrackCursor) {
        // Live tracking's own auto-click: a soft filled bar, not just a
        // thin line -- visually distinct from a manual click's accent
        // cursor line, see setCursor's liveTrack option / liveTrackTick.
        ctx.fillStyle = liveTrackColor;
        ctx.globalAlpha = 0.25;
        ctx.fillRect(x - 3, 0, 6, h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = liveTrackColor;
      } else {
        ctx.strokeStyle = themeVar("--accent");
      }
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }
  if (state.hoverX != null) {
    ctx.strokeStyle = themeVar("--muted");
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(state.hoverX + 0.5, 0);
    ctx.lineTo(state.hoverX + 0.5, h);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // "now" marker: real time progressing across the chart, independent of
  // the cursor/selection -- see Preferences > Appearance > "Now" line.
  // Only meaningful while Live is the active view: a loaded metric/
  // recording is static, already-captured data, and a line silently
  // drifting across it as real time passes would read as something in the
  // *file* were still moving (BUG-0078).
  if (state.view && !state.liveHidden) {
    const nowX = tToX(Date.now());
    if (nowX >= MARGIN_L && nowX <= MARGIN_L + plotWidth()) {
      ctx.strokeStyle = nowLineColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(NOW_LINE_DASHES[nowLineStyle] || []);
      ctx.beginPath();
      ctx.moveTo(nowX + 0.5, 0);
      ctx.lineTo(nowX + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/* ── density lanes (one per log source) ─────────────────────────────────── */

function drawLanes() {
  let logs = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id) && !isLiveDataHidden(s.id) && !isOtherDockerHostHidden(s.id));
  // a series popout keeps only the lanes of the same-named log source(s)
  if (POPOUT_KIND === "series") logs = logs.filter((s) => s.name === POPOUT_ID);
  // rebuild DOM if the set changed
  const want = logs.map((s) => s.id).join(",");
  if (lanesEl.dataset.ids !== want) {
    lanesEl.dataset.ids = want;
    lanesEl.innerHTML = "";
    for (const s of logs) {
      const canvas = document.createElement("canvas");
      canvas.className = "lane-canvas";
      canvas.dataset.sid = s.id;
      canvas.title = s.name;
      attachLaneEvents(canvas);
      lanesEl.appendChild(canvas);
    }
  }
  for (const c of lanesEl.querySelectorAll("canvas")) drawLane(c);
}

const LANE_H = 8; // was 18 -- these are just "an entry happened here" tick marks, not worth the same weight as the strips

function drawLane(c) {
  const sid = c.dataset.sid;
  const src = state.sources.find((s) => s.id === sid);
  const ctx = sizeCanvas(c, LANE_H);
  const w = c.clientWidth;
  const pw = plotWidth(); // identical geometry to the strips above
  ctx.clearRect(0, 0, w, LANE_H);
  drawHighlightBands(ctx, LANE_H);
  const counts = state.ticks.get(sid);
  const live = !src || src.live !== false;
  const color = colorFor(src?.name || sid);
  if (counts) {
    const maxC = Math.max(1, ...counts);
    const n = counts.length;
    ctx.fillStyle = live ? color : hatchPattern(ctx, grayedColor(color, sid), sid);
    for (let b = 0; b < n; b++) {
      if (!counts[b]) continue;
      ctx.globalAlpha = live ? 0.35 + 0.65 * (counts[b] / maxC) : 0.85;
      const x = MARGIN_L + (b / n) * pw;
      ctx.fillRect(x, 1, Math.max(1, pw / n - 0.5), LANE_H - 2);
    }
    ctx.globalAlpha = 1;
  }
  drawVerticals(ctx, LANE_H);
}

// double-click anywhere on the timeline (strips or lanes) re-centers every
// panel on that point in time, keeping the current zoom span (no zoom change)
function timelineDblclick(c, e) {
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < MARGIN_L || !state.view) return;
  recenterOn(xToT(x));
}

function attachLaneEvents(c) {
  c.addEventListener("mousedown", (e) => timelineDown(c, e));
  c.addEventListener("mouseup", (e) => timelineUp(c, e));
  c.addEventListener("dblclick", (e) => timelineDblclick(c, e));
  c.addEventListener("mousemove", (e) => {
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    state.hoverX = x >= MARGIN_L && x <= MARGIN_L + plotWidth() ? x : null;
    if (dragStart != null && e.buttons & 1) dragX = x;
    drawAll();
  });
  c.addEventListener("mouseleave", () => {
    state.hoverX = null;
    drawAll();
  });
}

/* ── legend ─────────────────────────────────────────────────────────────── */

/* ── legend context menu ────────────────────────────────────────────────── */

// ctxMenu/closeCtxMenu now live in src/shared/ctx-menu/ (positioning backed
// by @floating-ui/dom instead of the old hand-rolled Math.min clamp) -- see
// entry.ts.
window.addEventListener("click", closeCtxMenu);
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeCtxMenu();
  if (sampleArmed) { setSampleArmed(false); setStatus(""); }
  for (const p of panels.values()) {
    if (p.selected.size) { p.selected.clear(); p.render(); }
  }
});

// Track a so-far-unselected container: plot its telemetry and start following
// its logs from the docker host its stats came from.
async function startTracking(s) {
  setTrack(s.name, "sel");
  renderLegend();
  drawAll();
  const p = String(state.sources.find((x) => x.id === s.sid)?.path || "");
  if (p.startsWith("docker://") && p.endsWith("/stats")) {
    const host = p.slice("docker://".length, -"/stats".length);
    const ttype = s.ttype || "container";
    if (!openPaths().has(`docker://${host}/${ttype}/${s.name}`)) {
      try {
        await post("/docker/collect", {
          host: host === "local" ? null : host,
          stats: false, host_stats: false, transforms: [],
          logs: [{ name: s.name, type: ttype }],
          ssh_key: dockerHostKeys.get(host) ?? null,
          interval: dockerPollIntervalSecs,
        });
      } catch (err) {
        notifyEvent(String(err.message || err));
      }
    }
  }
  refreshAll();
}

/* ── legend ─────────────────────────────────────────────────────────────── */

// One legend entry: a color swatch (colorFor(name), or gray if `cls`
// includes "disabled") + a text label.
function legendItem(name, cls) {
  const item = document.createElement("span");
  item.className = "legend-item" + (cls ? " " + cls : "");
  const sw = document.createElement("span");
  sw.className = "legend-swatch";
  sw.style.background = cls === "disabled" ? "var(--muted)" : colorFor(name);
  item.append(sw, document.createTextNode(name));
  return item;
}

// A small pill-shaped, clickable label used for the "others (N)"/"hidden
// (N)" group headers in the legend -- no swatch, just text.
function legendChip(text) {
  const chip = document.createElement("span");
  chip.className = "legend-chip";
  chip.textContent = text;
  return chip;
}

// Read-only "currently viewing: <name>" line -- switching which loaded
// file is active (or back to Live) now lives solely in the view-switcher
// pill's dropdown (see setActiveView), not a per-file toggle here: two
// controls for the same state is exactly how ui-LIVE-005 happened before.
function renderSampleFiles() {
  const groups = sampleFileGroups();
  if (!groups.length) return;
  const box = document.createElement("div");
  box.id = "sample-files";
  const active = groups.find((g) => g.path === state.activeSamplePath) || groups[0];
  const row = document.createElement("div");
  row.className = "ctl sample-file-row";
  row.title = active.path;
  row.textContent = `Viewing: ${basename(active.path)}`;
  box.appendChild(row);
  legendEl.appendChild(box);
}

function relist() {
  renderLegend();
  drawAll();
}

// the view/cursor handed to a new popout window so it opens on exactly the
// same time range as this window (no blank boot, no zoom reset)
function popoutView() {
  return state.view ? { t0: state.view.t0, t1: state.view.t1, cursor: state.cursorT } : null;
}

// open one container's / loaded record's telemetry in its own synced window
// (kept as a plain function so the E2E spec can stub it)
function openSeriesPopout(name) {
  window.cttc?.popout?.("series", name, popoutView());
}

// open one log panel in its own synced window -- shared by its ⧉ button and
// dragging its header out past the window's edge (kept as a plain function,
// same reason as openSeriesPopout above, so the E2E spec can stub it)
function openLogPopout(sid) {
  state.poppedOut.add(sid);
  syncPanels();
  window.cttc?.popout?.("log", sid, popoutView());
}

function seriesPopoutMenuEntry(s) {
  return window.cttc?.popout
    ? [[`⧉ Open “${s.name}” in its own window`, () => openSeriesPopout(s.name)]]
    : [];
}

function renderLegend() {
  legendEl.innerHTML = "";
  renderSampleFiles();
  // Same rule seriesOf() already enforces for the chart itself: only the
  // active view's own series belong here -- a live container's series
  // while a sample is the active view (or vice versa), or a *different*
  // loaded file's own series, must never appear alongside the active
  // one's (BUG-0082 -- this filter was missing here, so every container
  // ever tracked across every load kept piling up in the legend forever).
  let all = allSvcSeries().filter((s) => !isSampleHidden(s.sid) && !isLiveDataHidden(s.sid) && !isOtherDockerHostHidden(s.sid));
  // a series popout's legend shows just its one series, always as selected
  if (POPOUT_KIND === "series") all = all.filter((s) => s.name === POPOUT_ID);
  const sel = all.filter((s) => POPOUT_KIND === "series" || trackStateOf(s) === "sel")
    .sort((a, b) => orderOf(a.name) - orderOf(b.name));
  const mut = POPOUT_KIND === "series" ? [] : all.filter((s) => trackStateOf(s) === "mut");
  const hid = POPOUT_KIND === "series" ? [] : all.filter((s) => trackStateOf(s) === "hid");

  for (const s of sel) {
    const sample = !isLiveSid(s.sid);
    const cls = (state.visible.get(s.name) === false ? "off " : "") + (sample ? "sample" : "");
    const item = legendItem(s.name, cls.trim());
    if (sample) item.title = "from loaded .cttc-metric/.cttc-record data";
    item.onclick = () => {
      state.visible.set(s.name, state.visible.get(s.name) === false);
      relist();
      syncPanels(); // this container's log panel (if any) hides/reappears alongside its chart series
    };
    item.oncontextmenu = (e) => ctxMenu(e, [
      ...seriesPopoutMenuEntry(s),
      [`Unselect “${s.name}” (keep listed, disabled)`, () => { setTrack(s.name, "mut"); relist(); }],
      [`Hide “${s.name}” entirely`, () => { setTrack(s.name, "hid"); relist(); }],
    ]);
    // Drag to reorder (moves this container's log panel to match), or drag
    // out past the window's edge to pop its telemetry out into its own
    // window -- same "drag out to detach" gesture as the log panel below.
    if (POPOUT_KIND !== "series") wireDragReorder(item, s.name, () => openSeriesPopout(s.name));
    legendEl.appendChild(item);
  }

  if (mut.length) {
    const chip = legendChip(`others (${mut.length}) ${state.showOthers ? "▾" : "▸"}`);
    chip.title = "containers reporting telemetry that are not selected as sources";
    chip.onclick = () => {
      state.showOthers = !state.showOthers;
      prefs.set("showOthers", state.showOthers);
      renderLegend();
    };
    legendEl.appendChild(chip);
    if (state.showOthers) {
      for (const s of mut) {
        const item = legendItem(s.name, "disabled");
        item.title = "not selected — right-click to track or hide";
        item.oncontextmenu = (e) => ctxMenu(e, [
          ...seriesPopoutMenuEntry(s),
          [`Track “${s.name}” (logs + telemetry)`, () => startTracking(s)],
          [`Hide “${s.name}” entirely`, () => { setTrack(s.name, "hid"); relist(); }],
        ]);
        legendEl.appendChild(item);
      }
    }
  }

  if (hid.length) {
    const chip = legendChip(`hidden (${hid.length})`);
    chip.title = "click to restore hidden containers";
    chip.onclick = (e) => ctxMenu(e, hid.map((s) => [
      `Restore “${s.name}”`,
      () => { setTrack(s.name, "mut"); relist(); },
    ]));
    legendEl.appendChild(chip);
  }
}

/* ── chart interactions: hover, click->cursor, drag->zoom/sample ────────── */

let dragStart = null;
let dragX = null;
let dragIsSample = false;
let sampleArmed = false;

// Toggles "capture metrics" drag mode: the next chart drag exports a
// sample instead of zooming (mirrors holding Shift while dragging, see
// timelineDown() below) -- also flips a body class the CSS uses to change
// the cursor over charts, as a visible reminder the mode is active.
function setSampleArmed(v) {
  sampleArmed = v;
  document.body.classList.toggle("sample-armed", v);
  // Blinking "capture mode" reminder in the bottom status bar, for as long
  // as the next chart drag would export a sample instead of zooming --
  // covers all three ways this turns back off (drag completes the export,
  // Esc cancels, or a fresh armSampleCapture() call re-arms it).
  const el = $("app-status-bar-text");
  if (v) {
    el.textContent = "capture mode ✂️";
    el.classList.add("status-bar-blink");
  } else if (el.classList.contains("status-bar-blink")) {
    el.classList.remove("status-bar-blink");
    el.textContent = "";
  }
}

function armSampleCapture() {
  setSampleArmed(true);
  setStatus("Capture metrics armed — drag across a chart to pick a time range (Esc to cancel)");
}

// mousedown on a chart/lane: records where a possible drag started, and
// whether this drag would export a sample (Shift held, Ctrl/Cmd held, or
// "capture metrics" armed) rather than zoom -- decided up front since
// dragIsSample also determines the selection band's color while dragging
// (see drawVerticals()). Ctrl/Cmd+drag is a second way in alongside Shift
// (kept, not replaced) -- plain drag stays zoom, the primary/most-used
// gesture, so it was never up for grabs here.
function timelineDown(c, e) {
  const rect = c.getBoundingClientRect();
  dragStart = e.clientX - rect.left;
  dragIsSample = e.shiftKey || e.ctrlKey || e.metaKey || sampleArmed;
  dragX = null;
}

// mouseup on a chart/lane: a drag past a small pixel threshold zooms (or
// exports a sample, per dragIsSample) to the dragged range; anything
// shorter (or a plain click) just moves the cursor to that point in time.
function timelineUp(c, e) {
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (dragStart != null && Math.abs(x - dragStart) > 6) {
    const [a, b] = [Math.min(dragStart, x), Math.max(dragStart, x)];
    if (dragIsSample) {
      setSampleArmed(false);
      exportSample(xToT(a), xToT(b));
    } else {
      setView(xToT(a), xToT(b));
    }
  } else if (x >= MARGIN_L) {
    setCursor(xToT(x));
  }
  dragStart = null;
  dragX = null;
  drawAll();
}

// whether host-level telemetry (CPU/MEM/NET of the docker host itself, as
// opposed to any individual container) is currently being collected --
// drives the export dialog's default "include host telemetry" checkbox.
function hasHostSeries() {
  return (state.series?.services || []).some((s) => s.host && !isOtherDockerHostHidden(s.sid));
}

// The active Docker host (see state.activeDockerHost), in the "null means
// local" shape every existing caller already expects (form pre-fill, Edit
// Docker Host's target, the export dialog's host-telemetry POST). Multiple
// hosts can be connected at once, so this deliberately does NOT scan
// state.sources for "the first docker:// source found" anymore (ambiguous,
// and arbitrary once a second host is open) -- state.activeDockerHost is
// the single source of truth, set on connect/edit and self-healed in
// refreshAll().
function currentDockerHost() {
  return state.activeDockerHost === "local" ? null : state.activeDockerHost;
}

// Whether *any* docker:// source (stats/host/container/service, local or
// remote) is currently open -- unlike currentDockerHost() above, this is a
// plain yes/no including the local daemon, which currentDockerHost()
// deliberately reports as null (it's answering "what host string, if any,
// should a form pre-fill", not "is a daemon being watched at all").
function hasDockerDaemon() {
  return state.sources.some((s) => /^docker:\/\//.test(s.path || ""));
}

// Remove Docker Host only makes sense once something is actually saved --
// enabling it regardless would have nothing to forget. New Docker Host
// stays enabled regardless (always opens a blank create form -- multiple
// hosts can be tracked at once). Edit Docker Host needs something actually
// connected to edit (ui-DHOST-025). Called after every state.sources
// refresh.
function syncDockerDaemonButtons() {
  $("btn-clear-sources").disabled = !hasDockerDaemon();
  $("btn-edit-docker-host").disabled = !hasDockerDaemon();
  // Remove Docker Host (permanently forgetting a saved one) is independent
  // of whether anything is currently connected -- it operates on the saved
  // catalog (savedDockerDaemons), not on state.sources.
  $("btn-remove-docker-daemon").disabled = Object.keys(prefs.get("savedDockerDaemons", {})).length === 0;
  refreshDockerHostPill();
}

// Reassigned by the Docker host pill IIFE further down (its DOM doesn't
// exist yet here) -- called on every state.sources refresh so the pill's
// dot/tooltip reflect the current connection without needing the dropdown
// to be opened first.
let refreshDockerHostPill = () => {};

const dlgExport = $("dlg-export");

async function askExportOptions() {
  const hasHost = hasHostSeries();
  const cb = $("export-host");
  cb.checked = hasHost;
  $("export-host-note").textContent = hasHost
    ? "Currently being collected — included automatically unless you uncheck this."
    : "Not currently collected — checking this starts collecting it now (this past range won't have host data yet, but later saved metrics will).";
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      $("dlg-export-ok").onclick = null;
      $("dlg-export-cancel").onclick = null;
      dlgExport.removeEventListener("close", onClose);
      dlgExport.close(); // no-op if already closed/closing (e.g. Esc got here first)
      resolve(ok ? { includeHost: cb.checked, hadHost: hasHost } : null);
    };
    // Esc is native <dialog> behavior that closes it without going through
    // either button's onclick -- without this, that left exportSample's
    // promise unresolved forever (ui-EXPORT-003). Treated the same as
    // Cancel; guarded by `settled` so OK/Cancel's own done()-triggered
    // close() (which also fires this same "close" event) doesn't re-resolve.
    const onClose = () => done(false);
    dlgExport.addEventListener("close", onClose);
    $("dlg-export-ok").onclick = () => done(true);
    $("dlg-export-cancel").onclick = () => done(false);
    dlgExport.showModal();
  });
}

// write bytes to a local file: Electron's native save dialog when available
// (window.cttc.saveBinary, via main.js), else a plain-browser download --
// works the same whether the bytes came from a same-machine embedded server
// or a remote one, since the fetch that produced them already happened.
async function saveBinaryFile(name, bytes) {
  if (window.cttc?.saveBinary) return window.cttc.saveBinary(name, bytes);
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return name; // no real filesystem path in this fallback; used for the status line only
}

async function exportSample(t0, t1) {
  const opts = await askExportOptions();
  if (!opts) return;
  if (opts.includeHost && !opts.hadHost) {
    try {
      const host = currentDockerHost();
      await post("/docker/collect", {
        host, stats: false, host_stats: true, logs: [], transforms: [],
        ssh_key: dockerHostKeys.get(host || "local") ?? null,
        interval: dockerPollIntervalSecs,
      });
    } catch (err) {
      notifyEvent("could not start host telemetry: " + (err.message || err));
    }
  }
  const name = `metrics-${new Date(t0).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.cttc-metric`;
  try {
    // fetch the sample's bytes from the server itself (works identically
    // whether server.py is this same machine's embedded process or a
    // remote one reached directly over HTTP -- see docs/architecture/
    // remote-server.md phase 3) rather than asking it to write to a path
    // that might not exist on whichever machine actually ran it
    // Scoped to the active Docker host server-side too (not just this
    // client's own display filtering) -- see isOtherDockerHostHidden and
    // /files/download's `host` param. state.activeDockerHost itself (not
    // currentDockerHost(), which maps local to null for form pre-fill).
    const params = new URLSearchParams({
      from: t0, to: t1, include_host: opts.includeHost ? "1" : "0",
      host: state.activeDockerHost || "local",
    });
    const res = await fetch(`${API}/files/download?${params}`, { headers: authHeaders() });
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `download failed: ${res.status}`);
    const sourceCount = Number(res.headers.get("X-CTTC-Source-Count") || 0);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const path = await saveBinaryFile(name, bytes);
    if (!path) { notifyEvent("metrics export canceled"); return; }
    notifyEvent(sourceCount ? `metrics saved: ${path} (${sourceCount} sources)`
                            : "metrics saved, but no data in the selected range");
  } catch (err) {
    notifyEvent("metrics export failed: " + (err.message || err));
  }
}

/* ── snapshots: telemetry + nearby log entries at one point in time ──────
   Right-click a chart -> "Take snapshot at this time". /point aggregates
   every currently open stats source, but a snapshot only ever shows the
   currently tracked/selected containers -- host telemetry is always
   included (it isn't a per-container track state), same as everywhere
   else the legend's selection applies. */

const dlgSnapshot = $("dlg-snapshot");
let currentSnapshot = null;

// escapes text (log/container names, which are arbitrary user/docker-
// controlled strings) before it's interpolated into innerHTML in the
// snapshot table -- everywhere else builds DOM nodes directly and doesn't
// need this.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// epoch ms -> full "YYYY-MM-DD HH:MM:SS.sssZ"-style UTC timestamp, used
// wherever precision (not just clock-face time, see fmtClock()) matters:
// snapshot metadata, exported file names' timestamp component.
function fmtIso(t) {
  return new Date(t).toISOString().replace("T", " ").replace("Z", " UTC");
}

async function takeSnapshot(t) {
  currentSnapshot = null;
  $("snapshot-meta").textContent = "loading…";
  $("snapshot-props").innerHTML = "";
  $("snapshot-json").textContent = "";
  dlgSnapshot.showModal();
  await refreshSnapshot(t);
}

// a single point-in-time slice: telemetry (via /point) + nearby log entries
// (via /index_at + /logs). Reused for the center time and, when a panorama
// is requested, for the "before"/"after" times too.
async function computeSlice(t, { includeLogs, ctxLines }) {
  const r = await get(`/point?t=${t}`);
  let services = Object.entries(r.services || {}).map(([name, v]) => ({ name, ...v }));
  const selected = new Set(allSvcSeries().filter((s) => trackStateOf(s) === "sel").map((s) => s.name));
  services = services.filter((s) => (s.host || selected.has(s.name)) && !isOtherDockerHostHidden(s.sid));
  services.sort((a, b) => (b.host - a.host) || a.name.localeCompare(b.name));

  let logs = [];
  if (includeLogs) {
    const logSources = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id) && !isLiveDataHidden(s.id) && !isOtherDockerHostHidden(s.id));
    logs = await Promise.all(logSources.map(async (s) => {
      try {
        const idx = await get(`/index_at?source=${s.id}&t=${t}`);
        const start = Math.max(0, idx.index - ctxLines);
        const page = await get(`/logs?source=${s.id}&start=${start}&count=${ctxLines * 2 + 1}`);
        return { source: s.name, path: s.path, rows: page.rows };
      } catch {
        return { source: s.name, path: s.path, rows: [] };
      }
    }));
    logs = logs.filter((l) => l.rows.length);
  }
  return { t, services, logs };
}

async function refreshSnapshot(t) {
  const includeLogs = $("snap-logs").checked;
  const panOn = $("snap-panorama-on").checked;
  const panUnit = $("snap-panorama-unit").value; // "entries" | "seconds"
  const panValue = panOn ? Math.max(0, Number($("snap-panorama-value").value) || 0) : 0;
  const ctxLines = panUnit === "entries" ? panValue : 0;
  const panSec = panUnit === "seconds" ? panValue : 0;
  const opts = { includeLogs, ctxLines };

  // a "panorama" enlarges the snapshot around the selected time: either by
  // widening the per-slice log context (n nearby entries), or by adding two
  // extra full slices (n seconds before / after) so records on both sides of
  // the selected time can be compared to the center one.
  const wanted = panSec > 0
    ? [{ label: `${panSec}s before`, at: t - panSec * 1000 },
       { label: "at", at: t },
       { label: `${panSec}s after`, at: t + panSec * 1000 }]
    : [{ label: "at", at: t }];

  let slices;
  try {
    slices = await Promise.all(wanted.map(async (w) => ({ label: w.label, ...(await computeSlice(w.at, opts)) })));
  } catch (err) {
    $("snapshot-meta").textContent = "snapshot failed: " + (err.message || err);
    return;
  }

  currentSnapshot = { t, panoramaOn: panOn, panoramaUnit: panUnit, panoramaValue: panValue, generated_at: new Date().toISOString(), slices };
  renderSnapshot();
}

function renderSnapshot() {
  const snap = currentSnapshot;
  if (!snap) return;
  const nServices = snap.slices[0]?.services.length || 0;
  const nLogRows = snap.slices.reduce((n, sl) => n + sl.logs.reduce((m, l) => m + l.rows.length, 0), 0);
  const panoramaDesc = !(snap.panoramaOn && snap.panoramaValue) ? "" :
    snap.panoramaUnit === "seconds" ? `panorama ±${snap.panoramaValue}s` : `panorama ${snap.panoramaValue} entries`;
  $("snapshot-meta").textContent =
    `t = ${fmtIso(snap.t)}` +
    (panoramaDesc ? ` · ${panoramaDesc}` : "") +
    ` · ${nServices} series · ${nLogRows} log entries`;

  const box = $("snapshot-props");
  box.innerHTML = "";
  for (const slice of snap.slices) {
    if (snap.slices.length > 1) {
      const h = document.createElement("div");
      h.className = "snapshot-slice-head";
      h.textContent = `${slice.label} — ${fmtIso(slice.t)}`;
      box.appendChild(h);
    }
    const table = document.createElement("table");
    table.className = "snapshot-table";
    const head = document.createElement("tr");
    head.innerHTML = "<th>source</th><th>cpu</th><th>mem</th><th>net</th><th>at</th>";
    table.appendChild(head);
    for (const s of slice.services) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${s.host ? "\u{1F5A5} " : ""}${escapeHtml(s.name)}</td>` +
        `<td>${s.cpu != null ? s.cpu.toFixed(1) + "%" : "\u2013"}</td>` +
        `<td>${s.mem != null ? s.mem.toFixed(1) + "%" : "\u2013"}</td>` +
        `<td>${s.net != null ? fmtBytes(s.net) : "\u2013"}</td>` +
        `<td>${s.ts != null ? fmtClock(s.ts, true) : "\u2013"}</td>`;
      table.appendChild(tr);
    }
    box.appendChild(table);

    for (const l of slice.logs) {
      const lh = document.createElement("div");
      lh.className = "snapshot-log-head";
      lh.textContent = l.source;
      box.appendChild(lh);
      for (const row of l.rows) {
        const div = document.createElement("div");
        div.className = "snapshot-log-row";
        div.textContent = `${fmtClock(row.ts, true)}  ${row.text.split("\n")[0]}`;
        box.appendChild(div);
      }
    }
  }

  $("snapshot-json").textContent = JSON.stringify(snap, null, 2);
}

// plain-text rendering of the Raw view, for the "Save as TXT" export.
function snapshotToText(snap) {
  const lines = [];
  lines.push(`Snapshot @ ${fmtIso(snap.t)}`);
  if (snap.panoramaOn && snap.panoramaValue) {
    lines.push(snap.panoramaUnit === "seconds"
      ? `Panorama: +/- ${snap.panoramaValue}s`
      : `Panorama: ${snap.panoramaValue} entries`);
  }
  lines.push(`Generated: ${snap.generated_at}`);
  for (const slice of snap.slices) {
    lines.push("");
    if (snap.slices.length > 1) lines.push(`== ${slice.label} — ${fmtIso(slice.t)} ==`);
    if (slice.services.length) {
      const header = ["source", "cpu", "mem", "net", "at"];
      const rows = slice.services.map((s) => [
        (s.host ? "* " : "") + s.name,
        s.cpu != null ? s.cpu.toFixed(1) + "%" : "-",
        s.mem != null ? s.mem.toFixed(1) + "%" : "-",
        s.net != null ? fmtBytes(s.net) : "-",
        s.ts != null ? fmtClock(s.ts, true) : "-",
      ]);
      const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
      const fmtRow = (r) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
      lines.push(fmtRow(header));
      for (const r of rows) lines.push(fmtRow(r));
    } else {
      lines.push("(no telemetry)");
    }
    for (const l of slice.logs) {
      lines.push("");
      lines.push(`[${l.source}]`);
      for (const row of l.rows) lines.push(`  ${fmtClock(row.ts, true)}  ${row.text.split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}

$("snap-view-raw").onclick = () => {
  $("snap-view-raw").classList.add("primary");
  $("snap-view-json").classList.remove("primary");
  $("snapshot-props").hidden = false;
  $("snapshot-json").hidden = true;
  $("dlg-snapshot-save-txt").hidden = false;
  $("dlg-snapshot-save").hidden = true;
};
$("snap-view-json").onclick = () => {
  $("snap-view-json").classList.add("primary");
  $("snap-view-raw").classList.remove("primary");
  $("snapshot-props").hidden = true;
  $("snapshot-json").hidden = false;
  $("dlg-snapshot-save-txt").hidden = true;
  $("dlg-snapshot-save").hidden = false;
};
$("snap-logs").onchange = () => currentSnapshot && refreshSnapshot(currentSnapshot.t);
$("snap-panorama-on").onchange = () => {
  $("snap-panorama-value").disabled = !$("snap-panorama-on").checked;
  $("snap-panorama-unit").disabled = !$("snap-panorama-on").checked;
  currentSnapshot && refreshSnapshot(currentSnapshot.t);
};
$("snap-panorama-value").onchange = () => currentSnapshot && refreshSnapshot(currentSnapshot.t);
$("snap-panorama-unit").onchange = () => currentSnapshot && refreshSnapshot(currentSnapshot.t);
$("dlg-snapshot-close").onclick = () => dlgSnapshot.close();
$("dlg-snapshot-save").onclick = async () => {
  if (!currentSnapshot) return;
  const name = `snapshot-${new Date(currentSnapshot.t).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.json`;
  const json = JSON.stringify(currentSnapshot, null, 2);
  try {
    const path = window.cttc?.saveJson ? await window.cttc.saveJson(name, json) : null;
    if (path) notifyEvent("snapshot saved: " + path);
  } catch (err) {
    notifyEvent("snapshot save failed: " + (err.message || err));
  }
};
$("dlg-snapshot-save-txt").onclick = async () => {
  if (!currentSnapshot) return;
  const name = `snapshot-${new Date(currentSnapshot.t).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.txt`;
  const text = snapshotToText(currentSnapshot);
  try {
    const path = window.cttc?.saveText ? await window.cttc.saveText(name, text) : null;
    if (path) notifyEvent("snapshot saved: " + path);
  } catch (err) {
    notifyEvent("snapshot save failed: " + (err.message || err));
  }
};

/* ── Export metrics: the active file's stats/logs as text or JSON ────────
   #btn-export-metrics (next to #record-sections, shown only while a
   metrics file is the active view, see setLiveHidden) -- two steps: what
   to include, then how. Covers the active view's own whole range
   (activeViewRange()), not just the current zoom/pan window -- unlike
   the point-in-time snapshot above, or exportSample's drag-selected
   range. */

const dlgExportMetrics = $("dlg-export-metrics");
let exportMetricsFormat = "text"; // "text" | "json"
let exportMetricsGranularity = "summary"; // "summary" | "full"

// Next requires at least one of stats/logs checked -- same "disabled
// until a valid choice exists" convention as e.g. ui-DHOST-012.
function updateExportMetricsNextEnabled() {
  $("dlg-export-metrics-next").disabled = !$("export-metrics-stats").checked && !$("export-metrics-logs").checked;
}
$("export-metrics-stats").onchange = updateExportMetricsNextEnabled;
$("export-metrics-logs").onchange = updateExportMetricsNextEnabled;

$("btn-export-metrics").onclick = () => {
  $("export-metrics-step1").hidden = false;
  $("export-metrics-step2").hidden = true;
  updateExportMetricsNextEnabled();
  dlgExportMetrics.showModal();
};
$("dlg-export-metrics-cancel").onclick = () => dlgExportMetrics.close();
$("dlg-export-metrics-next").onclick = () => {
  $("export-metrics-step1").hidden = true;
  $("export-metrics-step2").hidden = false;
  // The full-vs-summary choice only means anything if stats was checked.
  $("export-metrics-granularity-row").hidden = !$("export-metrics-stats").checked;
};
$("dlg-export-metrics-back").onclick = () => {
  $("export-metrics-step1").hidden = false;
  $("export-metrics-step2").hidden = true;
};
$("export-metrics-format-text").onclick = () => {
  exportMetricsFormat = "text";
  $("export-metrics-format-text").classList.add("primary");
  $("export-metrics-format-json").classList.remove("primary");
};
$("export-metrics-format-json").onclick = () => {
  exportMetricsFormat = "json";
  $("export-metrics-format-json").classList.add("primary");
  $("export-metrics-format-text").classList.remove("primary");
};
$("export-metrics-granularity-summary").onclick = () => {
  exportMetricsGranularity = "summary";
  $("export-metrics-granularity-summary").classList.add("primary");
  $("export-metrics-granularity-full").classList.remove("primary");
};
$("export-metrics-granularity-full").onclick = () => {
  exportMetricsGranularity = "full";
  $("export-metrics-granularity-full").classList.add("primary");
  $("export-metrics-granularity-summary").classList.remove("primary");
};

// Shown once at the top of a text export's stats section, not repeated per
// row -- matches server.py's own StatsSource field semantics (docker
// stats' CPUPerc/MemPerc/NetIO, see ingest_row/_net_rate): cpu can exceed
// 100% for a multi-core container (percent of one core, not the whole
// machine); mem is percent of the container's own memory limit, not host
// RAM; net is an instantaneous combined rx+tx throughput rate, not a
// cumulative total.
const STATS_FIELD_EXPLANATIONS = [
  "cpu: percent of one CPU core in use (can exceed 100% for a multi-core container)",
  "mem: percent of the container's own memory limit in use (not host RAM)",
  "mem_bytes: memory in use, in bytes",
  "net: combined rx+tx network throughput at that instant, in bytes/sec",
];

// Every raw log row in [t0, t1] for one source, paging through /logs (its
// own count cap is 2000/request) starting from /index_at's nearest-t0
// index -- unlike computeSlice's fixed-size context window above, this
// keeps paging until it either passes t1 or the source runs out of rows.
async function fetchLogRowsInRange(sourceId, t0, t1) {
  let start;
  try {
    start = (await get(`/index_at?source=${sourceId}&t=${t0}`)).index;
  } catch {
    return [];
  }
  const rows = [];
  for (;;) {
    const page = await get(`/logs?source=${sourceId}&start=${start}&count=2000`);
    for (const row of page.rows) {
      if (row.ts > t1) return rows;
      rows.push(row);
    }
    start += page.rows.length;
    if (page.rows.length < 2000 || start >= page.total) return rows;
  }
}

// Every row a source has, start to end -- the counterpart to
// fetchLogRowsInRange above but with no time bound at all (used by the log
// panel's own "Export .log" button, which always exports everything
// currently in that viewer, not just what's in the chart's current time
// window).
async function fetchAllLogRows(sourceId) {
  const rows = [];
  let start = 0;
  for (;;) {
    const page = await get(`/logs?source=${sourceId}&start=${start}&count=2000`);
    rows.push(...page.rows);
    start += page.rows.length;
    if (page.rows.length < 2000 || start >= page.total) return rows;
  }
}

// Thin, individually reassignable wrappers -- same pattern as
// pickRecordingSavePath/writeRecordingBytes, so tests can substitute an
// in-memory store instead of driving a real native save dialog (which
// can't run headlessly). Dialog and write are deliberately two separate
// calls (see main.js's pick-log-export-path docstring): the log panel's
// export button asks where to save *before* fetching a single row, so
// cancelling out of the dialog costs nothing.
async function pickLogExportPath(defaultName) {
  return window.cttc?.pickLogExportPath ? window.cttc.pickLogExportPath(defaultName) : null;
}
async function writeLogExportFile(path, bytes) {
  return window.cttc.writeBinaryFile(path, bytes);
}

// stats_export's response, like /series's own, spans every open stats
// source -- filtered down to just the active sample's own (isSampleHidden/
// isLiveDataHidden, via each service's "sid") so an export doesn't pile up
// data from other loaded-but-inactive files or from Live, same scoping
// BUG-0082 already applies to the legend/chart/log panels.
async function gatherExportMetricsData(includeStats, includeLogs) {
  const range = activeViewRange();
  const data = { generated_at: new Date().toISOString(), from: range.min_ts, to: range.max_ts };
  if (includeStats) {
    const r = await get(`/stats_export?from=${range.min_ts}&to=${range.max_ts}&granularity=${exportMetricsGranularity}`);
    data.stats = {
      granularity: exportMetricsGranularity,
      services: r.services.filter((s) => !isSampleHidden(s.sid) && !isLiveDataHidden(s.sid) && !isOtherDockerHostHidden(s.sid)),
    };
  }
  if (includeLogs) {
    const logSources = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id) && !isLiveDataHidden(s.id) && !isOtherDockerHostHidden(s.id));
    data.logs = await Promise.all(logSources.map(async (s) => ({
      source: s.name,
      path: s.path,
      rows: await fetchLogRowsInRange(s.id, range.min_ts, range.max_ts),
    })));
  }
  return data;
}

function exportMetricsToText(data) {
  const lines = [];
  lines.push(`Metrics export @ ${data.generated_at}`);
  lines.push(`Range: ${fmtIso(data.from)} — ${fmtIso(data.to)}`);
  if (data.stats) {
    lines.push("");
    lines.push(data.stats.granularity === "summary" ? "== Stats (summary) ==" : "== Stats (full time series) ==");
    lines.push(...STATS_FIELD_EXPLANATIONS);
    for (const svc of data.stats.services) {
      lines.push("");
      lines.push(`[${(svc.host ? "* " : "") + svc.name}]`);
      if (data.stats.granularity === "summary") {
        const fmts = { cpu: (v) => v.toFixed(1) + "%", mem: (v) => v.toFixed(1) + "%", mem_bytes: fmtBytes, net: (v) => fmtBytes(v) + "/s" };
        for (const key of ["cpu", "mem", "mem_bytes", "net"]) {
          const s = svc[key];
          if (!s) continue;
          lines.push(`  ${key}: min ${fmts[key](s.min)}  avg ${fmts[key](s.avg)}  max ${fmts[key](s.max)}  (${svc.count} samples)`);
        }
      } else {
        for (const s of svc.samples) {
          lines.push(`  ${fmtClock(s.ts, true)}  cpu=${s.cpu ?? "-"}  mem=${s.mem ?? "-"}  mem_bytes=${s.mem_bytes ?? "-"}  net=${s.net ?? "-"}`);
        }
      }
    }
  }
  if (data.logs) {
    lines.push("");
    lines.push("== Logs ==");
    for (const l of data.logs) {
      lines.push("");
      lines.push(`[${l.source}]`);
      for (const row of l.rows) lines.push(`  ${fmtClock(row.ts, true)}  ${row.text.split("\n")[0]}`);
    }
  }
  return lines.join("\n");
}

$("dlg-export-metrics-export").onclick = async () => {
  const includeStats = $("export-metrics-stats").checked;
  const includeLogs = $("export-metrics-logs").checked;
  const btn = $("dlg-export-metrics-export");
  btn.disabled = true;
  try {
    const data = await gatherExportMetricsData(includeStats, includeLogs);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    if (exportMetricsFormat === "json") {
      const name = `metrics-export-${stamp}.json`;
      const path = window.cttc?.saveJson ? await window.cttc.saveJson(name, JSON.stringify(data, null, 2)) : null;
      if (path) { notifyEvent("metrics exported: " + path); dlgExportMetrics.close(); }
    } else {
      const name = `metrics-export-${stamp}.txt`;
      const path = window.cttc?.saveText ? await window.cttc.saveText(name, exportMetricsToText(data)) : null;
      if (path) { notifyEvent("metrics exported: " + path); dlgExportMetrics.close(); }
    }
  } catch (err) {
    notifyEvent("metrics export failed: " + (err.message || err));
  } finally {
    btn.disabled = false;
  }
};

// Shared "time" context menu: capture metrics / take snapshot, anchored on
// time `t`. Used both by right-clicking a chart (t = the point under the
// cursor) and by right-clicking selected log entries (t = the center of
// their timestamps). `onDone`, if given, runs once whichever action was
// picked (used to clear a log panel's selection afterwards).
//
// Zoom in/out/reset used to be menu items here too -- removed from this
// menu on request, but zoomAt()/resetZoom() themselves are untouched and
// still very much live: plain drag-to-zoom (timelineUp) and the
// View > Actual Size / Ctrl+0 menubar action (see menubarActions'
// "zoom-reset") still work exactly as before.
function timeContextMenu(e, t, onDone) {
  const wrap = (fn) => () => { onDone?.(); fn(); };
  ctxMenu(e, [
    ["✂ Capture metrics", wrap(armSampleCapture)],
    ["📸 Take snapshot at this time", wrap(() => takeSnapshot(t))],
  ]);
}

function attachChartEvents() {
  for (const c of [...stripCanvases, ...hostCanvases]) {
    c.addEventListener("mousemove", (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      state.hoverX = x >= MARGIN_L && x <= MARGIN_L + plotWidth() ? x : null;
      state.hoverStrip = Number(c.dataset.strip);
      state.hoverGroup = c.dataset.group;
      if (dragStart != null && e.buttons & 1) dragX = x;
      drawAll();
      updateTooltip(e, x);
    });
    c.addEventListener("mouseleave", () => {
      state.hoverX = null;
      tooltipEl.hidden = true;
      drawAll();
    });
    c.addEventListener("mousedown", (e) => timelineDown(c, e));
    c.addEventListener("mouseup", (e) => timelineUp(c, e));
    c.addEventListener("dblclick", (e) => timelineDblclick(c, e));
    c.addEventListener("contextmenu", (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < MARGIN_L || !state.view) return;
      timeContextMenu(e, xToT(x));
    });
  }
}

function updateTooltip(e, x) {
  if (state.hoverX == null || !state.series) { tooltipEl.hidden = true; return; }
  const spec = STRIPS[state.hoverStrip] || STRIPS[0];
  const px = state.series.px;
  const b = Math.floor(((x - MARGIN_L) / plotWidth()) * px);
  if (b < 0 || b >= px) { tooltipEl.hidden = true; return; }
  const t = xToT(x);
  const rows = [];
  for (const s of seriesOf(state.hoverGroup)) {
    // snap to the nearest non-empty bucket (samples are sparser than pixels)
    let v = null;
    for (let d = 0; d <= 8 && v == null; d++)
      v = s[spec.key][b + d] ?? s[spec.key][b - d] ?? null;
    if (v == null) continue;
    rows.push({ name: s.name, v });
  }
  rows.sort((r1, r2) => r2.v - r1.v);
  tooltipEl.innerHTML = "";
  const time = document.createElement("div");
  time.className = "tt-time";
  time.textContent = `${spec.title} · ${fmtClock(t, true)}`;
  tooltipEl.appendChild(time);
  for (const r of rows.slice(0, 10)) {
    const row = document.createElement("div");
    row.className = "tt-row";
    const sw = document.createElement("span");
    sw.className = "legend-swatch";
    sw.style.background = colorFor(r.name);
    const val = document.createElement("span");
    val.className = "tt-val";
    val.textContent = spec.fmt(r.v);
    row.append(sw, document.createTextNode(r.name), val);
    tooltipEl.appendChild(row);
  }
  tooltipEl.hidden = rows.length === 0;
  const pad = 14;
  let left = e.clientX + pad, top = e.clientY + pad;
  const bb = tooltipEl.getBoundingClientRect();
  if (left + bb.width > innerWidth - 8) left = e.clientX - bb.width - pad;
  if (top + bb.height > innerHeight - 8) top = e.clientY - bb.height - pad;
  tooltipEl.style.left = left + "px";
  tooltipEl.style.top = top + "px";
}

/* ── view / zoom / series fetching ──────────────────────────────────────── */

let seriesTimer = null;

// Formats a view span for the status bar, e.g. 1500 -> "1.5s", 125000 -> "2m 5s".
function fmtSpan(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60), rem = Math.round(s % 60);
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60), remM = m % 60;
  return remM ? `${h}h ${remM}m` : `${h}h`;
}

function updateViewRangeLabel() {
  const el = $("view-range-label-text");
  if (!el) return;
  if (!state.view) { el.textContent = ""; return; }
  const t0 = new Date(state.view.t0).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  el.textContent = `${t0} + ${fmtSpan(state.view.t1 - state.view.t0)}`;
}

function setView(t0, t1, opts = {}) {
  if (t1 - t0 < 200) return; // 200ms minimum zoom
  state.view = { t0, t1 };
  // Any caller *except* the live-follow ticker itself (opts._follow) is a
  // deliberate pan/zoom -- the user just chose to look at a fixed window,
  // so stop auto-advancing it out from under them. Also cancels any pending
  // double-click auto-resume (see recenterOn) -- a further pan/zoom after
  // the recenter means the user is still looking around, not waiting to
  // snap back to live.
  if (!opts._follow) { state.live = false; state.liveResumeAt = null; }
  scheduleSeriesFetch();
  drawAll();
  updateViewRangeLabel();
  updateLiveResumeUI();
  if (opts.broadcast !== false) window.cttc?.broadcastSync?.({ type: "view", t0, t1 });
}

// Reflects a pending double-click auto-resume (state.liveResumeAt, see
// recenterOn) in the UI: the Live tracking switches read as off (matching
// the actual paused state, not the underlying liveTrackEnabled preference)
// and the status bar shows a countdown. The switches stay clickable while
// paused (see the onchange handlers below) so flipping one back on resumes
// live-follow early instead of waiting out the countdown. Restores the
// normal switch state and clears that status message once the pause ends,
// whether by expiring, being cancelled (further pan/zoom), or an early
// manual resume.
function updateLiveResumeUI() {
  const paused = !state.live && !!state.liveResumeAt;
  $("live-track-toggle").checked = paused ? false : liveTrackEnabled;
  $("live-track-toggle-sidebar").checked = paused ? false : liveTrackEnabled;
  $("live-track-secs").disabled = paused || !liveTrackEnabled;
  $("live-track-secs-sidebar").disabled = paused || !liveTrackEnabled;
  // The bottom app-status-bar (see notifyEvent, "Appearance > Status bar"),
  // not the toolbar's #status -- that one's for ordinary action feedback,
  // this is the persistent background-state bar.
  if (paused) {
    const remaining = Math.max(0, Math.ceil((state.liveResumeAt - Date.now()) / 1000));
    $("app-status-bar-text").textContent = `Live tracking disabled — resuming in ${remaining}s (clicking "now" will resume live tracking)`;
    state.liveResumeStatusShown = true;
  } else if (state.liveResumeStatusShown) {
    $("app-status-bar-text").textContent = "";
    state.liveResumeStatusShown = false;
  }
}

// Recenters the view on (now - FOLLOW_LAG), keeping the current span --
// "centered a few seconds behind now" rather than pinned exactly to the
// leading edge, so the most recent points aren't drawn flush against the
// chart's right border. Used both by the 1s auto-follow ticker (see
// followNowTick below) and by goLive() for an immediate jump.
const FOLLOW_LAG = 5000;
function followNow() {
  const span = state.view ? state.view.t1 - state.view.t0 : DEFAULT_SPAN;
  const center = Date.now() - FOLLOW_LAG;
  setView(center - span / 2, center + span / 2, { _follow: true });
}

// The nav's "now" label: explicitly resumes live-following (unlike a plain
// click elsewhere, which only recenters once and leaves live off).
function goLive() {
  state.live = true;
  state.liveResumeAt = null;
  followNow();
  setCursor(Date.now());
}

// Keeps the view sliding forward while live, and always redraws so the
// "now" line advances even when the view is a fixed (non-live) window.
// Also resumes live-follow on its own once a pending double-click pause
// (state.liveResumeAt, see recenterOn) expires.
//
// liveTrackTick() runs from this same local, wall-clock-driven heartbeat
// rather than only from refreshAll() (itself only triggered by an SSE
// "something changed" push, see connectSSE) -- otherwise a lull in new
// telemetry/log data (nothing for any collector to broadcast) silently
// stalls the Live tracking cursor even though nothing about live-follow
// itself turned off: no data change means no SSE message means
// refreshAll() never re-runs. Advancing the cursor doesn't depend on the
// server having anything new to say, so it shouldn't wait on that.
setInterval(() => {
  liveTrackTick();
  if (!state.view) return;
  // Analysis mode's view is static (see setLiveHidden's own centering) --
  // nothing here may move it, resume live-follow out from under it, or
  // even redraw on its behalf. Collection may still be running server-side
  // for other open sources, but the displayed view must not react to real
  // time at all while a sample/recording is what's shown.
  if (state.liveHidden) return;
  if (state.live) followNow();
  else {
    if (state.liveResumeAt && Date.now() >= state.liveResumeAt) goLive();
    else { updateLiveResumeUI(); drawAll(); }
  }
}, 1000);

// The navigable time range for whatever's currently the active view
// (ui-EXPORT-018) -- the full combined /range (state.range) while Live
// is active, exactly as before, or just the active file's own sources'
// min/max otherwise, so panning/zooming a loaded metric/recording can
// never wander outside its own data (System Observability spec's
// "Synchronization Continuity" -- the log viewer, already scoped to
// whichever sources are visible via isSampleHidden, stays locked to the
// same window as a natural consequence of sharing this same bound, no
// separate log-specific logic needed).
function activeViewRange() {
  if (!state.liveHidden || !state.activeSamplePath) return state.range;
  const group = sampleFileGroups().find((g) => g.path === state.activeSamplePath);
  if (!group) return state.range;
  const starts = [], ends = [];
  for (const s of state.sources) {
    if (group.ids.has(s.id) && s.min_ts != null) {
      starts.push(s.min_ts);
      ends.push(s.max_ts);
    }
  }
  if (!starts.length) return state.range;
  return { min_ts: Math.min(...starts), max_ts: Math.max(...ends) };
}

function resetZoom() {
  const range = activeViewRange();
  if (!range || range.min_ts == null) return;
  const pad = Math.max(1000, (range.max_ts - range.min_ts) * 0.01);
  setView(range.min_ts - pad, range.max_ts + pad);
  // "now" only makes sense while Live -- a file view's own most recent
  // point is the closest equivalent otherwise, never outside its own
  // range (ui-EXPORT-018's "locked to this view's own window").
  setCursor(!state.liveHidden ? Date.now() : range.max_ts);
}

// double-clicking anywhere on the timeline (charts or log density lanes)
// re-centers every panel on that exact point in time, keeping the current
// zoom span.
function recenterOn(t) {
  if (!state.view) return;
  const span = state.view.t1 - state.view.t0;
  const wasLive = state.live;
  setView(t - span / 2, t + span / 2);
  // If this recenter interrupted live-follow, resume it automatically after
  // a short grace period instead of either staying paused indefinitely or
  // snapping straight back to "now" (which would erase the recenter within
  // the next 1s tick). 0s means "stay paused until the user clicks now".
  if (wasLive && dblclickResumeSecs > 0) {
    state.liveResumeAt = Date.now() + dblclickResumeSecs * 1000;
    updateLiveResumeUI();
  }
}

// zoom in/out around a given point in time (from the chart's right-click
// menu): factor < 1 narrows the span (zoom in), factor > 1 widens it.
function zoomAt(t, factor) {
  if (!state.view) return;
  const span = (state.view.t1 - state.view.t0) * factor;
  setView(t - span / 2, t + span / 2);
}

const DEFAULT_SPAN = 10 * 60 * 1000; // initial window: now ± 5 min

function centerOnNow() {
  const span = state.view ? state.view.t1 - state.view.t0 : DEFAULT_SPAN;
  const now = Date.now();
  setView(now - span / 2, now + span / 2);
}

/* ── timeline navigator: a scrollbar-style control (not buttons) spanning
   the entire width of its graph panel. The thumb shows the current view as
   a fraction of the whole available time range; drag it (or click the
   track) to pan/jump. "now" is a fixed label in the middle, click it to
   re-center on the present. ────────────────────────────────────────────── */

function totalSpanBounds() {
  const now = Date.now();
  const range = activeViewRange();
  let lo = range?.min_ts, hi = range?.max_ts;
  if (lo == null || hi == null) {
    lo = state.view ? state.view.t0 : now - DEFAULT_SPAN / 2;
    hi = state.view ? state.view.t1 : now + DEFAULT_SPAN / 2;
  }
  if (state.view) { lo = Math.min(lo, state.view.t0); hi = Math.max(hi, state.view.t1); }
  // "now" only belongs in the navigator's own span while Live is active --
  // stretching a historical file view's navigator out to today would
  // contradict it staying locked to that file's own window (ui-EXPORT-018).
  if (!state.liveHidden) {
    lo = Math.min(lo, now);
    hi = Math.max(hi, now);
  }
  return { lo, hi: Math.max(hi, lo + 1) };
}

function updateTimelineNav(nav) {
  if (!state.view) return;
  const { lo, hi } = totalSpanBounds();
  const span = hi - lo;
  const w = nav.track.clientWidth;
  const x0 = ((state.view.t0 - lo) / span) * w;
  const x1 = ((state.view.t1 - lo) / span) * w;
  nav.thumb.style.left = `${Math.max(0, x0)}px`;
  nav.thumb.style.width = `${Math.max(8, x1 - x0)}px`;
  nav.nowLabel.dataset.live = String(!!state.live);
  // The countdown itself lives only in the status bar (see
  // updateLiveResumeUI) -- this label just says whether we're following now.
  nav.nowLabel.textContent = "now";
  nav.nowLabel.title =
    !state.live && state.liveResumeAt
      ? "Live tracking paused -- see the status bar for the resume countdown, or click to jump now"
      : state.live
      ? "Following the present -- click to jump anyway"
      : "Jump back to the present and resume following it";
}

function attachTimelineNav(navEl) {
  const track = navEl.querySelector(".tl-track");
  const thumb = navEl.querySelector(".tl-thumb");
  const nowLabel = navEl.querySelector(".tl-now-label");

  nowLabel.addEventListener("click", (e) => {
    e.stopPropagation();
    goLive();
  });

  thumb.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    if (!state.view) return;
    const startX = e.clientX, startT0 = state.view.t0, startT1 = state.view.t1;
    const move = (ev) => {
      const { lo, hi } = totalSpanBounds();
      const dt = ((ev.clientX - startX) / track.clientWidth) * (hi - lo);
      setView(startT0 + dt, startT1 + dt);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  track.addEventListener("click", (e) => {
    if (e.target === thumb || e.target === nowLabel || !state.view) return;
    const rect = track.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const { lo, hi } = totalSpanBounds();
    const t = lo + frac * (hi - lo);
    const span = state.view.t1 - state.view.t0;
    setView(t - span / 2, t + span / 2);
  });

  return { track, thumb, nowLabel };
}


function scheduleSeriesFetch() {
  clearTimeout(seriesTimer);
  seriesTimer = setTimeout(fetchSeries, 120);
}

async function fetchSeries() {
  if (!state.view) return;
  const px = Math.round(plotWidth());
  const { t0, t1 } = state.view;
  try {
    state.series = await get(`/series?from=${t0}&to=${t1}&px=${px}`);
    const logs = state.sources.filter((s) => s.kind === "log");
    await Promise.all(
      logs.map(async (s) => {
        const r = await get(`/ticks?source=${s.id}&from=${t0}&to=${t1}&px=${px}`);
        state.ticks.set(s.id, r.counts);
      })
    );
  } catch (err) {
    notifyEvent(String(err));
    return;
  }
  assignColorSlots();
  renderLegend();
  drawAll();
}

// Deterministic slot assignment: sorted on arrival, existing entities never
// repainted when sources come and go.
function assignColorSlots() {
  const names = [
    ...new Set([
      ...(state.series?.services || []).map((s) => s.name),
      ...state.sources.flatMap((s) => s.services || []),
      ...state.sources.filter((s) => s.kind === "log").map((s) => s.name),
    ]),
  ].sort();
  for (const n of names) ensureColorSlot(n);
}

/* ── cursor → log panel sync ────────────────────────────────────────────── */

async function setCursor(t, opts = {}) {
  state.cursorT = t;
  state.liveTrackCursor = !!opts.liveTrack;
  drawAll();
  for (const p of panels.values()) p.jumpTo(t);
  if (opts.broadcast !== false) window.cttc?.broadcastSync?.({ type: "cursor", t, liveTrack: !!opts.liveTrack });
}

/* ── log panels (virtual scroll) ────────────────────────────────────────── */

// A log line that's itself a JSON object (some shippers JSON-encode it a
// second time on top, e.g. `"{\"key\": \"val\"}"` as the literal line) reads
// far better pretty-printed than as one dense escaped string -- used by the
// row tooltip below, see formatLogEntryText/deepJsonParse.
const LOG_LEVEL_KEYS = ["level", "lvl", "loglevel", "log_level", "severity", "syslog_severity"];
const LOG_LEVEL_TOKENS = ["TRACE", "DEBUG", "INFO", "NOTICE", "WARN", "WARNING", "ERROR", "CRIT", "CRITICAL", "FATAL", "EMERG", "ALERT"];

// Repeatedly JSON.parses a string result (handles a line JSON-encoded an
// extra time by an upstream shipper on top of the record's own encoding) --
// null if it's not JSON at all, or never bottoms out at a plain object
// (arrays/primitives aren't "fields" to pretty-print).
function deepJsonParse(text) {
  let value = text;
  for (let i = 0; i < 5 && typeof value === "string"; i++) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// A well-known level-shaped key wins over a value that merely looks like a
// level token (a field could legitimately hold "ERROR" as data, e.g. a
// status name, without the line itself being at that level) -- "INFO" is
// the fallback once neither signal is present, matching this app's own
// default severity everywhere else a level isn't otherwise known.
function detectLogLevel(entries) {
  for (const [k, v] of entries) {
    if (typeof v === "string" && LOG_LEVEL_KEYS.includes(k.toLowerCase())) return v.toUpperCase();
  }
  for (const [, v] of entries) {
    if (typeof v === "string" && LOG_LEVEL_TOKENS.includes(v.toUpperCase())) return v.toUpperCase();
  }
  return "INFO";
}

// Tooltip-only (the compact virtualized row stays raw, see Panel.render) --
// row.text unchanged unless it deserializes to a JSON object, in which case
// it's rendered as one "key: value" line per field instead of raw escaped
// JSON. Field values are shown exactly as deserialized, no further string
// transformation of any kind -- URLs/paths in a value must reach the
// tooltip byte-for-byte, only JSON's own escaping is undone by JSON.parse.
function formatLogEntryText(text) {
  const obj = deepJsonParse(text);
  if (!obj) return text;
  const entries = Object.entries(obj);
  if (!entries.length) return text;
  const level = detectLogLevel(entries);
  const lines = entries.map(([k, v]) => `${k}: ${v !== null && typeof v === "object" ? JSON.stringify(v) : v}`);
  return `${level}:  ${lines[0]}` + lines.slice(1).map((l) => `\n        ${l}`).join("");
}

const panels = new Map(); // source id -> Panel

// Which side the OS's own window-control buttons are on. Ideally this
// would ask the OS directly (Windows/Linux themes and DEs can move
// those buttons, unlike macOS's fixed-left traffic lights) -- an earlier
// version of this did exactly that via Electron's titleBarOverlay +
// navigator.windowControlsOverlay, but that requires frame:false, and
// frame:false silently dropped the window's control buttons entirely on
// Windows (never actually verified there before landing) -- a broken
// window is worse than an imperfect guess, so that's reverted and this
// is back to a platform-only default until a way to detect the real
// side is found that doesn't risk the window chrome itself. Log panel
// headers mirror this: the hamburger sits opposite the OS's own
// controls, the two right-side icons sit alongside them (see Panel's
// syncControlsSide and the body.controls-left CSS overrides).
let controlsSide = IS_MAC ? "left" : "right";

// A button cluster's outside-in reading order (the order you'd encounter
// its buttons moving from the window's edge toward the center) has to
// stay the same regardless of which side it's actually pinned to -- e.g.
// the detach/popout button always closest to the edge, a "hide"-style
// toggle always closest to center. canonicalOutsideIn is that fixed
// reading order; reversing it is only ever needed once the cluster
// itself is on the right (so left-to-right DOM order still reads as
// outside-in from that side).
function orderForSide(canonicalOutsideIn, side) {
  return side === "left" ? canonicalOutsideIn : [...canonicalOutsideIn].reverse();
}

function applyControlsSide(side) {
  controlsSide = side;
  document.body.classList.toggle("controls-left", side === "left");
  document.body.classList.toggle("controls-right", side === "right");
  $("chart-head").querySelector(".panel-head-right").append(
    ...orderForSide([$("btn-popout-telemetry"), $("btn-popback-telemetry"), $("btn-style-toggle-svc")], side)
  );
  $("host-head").querySelector(".panel-head-right").append(
    ...orderForSide([$("btn-popout-host"), $("btn-popback-host"), $("btn-style-toggle-host"), $("btn-host-toggle")], side)
  );
  for (const p of panels.values()) p.syncControlsSide();
}
applyControlsSide(controlsSide);

// One log source's virtual-scrolled panel: renders only the rows currently
// in (or just outside) the visible scroll viewport, fetching them from the
// server a PAGE (200 rows) at a time and caching pages by index for as long
// as the panel lives (see this.pages). Rows are always stored/fetched
// oldest-first; `reversed` only affects display order (see dataIndexAt/
// visualIndexOf) so index-based operations (cursor sync, search) never need
// to care which way the panel is currently sorted.
// Log panel header menu icons -- inlined the same way the Export entry's
// own SVG is (see below, in the constructor), sourced from
// ~/sources/icons/{search,sort-up,sort-down,hamburger}.svg, stripped down
// to just viewBox plus fill="currentColor" so they inherit .icon-btn's
// color like every other
// header icon. Search's markup is identical (same path data) to the
// magnifier already inlined at index.html's .mac-settings-search button.
const LOG_MENU_SEARCH_SVG = '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="m292 80c-77.196 0-140 62.804-140 140s62.804 140 140 140 140-62.804 140-140-62.804-140-140-140zm97.989 120h-38.507c-1.262-24.255-4.859-47.745-10.975-67.42 25.09 13.978 43.576 38.437 49.482 67.42zm-117.414 40h38.849c-2.545 43.399-12.971 69.987-19.425 78.185-6.453-8.198-16.879-34.786-19.424-78.185zm0-40c2.545-43.399 12.971-69.987 19.425-78.185 6.454 8.198 16.88 34.786 19.425 78.185zm-29.082-67.42c-6.116 19.675-9.714 43.165-10.975 67.42h-38.507c5.906-28.983 24.392-53.442 49.482-67.42zm-49.482 107.42h38.507c1.262 24.255 4.859 47.745 10.975 67.42-25.09-13.978-43.576-38.437-49.482-67.42zm146.496 67.42c6.116-19.675 9.714-43.165 10.975-67.42h38.507c-5.906 28.983-24.392 53.442-49.482 67.42z"/><path d="m292 0c-121.588 0-220 98.396-220 220 0 52.045 17.963 101.324 50.935 140.781l-117.077 117.077c-7.811 7.811-7.811 20.474 0 28.284 7.81 7.81 20.473 7.811 28.284 0l117.077-117.077c39.457 32.972 88.736 50.935 140.781 50.935 121.588 0 220-98.396 220-220 0-121.588-98.396-220-220-220zm0 400c-99.252 0-180-80.748-180-180s80.748-180 180-180 180 80.748 180 180-80.748 180-180 180z"/></svg>';
const LOG_MENU_SORT_UP_SVG = '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M9.707,7.293A1,1,0,1,1,8.293,8.707L7,7.414V27a1,1,0,0,1-2,0V7.414L3.707,8.707A1,1,0,0,1,2.293,7.293l3-3a1,1,0,0,1,1.414,0ZM29,5H13a1,1,0,0,0,0,2H29a1,1,0,0,0,0-2Zm-4,7H13a1,1,0,0,0,0,2H25a1,1,0,0,0,0-2Zm-4,7H13a1,1,0,0,0,0,2h8a1,1,0,0,0,0-2Zm-4,7H13a1,1,0,0,0,0,2h4a1,1,0,0,0,0-2Z"/></svg>';
const LOG_MENU_SORT_DOWN_SVG = '<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="m9.707 23.293a1 1 0 0 1 0 1.414l-3 3a1 1 0 0 1 -1.414 0l-3-3a1 1 0 0 1 1.414-1.414l1.293 1.293v-19.586a1 1 0 0 1 2 0v19.586l1.293-1.293a1 1 0 0 1 1.414 0zm19.293-18.293h-16a1 1 0 0 0 0 2h16a1 1 0 0 0 0-2zm-4 7h-12a1 1 0 0 0 0 2h12a1 1 0 0 0 0-2zm-4 7h-8a1 1 0 0 0 0 2h8a1 1 0 0 0 0-2zm-4 7h-4a1 1 0 0 0 0 2h4a1 1 0 0 0 0-2z"/></svg>';
const LOG_MENU_HAMBURGER_SVG = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="m19 11h-18c-.265216 0-.51957-.1054-.707107-.2929-.187536-.1875-.292893-.4419-.292893-.7071 0-.26522.105357-.51957.292893-.70711.187537-.18753.441891-.29289.707107-.29289h18c.2652 0 .5196.10536.7071.29289.1875.18754.2929.44189.2929.70711 0 .2652-.1054.5196-.2929.7071s-.4419.2929-.7071.2929zm0-7h-18c-.265216 0-.51957-.10536-.707107-.29289-.187536-.18754-.292893-.44189-.292893-.70711s.105357-.51957.292893-.70711c.187537-.18753.441891-.29289.707107-.29289h18c.2652 0 .5196.10536.7071.29289.1875.18754.2929.44189.2929.70711s-.1054.51957-.2929.70711c-.1875.18753-.4419.29289-.7071.29289zm0 14h-18c-.265216 0-.51957-.1054-.707107-.2929-.187536-.1875-.292893-.4419-.292893-.7071s.105357-.5196.292893-.7071c.187537-.1875.441891-.2929.707107-.2929h18c.2652 0 .5196.1054.7071.2929s.2929.4419.2929.7071-.1054.5196-.2929.7071-.4419.2929-.7071.2929z"/></svg>';

class Panel {
  constructor(src) {
    this.src = src;
    this.total = src.total;
    this.pages = new Map(); // pageIdx -> rows | Promise
    this.cursorIdx = null;
    this.reversed = prefs.get("logNewestFirst", true); // true: newest entry on top
    this.selected = new Map(); // dataIdx -> ts, entries picked for right-click actions
    this.lastClickIdx = null; // anchor for shift-click range selection

    this.el = document.createElement("div");
    this.el.className = "panel";
    const head = document.createElement("div");
    head.className = "panel-head";
    const headTop = document.createElement("div");
    headTop.className = "panel-head-top";
    const headControls = document.createElement("div");
    headControls.className = "panel-head-controls";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = src.name;
    name.title = src.path;
    this.sampleBadge = document.createElement("span");
    this.sampleBadge.className = "sample-badge";
    this.sampleBadge.title = "static data from loaded .cttc-metric/.cttc-record data";
    this.sampleBadge.hidden = true;
    this.countEl = document.createElement("span");
    this.countEl.className = "muted";
    // Search/Sort up/Sort down/Export all live in the hamburger menu below
    // instead of as standalone buttons -- setSortDir is shared by the Sort
    // up/down entries (mutually exclusive; the active one is marked fresh
    // on every menu open, since entries are rebuilt per click).
    const setSortDir = (reversed) => {
      this.reversed = reversed;
      prefs.set("logNewestFirst", this.reversed);
      this.body.scrollTop = 0;
      this.render();
    };
    const menuBtn = document.createElement("button");
    menuBtn.className = "icon-btn panel-menu-btn";
    menuBtn.innerHTML = LOG_MENU_HAMBURGER_SVG;
    menuBtn.title = "Menu";
    menuBtn.setAttribute("aria-label", "Menu");
    menuBtn.setAttribute("aria-haspopup", "true");
    menuBtn.setAttribute("aria-expanded", "false");
    menuBtn.onclick = (e) => {
      ctxMenu(e, [
        ["Search", () => {
          this.searchBar.hidden = !this.searchBar.hidden;
          if (!this.searchBar.hidden) this.searchInput.focus();
        }, LOG_MENU_SEARCH_SVG],
        ["Sort up", () => setSortDir(false), LOG_MENU_SORT_UP_SVG, !this.reversed],
        ["Sort down", () => setSortDir(true), LOG_MENU_SORT_DOWN_SVG, this.reversed],
        // Same export glyph as #btn-export-metrics, next to the metric(s)
        // dropdown in analysis mode -- this is that same action's
        // log-viewer counterpart, one panel at a time.
        ["Export", () => this.exportLog(), '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="m256.008 383.451c-26.012 0-47.149-21.137-47.149-47.117v-181.017c-16.889 6.563-36.829 3.037-50.442-10.576-.117-.117-.232-.236-.345-.356-18.066-18.418-18.005-47.98.341-66.313l64.263-64.263c8.889-8.902 20.726-13.809 33.324-13.809s24.435 4.907 33.332 13.816l64.259 64.259c18.286 18.273 18.46 47.834.337 66.309-.113.121-.228.24-.345.356-13.617 13.618-33.563 17.142-50.458 10.571v181.022c0 25.981-21.136 47.118-47.117 47.118zm-26.409-272.59c5.605 2.321 9.26 7.791 9.26 13.858v211.614c0 9.438 7.679 17.117 17.117 17.117 9.47 0 17.149-7.679 17.149-17.117v-211.63c0-6.067 3.655-11.537 9.26-13.858s12.057-1.038 16.347 3.252l9.431 9.431c6.604 6.604 17.306 6.674 23.995.208.074-.076.148-.152.224-.228 6.696-6.692 6.701-17.52 0-24.216l-64.27-64.271c-3.237-3.24-7.535-5.021-12.112-5.021s-8.875 1.781-12.104 5.014l-64.274 64.274c-6.698 6.694-6.707 17.52-.003 24.22.075.075.15.151.223.228 6.689 6.465 17.391 6.396 23.996-.208l9.415-9.415c4.605-4.607 11.159-5.401 16.346-3.252z"/><path d="m432.733 512h-353.466c-43.781 0-79.267-35.415-79.267-79.267v-160.666c0-43.78 35.415-79.267 79.267-79.267h48.2c25.808 0 47.133 20.856 47.133 47.133 0 25.744-20.796 47.134-47.133 47.134h-33.2v130.667h323.467v-130.667h-33.2c-25.743 0-47.133-20.797-47.133-47.134 0-25.743 20.796-47.133 47.133-47.133h48.2c43.78 0 79.267 35.415 79.267 79.267v160.667c-.001 43.781-35.417 79.266-79.268 79.266zm-353.466-289.2c-27.216 0-49.267 22.015-49.267 49.267v160.667c0 27.211 22.011 49.266 49.267 49.266h353.467c27.214 0 49.266-22.012 49.266-49.267v-160.666c0-27.216-22.015-49.267-49.267-49.267h-48.2c-9.596 0-17.133 7.808-17.133 17.133 0 9.578 7.788 17.134 17.133 17.134h48.2c8.284 0 15 6.716 15 15v160.667c0 8.284-6.716 15-15 15h-353.466c-8.284 0-15-6.716-15-15v-160.667c0-8.284 6.716-15 15-15h48.2c9.595 0 17.133-7.807 17.133-17.134 0-9.576-7.786-17.133-17.133-17.133z"/></svg>'],
      ]);
    };
    const popout = document.createElement("button");
    popout.className = "icon-btn";
    popout.textContent = "⧉";
    popout.hidden = !window.cttc?.popout || POPOUT_KIND != null;
    popout.title = "Open this log in its own window";
    popout.onclick = () => openLogPopout(src.id);
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "✕";
    close.title = "Disable this container's telemetry (logs + chart) -- keeps collecting in the background, still Connect Docker Host-synced";
    // Same hide as switching it off from the Telemetry legend -- not an
    // actual /close: collection keeps running server-side, and re-enabling
    // it (from the legend) brings this exact panel back at the same spot,
    // since it never actually left panels/#panels.
    close.onclick = () => {
      state.visible.set(src.name, false);
      relist();
      syncPanels();
    };
    const right = document.createElement("div");
    right.className = "panel-head-right";
    this.popout = popout;
    this.close = close;
    this.popback = null;
    if (POPOUT_KIND === "log") {
      const popback = document.createElement("button");
      popback.className = "popback btn-flat";
      popback.innerHTML =
        '<svg class="btn-flat-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<path d="m12 2a9.95 9.95 0 0 0 -7 2.88v-1.88a1 1 0 0 0 -2 0v5a1 1 0 0 0 1 1h5a1 1 0 0 0 0-2h-3.2242a7.9872 7.9872 0 1 1 .2613 10.3335 1 1 0 1 0 -1.49 1.334 10 10 0 1 0 7.4529-16.6675z"/></svg>' +
        "Bring Back";
      popback.title = "Bring back into the main window";
      popback.onclick = () => window.close();
      this.popback = popback;
    }
    const center = document.createElement("div");
    center.className = "panel-head-center";
    center.append(name, this.sampleBadge);
    // Row 1: hamburger menu, centered name+badge, and the right-side icons
    // -- a 3-column grid (see .panel-head-top) so the center stays
    // centered regardless of how wide either side is, with the hamburger
    // and icon cluster swapping which column they occupy to mirror the
    // OS's own window-control side (see syncControlsSide). Row 2
    // (headControls) is the entries/transforms count, flushed right on
    // its own -- this.countEl (set in update()) is the only thing on the
    // row below.
    this.headTop = headTop;
    this.menuBtn = menuBtn;
    this.headCenter = center;
    this.headRight = right;
    this.syncControlsSide();
    headControls.append(this.countEl);
    head.append(headTop, headControls);
    // Drag the header to reorder this panel (and its matching legend entry
    // moves to match), or drag it out past the window's edge to pop it out
    // into its own window -- not offered inside an already-popped-out
    // window, which only ever shows the one panel it opened with.
    if (POPOUT_KIND !== "log") wireDragReorder(head, src.name, () => openLogPopout(src.id), this.el);

    this.searchBar = document.createElement("div");
    this.searchBar.className = "panel-search";
    this.searchBar.hidden = true;
    this.searchQuery = "";
    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.placeholder = "search…";
    this.searchInput.onkeydown = (e) => {
      // Enter/Shift+Enter and Up/Down all drive the same find() -- focus
      // stays on the input the whole time (find() itself re-focuses after
      // jumping to a match), so once a search is underway the user can
      // keep stepping through matches with the keyboard alone, without
      // ever needing to click ▲/▼.
      if (e.key === "Enter") { e.preventDefault(); this.find(!e.shiftKey); }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.find(true); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this.find(false); }
      else if (e.key === "Escape") { this.searchBar.hidden = true; }
    };
    const prevBtn = document.createElement("button");
    prevBtn.textContent = "▲";
    prevBtn.title = "Previous match";
    prevBtn.onclick = () => this.find(false);
    const nextBtn = document.createElement("button");
    nextBtn.textContent = "▼";
    nextBtn.title = "Next match";
    nextBtn.onclick = () => this.find(true);
    this.searchStatus = document.createElement("span");
    this.searchStatus.className = "muted search-status";
    const searchClose = document.createElement("button");
    searchClose.textContent = "✕";
    searchClose.title = "Close search";
    searchClose.onclick = () => { this.searchBar.hidden = true; };
    this.searchBar.append(this.searchInput, prevBtn, nextBtn, this.searchStatus, searchClose);

    this.body = document.createElement("div");
    this.body.className = "panel-body";
    this.spacer = document.createElement("div");
    this.spacer.className = "panel-spacer";
    // Shown instead of the (otherwise blank) log view whenever this source
    // has no rows at all and last reported an error -- a failed ssh/docker
    // connection, "log stream ended" before ever ingesting a line, etc. --
    // so a broken source reads as a clear message, not an empty box with a
    // barely-visible one-line error tucked into the header.
    this.emptyState = document.createElement("div");
    this.emptyState.className = "panel-empty-state";
    this.emptyState.hidden = true;
    this.body.append(this.spacer, this.emptyState);
    this.body.addEventListener("scroll", () => this.render());

    this.el.append(head, this.searchBar, this.body);
    this.update(src);
  }

  // Places the hamburger and icon-cluster zones into headTop, and orders
  // the icon cluster's own buttons (detach closest to the window edge,
  // close closest to center -- see orderForSide), according to the
  // current controlsSide. Called once from the constructor, and again
  // for every existing panel if controlsSide ever changes live (a
  // geometrychange from the Window Controls Overlay API, see the
  // controlsSide/applyControlsSide definitions above).
  syncControlsSide() {
    const start = controlsSide === "left" ? this.headRight : this.menuBtn;
    const end = controlsSide === "left" ? this.menuBtn : this.headRight;
    this.headTop.append(start, this.headCenter, end);
    this.headRight.append(...orderForSide([this.popout, this.popback, this.close].filter(Boolean), controlsSide));
  }

  // Called on every refreshAll() with this source's latest /sources entry
  // (row count, error, transforms). Refreshes the header/spacer and, if the
  // row count grew, invalidates the last cached page so newly-tailed rows
  // actually get re-fetched instead of serving a stale, now-incomplete copy.
  update(src) {
    this.src = src;
    this.sampleBadge.hidden = src.live !== false;
    if (src.live === false) this.sampleBadge.textContent = basename(src.path);
    if (src.total !== this.total) {
      // drop the last (possibly partial) cached page so new rows appear
      const lastPage = Math.floor(this.total / PAGE);
      this.pages.delete(lastPage);
      this.total = src.total;
    }
    this.countEl.textContent = `${this.total.toLocaleString()} entries` +
      (src.transforms?.length ? ` · ${src.transforms.map(formatTransformName).join("+")}` : "");
    const broken = this.total === 0 && !!src.error;
    this.emptyState.hidden = !broken;
    this.emptyState.textContent = broken ? src.error : "";
    this.countEl.title = src.error || "";
    this.spacer.style.height = this.total * ROWH + "px";
    this.render();
  }

  // Row page `idx` (data indices [idx*PAGE, idx*PAGE+PAGE)), fetched once
  // and cached indefinitely (see this.pages) -- concurrent callers awaiting
  // the same not-yet-resolved page share one in-flight request, since the
  // Promise itself is what's cached until it resolves to the actual rows.
  async page(idx) {
    if (this.pages.has(idx)) return this.pages.get(idx);
    const pr = get(`/logs?source=${this.src.id}&start=${idx * PAGE}&count=${PAGE}`).then((r) => {
      this.pages.set(idx, r.rows);
      return r.rows;
    });
    this.pages.set(idx, pr);
    return pr;
  }

  // rows are stored oldest→newest (data index 0 = oldest); when `reversed`
  // the newest entry is displayed at the top, so visual row position and
  // data index run in opposite directions.
  dataIndexAt(visualIdx) {
    return this.reversed ? this.total - 1 - visualIdx : visualIdx;
  }
  visualIndexOf(dataIdx) {
    return this.reversed ? this.total - 1 - dataIdx : dataIdx;
  }

  async render() {
    const h = this.body.clientHeight;
    const i0 = Math.max(0, Math.floor(this.body.scrollTop / ROWH) - 10);
    const i1 = Math.min(this.total - 1, Math.ceil((this.body.scrollTop + h) / ROWH) + 10);
    if (i1 < i0) return;
    let p0 = Infinity, p1 = -Infinity;
    for (let i = i0; i <= i1; i++) {
      const p = Math.floor(this.dataIndexAt(i) / PAGE);
      if (p < p0) p0 = p;
      if (p > p1) p1 = p;
    }
    const pages = {};
    for (let p = p0; p <= p1; p++) pages[p] = await this.page(p);

    for (const r of this.body.querySelectorAll(".log-row")) r.remove();
    const frag = document.createDocumentFragment();
    // dotted top/bottom border marks the edges of a contiguous run of
    // highlighted rows (not every row), so track the previous row's state
    // across loop iterations.
    let prevHl = false, prevDiv = null;
    for (let i = i0; i <= i1; i++) {
      const dataIdx = this.dataIndexAt(i);
      const row = pages[Math.floor(dataIdx / PAGE)]?.[dataIdx % PAGE];
      if (!row) continue;
      const div = document.createElement("div");
      div.className = "log-row";
      div.style.top = i * ROWH + "px";
      const isHl = state.cursorT != null && Math.abs(row.ts - state.cursorT) <= state.windowMs;
      if (isHl) {
        // Live tracking's auto-click highlights rows in liveTrackColor
        // instead of the normal selection highlight color -- see
        // setCursor's liveTrack option / the "Live tracking" Appearance
        // section.
        div.classList.add(state.liveTrackCursor ? "hl-live" : "hl");
        if (!prevHl) div.classList.add("hl-top");
      } else if (prevHl) {
        prevDiv.classList.add("hl-bottom");
      }
      prevHl = isHl;
      prevDiv = div;
      if (dataIdx === this.cursorIdx) div.classList.add("cursor-row");
      if (this.selected.has(dataIdx)) div.classList.add("selected");
      if (/\b(ERROR|FATAL|CRIT)/i.test(row.text)) div.classList.add("lvl-error");
      else if (/\bWARN/i.test(row.text)) div.classList.add("lvl-warn");
      if (this.searchQuery && row.text.toLowerCase().includes(this.searchQuery)) div.classList.add("search-hit");
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = fmtClock(row.ts, true);
      div.appendChild(ts);
      div.appendChild(document.createTextNode(row.text.split("\n")[0]));
      div.title = new Date(row.ts).toISOString() + "\n" + formatLogEntryText(row.text)
        + "\n(ctrl/cmd-click to select, shift-click to select a range, right-click for actions)";
      div.onclick = (e) => {
        if (e.shiftKey && this.lastClickIdx != null) {
          const [a, b] = [Math.min(this.lastClickIdx, dataIdx), Math.max(this.lastClickIdx, dataIdx)];
          for (let k = a; k <= b; k++) {
            const r = pages[Math.floor(k / PAGE)]?.[k % PAGE];
            if (r) this.selected.set(k, r.ts);
          }
          this.render();
        } else if (e.metaKey || e.ctrlKey) {
          if (this.selected.has(dataIdx)) this.selected.delete(dataIdx);
          else this.selected.set(dataIdx, row.ts);
          this.lastClickIdx = dataIdx;
          this.render();
        } else {
          this.selected.clear();
          this.lastClickIdx = dataIdx;
          setCursor(row.ts);
          recenterOn(row.ts); // same as double-clicking the timeline at this point in time
          this.render();
        }
      };
      div.oncontextmenu = (e) => {
        if (!this.selected.has(dataIdx)) {
          this.selected.clear();
          this.selected.set(dataIdx, row.ts);
          this.lastClickIdx = dataIdx;
          this.render();
        }
        const tsList = [...this.selected.values()];
        const t = (Math.min(...tsList) + Math.max(...tsList)) / 2;
        timeContextMenu(e, t, () => { this.selected.clear(); this.render(); });
      };
      frag.appendChild(div);
    }
    if (prevHl && prevDiv) prevDiv.classList.add("hl-bottom"); // last rendered row ends a run
    this.body.appendChild(frag);
  }

  async jumpTo(t) {
    try {
      const r = await get(`/index_at?source=${this.src.id}&t=${t}`);
      this.cursorIdx = r.index;
      const vi = this.visualIndexOf(r.index);
      this.body.scrollTop = Math.max(0, vi * ROWH - this.body.clientHeight / 2 + ROWH / 2);
      this.render();
    } catch { /* source may have vanished */ }
  }

  async jumpToIndex(idx) {
    this.cursorIdx = idx;
    const vi = this.visualIndexOf(idx);
    this.body.scrollTop = Math.max(0, vi * ROWH - this.body.clientHeight / 2 + ROWH / 2);
    await this.render();
    const row = (await this.page(Math.floor(idx / PAGE)))?.[idx % PAGE];
    if (row) setCursor(row.ts); // keep the chart crosshair (and other panels) in sync
  }

  async find(forward) {
    const q = this.searchInput.value;
    this.searchQuery = q.toLowerCase();
    if (!q) { this.searchStatus.textContent = ""; this.render(); return; }
    const start = this.cursorIdx != null ? this.cursorIdx + (forward ? 1 : -1) : 0;
    try {
      const r = await get(
        `/logs/find?source=${this.src.id}&q=${encodeURIComponent(q)}&start=${Math.max(0, start)}&dir=${forward ? "fwd" : "back"}`
      );
      if (r.index == null) { this.searchStatus.textContent = "no matches"; return; }
      this.searchStatus.textContent = "";
      await this.jumpToIndex(r.index);
    } catch (err) {
      this.searchStatus.textContent = String(err.message || err);
    } finally {
      // Whether this find succeeded, found nothing, or errored, focus
      // stays on the input -- jumpToIndex()'s own render()/setCursor()
      // touch every panel's DOM but never this one's search box, so this
      // is only ever needed after a click on ▲/▼ (which, unlike Enter/
      // Up/Down on the input itself, steals focus to the button).
      this.searchInput.focus();
    }
  }

  // "Export .log": writes every entry this log viewer currently has to a
  // plain .log file, one line per entry. Asks where to save *first* (see
  // main.js's pick-log-export-path docstring) -- fetchAllLogRows only
  // runs, and nothing gets written, once the user actually confirms Save
  // in the native dialog; cancelling costs nothing.
  async exportLog() {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const path = await pickLogExportPath(`${this.src.name}-${stamp}.log`);
    if (!path) return;
    try {
      const rows = await fetchAllLogRows(this.src.id);
      const text = rows.map((r) => r.text).join("\n") + (rows.length ? "\n" : "");
      await writeLogExportFile(path, new TextEncoder().encode(text));
      notifyEvent(`Log exported: ${path}`);
    } catch (err) {
      notifyEvent(`Could not export log: ${err.message || err}`);
    }
  }

}

// Assigns (once) or looks up a log panel's stable position among its
// siblings -- see state.panelOrder's own comment.
function orderOf(name) {
  if (!(name in state.panelOrder)) {
    const used = Object.values(state.panelOrder);
    state.panelOrder[name] = used.length ? Math.max(...used) + 1 : 0;
    prefs.set("panelOrder", state.panelOrder);
  }
  return state.panelOrder[name];
}

// Drag-and-drop reordering: the legend and the log panels below share this
// same by-name order (see state.panelOrder/orderOf), so dragging a legend
// entry to a new spot reorders that container's log panel to match, and
// dragging a log panel's header reorders its legend entry the same way --
// one order, two views onto it.
function reorderTo(draggedName, targetName) {
  if (draggedName === targetName) return;
  orderOf(draggedName); // make sure both names have an assigned slot before...
  orderOf(targetName); // ...building the array to reinsert into
  const arr = Object.keys(state.panelOrder).sort((a, b) => state.panelOrder[a] - state.panelOrder[b]);
  const from = arr.indexOf(draggedName);
  arr.splice(from, 1);
  arr.splice(arr.indexOf(targetName), 0, draggedName);
  arr.forEach((n, i) => { state.panelOrder[n] = i; });
  prefs.set("panelOrder", state.panelOrder);
  renderLegend();
  syncPanels();
}

// Common dragstart/dragover/drop wiring for anything draggable-by-name
// (legend entries, panel headers) -- `onDetach` fires instead of a reorder
// when the drag ends outside this window's own bounds (checked in screen
// coordinates, since dragend's clientX/Y are relative to whatever window
// the pointer is over when it lets go), letting either side "drag out to
// pop out" the same way. `dragImageEl` (defaults to `el` itself) is what's
// actually shown as the drag ghost -- a log panel's header stays the
// interactive handle (so selecting log text/scrolling doesn't start a
// drag), but the ghost image is the *whole panel*, header and body moving
// together, so it reads as "this panel is moving", not just its header.
function wireDragReorder(el, name, onDetach, dragImageEl = el) {
  el.draggable = true;
  el.ondragstart = (e) => {
    e.dataTransfer.setData("text/cttc-series-name", name);
    e.dataTransfer.effectAllowed = "move";
    if (dragImageEl !== el) {
      const elRect = el.getBoundingClientRect();
      e.dataTransfer.setDragImage(dragImageEl, e.clientX - elRect.left, e.clientY - elRect.top);
    }
  };
  el.ondragover = (e) => {
    if (!e.dataTransfer.types.includes("text/cttc-series-name")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  el.ondrop = (e) => {
    const dragged = e.dataTransfer.getData("text/cttc-series-name");
    if (!dragged) return;
    e.preventDefault();
    reorderTo(dragged, name);
  };
  el.ondragend = (e) => {
    const outside = e.screenX < window.screenX || e.screenX > window.screenX + window.outerWidth ||
      e.screenY < window.screenY || e.screenY > window.screenY + window.outerHeight;
    if (outside) onDetach();
  };
}

function syncPanels() {
  let logs = state.sources.filter((s) => s.kind === "log");
  if (POPOUT_KIND === "log") logs = logs.filter((s) => s.id === POPOUT_ID);
  else if (!POPOUT_KIND) logs = logs.filter((s) => !state.poppedOut.has(s.id));
  for (const [sid, p] of panels) {
    if (!logs.find((s) => s.id === sid)) {
      p.el.remove();
      panels.delete(sid);
    }
  }
  for (const s of logs) {
    let p = panels.get(s.id);
    if (!p) {
      p = new Panel(s);
      panels.set(s.id, p);
      panelsEl.appendChild(p.el);
    } else {
      p.update(s);
    }
    // Hidden (not removed) when its container's telemetry was switched off
    // via the legend or the panel's own close button (see Panel's close
    // handler) -- collection keeps running server-side either way, so it's
    // still right here, at the exact same spot, whenever it's switched back on.
    p.el.hidden = isSampleHidden(s.id) || isLiveDataHidden(s.id) || isOtherDockerHostHidden(s.id) || state.visible.get(s.name) === false;
  }
  // Reorders the DOM to match panelOrder every sync -- appendChild on an
  // already-attached node just moves it, so this is cheap and keeps a
  // popped-out-then-brought-back (or hidden-then-shown) panel in its
  // original slot relative to its siblings rather than wherever it was
  // (re)created just now.
  for (const sid of [...panels.keys()].sort((a, b) => orderOf(panels.get(a).src.name) - orderOf(panels.get(b).src.name))) {
    panelsEl.appendChild(panels.get(sid).el);
  }
}

/* ── refresh / SSE ──────────────────────────────────────────────────────── */

// The toolbar's own status line, next to the timestamp/cursor controls --
// deliberately narrow now: only armSampleCapture's "drag across a chart"
// hint uses it, since that instruction is specifically about those
// controls. Every other transient status/error (server connectivity,
// export/save results, recording lifecycle, ...) goes through notifyEvent
// instead, so it shows up in exactly one place, the bottom status bar --
// showing it here too used to duplicate it right next to the timestamp
// controls, which have nothing to do with most of those messages.
function setStatus(msg) {
  $("status").textContent = msg || "";
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshAll, 300);
}

async function refreshAll() {
  try {
    const [src, range] = await Promise.all([get("/sources"), get("/range")]);
    state.sources = src.sources;
    // Analysis mode (see setLiveHidden) is a reflection of
    // whether any sample/recording source is actually open, re-derived on
    // every refresh (not just right after a fresh upload) -- otherwise
    // re-loading a file that's already open (a no-op upload, see
    // btn-load-sample) or a sample restored from an earlier session would
    // never trip it, leaving live data shown right alongside the sample it
    // was supposed to hide behind.
    const hasSample = state.sources.some((s) => s.live === false);
    // Self-heals #record-sections: if the tracked record's own sources got
    // closed some other way (Back to live tracking, a sidebar per-file
    // close, the dropdown's own onchange, ...) there's nothing left for it
    // to switch between, so it shouldn't linger showing a stale file's
    // segments. Checked unconditionally (not just inside setLiveHidden,
    // below) since that only runs when state.liveHidden itself flips --
    // with some OTHER sample still open, closing just this one wouldn't
    // change it at all, and the dropdown would never get a chance to hide.
    if (
      activeRecordSections &&
      !activeRecordSections.openedIds.some((id) => state.sources.some((s) => s.id === id))
    ) {
      setActiveRecordSections(null);
    }
    // Self-heals state.activeSamplePath the same way, and for the same
    // reason: if the active view's own sources got closed some other way
    // (Close view, a sidebar per-file close, ...) there's nothing left to
    // show for it -- fall back to another still-open file if one exists,
    // rather than isSampleHidden hiding every source with nothing switched
    // to instead (see setActiveView).
    const sampleGroups = sampleFileGroups();
    if (!sampleGroups.some((g) => g.path === state.activeSamplePath)) {
      // Covers both directions: activeSamplePath pointing at a file that's
      // no longer open (fall back to another still-open one, or none),
      // and activeSamplePath never having been set at all despite a
      // sample now being open (e.g. opened via a path other than
      // btn-load-sample/openRecording's own setActiveView call, such as a
      // direct /open) -- either way, default to the first still-open file
      // rather than leaving every sample hidden with nothing selected.
      state.activeSamplePath = sampleGroups.length ? sampleGroups[0].path : null;
    }
    // Self-heals state.activeDockerHost the same way: if it no longer
    // matches any currently-open live docker source (that host was
    // disconnected/removed some other way), fall back to whichever live
    // docker source is still open rather than leaving the graph/exports
    // scoped to a host with nothing left collecting. Left as-is (not
    // reset to "local") when nothing docker-related is open at all, so
    // reconnecting the same remote host later restores it.
    const liveDockerHosts = state.sources
      .filter((s) => s.live === true && /^docker:\/\//.test(s.path || ""))
      .map((s) => s.host || "local");
    if (liveDockerHosts.length && !liveDockerHosts.includes(state.activeDockerHost)) {
      state.activeDockerHost = liveDockerHosts[0];
      prefs.set("activeDockerHost", state.activeDockerHost);
    }
    // Regression fix: this self-heal used to fire unconditionally, which
    // predates ui-LIVE-016 (Back to Live deliberately never closes loaded
    // samples). Once that shipped, hasSample=true + liveHidden=false
    // became a perfectly legitimate state -- exactly what clicking Back
    // to Live with an old sample still parked open leaves you in -- but
    // this line still treated it as "stale, force analysis mode back on",
    // so the view rubber-banded: briefly live, then straight back to the
    // sample. liveChosenWithSamplesStillOpen (set by setActiveView) is
    // the fix: skip re-forcing analysis mode on only while that explicit
    // choice still stands. The other direction (last sample just closed,
    // nothing left to show) is unaffected and stays unconditional -- and
    // any *explicit* switch into a file, including a no-op reupload's own
    // setActiveView call (btn-load-sample/openRecording), already clears
    // the flag itself, so a genuinely new/returning sample still correctly
    // trips analysis mode exactly as this self-heal originally intended.
    // Also self-clears here once every sample is actually gone (closed via
    // Opened Metrics, a panel's own close button, etc. -- any route that
    // doesn't go through setActiveView either): with nothing left open,
    // "stay Live despite an old sample" is moot, and the *next* sample to
    // appear is unambiguously new, so it must correctly trip analysis mode
    // again rather than staying suppressed by a stale choice about a file
    // that isn't even open anymore.
    if (!hasSample) liveChosenWithSamplesStillOpen = false;
    if (hasSample !== state.liveHidden && !(hasSample && liveChosenWithSamplesStillOpen)) {
      setLiveHidden(hasSample);
    }
    assignColorSlots(); // before anything draws, so slots don't depend on draw order
    const hadView = !!state.view;
    state.range = range;
    $("empty-state").hidden = state.sources.length > 0;
    syncPanels();
    syncDockerDaemonButtons();
    if (range.min_ts != null && !hadView) {
      if (POPOUT_KIND) {
        // popout fallback (no view handed over): fit quietly, never yank the
        // opener's view via a broadcast
        const pad = Math.max(1000, (range.max_ts - range.min_ts) * 0.01);
        setView(range.min_ts - pad, range.max_ts + pad, { broadcast: false });
      } else {
        goLive();
      }
    }
    await fetchSeries();
    liveTrackTick();
    if (src.json_impl !== "orjson") notifyEvent("server running without orjson (slow parse)");
  } catch (err) {
    notifyEvent("server unreachable: " + err.message);
  }
}

// Live tracking (see the toolbar/Settings "Live tracking" seconds field):
// on every refresh while the view is following live, simulates a click at
// now + liveTrackSecs (never positive -- the future has no data to show
// yet, see setLiveTrackSecs's clamp). Deliberately gated on state.live
// (not "always"): a user who's panned away to look at history shouldn't
// have their cursor yanked back to the live edge by a background refresh.
function liveTrackTick() {
  if (!state.live || !liveTrackEnabled || state.liveHidden) return;
  setCursor(Date.now() + liveTrackSecs * 1000, { liveTrack: true });
}

// Opens the server's /events stream (see route_events in server.py): every
// message just means "something changed, go refetch" -- this deliberately
// carries no payload of its own, so a debounced refreshAll() (via
// scheduleRefresh()) is always what actually pulls new data, keeping one
// single code path for both the SSE-driven and manual-action refresh cases.
function connectSSE() {
  // EventSource can't attach a custom header (a long-standing spec
  // limitation) -- the query param is server.py's own documented fallback
  // for exactly this one case (see _require_api_token, br-NET-004).
  const url = API_TOKEN ? `${API}/events?token=${encodeURIComponent(API_TOKEN)}` : `${API}/events`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    // A "rate" event (server.py's route_logs_rate_set broadcasts one on
    // every successful POST /logs/rate) is sRate changing, not new data --
    // routes to the client-side cRate clamp (src/shared/poll-rate)
    // instead of triggering a refresh.
    let ev = null;
    try {
      ev = JSON.parse(e.data);
    } catch {
      /* malformed payload -- ignore, same as any other unrecognized event */
    }
    if (ev && ev.type === "rate" && typeof ev.seconds === "number") {
      onServerRateEvent(ev.seconds);
      return;
    }
    throttledScheduleRefresh();
  };
  es.onerror = () => notifyEvent("reconnecting to server…");
}

// Set/Edit Docker Host and Remove Docker Host dialogs (DHOST domain) now
// live in src/modules/docker-host/ -- see entry.ts.

// A target that is already being collected can only be selected once: its
// checkbox is disabled while the matching source is open. Shared across
// several domains (this file's own sidebar "start tracking" flow, plus
// src/modules/docker-host/), not DHOST-owned, so it stays here.
function openPaths() {
  return new Set(state.sources.map((s) => s.path));
}

/* ── load .cttc-metric/.cttc-record files (separate from the Docker "Set
   sources" flow) ──────────────────────────────────────────────────── */

// reads a local path's bytes (via main.js, which has fs access the renderer
// doesn't) and POSTs them to /files/upload -- works identically whether
// server.py is this machine's embedded process or a remote one (see
// docs/architecture/remote-server.md phase 3), unlike sending the path
// itself, which only means anything when client and server share a
// filesystem. `segment` picks one recording out of a multi-segment
// .cttc-record
// (see the Recording feature below) -- omitted on the first attempt, which
// is enough for an ordinary single-segment file and only comes back with
// needs_selection (not opened) when there's more than one to choose from.
async function uploadFile(localPath, segment) {
  const filename = basename(localPath);
  if (!window.cttc?.readFile) {
    return { opened: [], errors: [{ path: filename, error: "cannot read local files in this environment" }] };
  }
  const bytes = await window.cttc.readFile(localPath);
  const headers = authHeaders({ "X-CTTC-Filename": filename });
  if (segment != null) headers["X-CTTC-Segment"] = String(segment);
  const res = await fetch(`${API}/files/upload`, { method: "POST", body: bytes, headers });
  return res.json().catch(() => ({ opened: [], errors: [{ path: filename, error: `upload failed: ${res.status}` }] }));
}

// Shared by "Load metrics" and "Open Recording": upload once, and if the
// server comes back asking which segment (a multi-segment recording, see
// merge_sample_bytes/MultiSegmentSample), load the first recorded segment
// automatically -- no prompt. Either way, remember it via
// setActiveRecordSections so the #record-sections "metric(s)" dropdown
// (right of Back to live tracking) is always populated with whatever is
// currently loaded -- one entry for a plain single metric, one per segment
// for a multi-segment recording -- and lets the user switch to any of the
// *other* entries afterward.
async function uploadAndResolveSegment(path) {
  const first = await uploadFile(path);
  if (!first.needs_selection?.length) {
    if (!first.opened?.length) {
      setActiveRecordSections(null);
      return first;
    }
    // No real segment metadata for a plain, non-ambiguous file -- a single
    // synthetic entry labeled with the filename still gives the dropdown
    // something to show, per its "always reflects what's loaded" contract.
    const segments = [{ index: 0, label: basename(path) }];
    setActiveRecordSections({ path, segments, activeIndex: 0, openedIds: first.opened });
    return first;
  }
  const segments = first.needs_selection[0].segments;
  const index = segments[0].index;
  const res = await uploadFile(path, index);
  setActiveRecordSections({ path, segments, activeIndex: index, openedIds: res.opened || [] });
  return res;
}

// Tracks the currently loaded metric(s)/recording segment(s) (null once
// nothing loaded is open) so #record-sections can offer switching to any
// OTHER entry without re-running the upload -- see uploadAndResolveSegment
// above and this dropdown's own onchange handler below.
let activeRecordSections = null; // {path, segments, activeIndex, openedIds}

function setActiveRecordSections(next) {
  activeRecordSections = next;
  const sel = $("record-sections");
  if (!next) {
    sel.hidden = true;
    sel.innerHTML = "";
    return;
  }
  sel.innerHTML = "";
  for (const seg of next.segments) {
    const opt = document.createElement("option");
    opt.value = String(seg.index);
    opt.textContent = seg.label ?? `${fmtIso(seg.from)} — ${fmtIso(seg.to)}`;
    sel.appendChild(opt);
  }
  sel.value = String(next.activeIndex);
  sel.hidden = false;
}

$("record-sections").onchange = async () => {
  if (!activeRecordSections) return;
  const index = Number($("record-sections").value);
  if (index === activeRecordSections.activeIndex) return;
  const { path, segments, openedIds } = activeRecordSections;
  await Promise.all(openedIds.map((id) => post("/close", { id })));
  const res = await uploadFile(path, index);
  if (res.errors?.length) alert(res.errors.map((e) => `${e.path}: ${e.error}`).join("\n"));
  await refreshAll();
  // Without this, the view stays wherever it was left (the *previous*
  // segment's own window) -- refreshAll() only ever sets an initial view
  // when none exists yet (see its own "!hadView" check), so switching to a
  // segment recorded at a different point in time left its data outside
  // the visible window entirely: it looked empty even though it loaded
  // correctly (BUG-0077).
  centerViewOnLoadedRange(res.opened || []);
  // Flip activeIndex (and the dropdown) only now that the view is actually
  // centered on the new segment -- this is the signal anything watching
  // activeRecordSections uses to know the switch is done, so it must not
  // go out before the view itself has caught up (otherwise there's a
  // window where activeIndex already reads "segment 1" while the chart is
  // still showing segment 0's stale range).
  setActiveRecordSections({ path, segments, activeIndex: index, openedIds: res.opened || [] });
};

// Same pattern as pickRecordingSavePath: a named wrapper around the native
// picker so tests can substitute canned paths instead of driving a real
// file dialog (which can't run headlessly) -- see ui-EXPORT-011.
async function pickAnalysisFiles() {
  if (!window.cttc?.pickFiles) {
    const p = prompt("Path to .cttc-metric or .cttc-record file:");
    return p ? [p] : [];
  }
  return window.cttc.pickFiles("Load Analysis", [
    { name: "CTTC analysis files", extensions: ["cttc-metric", "cttc-record"] },
  ]);
}

// Centers the view on the midpoint of just-opened sources' own combined
// span, zoomed so that span occupies 75% of the visible width (explicit
// user direction, 2026-08-12) -- instead of resetZoom()'s "fit the
// combined /range". Recording keeps ingesting live data in the background
// regardless of what's shown (see ui-REC-013), so the combined /range can
// span from the loaded file's own history all the way to "now", making
// the file itself look like a sliver (or vice versa) rather than showing
// what was actually just loaded. Reads from state.sources (already
// refreshed by the caller's own refreshAll(), which is /sources-backed
// and so already carries min_ts/max_ts).
function centerViewOnLoadedRange(openedIds) {
  const opened = new Set(openedIds);
  const starts = [], ends = [];
  for (const s of state.sources) {
    if (opened.has(s.id) && s.min_ts != null) {
      starts.push(s.min_ts);
      ends.push(s.max_ts);
    }
  }
  if (!starts.length) return;
  const start = Math.min(...starts);
  const end = Math.max(...ends);
  // pad chosen so (span + 2*pad) * 0.75 === span, i.e. the loaded data
  // occupies exactly 75% of the resulting view; floored so a near-
  // instantaneous recording still gets a sensible, non-degenerate zoom.
  const span = Math.max(end - start, 1500);
  const pad = span / 6;
  setView(start - pad, end + pad);
}

$("btn-load-sample").onclick = async () => {
  const paths = await pickAnalysisFiles();
  const isAnalysisFile = (p) => p.endsWith(".cttc-metric") || p.endsWith(".cttc-record");
  const open = openPaths();
  const alreadyOpen = paths.filter((p) => isAnalysisFile(p) && open.has(`upload://${basename(p)}`));
  const files = paths.filter((p) => isAnalysisFile(p) && !open.has(`upload://${basename(p)}`));
  if (!files.length) {
    // Every picked file is already open -- switch to the last one instead
    // of silently doing nothing: opening an already-open file switches to
    // its existing view, it never duplicates or no-ops quietly (see
    // setActiveView). resetZoom() restores that file's own range -- without
    // it, the view stayed wherever it was left, reading as an empty graph/
    // logs if that was a different (or out-of-range) file (BUG-0091).
    if (alreadyOpen.length) {
      setActiveView(`upload://${basename(alreadyOpen[alreadyOpen.length - 1])}`);
      resetZoom();
    }
    return;
  }
  try {
    const errors = [];
    const openedIds = [];
    for (const path of files) {
      const res = await uploadAndResolveSegment(path);
      errors.push(...(res.errors || []));
      openedIds.push(...(res.opened || []));
    }
    if (errors.length) alert(errors.map((e) => `${e.path}: ${e.error}`).join("\n"));
    if (!openedIds.length) {
      // Uploaded fine (no errors), but the recorded/exported segment(s)
      // held zero rows for every source. Without this, the call below
      // still forced a switch into analysis mode with nothing in it,
      // reading as "the file just vanished" (see BUG-0089).
      if (!errors.length) alert("No data found in the selected file for its recorded time range.");
      return;
    }
    await refreshAll(); // also switches into analysis mode -- see setLiveHidden
    setActiveView(`upload://${basename(files[files.length - 1])}`);
    centerViewOnLoadedRange(openedIds);
  } catch (err) {
    alert(String(err.message || err));
  }
};

/* ── Opened Data: one row per currently open metric/recording file (see
   #btn-opened-data in the sidebar, and #menu-opened-data in the File
   menu). Clicking a row switches the active view to it -- setActiveView
   is purely a visibility flip (sampleFileGroups(), same list Load Data's
   own already-open dedup above draws from), so resetZoom() is what
   actually restores that file's own range/chart/log data (see
   BUG-0091 -- setActiveView alone left the previous file's stale, often
   out-of-range view in place, reading as an empty graph/logs). Each
   row's own Remove button drops that file from memory instead
   (ui-EXPORT-023), uniformly for metric and recording files. */
const dlgOpenedData = $("dlg-opened-data");

function openOpenedDataRow(path) {
  dlgOpenedData.close();
  setActiveView(path);
  resetZoom();
}

// Applies uniformly to metric and recording files alike (per explicit
// user direction, superseding the old View pill's .cttc-record exemption
// -- see ui-EXPORT-019, retired). The underlying file on disk is never
// touched -- re-opening it via Load Data/Open Recording brings it right
// back. The dialog stays open afterward (unlike clicking a row) so
// several files can be removed in one pass; refreshAll()'s existing
// self-heal (ui-EXPORT-018) picks the next active view, or falls back to
// Live, if the removed file was active.
async function removeOpenedDataRow(path) {
  const group = sampleFileGroups().find((g) => g.path === path);
  if (!group) return;
  await Promise.all([...group.ids].map((id) => post("/close", { id })));
  await refreshAll();
  populateOpenedDataList();
}

function populateOpenedDataList() {
  const list = $("opened-data-list");
  const groups = sampleFileGroups();
  list.innerHTML = "";
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "opened-data-empty";
    empty.textContent = "No files currently open";
    list.appendChild(empty);
    return;
  }
  for (const g of groups) {
    const row = document.createElement("div");
    row.className = "opened-data-row";
    row.dataset.path = g.path;
    row.setAttribute("role", "option");
    if (g.path === state.activeSamplePath) row.dataset.active = "true";
    const name = document.createElement("span");
    name.className = "opened-data-row-name";
    name.textContent = basename(g.path);
    row.appendChild(name);
    const removeBtn = document.createElement("button");
    removeBtn.className = "opened-data-row-remove";
    removeBtn.textContent = "Remove";
    removeBtn.title = "Remove from memory (the file itself is untouched)";
    removeBtn.onclick = async (e) => {
      e.stopPropagation();
      await removeOpenedDataRow(g.path);
    };
    row.appendChild(removeBtn);
    row.onclick = () => openOpenedDataRow(g.path);
    list.appendChild(row);
  }
}
$("btn-opened-data").onclick = () => {
  populateOpenedDataList();
  dlgOpenedData.showModal();
};
$("dlg-opened-data-cancel").onclick = () => dlgOpenedData.close();

/* ── Recording (Start/Pause/Stop/Open Recording, Recording menu) ─────────
   Each Record→Pause span is flushed as one more segment into the same
   .cttc-record archive via /sample/record (byte-oriented, mirroring Capture
   metrics/Load metrics -- no shared-filesystem assumption), rather than
   each span becoming its own file. Every flush between Start and Stop
   overwrites a fixed internal scratch file (main.js's
   RECORDING_SCRATCH_PATH) -- the user only picks a real destination once,
   at Stop, once the recording is actually finished (see stopRecording). */

// segments is purely for the capture-range highlight (see drawVerticals):
// {from, to} for every completed (Paused) segment this session, so a pause
// leaves a genuine, unhighlighted gap instead of the highlight painting
// straight through it. segmentStart (below) still separately drives the
// *current* in-progress segment's actual /sample/record range.
const recording = { status: "idle", path: null, segmentStart: null, segments: [] };

function syncRecordingMenu() {
  $("btn-start-recording").dataset.state = recording.status;
  // "stopped" (finalized, awaiting the Stop save-path prompt -- see
  // stopRecording) can't be resumed into, same as "recording" itself.
  $("btn-start-recording").disabled = recording.status === "recording" || recording.status === "stopped";
  $("btn-start-recording").title =
    recording.status === "recording"
      ? "Recording"
      : recording.status === "paused"
        ? "Resume Recording"
        : "Start Recording";
  // dataset.state (not just .disabled) so the paused glyph itself can be
  // styled directly (blinking orange -- see .recording-dot's neighboring
  // CSS) instead of just reading as a grayed-out, disabled-and-uninformative
  // button while there's nothing left for it to do.
  $("btn-pause-recording").dataset.state = recording.status;
  $("btn-pause-recording").disabled = recording.status !== "recording";
  $("btn-pause-recording").title =
    recording.status === "paused" ? "Recording Paused" : "Pause Recording";
  $("btn-stop-recording").disabled = recording.status === "idle";
  // Bottom status bar's own recording indicator -- same dot, same colors/
  // blink, as the toolbar button (see .recording-dot in style.css), so
  // recording state reads the same way whether or not that panel is open.
  // While paused specifically, the dedicated pause glyph (see below)
  // replaces the dot rather than showing alongside it -- one indicator per
  // state, same reasoning as the toolbar's own glyph/dot swap.
  const dot = $("status-bar-recording-dot");
  dot.hidden = recording.status === "idle" || recording.status === "paused";
  dot.dataset.state = recording.status;
  dot.title =
    recording.status === "stopped" ? "Recording stopped -- not yet saved" : "Recording";
  const pauseGlyph = $("status-bar-recording-glyph");
  pauseGlyph.hidden = recording.status !== "paused";
  const label = $("status-bar-recording-text");
  label.hidden = recording.status === "idle";
  // No filename here while "recording"/"paused"/"stopped": recording.path
  // is the fixed internal scratch file (see main.js's
  // RECORDING_SCRATCH_PATH), not anything the user chose -- the real
  // destination is only known once Stop's save prompt actually succeeds,
  // at which point this label is hidden again (status back to "idle")
  // anyway, so it never needs to show a real name at all.
  label.textContent =
    recording.status === "paused"
      ? "recording paused"
      : recording.status === "recording"
        ? "recording"
        : recording.status === "stopped"
          ? "recording stopped, not yet saved"
          : "";
}

// Reassignable wrappers (window.cttc's own properties are read-only --
// contextBridge.exposeInMainWorld -- so tests substitute these instead;
// same reasoning as pickRecordingSavePath/readRecordingBytes above).
async function getRecordingMarkerFromDisk() {
  return window.cttc?.getRecordingMarker ? window.cttc.getRecordingMarker() : null;
}
async function setRecordingMarkerOnDisk(marker) {
  if (window.cttc?.setRecordingMarker) await window.cttc.setRecordingMarker(marker);
}

async function persistRecordingMarker() {
  await setRecordingMarkerOnDisk(
    recording.status === "idle"
      ? null
      : {
          path: recording.path,
          status: recording.status,
          segmentStart: recording.segmentStart,
          segments: recording.segments,
        }
  );
}

function setRecordingState(next) {
  // Guards against a stale open resume-choice dialog (see
  // recoverInterruptedRecording) leaking across a later state transition
  // triggered some other way (e.g. a test calling startRecording directly).
  if (dlgResumeChoice?.open) dlgResumeChoice.close();
  Object.assign(recording, next);
  syncRecordingMenu();
}

// Thin, individually reassignable wrappers around the native-fs calls
// Recording needs -- same pattern as saveBinaryFile above, so tests can
// substitute an in-memory store instead of driving a real native save
// dialog (which can't run headlessly).
async function pickRecordingSavePath() {
  return window.cttc?.pickRecordingPath ? window.cttc.pickRecordingPath() : null;
}
async function readRecordingBytes(path) {
  return window.cttc.readFile(path);
}
async function writeRecordingBytes(path, bytes) {
  return window.cttc.writeBinaryFile(path, bytes);
}
// The fixed, never-prompted-for path every segment flush writes to while
// "recording"/"paused"/"stopped" -- see main.js's RECORDING_SCRATCH_PATH
// docstring for why a fixed path rather than asking upfront.
async function recordingScratchPath() {
  return window.cttc?.getRecordingScratchPath
    ? window.cttc.getRecordingScratchPath()
    : "/tmp/cttc-recording-in-progress.cttc-record";
}

// Flushes [recording.segmentStart, t1) as one more segment: reads whatever
// bytes are already at recording.path (none yet, on the very first
// segment), POSTs them to /sample/record alongside the new range, and
// writes the merged archive back over the same local file.
async function flushRecordingSegment(t1) {
  let existing = new Uint8Array(0);
  try {
    existing = await readRecordingBytes(recording.path);
  } catch {
    /* first segment -- nothing on disk yet */
  }
  const res = await fetch(`${API}/sample/record`, {
    method: "POST",
    body: existing,
    headers: authHeaders({ "X-CTTC-From": String(recording.segmentStart), "X-CTTC-To": String(t1) }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `sample/record failed: ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  await writeRecordingBytes(recording.path, bytes);
}

async function startRecording(segmentStartOverride) {
  if (recording.status === "recording") return;
  if (recording.status === "idle") {
    if (!window.cttc?.getRecordingScratchPath && !window.cttc?.writeBinaryFile) {
      notifyEvent("Recording needs desktop file access — unavailable here");
      return;
    }
    // No save-path prompt here -- see main.js's RECORDING_SCRATCH_PATH
    // docstring for why: every segment flushed between now and Stop goes
    // to this fixed internal file instead, so starting never interrupts
    // the user before they even know how long they'll be recording.
    const path = await recordingScratchPath();
    // RECORDING_SCRATCH_PATH is one fixed path reused by every recording,
    // never deleted after a successful Stop (see stopRecording) -- without
    // clearing it here, a brand-new recording's first flushRecordingSegment
    // would read the *previous* recording's leftover bytes as "existing"
    // and silently merge onto them, resurrecting already-saved segments
    // that have nothing to do with this recording (BUG-0076). Resuming
    // from "paused" (the other branch below) must NOT do this -- that one
    // genuinely continues the same in-progress archive.
    await writeRecordingBytes(path, new Uint8Array(0));
    setRecordingState({ status: "recording", path, segmentStart: Date.now(), segments: [] });
    notifyEvent("Recording started");
  } else if (recording.status === "paused") {
    // resume from paused: same (scratch) path, a new segment starts either
    // now or, if the caller supplied one (the resume-choice dialog's two
    // options -- see recoverInterruptedRecording), at that timestamp
    // instead -- REQ-0067/ui-REC-019. Ordinary Resume (no override) still
    // leaves a genuine gap in the highlight between the just-completed
    // segment (already in recording.segments, see pauseRecording) and
    // this one.
    setRecordingState({ status: "recording", segmentStart: segmentStartOverride ?? Date.now() });
    notifyEvent("Recording resumed");
  } else {
    return; // "stopped" -- btn-start-recording is disabled here, nothing to do
  }
  await persistRecordingMarker();
  drawAll(); // capture-range highlight starts/resumes immediately, not on the next 1s tick
}

async function pauseRecording() {
  if (recording.status !== "recording") return;
  try {
    const to = Date.now();
    await flushRecordingSegment(to);
    // finalize this segment's highlight range -- frozen here for good, the
    // gap until the next Resume (if any) is deliberately left unhighlighted
    setRecordingState({
      status: "paused",
      segments: [...recording.segments, { from: recording.segmentStart, to }],
      segmentStart: null,
    });
    notifyEvent("Recording paused");
  } catch (err) {
    notifyEvent(`Could not pause recording: ${err.message || err}`);
    return; // stay "recording" -- the segment wasn't actually flushed
  }
  await persistRecordingMarker();
  drawAll(); // the just-completed segment's highlight (and the new gap) show up immediately
}

// Finalizes whatever's still in progress (if anything), then -- and only
// then -- asks where to actually save it (the point of this whole
// scratch-file design, see main.js's pick-recording-path docstring).
// Reaching "stopped" without a chosen destination yet (the save dialog was
// cancelled, or the write itself failed) is a real, expected resting
// state: btn-stop-recording stays enabled so clicking Stop again just
// re-prompts, without re-flushing (there's nothing left to flush) or
// losing what's already safely on the scratch file.
async function stopRecording() {
  if (recording.status === "idle") return;
  if (recording.status === "recording") {
    try {
      await flushRecordingSegment(Date.now());
    } catch (err) {
      notifyEvent(`Could not finalize recording: ${err.message || err}`);
      return; // stay "recording" -- the final segment wasn't actually flushed
    }
  }
  if (recording.status !== "stopped") {
    setRecordingState({ status: "stopped", segmentStart: null, segments: [] });
    await persistRecordingMarker();
    drawAll(); // clears the capture-range highlight immediately, recording is over
  }
  const savePath = await pickRecordingSavePath();
  if (!savePath) {
    notifyEvent("Recording stopped but not saved — click Stop again to choose a file");
    return; // stays "stopped"
  }
  try {
    const bytes = await readRecordingBytes(recording.path);
    await writeRecordingBytes(savePath, bytes);
  } catch (err) {
    notifyEvent(`Could not save recording: ${err.message || err}`);
    return; // stays "stopped" -- Stop can be clicked again to retry
  }
  notifyEvent(`Recording stopped — saved to ${savePath}`);
  setRecordingState({ status: "idle", path: null, segmentStart: null, segments: [] });
  await persistRecordingMarker();
}

// Erases the current in-progress/paused/stopped-but-unsaved recording
// outright (business rule, 2026-08-07: editing or deleting the active
// Gateway/Docker Host abandons whatever recording is running, since the
// live data it was capturing no longer corresponds to a stable source --
// see confirmAbandonRecordingIfAny below). Overwrites the scratch file
// with nothing rather than leaving stale bytes for the next
// startRecording to silently build on (the fixed-path design otherwise
// merges onto whatever's already there, see flushRecordingSegment).
async function discardRecording() {
  if (recording.status === "idle") return;
  try {
    await writeRecordingBytes(recording.path, new Uint8Array(0));
  } catch {
    /* best-effort -- the state reset below still happens regardless */
  }
  setRecordingState({ status: "idle", path: null, segmentStart: null, segments: [] });
  await persistRecordingMarker();
  drawAll(); // clears the capture-range highlight immediately
  notifyEvent("Recording discarded");
}

// Gate for any action that edits or deletes the *active* Gateway/Docker
// Host: warns that doing so abandons an in-progress, paused, or
// stopped-but-not-yet-saved recording, and only proceeds (discarding it)
// if the user confirms. Returns true if the caller should continue with
// its own action, false if it should abort. A no-op (returns true
// immediately) when nothing is recording.
async function confirmAbandonRecordingIfAny(actionLabel) {
  if (recording.status === "idle") return true;
  if (!confirm(`${actionLabel} will abandon the recording currently in progress -- it has not been saved and will be disposed. Continue?`)) {
    return false;
  }
  await discardRecording();
  return true;
}

// Same pattern as pickAnalysisFiles/pickRecordingSavePath: a named wrapper
// around the native picker so tests can substitute canned paths.
async function pickRecordingFiles() {
  if (!window.cttc?.pickFiles) {
    const p = prompt("Path to a recorded .cttc-record file:");
    return p ? [p] : [];
  }
  return window.cttc.pickFiles("Open Recording", [
    { name: "CTTC recording", extensions: ["cttc-record"] },
  ]);
}

async function openRecording() {
  const paths = await pickRecordingFiles();
  // Same dedup as Load Data (btn-load-sample) -- without it, re-clicking
  // Open Recording on an already-open file re-uploads and opens a second,
  // fully independent set of sources every time (each now correctly
  // isolated in Redis, see LogSource._entity, so it's no longer a data
  // *collision*, just a needless, ever-growing pile of duplicate sources).
  const open = openPaths();
  const alreadyOpen = paths.filter((p) => p.endsWith(".cttc-record") && open.has(`upload://${basename(p)}`));
  const files = paths.filter((p) => p.endsWith(".cttc-record") && !open.has(`upload://${basename(p)}`));
  if (!files.length) {
    // Already open -- switch to it instead of silently doing nothing (see
    // btn-load-sample's matching comment/setActiveView/resetZoom).
    if (alreadyOpen.length) {
      setActiveView(`upload://${basename(alreadyOpen[alreadyOpen.length - 1])}`);
      resetZoom();
    }
    return;
  }
  try {
    const errors = [];
    const openedIds = [];
    for (const path of files) {
      const res = await uploadAndResolveSegment(path);
      errors.push(...(res.errors || []));
      openedIds.push(...(res.opened || []));
    }
    if (errors.length) alert(errors.map((e) => `${e.path}: ${e.error}`).join("\n"));
    if (!openedIds.length) {
      // Uploaded fine (no errors), but the recorded segment(s) held zero
      // rows for every source -- e.g. Stop was hit before any data had
      // actually arrived. Without this, the call below still forced a
      // switch into analysis mode with nothing in it, reading as "the
      // recording just vanished" (see BUG-0089).
      if (!errors.length) alert("No data found in the selected recording for its recorded time range.");
      return;
    }
    await refreshAll(); // also switches into analysis mode -- see setLiveHidden
    setActiveView(`upload://${basename(files[files.length - 1])}`);
    centerViewOnLoadedRange(openedIds);
  } catch (err) {
    alert(String(err.message || err));
  }
}

// Resume-choice prompt shown by recoverInterruptedRecording below (see
// ui-REC-019/br-ORPHAN-005, REQ-0067) -- declared here (used only inside
// that function and setRecordingState above) even though this file's
// script executes top-to-bottom and recoverInterruptedRecording() itself
// runs before window.onload; that's fine, since it's only ever invoked
// from an event handler, well after this whole script (and the DOM it
// queries) has finished loading -- same reasoning as recording/state
// being referenced by drawVerticals despite being declared later.
const dlgResumeChoice = $("dlg-recording-resume-choice");

// Crash recovery: if the app went down mid-recording (crash, force-quit,
// sleep/shutdown) without Pause/Stop ever running, the marker on disk
// still says "recording" -- surfacing that as-is would either silently
// resume timing a segment whose start may be long gone, or just as
// silently drop it. Instead, treat it exactly like a Pause already
// happened: no new segment is flushed (the data for it may not even exist
// anymore if the server itself restarted), just move to "paused" so the
// user can explicitly Resume or Stop from an honest state. A named
// function (not an inline IIFE) so it's callable again from tests.
async function recoverInterruptedRecording() {
  // ui-REC-019: captured once, right here, at recovery time -- not
  // re-read whenever the user actually clicks "Resume from now" below,
  // however long they take to decide, so the decision window itself
  // isn't silently absorbed into the resumed segment.
  const restartTime = Date.now();
  const marker = await getRecordingMarkerFromDisk();
  if (!marker) return;
  const wasInterrupted = marker.status === "recording";
  // A crash while already "stopped" (finalized, just waiting on the save
  // dialog -- see stopRecording) has nothing left to resume into: recover
  // straight back into "stopped" so Stop only needs to re-prompt for a
  // destination, not incorrectly reopen it as a resumable "paused"
  // recording (which would start a fresh segment on top of already-
  // finished data instead of just asking where to save it).
  setRecordingState({
    status: marker.status === "stopped" ? "stopped" : "paused",
    path: marker.path,
    segmentStart: null,
    // Whatever was already flushed (via a real Pause) before the crash --
    // markers written before this field existed just have none. The
    // segment that was actually in progress at crash time (if any) isn't
    // added here -- see the resume-choice prompt below, which is what
    // lets the user actually continue it instead.
    segments: marker.status === "stopped" ? [] : (marker.segments ?? []),
  });
  await persistRecordingMarker();
  if (wasInterrupted) {
    notifyEvent("A previous recording was interrupted and is now paused — Resume to continue, or Stop to finalize.");
    // ui-REC-019: offer an explicit choice instead of silently landing in
    // paused. marker.segmentStart -- the interrupted segment's original
    // start -- is only ever known right here, from this one stale marker
    // (persistRecordingMarker() above already wrote the live `recording`
    // state's own segmentStart back as null, like any ordinary paused
    // recording); dismissing this prompt loses it for good, same as
    // before this rule existed.
    if (marker.segmentStart != null) {
      $("dlg-recording-resume-choice-interruption").onclick = () => {
        dlgResumeChoice.close();
        // br-ORPHAN-005: no separate backfill call here -- resuming with
        // segmentStart pinned back to the original interruption point is
        // enough. The *next* Pause/Stop's existing, unmodified
        // flushRecordingSegment naturally asks Redis for the whole
        // [marker.segmentStart, thatTime) span, and Redis has been
        // collecting continuously the whole time regardless of this
        // feature's own state -- whatever genuinely survived (bounded by
        // sTTL, see br-REDIS-021) comes back for free; whatever didn't
        // stays a real, honest gap.
        startRecording(marker.segmentStart).then(() =>
          notifyEvent(`Resumed from the interruption point (continuing since ${new Date(marker.segmentStart).toLocaleString()})`)
        );
      };
      $("dlg-recording-resume-choice-now").onclick = () => {
        dlgResumeChoice.close();
        startRecording(restartTime).then(() => notifyEvent("Resumed from now — the interruption is left as a gap"));
      };
      $("dlg-recording-resume-choice-later").onclick = () => dlgResumeChoice.close();
      dlgResumeChoice.showModal();
    }
  } else if (marker.status === "stopped") {
    notifyEvent("A previous recording finished but wasn't saved yet — click Stop to choose where to save it.");
  }
}
recoverInterruptedRecording();

syncRecordingMenu();

$("btn-start-recording").onclick = () => startRecording();
$("btn-pause-recording").onclick = () => pauseRecording();
$("btn-stop-recording").onclick = () => stopRecording();
$("btn-open-recording").onclick = () => openRecording();

/* ── theme preferences (dlg-preferences' "Preferences" pane) ──────────────
   Reached via the sidebar's Appearance… button. Currently just the log-
   highlight color (the background + dotted top/bottom border painted on
   log rows within the sampling frequency window around the selected time — see
   Panel.render()'s "hl"/"hl-top"/"hl-bottom" classes). */

const DEFAULT_HL_COLOR = "#eaff00"; // light neon yellow
// Settings and Preferences (formerly two separate dialogs, dlg-settings and
// dlg-theme) now share one mac-System-Settings-style dialog with a left-hand
// pane list -- the dialog shell itself (dlgPreferences/openPreferencesDialog/
// selectPreferencesPane/openSettingsDialog/openThemeDialog) now lives in
// src/modules/preferences/ (PREF domain); every pane's own field wiring,
// including prefillPreferencesPane just below, stays here since each field
// previews/persists a variable actually owned by another domain (LIVE/CHART's
// rendering code, mostly) -- see that module for why.

function applyHlColor(color) {
  document.documentElement.style.setProperty("--hl-color", color);
}
applyHlColor(prefs.get("hlColor", DEFAULT_HL_COLOR));

// Live tracking's color drives both the canvas-drawn bar (liveTrackColor,
// a plain JS variable -- canvas needs an actual color string, see
// drawVerticals) and the log row highlight (the --live-track-color CSS
// var, see .hl-live in style.css) -- kept in sync by always setting both.
function applyLiveTrackColor(color) {
  liveTrackColor = color;
  document.documentElement.style.setProperty("--live-track-color", color);
}
applyLiveTrackColor(liveTrackColor);

// Light/Dark/System: unlike the highlight color, this takes effect (and
// persists) the moment you click it rather than waiting on Save/Cancel --
// nativeTheme.themeSource (see main.js) is process-wide, so it's set from
// here rather than gated behind this one dialog closing. Main window only:
// it's a single global switch, not something every popout needs to (re-)set.
const DEFAULT_THEME_MODE = "system";
function syncThemeModeButtons(mode) {
  for (const b of $("theme-mode-switch").querySelectorAll("button")) {
    b.dataset.active = String(b.dataset.mode === mode);
  }
}
function setThemeMode(mode) {
  prefs.set("themeMode", mode);
  window.cttc?.setThemeMode?.(mode);
  syncThemeModeButtons(mode);
}
if (!POPOUT_KIND) {
  for (const b of $("theme-mode-switch").querySelectorAll("button")) {
    b.onclick = () => setThemeMode(b.dataset.mode);
  }
  setThemeMode(prefs.get("themeMode", DEFAULT_THEME_MODE));
}

function syncNowStyleButtons(style) {
  for (const b of $("theme-now-style-switch").querySelectorAll("button")) {
    b.dataset.active = String(b.dataset.style === style);
  }
}

// Prefills the Preferences pane's fields from saved prefs -- called every
// time that pane is selected (see selectPreferencesPane), not just once at
// dialog-open, since the dialog itself now stays open across pane switches.
function prefillPreferencesPane() {
  $("theme-hl-color").value = prefs.get("hlColor", DEFAULT_HL_COLOR);
  $("theme-status-bar-toggle").checked = isStatusBarVisible();
  $("theme-now-color").value = prefs.get("nowLineColor", DEFAULT_NOW_COLOR);
  syncNowStyleButtons(prefs.get("nowLineStyle", DEFAULT_NOW_STYLE));
  $("theme-live-track-color").value = prefs.get("liveTrackColor", DEFAULT_LIVE_TRACK_COLOR);
  $("theme-recording-color").value = prefs.get("recordingBandColor", DEFAULT_RECORDING_COLOR);
  $("theme-recording-sprockets-toggle").checked = prefs.get("recordingSprocketHoles", true);
}
$("theme-hl-color").oninput = (e) => applyHlColor(e.target.value); // live preview
$("theme-now-color").oninput = (e) => { nowLineColor = e.target.value; drawAll(); }; // live preview
for (const b of $("theme-now-style-switch").querySelectorAll("button")) {
  b.onclick = () => { syncNowStyleButtons(b.dataset.style); nowLineStyle = b.dataset.style; drawAll(); };
}
$("theme-live-track-color").oninput = (e) => { applyLiveTrackColor(e.target.value); drawAll(); }; // live preview
$("theme-recording-color").oninput = (e) => { recordingBandColor = e.target.value; drawAll(); }; // live preview
$("theme-recording-sprockets-toggle").onchange = (e) => { recordingSprocketHoles = e.target.checked; drawAll(); }; // live preview
$("dlg-theme-reset").onclick = () => {
  $("theme-hl-color").value = DEFAULT_HL_COLOR;
  applyHlColor(DEFAULT_HL_COLOR);
  setThemeMode("light");
  $("theme-now-color").value = DEFAULT_NOW_COLOR;
  nowLineColor = DEFAULT_NOW_COLOR;
  syncNowStyleButtons(DEFAULT_NOW_STYLE);
  nowLineStyle = DEFAULT_NOW_STYLE;
  $("theme-live-track-color").value = DEFAULT_LIVE_TRACK_COLOR;
  applyLiveTrackColor(DEFAULT_LIVE_TRACK_COLOR);
  $("theme-recording-color").value = DEFAULT_RECORDING_COLOR;
  recordingBandColor = DEFAULT_RECORDING_COLOR;
  $("theme-recording-sprockets-toggle").checked = true;
  recordingSprocketHoles = true;
  drawAll();
};
$("dlg-theme-save").onclick = () => {
  const color = $("theme-hl-color").value;
  prefs.set("hlColor", color);
  applyHlColor(color);
  prefs.set("nowLineColor", nowLineColor);
  prefs.set("nowLineStyle", nowLineStyle);
  prefs.set("liveTrackColor", liveTrackColor);
  prefs.set("recordingBandColor", recordingBandColor);
  prefs.set("recordingSprocketHoles", recordingSprocketHoles);
  dlgPreferences.close();
};
$("dlg-theme-close").onclick = () => {
  applyHlColor(prefs.get("hlColor", DEFAULT_HL_COLOR)); // discard live preview
  nowLineColor = prefs.get("nowLineColor", DEFAULT_NOW_COLOR); // discard live preview
  nowLineStyle = prefs.get("nowLineStyle", DEFAULT_NOW_STYLE);
  applyLiveTrackColor(prefs.get("liveTrackColor", DEFAULT_LIVE_TRACK_COLOR)); // discard live preview
  recordingBandColor = prefs.get("recordingBandColor", DEFAULT_RECORDING_COLOR); // discard live preview
  recordingSprocketHoles = prefs.get("recordingSprocketHoles", true); // discard live preview
  drawAll();
  dlgPreferences.close();
};

// SBAR domain (status bar message/history/visibility toggle) now lives in
// src/modules/status-bar/ -- entry.ts assigns notifyEvent,
// notifyEventWithCap, flashStatus, setStatusBarVisible, isStatusBarVisible,
// clearStatusMessage, and statusBarHistory back onto window. mountStatusBar
// (the module's own DOM wiring -- history button/popup/clear, visibility
// toggle) is called from here, not from entry.ts itself: that bundle's
// script tag runs before this one, before `recording`/`prefs` exist yet.
window.mountStatusBar();

// "application starting"/"application shutting down" -- the earliest and
// latest things this window's own lifecycle can report in the status bar,
// bookending whatever real activity notifyEvent/flashStatus show in
// between. Main window only: popouts never show the status bar at all (see
// syncStatusBarVisibility's own `if (!POPOUT_KIND)` gate) and have no
// app-level lifecycle worth announcing -- closing one is just closing a
// panel, not the app going away. main.js only sends "app-shutting-down" to
// windows still open when an actual quit begins (Quit menu/button, Cmd+Q,
// Dock > Quit) -- see its before-quit handler.
if (!POPOUT_KIND) {
  // By the time this line runs the window's own markup/toolbar/sidebar are
  // already fully rendered (this is a synchronous script running against
  // already-parsed DOM; only the data behind it loads progressively
  // afterward), so notifyEventWithCap's 3s here is 3s past that render --
  // see its own docstring for why this needs a cap at all.
  notifyEventWithCap("application starting", 3000);
  window.cttc?.onAppShuttingDown?.(() => notifyEvent("application shutting down"));
}

// Docker host activity log rendering, container/service checklist, and
// listContainers (DHOST domain) now live in src/modules/docker-host/ --
// see entry.ts.

/* ── toolbar ────────────────────────────────────────────────────────────── */

// Settings' "Time window" field (formerly the toolbar's "Frequency" too,
// before that got repurposed below into the actual Docker poll interval) --
// the ± highlight window around the selected time. A zero-second window
// would highlight nothing (or everything, depending on how the ± compare is
// read) -- 1s is the smallest interval that still means something.
function setTimeWindowSecs(v) {
  const secs = Math.max(1, Math.floor(Number(v)) || 1);
  state.windowMs = secs * 1000;
  $("win-secs-sidebar").value = secs;
  for (const p of panels.values()) p.render();
}
// "input" (not "change") so it takes effect immediately as you type/adjust,
// rather than waiting for blur/Enter.
$("win-secs-sidebar").oninput = (e) => setTimeWindowSecs(e.target.value);

// No dedicated telemetry section/poll-interval field in Set/Edit Docker
// Host anymore -- it's the toolbar/Settings' own "Frequency" field now
// (see setDockerPollIntervalSecs below), applied to every Set/Update
// Docker Host submission (read by src/modules/docker-host/ as a bare
// identifier -- see shared/legacy-globals.ts).
let dockerPollIntervalSecs = prefs.get("dockerPollIntervalSecs", 5);

// The toolbar's "Frequency" field -- how often (seconds) Connect/Update
// Docker Host polls the daemon for stats/logs. Persisted so it survives
// restarts; applied to every future Connect/Update Docker Host submission
// (dockerPollIntervalSecs, used in the dlg-ok handler, src/modules/
// docker-host/set-dialog.ts). Doesn't push a live update to an already-open
// collector on its own -- Update Docker Host (Edit) is still what applies a
// changed interval to one already running (see server.py's
// _update_poll_interval).
function setDockerPollIntervalSecs(v) {
  const secs = Math.max(1, Math.floor(Number(v)) || 1);
  dockerPollIntervalSecs = secs;
  prefs.set("dockerPollIntervalSecs", secs);
  $("win-secs").value = secs;
}
$("win-secs").oninput = (e) => setDockerPollIntervalSecs(e.target.value);
setDockerPollIntervalSecs(dockerPollIntervalSecs); // apply the persisted value on load
if (!POPOUT_KIND) window.cttc?.onSetPollInterval?.((secs) => setDockerPollIntervalSecs(secs));

// Live tracking's own seconds field -- never positive (the future has no
// data to show yet, see liveTrackTick), persisted so it survives restarts.
function setLiveTrackSecs(v) {
  const secs = Math.min(0, Math.floor(Number(v)) || 0);
  liveTrackSecs = secs;
  prefs.set("liveTrackSecs", secs);
  $("live-track-secs").value = secs;
  $("live-track-secs-sidebar").value = secs;
}
setLiveTrackSecs(liveTrackSecs); // apply the persisted value to both fields on load
$("live-track-secs").oninput = (e) => setLiveTrackSecs(e.target.value);
$("live-track-secs-sidebar").oninput = (e) => setLiveTrackSecs(e.target.value);

// The switch turns Live tracking off entirely (liveTrackTick becomes a
// no-op) independent of whatever seconds offset is dialed in -- disabling
// the seconds field alongside it makes that "off" state visible, not just
// functionally inert.
function setLiveTrackEnabled(enabled) {
  liveTrackEnabled = enabled;
  prefs.set("liveTrackEnabled", enabled);
  $("live-track-toggle").checked = enabled;
  $("live-track-toggle-sidebar").checked = enabled;
  $("live-track-secs").disabled = !enabled;
  $("live-track-secs-sidebar").disabled = !enabled;
  // Turning tracking off must interrupt its own highlight, not just stop
  // moving it -- liveTrackTick() becoming a no-op above only freezes
  // state.cursorT/liveTrackCursor wherever they last were, so the "live"
  // highlight (log rows in hl-live, the chart's own live-track bar --
  // both driven off this same shared cursor) would otherwise linger
  // indefinitely. Only clears it when the highlight actually is the
  // live-tracking one (liveTrackCursor true) -- a manually-placed cursor
  // is left alone.
  if (!enabled && state.liveTrackCursor) {
    state.liveTrackCursor = false;
    state.cursorT = null;
    drawAll();
    for (const p of panels.values()) p.render();
  }
}
setLiveTrackEnabled(liveTrackEnabled); // apply the persisted value to both fields on load

// flashStatus (SBAR) now lives in src/modules/status-bar/ alongside
// notifyEvent -- see entry.ts.

// Flipping the switch back on while a double-click pause is still counting
// down (see recenterOn/updateLiveResumeUI) resumes live-follow immediately
// instead of waiting out the rest of the countdown; otherwise it's just the
// ordinary Live tracking on/off preference.
function onLiveTrackToggle(checked) {
  if (checked && !state.live && state.liveResumeAt) {
    goLive();
    flashStatus("Live tracking resuming", 5000);
  } else {
    setLiveTrackEnabled(checked);
  }
}
$("live-track-toggle").onchange = (e) => onLiveTrackToggle(e.target.checked);
$("live-track-toggle-sidebar").onchange = (e) => onLiveTrackToggle(e.target.checked);

// How long a double-click recenter (see recenterOn) pauses live-follow
// before it resumes on its own. Never negative; 0 means "stay paused until
// the user clicks now themselves".
function setDblclickResumeSecs(v) {
  const secs = Math.max(0, Math.floor(Number(v)) || 0);
  dblclickResumeSecs = secs;
  prefs.set("dblclickResumeSecs", secs);
  $("dblclick-resume-secs-sidebar").value = secs;
}
setDblclickResumeSecs(dblclickResumeSecs); // apply the persisted value on load
$("dblclick-resume-secs-sidebar").oninput = (e) => setDblclickResumeSecs(e.target.value);

// How long a non-persistent bottom status-bar message stays before
// auto-clearing -- see notifyEvent. Never below 1s (0 would mean "never
// actually show", not "clear immediately").
function setStatusBarClearSecs(v) {
  const secs = Math.max(1, Math.floor(Number(v)) || 1);
  statusBarClearSecs = secs;
  prefs.set("statusBarClearSecs", secs);
  $("status-bar-clear-secs-sidebar").value = secs;
}
setStatusBarClearSecs(statusBarClearSecs); // apply the persisted value on load
$("status-bar-clear-secs-sidebar").oninput = (e) => setStatusBarClearSecs(e.target.value);

$("dlg-settings-close").onclick = () => dlgPreferences.close();

// Settings > Danger > Hard Reset: closes every open source (stopping
// collection server-side, same as Remove Docker Host) and wipes every
// persisted UI preference (prefs' entire localStorage namespace -- track
// states, panelOrder, dockerHostKeys, sidebar dock/size, theme, the "now"
// line style, everything), then reloads to boot exactly like a brand-new
// install. A real confirm() (not a styled dialog) on purpose -- its
// blocking, plain-text, native-chrome nature reads as more serious than
// anything CTTC could style itself, matching how irreversible this is.
// kept as a plain function (like openSeriesPopout/openLogPopout above) so
// the E2E spec can stub the actual page navigation away
function reloadApp() {
  location.reload();
}
$("btn-hard-reset").onclick = async () => {
  if (!confirm("Hard Reset: this closes every open source, erases all saved CTTC preferences on this machine, and reloads the app. This cannot be undone. Continue?")) return;
  try {
    await Promise.all(state.sources.map((s) => post("/close", { id: s.id })));
  } catch (err) {
    // Don't let a close failure block the reset the user explicitly asked
    // for -- the local prefs wipe below is unconditional either way.
    console.error(err);
  }
  localStorage.clear();
  reloadApp();
};

// New/Edit/Uninstall Gateway dialogs (GATE domain) now live in
// src/modules/gateway/ -- see entry.ts.

// "Collect CTTC Own Logs" -- main.js owns the actual file writing (it's the
// only process that sees its own logs and the server subprocess's stderr),
// this just reflects/toggles that state. Turning it on always prompts for
// a directory (see main.js's set-log-collector-enabled), every time, not
// just the first; if that prompt is cancelled the switch flips back off
// rather than claiming to be on with nothing actually being written.
function syncLogCollectStatus(settings) {
  $("log-collect-toggle").checked = !!settings?.enabled;
  $("log-collect-status").textContent = settings?.dir ? `Folder: ${settings.dir}` : "";
}
if (!POPOUT_KIND) {
  window.cttc?.getLogCollectorSettings?.().then((settings) => settings && syncLogCollectStatus(settings));
  $("log-collect-toggle").onchange = async (e) => {
    const result = await window.cttc?.setLogCollectorEnabled?.(e.target.checked);
    syncLogCollectStatus(result);
  };
}

// Reassignable wrapper (window.cttc's own properties are read-only --
// contextBridge.exposeInMainWorld -- so tests substitute this instead;
// same reasoning as pickRecordingSavePath/getRecordingMarkerFromDisk above).
async function shipLogsViaMain() {
  return window.cttc?.shipLogs ? window.cttc.shipLogs() : null;
}

// "Ship logs": gathers local .cttc-log files + the gateway's own docker
// logs into one zip (main.js's "ship-logs", which also owns the Save
// dialog and the erase-afterward confirmation), then reports the outcome
// via the bottom status bar (a background-ish action, not unlike an event
// trigger, so it gets the same "did something happen" visibility there).
if (!POPOUT_KIND) {
  $("btn-ship-logs").onclick = async () => {
    try {
      const result = await shipLogsViaMain();
      if (!result) return;
      if (result.canceled) { notifyEvent("ship logs canceled"); return; }
      if (!result.ok) { notifyEvent(result.error || "could not ship logs"); return; }
      notifyEvent(`shipped ${result.fileCount} log file${result.fileCount === 1 ? "" : "s"} to ${result.path}` +
        (result.erased ? " (local .cttc-log files erased)" : ""));
    } catch (err) {
      notifyEvent("ship logs failed: " + (err.message || err));
    }
  };
}

// Events (EVT domain: create/edit/list dialogs, plus the UI-hosted
// evaluation engine) now live in src/modules/events/ -- see entry.ts.
// mountEvents() (which starts the evaluation loop) is called below,
// where the original setInterval registration used to run.
window.mountEvents();

$("btn-freq-help").onclick = () => window.cttc.openHelp("frequency");
$("btn-popout-telemetry").onclick = () => {
  state.poppedOut.add("telemetry");
  applyPopoutLayout();
  window.cttc.popout("telemetry", null, popoutView());
};
$("btn-popout-host").onclick = () => {
  state.poppedOut.add("host");
  drawAll();
  window.cttc.popout("host", null, popoutView());
};

// Lines vs histogram is per graph (state.chartStyle.svc / .host), not one
// global toggle -- each of Telemetry's and Host telemetry's own headers
// carries a single icon-only button (no label) that toggles and reflects
// its own graph's current style, left of that panel's own pop-out button.
const STYLE_ICON = {
  lines: '<svg viewBox="0 0 512.007 512.007" fill="currentColor" aria-hidden="true"><path d="M501.333,448.004H64V10.67c0-5.891-4.776-10.667-10.667-10.667S42.667,4.779,42.667,10.67v437.333 h-32C4.776,448.004,0,452.779,0,458.67c0,5.891,4.776,10.667,10.667,10.667h32v32c0,5.891,4.776,10.667,10.667,10.667 S64,507.228,64,501.337v-32h437.333c5.891,0,10.667-4.776,10.667-10.667C512,452.779,507.224,448.004,501.333,448.004z"/><path d="M96,426.67c-5.891-0.008-10.66-4.791-10.651-10.682c0.003-2.414,0.825-4.755,2.331-6.641 l85.333-106.667c1.887-2.374,4.695-3.832,7.723-4.011c3.032-0.187,5.997,0.949,8.128,3.115l33.003,33.024l56.96-94.955 c1.815-3.027,5.01-4.959,8.533-5.163c3.472-0.151,6.816,1.323,9.045,3.989l28.544,35.691L362.901,93.87 c1.217-5.764,6.877-9.45,12.641-8.232c2.025,0.428,3.881,1.435,5.343,2.899l55.296,55.296L492.8,68.27 c3.53-4.716,10.215-5.678,14.931-2.149s5.678,10.215,2.149,14.931c-0.004,0.006-0.009,0.012-0.013,0.017l-64,85.333 c-3.535,4.712-10.221,5.666-14.934,2.131c-0.399-0.299-0.777-0.627-1.13-0.979l-50.069-50.091L341.12,300.932 c-1.213,5.765-6.87,9.454-12.635,8.241c-2.423-0.51-4.593-1.847-6.138-3.782l-33.088-41.344l-56.107,93.504 c-3.006,5.066-9.55,6.737-14.616,3.731c-0.752-0.446-1.446-0.983-2.066-1.598l-34.133-34.133l-77.995,97.131 C102.312,425.209,99.242,426.677,96,426.67z"/><path d="M53.333,512.004c-5.891,0-10.667-4.776-10.667-10.667V10.67c0-5.891,4.776-10.667,10.667-10.667S64,4.779,64,10.67v490.667 C64,507.228,59.224,512.004,53.333,512.004z"/><path d="M501.333,469.337H10.667C4.776,469.337,0,464.561,0,458.67c0-5.891,4.776-10.667,10.667-10.667h490.667 c5.891,0,10.667,4.776,10.667,10.667C512,464.561,507.224,469.337,501.333,469.337z"/></svg>',
  bars: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="3" y="10" width="4.5" height="11" rx="1"/><rect x="9.75" y="5" width="4.5" height="16" rx="1"/><rect x="16.5" y="13" width="4.5" height="8" rx="1"/></svg>',
};
function syncStyleToggle(group) {
  const btn = $(group === "host" ? "btn-style-toggle-host" : "btn-style-toggle-svc");
  const style = state.chartStyle[group];
  // shows the icon for the style a click would switch *to*, matching the
  // order-toggle/live-toggle icon-swap pattern used elsewhere in the app.
  const next = style === "bars" ? "lines" : "bars";
  btn.innerHTML = STYLE_ICON[next];
  btn.title = `Switch to ${next === "bars" ? "histogram" : "line plot"} (currently ${style === "bars" ? "histogram" : "line plot"})`;
}
function setChartStyle(group, style) {
  state.chartStyle[group] = style;
  prefs.set("chartStyle", state.chartStyle);
  syncStyleToggle(group);
  drawAll();
}
$("btn-style-toggle-svc").onclick = () => setChartStyle("svc", state.chartStyle.svc === "bars" ? "lines" : "bars");
$("btn-style-toggle-host").onclick = () => setChartStyle("host", state.chartStyle.host === "bars" ? "lines" : "bars");

$("btn-host-toggle").onclick = () => {
  state.showHost = !state.showHost;
  prefs.set("showHost", state.showHost);
  drawAll();
};

$("btn-lanes-toggle").onclick = () => {
  state.showLanes = !state.showLanes;
  prefs.set("showLanes", state.showLanes);
  drawAll();
};

// #chart-block / #panels split (see style.css's rigid flex: 0 0 <pct>%,
// overridden here via inline style once a user actually drags this) --
// individual strip heights are no longer part of what this drags (see
// computeStripH: each graph now auto-fits whatever room its own container
// ends up with, shrinking/growing with it), so dragging this now changes
// how much of that room there *is*, between telemetry and the logs panel.
let chartSplitPct = prefs.get("chartSplitPct", 70);
function applyChartSplit() {
  $("chart-block").style.flexBasis = chartSplitPct + "%";
  panelsEl.style.flexBasis = 100 - chartSplitPct + "%";
}
applyChartSplit();

/* splitter: dragging down grows the charts, dragging up grows the logs panel */
$("splitter").addEventListener("mousedown", (e) => {
  e.preventDefault();
  $("splitter").classList.add("dragging");
  const startY = e.clientY, startPct = chartSplitPct;
  const layoutH = $("layout").clientHeight || 1;
  const move = (ev) => {
    chartSplitPct = Math.min(85, Math.max(15, startPct + ((ev.clientY - startY) / layoutH) * 100));
    applyChartSplit();
    drawAll();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    $("splitter").classList.remove("dragging");
    prefs.set("chartSplitPct", Math.round(chartSplitPct));
    scheduleSeriesFetch();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up, { once: true });
});

// Reflects analysis mode (state.liveHidden): swaps the
// toolbar's mode icon (live.svg <-> record.svg), shows/hides the Live data
// group vs. the Back to live tracking button, and re-renders so every live
// source's graphs/logs actually hide/reappear (see isLiveDataHidden).
// Doesn't touch which sources are open -- called automatically from
// refreshAll() based on whether any sample/recording source is actually
// present, so it always matches reality rather than only the instant a
// file finishes uploading.
// Set right before entering analysis mode so "Back to live tracking" can
// restore the exact prior view instead of leaving it wherever analysis
// mode happened to pan/zoom to -- see setLiveHidden below.
let savedLiveView = null; // {t0, t1, live}

function setLiveHidden(hidden) {
  const wasHidden = state.liveHidden;
  state.liveHidden = hidden;
  $("toolbar-mode-live").hidden = hidden;
  $("toolbar-mode-record").hidden = !hidden;
  $("live-data-group").hidden = hidden;
  // ui-REC-013: recording controls (Start/Pause/Stop/Open Recording) hide
  // along with the rest of the live-data controls while in analysis mode --
  // reversed from the earlier "stay visible regardless" fix, per explicit
  // user direction, since the app should read as fully in analysis mode,
  // not a hybrid.
  $("section-recording").hidden = hidden;
  $("btn-back-to-live").hidden = !hidden;
  $("btn-export-metrics").hidden = !hidden;
  // File > Export Metrics… mirrors the toolbar button's own availability,
  // disabled (not hidden -- it's a fixed menu, unlike the toolbar button
  // that only exists once a metrics file is loaded) while still in live mode.
  $("menu-export-metrics").disabled = !hidden;
  // Recording keeps capturing the live feed in the background regardless
  // of analysis mode -- if a metric/recording gets loaded while actively
  // recording, the status bar's mode icon must NOT swap to "Analysis
  // mode": leave it (and the recording dot/glyph/text right next to it)
  // exactly as-is instead of presenting a confusing hybrid state. Any
  // other message that still needs the status bar goes through
  // notifyEvent, which appends after a separator rather than replacing --
  // see its own docstring.
  if (recording.status !== "recording" && recording.status !== "paused") {
    $("status-bar-mode-live").hidden = hidden;
    $("status-bar-mode-record").hidden = !hidden;
  }
  if (hidden && !wasHidden) {
    // Entering analysis mode: remember the live view so returning to it
    // restores exactly this, rather than whatever analysis mode leaves it
    // panned/zoomed to.
    savedLiveView = state.view ? { t0: state.view.t0, t1: state.view.t1, live: state.live } : null;
    // Extremely hard rule: analysis mode is a static view centered on the
    // active sample's own range, not wherever Live happened to be looking
    // the instant it loaded (state.liveHidden is already true above, so
    // resetZoom()'s own activeViewRange() picks up the active sample; the
    // heartbeat's !state.liveHidden guard, above, is what then keeps it
    // static going forward).
    resetZoom();
  } else if (!hidden && wasHidden) {
    // Leaving analysis mode: restore the saved view (resuming live-follow
    // too, if it was on) rather than leaving the view stuck wherever
    // analysis mode was last panned/zoomed to. No saved view (e.g. the
    // very first transition) falls back to the normal "jump to now".
    if (savedLiveView) {
      state.live = savedLiveView.live;
      setView(savedLiveView.t0, savedLiveView.t1, { _follow: true });
      if (state.live) followNow();
    } else {
      goLive();
    }
    savedLiveView = null;
    // Any leftover analysis-mode notification (e.g. an upload error) has
    // no bearing on live mode -- clear it outright rather than waiting out
    // its own auto-clear timer. #status-bar-recording-text is a separate
    // element, untouched by this, so an actually-still-running recording's
    // own status is unaffected.
    clearStatusMessage();
  }
  // Back live -- #record-sections' own self-heal (refreshAll, above) only
  // fires once its tracked sources are actually gone, which isn't
  // necessarily true the instant this specific call happens (a caller
  // might flip liveHidden before closing them) -- clear it unconditionally
  // here too so it never lingers into a live view.
  if (!hidden) setActiveRecordSections(null);
  relist();
  syncPanels();
}

// Set by the user's own explicit "Back to Live" click, cleared by any
// explicit switch back into a file (including a no-op reupload's own
// setActiveView call) -- tells refreshAll()'s self-heal not to treat a
// sample still sitting open in the background as a reason to force
// analysis mode back on. See that self-heal's own comment for why this
// exists (ui-LIVE-016 regression fix).
let liveChosenWithSamplesStillOpen = false;

// The one entry point for "show exactly this, and nothing else" -- either
// "live" or one loaded file's path (sampleFileGroups()'s own g.path, the
// same value state.activeSamplePath and isSampleHidden compare against).
// Thin wrapper around setLiveHidden, which already owns every side effect
// of entering/leaving analysis mode (mode icon, recording controls,
// saved-view restore, #record-sections cleanup) -- this only adds *which*
// loaded file is the active one on top of that, and is safe to call even
// when the requested view is already the active one (setLiveHidden no-ops
// its own side effects when `hidden` doesn't actually change, but still
// re-renders, so switching between two already-open files still works).
function setActiveView(view) {
  liveChosenWithSamplesStillOpen = view === "live";
  if (view === "live") {
    setLiveHidden(false);
    return;
  }
  state.activeSamplePath = view;
  setLiveHidden(true);
}

// A thin wrapper around setActiveView("live"), same as switching to any
// other open file (ui-LIVE-016) -- does NOT close any loaded sample/
// recording source. Live collection, per its own docstring, was never
// stopped while viewing analysis mode, so there's nothing to "resume";
// closing loaded data the moment you leave it for Live would just
// discard state the user could still come back for via Opened Metrics.
$("btn-back-to-live").onclick = () => setActiveView("live");

/* ── boot ───────────────────────────────────────────────────────────────── */

buildStrips();
syncStyleToggle("svc");
syncStyleToggle("host");
applyPopoutLayout();
// main window: default view is the present, ± DEFAULT_SPAN/2. Popped-out
// panel windows inherit the opener's exact view/cursor from the URL, so they
// open on the same time range without resetting (or broadcasting) anything;
// they then track the opener via sync-broadcast.
if (!POPOUT_KIND) {
  goLive();
} else {
  const q = new URLSearchParams(location.search);
  const v0 = parseFloat(q.get("v0")), v1 = parseFloat(q.get("v1")), vc = parseFloat(q.get("vc"));
  if (Number.isFinite(v0) && Number.isFinite(v1)) {
    setView(v0, v1, { broadcast: false });
    if (Number.isFinite(vc)) setCursor(vc, { broadcast: false });
  }
  // no view handed over (shouldn't happen): the first refreshAll() falls
  // back to fitting the full available range
}
const chartsResizeObserver = new ResizeObserver(() => {
  scheduleSeriesFetch();
  drawAll();
});
chartsResizeObserver.observe(chartsEl);
chartsResizeObserver.observe(hostChartsEl);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);

// stay in sync with other windows (popped-out telemetry/log panels): mirror
// cursor moves and pan/zoom without re-broadcasting (avoids echo loops).
window.cttc?.onSync?.((msg) => {
  if (msg.type === "cursor") setCursor(msg.t, { broadcast: false, liveTrack: !!msg.liveTrack });
  else if (msg.type === "view") setView(msg.t0, msg.t1, { broadcast: false });
});

// a popped-out panel window was closed: bring its panel back into this window.
window.cttc?.onPopoutClosed?.(({ kind, id }) => {
  if (kind === "telemetry") state.poppedOut.delete("telemetry");
  else if (kind === "host") state.poppedOut.delete("host");
  else state.poppedOut.delete(id);
  applyPopoutLayout();
  drawAll();
  syncPanels();
});

// File menu actions (main.js's application menu; popped-out panel windows
// don't have the matching toolbar/dialogs wired up, so they ignore these).
if (!POPOUT_KIND) {
  window.cttc?.onMenuAction?.((action) => {
    if (action === "set-sources") $("btn-set").click();
    else if (action === "load-metrics") $("btn-load-sample").click();
    else if (action === "open-theme") openThemeDialog();
  });
}

/* ── custom menu bar (replaces the native OS menu — its row spacing can't
   be styled via CSS on either macOS or Windows) ─────────────────────────── */
{
  const menubar = $("menubar");
  if (IS_MAC) {
    for (const acc of menubar.querySelectorAll(".acc")) {
      acc.textContent = acc.textContent
        .replace(/Ctrl\+Shift\+/, "⇧⌘")
        .replace(/Ctrl\+/, "⌘");
    }
  }

  // File > Load Data…/Export Metrics… clone their icon from the
  // action-bar/toolbar button they duplicate (see ctxMenu's own icon
  // cloning above) so the menu can never drift out of sync with it.
  // #btn-load-sample is a sidebar button (icon wrapped in .ab-icon);
  // #btn-export-metrics is a plain toolbar .icon-btn (bare <svg>) --
  // either way, only the <svg> itself is cloned.
  for (const [menuId, sourceSel] of [["menu-load-metrics", "#btn-load-sample"], ["menu-opened-data", "#btn-opened-data"], ["menu-export-metrics", "#btn-export-metrics"]]) {
    const svg = document.querySelector(sourceSel)?.querySelector("svg");
    if (svg) {
      const iconEl = document.createElement("span");
      iconEl.className = "ctxmenu-icon";
      iconEl.appendChild(svg.cloneNode(true));
      $(menuId)?.querySelector(".menu-item-label")?.prepend(iconEl);
    }
  }

  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    openMenu.classList.remove("open");
    openMenu = null;
  }
  for (const menu of menubar.querySelectorAll(".menu")) {
    const label = menu.querySelector(".menu-label");
    label.onclick = () => {
      if (openMenu === menu) { closeMenu(); return; }
      closeMenu();
      menu.classList.add("open");
      openMenu = menu;
    };
    label.onmouseenter = () => {
      if (openMenu && openMenu !== menu) {
        closeMenu();
        menu.classList.add("open");
        openMenu = menu;
      }
    };
  }
  document.addEventListener("click", (e) => { if (!menubar.contains(e.target)) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

  const RENDERER_ACTIONS = {
    "set-sources": () => $("btn-set").click(),
    "clear-sources": () => $("btn-clear-sources").click(),
    "remove-docker-daemon": () => $("btn-remove-docker-daemon").click(),
    "load-metrics": () => $("btn-load-sample").click(),
    "opened-data": () => $("btn-opened-data").click(),
    "export-metrics": () => $("btn-export-metrics").click(),
    "new-gateway": () => openNewGatewayDialog(),
    "edit-gateways": () => openEditGatewaysDialog(),
    "uninstall-gateway": () => openUninstallGatewayDialog(),
    "event-create": () => $("btn-event-create").click(),
    "event-edit": () => $("btn-event-edit").click(),
    "open-theme": () => openThemeDialog(),
    "open-settings": () => openSettingsDialog(),
    // View > Actual Size (Ctrl/Cmd+0) otherwise only resets the browser
    // page's own zoom level (window.cttc.menubarAction, handled in main.js)
    // -- which does nothing to the timeline's pan/zoom. "Reset zoom"
    // reads as one action to a user, so it should also reset/recenter the
    // chart, not leave it wherever it was panned/zoomed to.
    "zoom-reset": () => {
      resetZoom();
      window.cttc?.menubarAction?.("zoom-reset");
    },
    undo: () => document.execCommand("undo"),
    redo: () => document.execCommand("redo"),
    cut: () => document.execCommand("cut"),
    copy: () => document.execCommand("copy"),
    paste: () => document.execCommand("paste"),
    "select-all": () => document.execCommand("selectAll"),
  };

  function runMenuAction(action) {
    closeMenu();
    const fn = RENDERER_ACTIONS[action];
    if (fn) fn();
    else window.cttc?.menubarAction?.(action); // about/reload/devtools/zoom/fullscreen/minimize/close/quit
  }

  menubar.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (btn) runMenuAction(btn.dataset.action);
  });

  // A detached action-bar window has no access to this document (it's a
  // separate renderer) -- it forwards its clicks here over IPC instead of
  // running them locally, so Undo/Redo/etc. still act on this window's own
  // content rather than the (empty) detached window's. Main window only --
  // main.js only ever forwards to the tracked mainWindow, but registering
  // this in every popout too would be pure dead weight.
  if (!POPOUT_KIND) window.cttc?.onRunAction?.(runMenuAction);

  /* ── dockable action bar (File/Edit/View/Window/Help as buttons,
     left/right/detached) -- main window only: popouts hide the
     bar entirely (see body[class*="popout-"] in style.css) and have no
     business opening/closing the shared detached-bar window themselves. */
  const appBody = $("app-body");
  const actionBar = $("action-bar");
  if (!POPOUT_KIND && appBody && actionBar) {
    actionBar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (btn) runMenuAction(btn.dataset.action);
    });

    // Top/bottom docking has been removed (left/right/detached only) --
    // clamps any dock value left over from before that change (persisted
    // prefs, or a redock request) so it doesn't get stuck referencing a
    // position with no button to reach it anymore.
    function clampDock(dock) {
      return dock === "top" || dock === "bottom" ? "left" : dock;
    }
    function setDock(dock) {
      dock = clampDock(dock);
      prefs.set("actionBarDock", dock);
      // Remembers the last real (non-detached) position separately, so
      // Redock can restore it -- "actionBarDock" alone would just say
      // "detached" once you've detached it, with nothing to go back to.
      if (dock !== "detached") prefs.set("actionBarLastDock", dock);
      appBody.dataset.dock = dock === "detached" ? "detached" : dock;
      for (const b of actionBar.querySelectorAll(".ab-dock-btn[data-dock-to]")) {
        b.dataset.current = String(b.dataset.dockTo === dock);
      }
      if (dock === "detached") window.cttc?.openActionBarWindow?.();
      else window.cttc?.closeActionBarWindow?.();
      updateCollapseToggleIcon();
      applyActionBarSize();
    }
    for (const b of actionBar.querySelectorAll(".ab-dock-btn[data-dock-to]")) {
      b.onclick = () => setDock(b.dataset.dockTo);
    }

    // Collapses the sidebar to a thin rail (full height for left/right dock,
    // full width for top/bottom -- see style.css) with just this one button
    // left to restore it, rather than removing it from the layout entirely.
    // The restore chevron always points "into" the content area, whichever
    // edge that is for the current dock, so it has to be recomputed on
    // every dock change too, not just when the collapsed state itself flips.
    const collapseToggle = $("ab-collapse-toggle");
    const COLLAPSE_ICON = { top: "▾", bottom: "▴", left: "▸", right: "◂" };
    const EXPAND_ICON = { top: "▴", bottom: "▾", left: "◂", right: "▸" };
    function updateCollapseToggleIcon() {
      const dock = appBody.dataset.dock === "detached" ? prefs.get("actionBarLastDock", "left") : appBody.dataset.dock;
      const collapsed = actionBar.dataset.collapsed === "true";
      collapseToggle.textContent = collapsed ? (EXPAND_ICON[dock] || "▸") : (COLLAPSE_ICON[dock] || "◂");
      collapseToggle.title = collapsed ? "Show sidebar" : "Hide sidebar";
    }
    function setActionBarCollapsed(collapsed) {
      prefs.set("actionBarCollapsed", collapsed);
      actionBar.dataset.collapsed = String(collapsed);
      updateCollapseToggleIcon();
      // The splitter drag sets an inline width/height (see applyActionBarSize
      // below) which, being inline, would otherwise keep winning over the
      // CSS rail-size rule for the collapsed state -- clear it collapsing,
      // restore it expanding.
      if (collapsed) {
        actionBar.style.width = "";
        actionBar.style.height = "";
      } else {
        applyActionBarSize();
      }
      applyActionBarSize();
    }
    collapseToggle.onclick = () => setActionBarCollapsed(actionBar.dataset.collapsed !== "true");

    // Drag-resize the sidebar via #action-bar-splitter (see style.css for
    // its positioning, which reuses the same row/row-reverse/column/
    // column-reverse trick #action-bar's own edge placement relies on).
    // Persisted per axis, not per dock direction, so switching left<->right
    // (or top<->bottom) keeps whatever size was set rather than resetting
    // it -- only collapsing (the rail's own fixed size, set in CSS) and
    // "detached" (no docked bar at all) skip applying it.
    const ACTION_BAR_MIN = 120, ACTION_BAR_MAX = 480;
    function applyActionBarSize() {
      if (actionBar.dataset.collapsed === "true") return;
      const dock = appBody.dataset.dock;
      if (dock === "left" || dock === "right") {
        actionBar.style.width = prefs.get("actionBarWidth", 210) + "px";
        actionBar.style.height = "";
      } else if (dock === "top" || dock === "bottom") {
        actionBar.style.height = prefs.get("actionBarHeight", 210) + "px";
        actionBar.style.width = "";
      }
    }
    const splitter = $("action-bar-splitter");
    splitter.addEventListener("mousedown", (e) => {
      const dock = appBody.dataset.dock;
      if (dock === "detached" || actionBar.dataset.collapsed === "true") return;
      e.preventDefault();
      splitter.classList.add("dragging");
      const rect = actionBar.getBoundingClientRect();
      const startX = e.clientX, startY = e.clientY, startW = rect.width, startH = rect.height;
      const clamp = (v) => Math.min(ACTION_BAR_MAX, Math.max(ACTION_BAR_MIN, v));
      const move = (ev) => {
        if (dock === "left") actionBar.style.width = clamp(startW + (ev.clientX - startX)) + "px";
        else if (dock === "right") actionBar.style.width = clamp(startW - (ev.clientX - startX)) + "px";
        else if (dock === "top") actionBar.style.height = clamp(startH + (ev.clientY - startY)) + "px";
        else if (dock === "bottom") actionBar.style.height = clamp(startH - (ev.clientY - startY)) + "px";
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        splitter.classList.remove("dragging");
        if (dock === "left" || dock === "right") prefs.set("actionBarWidth", parseInt(actionBar.style.width, 10));
        else prefs.set("actionBarHeight", parseInt(actionBar.style.height, 10));
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up, { once: true });
    });

    setDock(prefs.get("actionBarDock", "left"));
    setActionBarCollapsed(prefs.get("actionBarCollapsed", false));
    window.cttc?.onActionBarRedock?.(() => setDock(clampDock(prefs.get("actionBarLastDock", "left"))));

    // Collapsible sidebar sections (Gateway/Sources/Metrics/Preferences):
    // each starts collapsed (see index.html's .ab-group-body[hidden]) and
    // toggles open on its header click; which ones are open persists across
    // launches, keyed by data-section so reordering the sections in markup
    // doesn't scramble anyone's saved state.
    const SIDEBAR_EXPANDED_KEY = "sidebarExpandedSections";
    function setSidebarSectionExpanded(group, expanded) {
      const body = group.querySelector(".ab-group-body");
      if (!body) return;
      body.hidden = !expanded;
      group.dataset.expanded = String(expanded);
      const section = group.dataset.section;
      const state = prefs.get(SIDEBAR_EXPANDED_KEY, {});
      state[section] = expanded;
      prefs.set(SIDEBAR_EXPANDED_KEY, state);
    }
    const savedSidebarState = prefs.get(SIDEBAR_EXPANDED_KEY, {});
    for (const group of actionBar.querySelectorAll(".ab-group[data-section]")) {
      const header = group.querySelector(".ab-group-header");
      if (!header) continue;
      setSidebarSectionExpanded(group, !!savedSidebarState[group.dataset.section]);
      header.onclick = () => setSidebarSectionExpanded(group, group.dataset.expanded !== "true");
    }
  }

  // Accelerators for actions with no native browser default (edit shortcuts
  // like Ctrl+C/V/Z work out of the box in inputs/contenteditable and are
  // deliberately left alone here).
  const ACCELERATORS = {
    "mod+o": "set-sources",
    "mod+l": "load-metrics",
    "mod+r": "reload",
    f12: "toggle-devtools",
    "mod+=": "zoom-in",
    "mod+-": "zoom-out",
    "mod+0": "zoom-reset",
    f11: "toggle-fullscreen",
    "mod+m": "minimize",
    "mod+w": "close",
    "mod+q": "quit",
  };
  window.addEventListener("keydown", (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    if (["control", "meta", "shift", "alt"].includes(key)) return;
    const combo = mod ? `mod+${key}` : key;
    const action = ACCELERATORS[combo];
    if (action) {
      e.preventDefault();
      runMenuAction(action);
    }
  });
}


// Named (not inlined) so it's independently testable -- see the
// dialog-stacking regression test in test/renderer-spec.js.
function shouldPromptSetSourcesOnBoot() {
  // Still nothing open: prompt right away -- unless the crash-recovery
  // resume-choice prompt (recoverInterruptedRecording, ui-REC-019) is
  // already showing. Both are native <dialog>s opened via showModal();
  // stacking a second one on top silently buries the first (still "open"
  // in the DOM, but no longer visible or reachable) -- deliberately not
  // opened here in that case, rather than fixing it by closing/deferring
  // the *other* one, since the interrupted-recording choice is the more
  // consequential of the two and shouldn't be preempted by routine setup.
  return state.sources.length === 0 && !dlgResumeChoice.open;
}

// Named (not inlined) so it's independently testable. Reopens whatever
// containers/services were being collected last time (nothing else has
// opened anything yet -- see the only caller, below), and sets
// state.activeDockerHost to match -- the same funnel point as Set/Edit
// Docker Host's dlg-ok (br-DHOST-030). Without this, activeDockerHost
// stays whatever it last was (often "local" from a much earlier session),
// and if that stale local session also gets replayed here alongside a
// newer remote one (lastDockerSessions is undeduped and append-only, so
// both can coexist), refreshAll()'s self-heal treats "local" as a
// perfectly valid match and never corrects it -- silently hiding the
// remote host's containers/telemetry even though it's the one just
// (re)connected (regression found 2026-08-12).
async function autoReconnectLastDockerSessions() {
  const sessions = prefs.get("lastDockerSessions", []);
  if (!sessions.length) return;
  try {
    await Promise.all(sessions.map((req) => post("/docker/collect", req)));
    const lastHost = sessions[sessions.length - 1]?.host;
    state.activeDockerHost = lastHost || "local";
    prefs.set("activeDockerHost", state.activeDockerHost);
    await refreshAll();
  } catch { /* remembered host(s) unreachable; fall through */ }
}

refreshAll().then(async () => {
  if (POPOUT_KIND) return; // popout windows never restore/set sources on their own
  if (state.sources.length === 0) {
    // nothing open yet (fresh install, or the last session's sources are all
    // closed): try to reopen the containers/services collected last time.
    await autoReconnectLastDockerSessions();
  }
  if (shouldPromptSetSourcesOnBoot()) $("btn-set").click();
});
connectSSE();

// cRate (client-side refresh-rate throttle/clamp against the server's own
// sRate) now lives in src/shared/poll-rate/ -- see entry.ts. Called here,
// right after connectSSE() (whose onmessage now routes through
// throttledScheduleRefresh/onServerRateEvent, both from that module),
// rather than from entry.ts itself, for the same reason mountStatusBar is.
window.mountPollRate();

// GATE/DHOST pills (status bar) + their shared overlay-coordination now
// live in src/modules/gateway/ and src/modules/docker-host/ -- entry.ts
// assigns each module's exports back onto window; mountGateway/
// mountDockerHost (the pills' own DOM wiring) are called from here, not
// from entry.ts itself, for the same reason mountStatusBar is: that
// bundle's script tag runs before this one.
window.mountGateway();
window.mountDockerHost();


