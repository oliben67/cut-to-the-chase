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

// GET path (relative to the CTTC server, never the docker/ssh target -- see
// normalizeDockerHost below) -> parsed JSON body. Throws on any non-2xx.
async function get(path) {
  const r = await fetch(API + path, { headers: authHeaders() });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(API + path, { method: "POST", body: JSON.stringify(body || {}), headers: authHeaders() });
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
const MARGIN_L = 46, MARGIN_R = 8, AXIS_H = 20;
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

// bytes/sec -> the largest unit (GB/MB/kB/B) that keeps the number >= 1,
// one decimal place -- used for the NET strip's axis labels and tooltip.
function fmtBytes(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + " GB/s";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + " MB/s";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + " kB/s";
  return v.toFixed(0) + " B/s";
}
// epoch ms -> local wall-clock "HH:MM:SS" (optionally ".mmm"). Deliberately
// no date part -- every chart/log panel only ever shows one day at a time
// in practice, and the full ISO timestamp is still available via title/
// fmtIso() wherever precision actually matters (log row tooltips, snapshots).
function fmtClock(ms, withMs) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  let s = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (withMs) s += "." + p(d.getMilliseconds(), 3);
  return s;
}

/* ── categorical colors: fixed slot order, never cycled ─────────────────── */

const slotByName = new Map();
// The first 8 concurrent series get one of the theme's curated --series-N
// colors, assigned the first time a given series name is seen and never
// reassigned afterward (see assignColorSlots(), which seeds this map in a
// stable sort order so colors don't shuffle around as sources come and
// go). Past 8, every *additional* container still gets its own genuinely
// distinct, full-saturation color -- procedurally generated (golden-angle
// hue rotation, so consecutive slots are always maximally far apart in hue
// and never visually repeat, no matter how many containers there are) --
// rather than folding to --muted gray. Gray is reserved for containers that
// are actually disabled/not-selected (see legendItem's own "disabled"
// class) -- a live, selected container must never read as "disabled" just
// because it happened to be the 9th one.
const GENERATED_COLOR_SAT = 68;
function generatedSlotColor(slot) {
  const hue = (slot * 137.508) % 360; // golden angle -- maximally spread hues, never repeats
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const lightness = dark ? 62 : 42; // brighter on a dark background, darker on a light one -- same idea as the curated --series-N pairs
  return `hsl(${hue.toFixed(1)}, ${GENERATED_COLOR_SAT}%, ${lightness}%)`;
}
function colorFor(name) {
  if (!slotByName.has(name)) slotByName.set(name, slotByName.size);
  const slot = slotByName.get(name);
  if (slot >= 8) return generatedSlotColor(slot);
  const css = getComputedStyle(document.documentElement);
  return css.getPropertyValue(`--series-${slot + 1}`).trim();
}
// Read a CSS custom property (e.g. "--accent") off :root -- the single
// source of truth for every color used in canvas drawing, so charts follow
// the active light/dark theme automatically without their own duplicated
// palette.
function themeVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ── sample vs. live styling ───────────────────────────────────────────────
   ui-CHART-026 (see stay-the-course/sampled-vs-live-data.md, updated):
   a loaded .cttc-metric/.cttc-record sample's data is exactly as real as
   live data, just not still updating -- the main charts (lines/bars) draw
   it identically to live data, full color/saturation, no dashing. Log
   density lanes (a different, auxiliary chart element -- see
   ui-CHART-009) still hatch sample-sourced lanes; each *sample file*
   (source id) still gets its own gray level there so several loaded
   samples stay visually distinguishable from each other. */

const sampleSlotBySid = new Map();
function sampleSlot(sid) {
  if (!sampleSlotBySid.has(sid)) sampleSlotBySid.set(sid, sampleSlotBySid.size);
  return sampleSlotBySid.get(sid);
}
const SAMPLE_GRAY_LEVELS = [0.3, 0.45, 0.6, 0.75];

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
// that *isn't* the current active view (see setActiveView) -- exactly one
// loaded file's sources are ever shown at a time now, checked everywhere a
// sample-sourced series/lane/panel might need hiding.
function isSampleHidden(sid) {
  const src = state.sources.find((s) => s.id === sid);
  return !!(src && src.live === false && src.path !== state.activeSamplePath);
}
// The inverse of isSampleHidden: true for a *live* source while the app is
// in analysis mode (state.liveHidden) -- checked
// everywhere isSampleHidden is, so live and sample data hide symmetrically
// depending on which one the toolbar is currently focused on.
function isLiveDataHidden(sid) {
  return state.liveHidden && isLiveSid(sid);
}
// this sample file's dash rhythm for chart lines, keyed by its slot (see
// sampleSlot() above) so it stays the same across redraws/reorders.
function dashFor(sid) {
  return SAMPLE_DASH_PATTERNS[sampleSlot(sid) % SAMPLE_DASH_PATTERNS.length];
}
// "#rrggbb" -> [r, g, b] ints, or null if the string doesn't match (theme
// colors always do; this is just defensive against a malformed CSS value).
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec((hex || "").trim());
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}
// blend a series color toward neutral gray by this sample's own gray level
function grayedColor(hex, sid) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const frac = SAMPLE_GRAY_LEVELS[sampleSlot(sid) % SAMPLE_GRAY_LEVELS.length];
  const [r, g, b] = rgb.map((c) => Math.round(c + (136 - c) * frac));
  return `rgb(${r}, ${g}, ${b})`;
}
// diagonal hatch fill pattern, one per (color, sample) pair — used for
// histogram bars and density lanes belonging to a loaded sample
const hatchPatternCache = new Map();
function hatchPattern(ctx, color, sid) {
  const key = color + "|" + sid;
  let pattern = hatchPatternCache.get(key);
  if (pattern) return pattern;
  const size = 6;
  const pc = document.createElement("canvas");
  pc.width = pc.height = size;
  const pctx = pc.getContext("2d");
  pctx.strokeStyle = color;
  pctx.lineWidth = 1;
  pctx.beginPath();
  pctx.moveTo(0, size);
  pctx.lineTo(size, 0);
  pctx.stroke();
  pattern = ctx.createPattern(pc, "repeat");
  hatchPatternCache.set(key, pattern);
  return pattern;
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
      c.title = "Click: move cursor  ·  Drag: zoom to selection  ·  Right-click: zoom menu";
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
      return s.name === POPOUT_ID && !isSampleHidden(s.sid) && !isLiveDataHidden(s.sid);
    }
    if (group === "svc" && trackStateOf(s) !== "sel") return false;
    if (isSampleHidden(s.sid) || isLiveDataHidden(s.sid)) return false;
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
  const src = state.sources.find((s) => s.kind === "stats" && s.is_host);
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
  STRIPS.forEach((spec, i) => drawStrip(stripCanvases[i], spec, "svc", i === STRIPS.length - 1));
  if (hasHost && state.showHost && !hostBlockEl.hidden) {
    stripH = computeStripH(hostChartsEl);
    STRIPS.forEach((spec, i) => drawStrip(hostCanvases[i], spec, "host", i === STRIPS.length - 1));
  }
  if (state.showLanes) drawLanes();
  updateTimelineNav(chartNav);
  updateTimelineNav(hostNav);
}

function drawStrip(c, spec, group, isLast) {
  if (!c) return;
  const h = stripH + (isLast ? AXIS_H : 0);
  const ctx = sizeCanvas(c, h);
  const w = c.clientWidth, pw = plotWidth();
  ctx.clearRect(0, 0, w, h);

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

function drawVerticals(ctx, h) {
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
  if ((recording.status === "recording" || recording.status === "paused") && state.view) {
    const ranges = recording.segments.slice();
    if (recording.status === "recording" && recording.segmentStart != null) {
      ranges.push({ from: recording.segmentStart, to: Date.now() });
    }
    ctx.fillStyle = themeVar("--warning");
    ctx.globalAlpha = 0.15;
    for (const { from, to } of ranges) {
      const xLo = Math.max(MARGIN_L, Math.min(MARGIN_L + plotWidth(), tToX(from)));
      const xHi = Math.max(MARGIN_L, Math.min(MARGIN_L + plotWidth(), tToX(to)));
      if (xHi > xLo) ctx.fillRect(xLo, 0, xHi - xLo, h);
    }
    ctx.globalAlpha = 1;
  }
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
  let logs = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id) && !isLiveDataHidden(s.id));
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

let ctxEl = null;
function closeCtxMenu() {
  ctxEl?.remove();
  ctxEl = null;
}
// entries: [label, fn] or [label, fn, icon] -- icon, when given, is either
// a CSS selector for an existing action-bar button whose own .ab-icon
// markup gets reused (cloned) to the left of the label (so the menu's icon
// can never drift out of sync with the button it duplicates), or a raw
// "<svg ...>...</svg>" string for an entry with no corresponding button to
// clone from. The literal string "separator" in place of an entry renders
// a thin divider instead (see Current Status's own entries below for both).
// A selector-sourced entry also mirrors that button's own .disabled --
// same reasoning as the icon: the sidebar button is the single source of
// truth for whether the action is currently available, so the menu entry
// that duplicates it must never claim to be clickable when the original
// isn't (previously Edit Docker Host stayed clickable in the menu even
// with nothing connected, silently no-op'ing when clicked instead of
// reading as unavailable up front, same as its sidebar button already did).
// ownerId: opaque tag identifying which caller opened this menu (only the
// Gateway/Docker Host pills currently pass one, see syncPillPeerVisibility)
// -- left off entirely by the legend/chart-time menus, which don't care.
function ctxMenu(e, entries, ownerId) {
  e.preventDefault();
  e.stopPropagation();
  closeCtxMenu();
  ctxEl = document.createElement("div");
  ctxEl.id = "ctxmenu";
  if (ownerId) ctxEl.dataset.owner = ownerId;
  for (const entry of entries) {
    if (entry === "separator") {
      const sep = document.createElement("div");
      sep.className = "ctxmenu-sep";
      ctxEl.appendChild(sep);
      continue;
    }
    const [label, fn, icon] = entry;
    const b = document.createElement("button");
    let iconEl = null;
    let sourceBtn = null;
    if (icon?.startsWith?.("<svg")) {
      // Wrapped in a <span>, same shape as the cloned .ab-icon <span> below
      // -- keeps a single ".ctxmenu-icon svg" CSS rule working for both, and
      // avoids setting .className directly on the parsed <svg> itself
      // (SVGElement.className is a read-only SVGAnimatedString, unlike a
      // plain HTMLElement's).
      iconEl = document.createElement("span");
      iconEl.innerHTML = icon;
    } else {
      sourceBtn = icon && document.querySelector(icon);
      const abIcon = sourceBtn?.querySelector(".ab-icon");
      if (abIcon) iconEl = abIcon.cloneNode(true);
    }
    if (iconEl) {
      iconEl.className = "ctxmenu-icon";
      b.appendChild(iconEl);
    }
    const text = document.createElement("span");
    text.textContent = label;
    b.appendChild(text);
    if (sourceBtn?.disabled) {
      b.disabled = true;
    } else {
      b.onclick = () => { closeCtxMenu(); fn(); };
    }
    ctxEl.appendChild(b);
  }
  document.body.appendChild(ctxEl);
  const bb = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(e.clientX, innerWidth - bb.width - 6) + "px";
  ctxEl.style.top = Math.min(e.clientY, innerHeight - bb.height - 6) + "px";
}
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
  let all = allSvcSeries().filter((s) => !isSampleHidden(s.sid) && !isLiveDataHidden(s.sid));
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
  return (state.series?.services || []).some((s) => s.host);
}

// any currently open docker:// source tells us which host (and ssh key) to
// use if we need to start host-telemetry collection from the export dialog
function currentDockerHost() {
  for (const s of state.sources) {
    // hostkey itself is "local" or a full "ssh://user@host[:port]" (which
    // has its own slashes) -- a plain "up to the first slash" match would
    // truncate that down to just "ssh:".
    const m = /^docker:\/\/(local|ssh:\/\/[^/]+)\//.exec(s.path || "");
    if (m) return m[1] === "local" ? null : m[1];
  }
  return null;
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
    const params = new URLSearchParams({ from: t0, to: t1, include_host: opts.includeHost ? "1" : "0" });
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
  services = services.filter((s) => s.host || selected.has(s.name));
  services.sort((a, b) => (b.host - a.host) || a.name.localeCompare(b.name));

  let logs = [];
  if (includeLogs) {
    const logSources = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id) && !isLiveDataHidden(s.id));
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
      services: r.services.filter((s) => !isSampleHidden(s.sid) && !isLiveDataHidden(s.sid)),
    };
  }
  if (includeLogs) {
    const logSources = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id) && !isLiveDataHidden(s.id));
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

// Shared "time" context menu: capture metrics / take snapshot / zoom / reset,
// anchored on time `t`. Used both by right-clicking a chart (t = the point
// under the cursor) and by right-clicking selected log entries (t = the
// center of their timestamps). `onDone`, if given, runs once whichever
// action was picked (used to clear a log panel's selection afterwards).
function timeContextMenu(e, t, onDone) {
  const wrap = (fn) => () => { onDone?.(); fn(); };
  ctxMenu(e, [
    ["✂ Capture metrics", wrap(armSampleCapture)],
    ["📸 Take snapshot at this time", wrap(() => takeSnapshot(t))],
    ["🔍+ Zoom in here", wrap(() => zoomAt(t, 0.5))],
    ["🔍− Zoom out here", wrap(() => zoomAt(t, 2))],
    ["↺ Reset zoom", wrap(resetZoom)],
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
  for (const n of names) if (!slotByName.has(n)) slotByName.set(n, slotByName.size);
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

// One log source's virtual-scrolled panel: renders only the rows currently
// in (or just outside) the visible scroll viewport, fetching them from the
// server a PAGE (200 rows) at a time and caching pages by index for as long
// as the panel lives (see this.pages). Rows are always stored/fetched
// oldest-first; `reversed` only affects display order (see dataIndexAt/
// visualIndexOf) so index-based operations (cursor sync, search) never need
// to care which way the panel is currently sorted.
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
    const orderToggle = document.createElement("button");
    orderToggle.className = "icon-btn";
    const syncOrderToggle = () => {
      orderToggle.textContent = this.reversed ? "⬆" : "⬇";
      orderToggle.title = this.reversed
        ? "Showing newest entries first — click to show oldest first"
        : "Showing oldest entries first — click to show newest first";
    };
    syncOrderToggle();
    orderToggle.onclick = () => {
      this.reversed = !this.reversed;
      prefs.set("logNewestFirst", this.reversed);
      syncOrderToggle();
      this.body.scrollTop = 0;
      this.render();
    };
    const searchToggle = document.createElement("button");
    searchToggle.className = "icon-btn";
    searchToggle.textContent = "🔍";
    searchToggle.title = "Search this log";
    searchToggle.onclick = () => {
      this.searchBar.hidden = !this.searchBar.hidden;
      if (!this.searchBar.hidden) this.searchInput.focus();
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
    right.append(popout, close);
    if (POPOUT_KIND === "log") {
      const popback = document.createElement("button");
      popback.className = "popback btn-flat";
      popback.innerHTML =
        '<svg class="btn-flat-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
        '<path d="m12 2a9.95 9.95 0 0 0 -7 2.88v-1.88a1 1 0 0 0 -2 0v5a1 1 0 0 0 1 1h5a1 1 0 0 0 0-2h-3.2242a7.9872 7.9872 0 1 1 .2613 10.3335 1 1 0 1 0 -1.49 1.334 10 10 0 1 0 7.4529-16.6675z"/></svg>' +
        "Bring Back";
      popback.title = "Bring back into the main window";
      popback.onclick = () => window.close();
      right.append(popback);
    }
    headTop.append(name, this.sampleBadge);
    headControls.append(this.countEl, orderToggle, searchToggle, right);
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
      if (e.key === "Enter") { e.preventDefault(); this.find(!e.shiftKey); }
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
      (src.transforms?.length ? ` · ${src.transforms.join("+")}` : "");
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
    p.el.hidden = isSampleHidden(s.id) || isLiveDataHidden(s.id) || state.visible.get(s.name) === false;
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
    if (hasSample !== state.liveHidden) setLiveHidden(hasSample);
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
  if (!state.live || !liveTrackEnabled) return;
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
  es.onmessage = () => scheduleRefresh();
  es.onerror = () => notifyEvent("reconnecting to server…");
}

/* ── set-sources dialog (Docker) ────────────────────────────────────────── */

const dlg = $("dlg-set");

// SSH key actually used for each docker host reached via "Set Sources" --
// keyed the same way as source paths (host string, or "local"). Populated
// when a host is (re)connected from the dialog; follow-up /docker/collect
// calls for that same host (startTracking, exportSample) that don't go
// through the dialog reuse it instead of silently dropping back to null.
// Persisted via prefs (not just an in-memory Map): without this, restarting
// the app forgot every remote host's ssh key even though its docker
// collection itself is restored on launch, so "Edit Docker Host" ->
// Refresh silently fell back to no key at all and failed for any host that
// actually needs one.
class PersistedMap extends Map {
  constructor(prefKey) {
    super(Object.entries(prefs.get(prefKey, {})));
    this.prefKey = prefKey;
  }
  set(k, v) {
    super.set(k, v);
    prefs.set(this.prefKey, Object.fromEntries(this));
    return this;
  }
  delete(k) {
    const had = super.delete(k);
    if (had) prefs.set(this.prefKey, Object.fromEntries(this));
    return had;
  }
}
const dockerHostKeys = new PersistedMap("dockerHostKeys");

$("docker-ssh-key-browse").onclick = async () => {
  const paths = await window.cttc.pickFiles("Choose your SSH private key");
  if (paths.length) $("docker-ssh-key").value = paths[0];
};

// names of the transform checkboxes ticked in Set Sources, in DOM order --
// sent as-is to /docker/collect, which loads and applies them server-side.
function chosenTransforms() {
  return [...dlg.querySelectorAll("#transforms-list input:checked")].map((i) => i.value);
}

// A target that is already being collected can only be selected once: its
// checkbox is disabled while the matching source is open.
function openPaths() {
  return new Set(state.sources.map((s) => s.path));
}

// Whether Fetch has successfully listed the host currently typed into
// Docker host -- until it has, every control it would otherwise toggle
// must stay disabled regardless, since nothing meaningful can be set until
// Fetch has shown what's actually on the host.
let dockerFormFetched = false;

// Whether a Fetch/Refresh attempt has completed at least once for the
// *current* dialog session, success or failure -- unlike dockerFormFetched
// (success only, gates the checklist), this gates Show activity: a failed
// attempt still has an activity log worth seeing (arguably more worth
// seeing than a successful one), so it shouldn't stay locked out just
// because the connection didn't work. Reset on every dialog open (see
// btn-set's create and edit-mode branches), set in listContainers()'s finally.
let dockerFetchAttempted = false;

// Show activity has nothing to show until a remote target has actually
// been probed (br-DHOST-001/BUG-0067) -- but an empty Docker host is a
// complete, valid target on its own (the gateway's local daemon, nothing
// to type), so it's exempt: only a *non-empty* host with no fetch attempt
// yet counts as "not entered". Deliberately disables rather than hides --
// ui-DHOST-016 ("Show activity always visible") is about the control never
// disappearing, not about it always being clickable.
function syncActivityToggleEnabled() {
  const remoteNotYetTested = $("docker-host").value.trim() !== "" && !dockerFetchAttempted;
  $("activity-toggle").disabled = remoteNotYetTested;
  if (remoteNotYetTested) {
    $("activity-toggle").checked = false;
    $("docker-activity").hidden = true;
  }
}
$("docker-host").addEventListener("input", syncActivityToggleEnabled);

// Whether the dialog is currently in "Edit Docker Host" mode -- listContainers()'s
// finally-block needs this so a Refresh doesn't unlock the host/ssh-key
// fields that Edit mode deliberately locked (see enterDockerHostEditMode
// below): Fetch (create mode) and Refresh (edit mode) share the exact same
// listContainers() function, so the difference has to be tracked here
// rather than duplicated per-caller.
let dockerDaemonEditMode = false;

// No dedicated telemetry section/poll-interval field in Set/Edit Docker
// Host anymore -- it's the toolbar/Settings' own "Frequency" field now
// (see setDockerPollIntervalSecs further down), applied to every Set/
// Update Docker Host submission.
let dockerPollIntervalSecs = prefs.get("dockerPollIntervalSecs", 5);

// Transform names (see server/transforms/*.py) ticked by default in the
// transforms checklist -- see listContainers()'s Fetch/Refresh handler.
const DEFAULT_ON_TRANSFORMS = new Set(["json_message", "parse_level"]);

// The durable "which containers/services were actually selected" record
// for whatever host is currently open in the dialog -- read from
// ~/.cttc/[user]@[gateway]-containers.json (see lib/container-selection.js)
// the moment Edit Docker Host opens, and what the checklist's checked
// defaults/missing-detection are driven by from then on (not state.track,
// which is a this-session-only, in-memory legend concern). Reset to empty
// by Connect Docker Host -- a fresh daemon starts with nothing preselected,
// never carrying over a stale file from some earlier, unrelated session.
let selectedTargets = { containers: new Set(), services: new Set() };

// Thin, individually stubbable wrappers around the IPC calls (see
// preload.js) -- kept as plain reassignable functions, same reasoning as
// openSeriesPopout/openLogPopout/reloadApp above, so the E2E spec can stub
// the actual file I/O without writing to a real ~/.cttc/ directory.
async function loadSelectedTargets(hostKey) {
  try {
    const r = await window.cttc?.getSelectedContainers?.(hostKey);
    return { containers: new Set(r?.containers || []), services: new Set(r?.services || []) };
  } catch (err) {
    console.error("loading selected containers failed:", err);
    return { containers: new Set(), services: new Set() };
  }
}
async function saveSelectedTargets(hostKey, { containers, services }) {
  try {
    await window.cttc?.setSelectedContainers?.(hostKey, { containers, services });
  } catch (err) {
    console.error("saving selected containers failed:", err);
  }
}

// Every daemon ever successfully Set/Updated (see savedDockerDaemons' write
// site further down), newest-used first -- backs both the "Load Docker
// Host" dropdown here and the Remove Docker Host picker.
function dockerHostHistory() {
  const saved = prefs.get("savedDockerDaemons", {});
  return Object.entries(saved)
    .map(([hostKey, entry]) => ({ hostKey, ...entry }))
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
}

// Fills the Connect Docker Host dialog's "Load Docker Host" dropdown --
// hidden entirely (rather than just empty) when there's no history yet, so
// a first-time user isn't shown a picker with nothing useful in it.
function populateDockerHostHistory() {
  const history = dockerHostHistory();
  $("docker-host-history-row").hidden = history.length === 0;
  const select = $("docker-host-history");
  select.innerHTML = '<option value="">— pick a previously used Docker host —</option>';
  for (const entry of history) {
    const opt = document.createElement("option");
    opt.value = entry.hostKey;
    opt.textContent = entry.hostKey === "local" ? "localhost" : entry.hostKey.replace(/^ssh:\/\//, "");
    select.appendChild(opt);
  }
  select.value = "";
}

// Picking a previously-used Docker host here now does what a separate Edit
// Docker Host button used to, for a *disconnected* one: pre-fills its ssh
// key and whatever containers/services it last had selected, then
// immediately re-probes it live. Host/ssh-key stay editable here (unlike
// enterDockerHostEditMode below) since nothing is actually connected yet --
// there's no live identity that needs protecting from being changed.
$("docker-host-history").onchange = async () => {
  const hostKey = $("docker-host-history").value;
  if (!hostKey) return;
  const entry = dockerHostHistory().find((e) => e.hostKey === hostKey);
  if (!entry) return;
  $("docker-host").value = hostKey === "local" ? "" : hostKey.replace(/^ssh:\/\//, "");
  $("docker-ssh-key").value = entry.ssh_key || "";
  // Loading a *different* saved host supersedes whatever the current
  // dialog session already fetched (if anything) -- that answer was for the
  // host just replaced, not this one.
  dockerFetchAttempted = false;
  selectedTargets = await loadSelectedTargets(hostKey);
  const { containers, services } = currentlyTrackedTargets(hostKey);
  renderDockerTargets(containers, services, hostKey);
  syncActivityToggleEnabled();
  await listContainers();
};

// Every control except Docker host / SSH key / Fetch starts empty and
// disabled -- there's nothing to configure until Fetch has actually shown
// what's running on the host currently typed in (see setDockerFormEnabled),
// so nothing here is populated or enabled speculatively. Always opens a
// blank create form, regardless of whatever else is already connected --
// multiple Docker hosts can be tracked at once (dlg-ok only ever closes
// sources for the *same* hostKey being submitted), so this never needs to
// disconnect anything first. No "Load Docker Host" picker here (that's
// specifically Edit Docker Host's job, see enterDockerHostEditMode) --
// picking an existing host to reconnect/reconfigure means Edit, not New.
function openNewDockerHostDialog() {
  dockerDaemonEditMode = false;
  // A fresh daemon starts with nothing preselected -- never carries over
  // some earlier, unrelated host's persisted selection.
  selectedTargets = { containers: new Set(), services: new Set() };
  $("docker-host").value = "";
  $("docker-host").disabled = false;
  $("docker-ssh-key").value = "";
  $("docker-ssh-key").disabled = false;
  $("docker-ssh-key-browse").disabled = false;
  $("dlg-set-title").textContent = "New Docker Host";
  $("btn-ps-refresh-label").textContent = "Fetch Sources";
  $("dlg-ok").textContent = "Connect Docker Host";
  $("docker-targets").innerHTML = "";
  $("transforms-list").innerHTML = "none found in server/transforms/";
  $("docker-error").textContent = "";
  setDockerFormEnabled(false);
  renderActivityLog(null);
  dockerFetchAttempted = false;
  syncActivityToggleEnabled();
  // Still populates the underlying <select>'s options (some callers drive
  // it programmatically, see the Docker Host pill's openHost) -- only the
  // row itself stays hidden, since New Docker Host never shows this picker.
  populateDockerHostHistory();
  $("docker-host-history-row").hidden = true;
  dlg.showModal();
}
$("btn-set").onclick = openNewDockerHostDialog;

// No-op with nothing connected (ui-DHOST-025) -- there's nothing to edit
// yet; use New Docker Host instead.
async function openEditDockerHostDialog() {
  if (!hasDockerDaemon()) return;
  dlg.showModal();
  await enterDockerHostEditMode(currentDockerHost() || "local");
}

// Reopens the dialog pre-pointed at hostKey -- host and ssh key are locked
// (this is "reconfigure/refresh what's already set", editing which
// containers/services are followed for an already-identified host, not
// its connection string itself), and Fetch becomes Refresh, since it's
// re-probing a known daemon rather than connecting to a new one. Load
// Docker Host stays visible+enabled here too (unlike before) -- picking a
// different saved host from it re-targets the checklist to that host, but
// never unlocks host/ssh-key: still Edit, just editing a different host's
// checklist now, not its connection string either. Submitting still goes
// through the same dlg-ok handler as the create flow, disabled inputs'
// .value reads normally.
async function enterDockerHostEditMode(hostKey) {
  dockerDaemonEditMode = true;
  populateDockerHostHistory();
  $("docker-host").value = hostKey === "local" ? "" : hostKey.replace(/^ssh:\/\//, "");
  $("docker-host").disabled = true;
  $("docker-ssh-key").value = dockerHostKeys.get(hostKey) || "";
  $("docker-ssh-key").disabled = true;
  $("docker-ssh-key-browse").disabled = true;
  $("dlg-set-title").textContent = "Edit Docker Host";
  $("btn-ps-refresh-label").textContent = "Refresh Sources";
  $("dlg-ok").textContent = "Update Docker Host";
  $("transforms-list").innerHTML = "none found in server/transforms/";
  $("docker-error").textContent = "";
  // The durable "what was actually selected" record for this daemon --
  // loaded before anything renders, since it (not state.track) is what
  // drives the checklist's checked defaults and "gone but was selected"
  // detection from here on (see renderDockerTargetGroup/renderDockerTargets).
  selectedTargets = await loadSelectedTargets(hostKey);
  // Pre-fill the checklist immediately from what's already being followed
  // for this daemon -- editing shouldn't start from a blank form while the
  // Refresh below is still in flight.
  const { containers, services } = currentlyTrackedTargets(hostKey);
  renderDockerTargets(containers, services, hostKey);
  setDockerFormEnabled(true);
  renderActivityLog(null);
  dockerFetchAttempted = false;
  syncActivityToggleEnabled();
  // Edit Docker Host always opens onto the daemon's *actual* current
  // state, not a snapshot from whenever it was last set -- run the same
  // live probe Refresh does immediately, so a container that's since
  // disappeared is caught (and disabled in the list, see
  // renderDockerTargets' closeMissing) right away rather than only after
  // the user remembers to click Refresh themselves.
  await listContainers();
}

// Toggles every "what to collect" control except Docker host/SSH key/Fetch
// itself -- there's nothing meaningful to set until Fetch has shown what's
// actually on the host, and re-fetching (a different host, or the same one
// after it changed) means the previous answer no longer applies either.
function setDockerFormEnabled(enabled) {
  dockerFormFetched = enabled;
  // "unavailable" checkboxes (renderDockerTargetGroup's `missing`) stay
  // disabled regardless -- they're not something Fetch/Refresh finishing
  // should ever re-enable, since there's nothing left to actually follow.
  for (const cb of $("docker-targets").querySelectorAll("input")) {
    if (!cb.closest("label")?.classList.contains("unavailable")) cb.disabled = !enabled;
  }
  for (const cb of $("transforms-list").querySelectorAll("input")) cb.disabled = !enabled;
  updateDlgOkEnabled();
}

// Set/Update Docker Host submits exactly what's checked (see dlg-ok's
// onclick) -- with nothing ticked there'd be nothing to collect at all, so
// it stays disabled until at least one container/service is actually
// checked, on top of the Fetch/Refresh-gated enabling above. Re-checked
// on every checkbox change (see renderDockerTargetGroup) and every
// checklist re-render (see renderDockerTargets), not just once on Fetch.
function updateDlgOkEnabled() {
  const anyChecked = $("docker-targets").querySelector("input:checked:not(:disabled)") != null;
  $("dlg-ok").disabled = !dockerFormFetched || !anyChecked;
}

// Closes every open source for the currently-connected daemon and drops it
// from the auto-reconnect-on-launch list (lastDockerSessions), so it
// doesn't silently come right back next launch -- but keeps its entry in
// savedDockerDaemons, so it still shows up in Load Docker Host (Connect
// Docker Host) and Remove Docker Host. "Disconnect", not "forget" -- use
// Remove Docker Host for that.
$("btn-clear-sources").onclick = async () => {
  if (!state.sources.length) return; // nothing to clear -- no point asking
  if (!confirm(`Close all ${state.sources.length} open source${state.sources.length === 1 ? "" : "s"}? You can reconnect it later via Load Docker Host.`)) return;
  const hostKey = currentDockerHost() || "local";
  try {
    await Promise.all(state.sources.map((s) => post("/close", { id: s.id })));
    const sessions = prefs.get("lastDockerSessions", []);
    prefs.set("lastDockerSessions", sessions.filter((s) => (s.host || "local") !== hostKey));
    await refreshAll();
  } catch (err) {
    alert(String(err.message || err));
  } finally {
    // #dlg-set is a showModal() dialog -- it's structurally impossible to
    // reach this handler while it's open (the modal blocks the toolbar), so
    // there's nothing to close here. What's real: dockerDaemonEditMode (and
    // the host/ssh-key/browse .disabled flags it drives) is set by whichever
    // branch of btn-set the dialog was *last* opened into (create mode or
    // enterDockerHostEditMode), and only ever reset when *opened*, not when
    // it's closed -- so a Cancel or successful submit out of Edit mode
    // leaves it true. Disconnect is exactly the moment that
    // staleness stops being harmless: the daemon it was tracking is gone,
    // so unconditionally clearing it here -- in a `finally`, not just after
    // a successful `await` -- guarantees the *next* open, whichever button
    // reaches it, never inherits a stale lock, even if closing a source (a
    // remote host is often disconnected precisely because it's flaky) or
    // refreshAll() itself failed (br-DHOST-001/BUG-0067, BUG-0069 -- this
    // used to be a `dlg.open`-gated partial reset that could never actually
    // run, then a reset that only ran on the happy path).
    dockerDaemonEditMode = false;
    $("docker-host").disabled = false;
    $("docker-ssh-key").disabled = false;
    $("docker-ssh-key-browse").disabled = false;
  }
};

/* ── Remove Docker Host: permanently forget a saved daemon ─────────────
   Distinct from Disconnect (above), which only stops it from auto-
   reconnecting -- this deletes it from savedDockerDaemons, its ssh-key
   mapping, and its ~/.cttc/[user]@[gateway]-containers.json selection file
   on disk, per host, picked from a dropdown of every daemon ever saved. */

const dlgRemoveDaemon = $("dlg-remove-daemon");

function populateRemoveDaemonSelect() {
  const history = dockerHostHistory();
  const select = $("remove-daemon-select");
  select.innerHTML = '<option value="">— pick a Docker host to remove —</option>';
  for (const entry of history) {
    const opt = document.createElement("option");
    opt.value = entry.hostKey;
    opt.textContent = entry.hostKey === "local" ? "localhost" : entry.hostKey.replace(/^ssh:\/\//, "");
    select.appendChild(opt);
  }
  select.value = "";
  $("dlg-remove-daemon-delete").disabled = true;
  $("remove-daemon-status").textContent = "";
}
$("btn-remove-docker-daemon").onclick = () => {
  populateRemoveDaemonSelect();
  dlgRemoveDaemon.showModal();
};
$("remove-daemon-select").onchange = () => {
  $("dlg-remove-daemon-delete").disabled = !$("remove-daemon-select").value;
};
$("dlg-remove-daemon-close").onclick = () => dlgRemoveDaemon.close();
$("dlg-remove-daemon-delete").onclick = async () => {
  const hostKey = $("remove-daemon-select").value;
  if (!hostKey) return;
  if (!confirm(`Permanently forget the saved daemon "${hostKey === "local" ? "localhost" : hostKey}"? This can't be undone.`)) return;
  // If it's currently connected, close it first -- leaving it running while
  // its saved record vanishes would be a dangling, un-editable, un-
  // reconnectable daemon.
  const activeHostKey = currentDockerHost() || "local";
  if (activeHostKey === hostKey && state.sources.length) {
    await Promise.all(state.sources.map((s) => post("/close", { id: s.id })));
    await refreshAll();
  }
  // br-REDIS-017: forgets the server-side Redis registry entry too, not
  // just this client's own local catalog above -- without this, a remote
  // daemon removed here (even one not currently connected) was silently
  // re-collected forever on the gateway's own next restart (see
  // redis_log.RedisLog.known_daemons()'s replay). "local" is never
  // remembered server-side in the first place (see collect_docker), so
  // there's nothing to forget for it.
  if (hostKey !== "local") {
    try {
      await post("/docker/forget", { host: hostKey });
    } catch (err) {
      console.error("could not forget daemon on the server:", hostKey, err);
    }
  }
  const saved = prefs.get("savedDockerDaemons", {});
  delete saved[hostKey];
  prefs.set("savedDockerDaemons", saved);
  const sessions = prefs.get("lastDockerSessions", []);
  prefs.set("lastDockerSessions", sessions.filter((s) => (s.host || "local") !== hostKey));
  dockerHostKeys.delete(hostKey);
  try {
    await window.cttc?.deleteSelectedContainers?.(hostKey);
  } catch (err) {
    console.error("could not delete saved container selection for", hostKey, err);
  }
  syncDockerDaemonButtons();
  dlgRemoveDaemon.close();
};

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
  setActiveRecordSections({ path, segments, activeIndex: index, openedIds: res.opened || [] });
  await refreshAll();
  // Without this, the view stays wherever it was left (the *previous*
  // segment's own window) -- refreshAll() only ever sets an initial view
  // when none exists yet (see its own "!hadView" check), so switching to a
  // segment recorded at a different point in time left its data outside
  // the visible window entirely: it looked empty even though it loaded
  // correctly (BUG-0077).
  centerViewOnLoadedStart(res.opened || []);
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

// Centers the view on the earliest min_ts among just-opened sources,
// instead of resetZoom()'s "fit the combined range" -- recording keeps
// ingesting live data in the background regardless of what's shown (see
// ui-REC-013), so the combined /range can span from the loaded file's own
// history all the way to "now", making the file itself look like a sliver
// (or vice versa) rather than showing what was actually just loaded.
// Reads from state.sources (already refreshed by the caller's own
// refreshAll(), which is /sources-backed and so already carries min_ts).
function centerViewOnLoadedStart(openedIds) {
  const opened = new Set(openedIds);
  const starts = state.sources
    .filter((s) => opened.has(s.id) && s.min_ts != null)
    .map((s) => s.min_ts);
  if (!starts.length) return;
  const start = Math.min(...starts);
  setView(start - DEFAULT_SPAN / 2, start + DEFAULT_SPAN / 2);
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
    // setActiveView).
    if (alreadyOpen.length) setActiveView(`upload://${basename(alreadyOpen[alreadyOpen.length - 1])}`);
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
    await refreshAll(); // also switches into analysis mode -- see setLiveHidden
    setActiveView(`upload://${basename(files[files.length - 1])}`);
    centerViewOnLoadedStart(openedIds);
  } catch (err) {
    alert(String(err.message || err));
  }
};

/* ── Opened Data: switch the active view to one of the currently open
   metric/recording files (see #btn-opened-data in the sidebar, and
   #menu-opened-data in the File menu) -- purely a visibility flip via
   setActiveView (sampleFileGroups(), same list Load Data's own
   already-open dedup above draws from), no re-picking/re-uploading. */
const dlgOpenedData = $("dlg-opened-data");

function populateOpenedDataSelect() {
  const select = $("opened-data-select");
  const groups = sampleFileGroups();
  select.innerHTML = "";
  if (!groups.length) {
    const opt = document.createElement("option");
    opt.textContent = "No files currently open";
    opt.disabled = true;
    select.appendChild(opt);
    select.disabled = true;
    $("dlg-opened-data-open").disabled = true;
    return;
  }
  select.disabled = false;
  for (const g of groups) {
    const opt = document.createElement("option");
    opt.value = g.path;
    opt.textContent = basename(g.path);
    select.appendChild(opt);
  }
  // Pre-selects the active view's own file when it's one of these -- Live
  // (or a hidden-in-background file that isn't the active view) falls back
  // to the first entry instead of leaving the select on nothing.
  select.value = groups.some((g) => g.path === state.activeSamplePath) ? state.activeSamplePath : groups[0].path;
  $("dlg-opened-data-open").disabled = false;
}
$("btn-opened-data").onclick = () => {
  populateOpenedDataSelect();
  dlgOpenedData.showModal();
};
$("dlg-opened-data-cancel").onclick = () => dlgOpenedData.close();
function openSelectedOpenedData() {
  const select = $("opened-data-select");
  if (select.disabled || !select.value) return;
  dlgOpenedData.close();
  setActiveView(select.value);
}
$("dlg-opened-data-open").onclick = openSelectedOpenedData;
// Double-clicking the select control itself (once it already shows a
// file -- native <select> options don't carry their own dblclick) opens
// that selection directly, without an extra trip to the Open button.
$("opened-data-select").ondblclick = openSelectedOpenedData;

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

async function startRecording() {
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
    // resume from paused: same (scratch) path, a new segment starts now,
    // leaving a genuine gap in the highlight between the just-completed
    // segment (already in recording.segments, see pauseRecording) and
    // this one.
    setRecordingState({ status: "recording", segmentStart: Date.now() });
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
    // btn-load-sample's matching comment/setActiveView).
    if (alreadyOpen.length) setActiveView(`upload://${basename(alreadyOpen[alreadyOpen.length - 1])}`);
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
    await refreshAll(); // also switches into analysis mode -- see setLiveHidden
    setActiveView(`upload://${basename(files[files.length - 1])}`);
    centerViewOnLoadedStart(openedIds);
  } catch (err) {
    alert(String(err.message || err));
  }
}

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
    // added: its true end time is unknown and its data may not have
    // survived a server restart either, so fabricating a highlighted range
    // for it would show something that was never really captured.
    segments: marker.status === "stopped" ? [] : (marker.segments ?? []),
  });
  await persistRecordingMarker();
  if (wasInterrupted) {
    notifyEvent("A previous recording was interrupted and is now paused — Resume to continue, or Stop to finalize.");
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
// pane list -- see openPreferencesDialog/selectPreferencesPane below (kept
// near the bottom of this section, after both panes' own field wiring is
// defined, since selecting the Preferences pane re-prefills its fields).
const dlgPreferences = $("dlg-preferences");

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
  $("theme-status-bar-toggle").checked = statusBarEnabled;
  $("theme-now-color").value = prefs.get("nowLineColor", DEFAULT_NOW_COLOR);
  syncNowStyleButtons(prefs.get("nowLineStyle", DEFAULT_NOW_STYLE));
  $("theme-live-track-color").value = prefs.get("liveTrackColor", DEFAULT_LIVE_TRACK_COLOR);
}
function openThemeDialog() {
  openPreferencesDialog("pane-preferences");
}
$("theme-hl-color").oninput = (e) => applyHlColor(e.target.value); // live preview
$("theme-now-color").oninput = (e) => { nowLineColor = e.target.value; drawAll(); }; // live preview
for (const b of $("theme-now-style-switch").querySelectorAll("button")) {
  b.onclick = () => { syncNowStyleButtons(b.dataset.style); nowLineStyle = b.dataset.style; drawAll(); };
}
$("theme-live-track-color").oninput = (e) => { applyLiveTrackColor(e.target.value); drawAll(); }; // live preview
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
  drawAll();
};
$("dlg-theme-save").onclick = () => {
  const color = $("theme-hl-color").value;
  prefs.set("hlColor", color);
  applyHlColor(color);
  prefs.set("nowLineColor", nowLineColor);
  prefs.set("nowLineStyle", nowLineStyle);
  prefs.set("liveTrackColor", liveTrackColor);
  dlgPreferences.close();
};
$("dlg-theme-close").onclick = () => {
  applyHlColor(prefs.get("hlColor", DEFAULT_HL_COLOR)); // discard live preview
  nowLineColor = prefs.get("nowLineColor", DEFAULT_NOW_COLOR); // discard live preview
  nowLineStyle = prefs.get("nowLineStyle", DEFAULT_NOW_STYLE);
  applyLiveTrackColor(prefs.get("liveTrackColor", DEFAULT_LIVE_TRACK_COLOR)); // discard live preview
  drawAll();
  dlgPreferences.close();
};

/* ── status bar (Appearance > Status bar) ─────────────────────────────────
   A slim, persistent bar at the bottom of the window reporting things that
   happen in the background with nobody having just clicked anything: an
   event created/fired, or the gateway connection going down/coming back --
   separate from the toolbar's #status (ordinary action feedback for
   something the user just did). Takes effect immediately, like the theme
   mode switch, rather than waiting on Save. */
const DEFAULT_STATUS_BAR_VISIBLE = true;
let statusBarEnabled = prefs.get("statusBarVisible", DEFAULT_STATUS_BAR_VISIBLE);
function syncStatusBarVisibility() {
  $("app-status-bar").hidden = !statusBarEnabled;
}
function setStatusBarVisible(visible) {
  statusBarEnabled = visible;
  prefs.set("statusBarVisible", visible);
  syncStatusBarVisibility();
}
$("theme-status-bar-toggle").onchange = (e) => setStatusBarVisible(e.target.checked);
if (!POPOUT_KIND) {
  syncStatusBarVisibility();
}
function notifyEvent(text) {
  const entry = `${new Date().toLocaleTimeString()} — ${text}`;
  const el = $("app-status-bar-text");
  // Recording keeps capturing the live feed regardless of analysis mode
  // (see setLiveHidden) -- while actively recording, a new notification
  // must not blow away whatever's already shown there; append it after a
  // single bar separator instead of replacing outright.
  if ((recording.status === "recording" || recording.status === "paused") && el.textContent) {
    el.textContent = `${el.textContent} | ${entry}`;
  } else {
    el.textContent = entry;
  }
  recordStatusBarHistory(text);
  scheduleStatusBarClear();
}

// Auto-clears the bottom status bar after the configured
// statusBarClearSecs, unless something else has already overwritten it by
// then (checked, not just timed, so a fast follow-up message isn't cut
// short by an earlier message's own timer) -- every notifyEvent call goes
// through this. Ongoing/ticking statuses (the live-resume countdown, see
// updateLiveResumeUI) write app-status-bar-text directly, bypassing
// notifyEvent entirely, so they're unaffected by this timer.
let statusBarClearTimer = null;
function scheduleStatusBarClear() {
  clearTimeout(statusBarClearTimer);
  const shown = $("app-status-bar-text").textContent;
  statusBarClearTimer = setTimeout(() => {
    if ($("app-status-bar-text").textContent === shown) $("app-status-bar-text").textContent = "";
  }, statusBarClearSecs * 1000);
}

// Same as notifyEvent, but force-clears the status bar after `ms` unless
// something else has already overwritten it by then -- used for
// "application starting" (see this app's own boot block, ui-SBAR-006) so a
// quiet boot with nothing else to report doesn't leave it on screen
// indefinitely instead of being cleared shortly past the app's own render.
// Independent of the general statusBarClearSecs setting above: this is a
// specific, already-documented "max 3 seconds" requirement, not the
// general default.
function notifyEventWithCap(text, ms) {
  notifyEvent(text);
  const shown = $("app-status-bar-text").textContent;
  setTimeout(() => {
    if ($("app-status-bar-text").textContent === shown) $("app-status-bar-text").textContent = "";
  }, ms);
}

/* ── status bar history (status bar's own History button) ────────────────
   Every discrete message that's ever been shown as feedback -- notifyEvent's
   background events (server connectivity, export/save results, Record/
   Pause/Resume/Stop lifecycle, ...) all funnel through here via notifyEvent
   itself, the one place any transient status or error is ever shown (see
   setStatus, now reserved just for the capture-arm hint next to the
   timestamp controls, which isn't a discrete event and was never logged
   here) -- kept in-memory only, capped so a long session can't grow this
   forever. Deliberately excludes continuous/repeating state that also
   happens to render into #app-status-bar-text (the live-resume countdown,
   ticking every second, see flashStatus; the "capture mode" reminder, and
   the persistent " recording ..." suffix from syncRecordingMenu) -- those
   aren't discrete events and would just flood this with near-duplicate
   noise. */
const STATUS_BAR_HISTORY_MAX = 500;
const statusBarHistory = [];
function recordStatusBarHistory(text) {
  statusBarHistory.push({ ts: Date.now(), text });
  if (statusBarHistory.length > STATUS_BAR_HISTORY_MAX) statusBarHistory.shift();
  if (!$("status-bar-history-popup").hidden) renderStatusBarHistory();
}
function renderStatusBarHistory() {
  const list = $("status-bar-history-list");
  list.innerHTML = "";
  if (!statusBarHistory.length) {
    const empty = document.createElement("div");
    empty.className = "status-bar-history-empty";
    empty.textContent = "Nothing yet.";
    list.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (let i = statusBarHistory.length - 1; i >= 0; i--) {
    const { ts, text } = statusBarHistory[i];
    const row = document.createElement("div");
    row.className = "status-bar-history-row";
    const t = document.createElement("span");
    t.className = "sbh-ts";
    t.textContent = new Date(ts).toLocaleTimeString();
    const msg = document.createElement("span");
    msg.textContent = text;
    row.append(t, msg);
    frag.appendChild(row);
  }
  list.appendChild(frag);
}
$("status-bar-history-btn").onclick = () => {
  const popup = $("status-bar-history-popup");
  popup.hidden = !popup.hidden;
  if (!popup.hidden) renderStatusBarHistory();
};
$("status-bar-history-clear").onclick = () => {
  statusBarHistory.length = 0;
  renderStatusBarHistory();
};
document.addEventListener("click", (e) => {
  const popup = $("status-bar-history-popup");
  if (
    !popup.hidden &&
    !popup.contains(e.target) &&
    e.target !== $("status-bar-history-btn") &&
    !$("status-bar-history-btn").contains(e.target)
  ) {
    popup.hidden = true;
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("status-bar-history-popup").hidden = true;
});

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

/* ── docker host activity log (ssh:// connections) ──────────────────────── */

// The Show activity switch is always visible now (not just once there's
// something to show) -- it drives #docker-activity's visibility directly,
// independent of whether entries exist yet, so flipping it on before any
// command has run just shows an empty panel rather than a hidden control
// with nothing to reveal.
function renderActivityLog(entries) {
  const pre = $("docker-activity");
  pre.textContent = (entries || [])
    .map((e) => `$ ${e.cmd}\n  → exit ${e.returncode} (${e.ms}ms)${e.stderr ? `\n  ${e.stderr}` : ""}`)
    .join("\n\n");
  pre.hidden = !$("activity-toggle").checked;
}

$("activity-toggle").onchange = () => {
  $("docker-activity").hidden = !$("activity-toggle").checked;
};

// Sets a checkbox's checked state and keeps its ✔/nothing mark in sync --
// the mark is a deliberately explicit, always-visible cue for "this is in
// [user]@[gateway]-containers.json" (see selectedTargets) independent of
// however checkboxes happen to render per OS/theme, shown/hidden on every
// check/uncheck, whether from a user click or the group-select-all header
// setting .checked programmatically (which fires no "change" event).
function setCheckedWithMark(cb, mark, checked) {
  cb.checked = checked;
  mark.textContent = checked ? "✔" : "";
}

// Builds one labelled group of checkboxes (Swarm services / Containers)
// inside #docker-targets -- shared by listContainers()' live `docker ps`
// result and enterDockerHostEditMode's immediate pre-fill from already-open
// sources (see renderDockerTargets below), so both end up with the exact
// same look/behavior. `wasChecked` (name -> bool) carries over whatever
// the user had ticked/unticked in the checklist *before* this render -- a
// Refresh must update the list to match the daemon's actual current state
// (new containers appear, gone ones disappear) without silently
// re-ticking something the user had just deliberately unchecked.
// `selectedNames` is this type's half of selectedTargets -- the checked
// default for anything not already touched this session. `missing` is
// whatever selectedNames says *was* selected but didn't come back in this
// fetch/pre-fill at all -- rendered disabled with a 🚫 mark rather than
// just vanishing, so "this was selected and is now gone" stays visible.
// A followed-but-never-selected container that's gone is never passed in
// `missing` at all (see renderDockerTargets) -- there's nothing to flag.
//
// Deliberately no other visual distinction for a plain, present,
// checked/unchecked entry (no dimming, no "already added" label, same
// color/enabled either way) -- the ✔/🚫 marks are the only cue.
function renderDockerTargetGroup(box, title, items, type, wasChecked, selectedNames, missing = []) {
  if (!items.length && !missing.length) return;
  const g = document.createElement("div");
  g.className = "group";
  g.textContent = title;
  g.title = "Click to select/deselect all of this group";
  const groupBoxes = []; // [{cb, mark}], for the group-select-all header below
  g.onclick = () => {
    const selectAll = groupBoxes.some(({ cb }) => !cb.checked);
    for (const { cb, mark } of groupBoxes) setCheckedWithMark(cb, mark, selectAll);
    updateDlgOkEnabled();
  };
  box.appendChild(g);
  for (const it of items) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = it.name;
    cb.dataset.type = type;
    const mark = document.createElement("span");
    mark.className = "mark";
    // Nothing is preselected just for having been *found* -- only a name
    // in selectedNames (persisted, see selectedTargets) starts ticked; a
    // fresh discovery starts unticked, and one already in the checklist
    // keeps whatever the user last left it at.
    const startChecked = wasChecked.has(it.name) ? wasChecked.get(it.name) : selectedNames.has(it.name);
    setCheckedWithMark(cb, mark, startChecked);
    cb.onchange = () => { setCheckedWithMark(cb, mark, cb.checked); updateDlgOkEnabled(); };
    groupBoxes.push({ cb, mark });
    label.append(cb, mark, ` ${it.name} `);
    const extra = document.createElement("span");
    extra.className = "tdoc";
    extra.textContent = it.image || it.replicas || "";
    label.appendChild(extra);
    box.appendChild(label);
  }
  for (const it of missing) {
    const label = document.createElement("label");
    label.classList.add("unavailable");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true; // it's only ever in `missing` because it WAS selected
    cb.disabled = true; // excluded from dlg-ok's submission query on purpose -- see "input:checked:not(:disabled)"
    cb.value = it.name;
    cb.dataset.type = type;
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "🚫";
    label.append(cb, mark, ` ${it.name} `);
    const extra = document.createElement("span");
    extra.className = "tdoc";
    extra.textContent = "no longer available";
    label.appendChild(extra);
    box.appendChild(label);
  }
}

// Repopulates #docker-targets from a {name, image?, replicas?}[] pair --
// either a live `docker ps` result (listContainers) or, immediately on
// opening Edit Docker Host (before any Refresh), whatever's already being
// followed for this host (see enterDockerHostEditMode below). Re-renders
// are a diff against selectedTargets (the persisted record, see its own
// comment), not a blind wipe: a Refresh that finds a *selected* container
// gone (stopped/removed) marks it disabled rather than dropping it outright
// (see renderDockerTargetGroup's `missing`) -- one that was never selected
// and is now gone is simply omitted, nothing to flag; a genuinely new one
// appears unticked (nothing is preselected just for having been *found*);
// and anything still there keeps exactly whatever the user last
// checked/unchecked it to.
//
// `closeMissing: true` (only from a real live fetch, i.e. listContainers --
// never the initial no-live-data pre-fill, which has nothing to diff
// against yet) also actually closes any now-gone *selected* container/
// service's source, so it stops being tracked/plotted immediately rather
// than waiting on the user to notice and click Update Docker Host: "no
// longer available" should mean gone from the graph too, not just flagged
// in this dialog.
function renderDockerTargets(containers, services, hostKey, { closeMissing = false } = {}) {
  const box = $("docker-targets");
  const wasChecked = new Map();
  for (const cb of box.querySelectorAll("input[type=checkbox]:not(:disabled)")) {
    wasChecked.set(cb.value, cb.checked);
  }
  box.innerHTML = "";
  // Only ever used here to find an *id* to close for a gone-but-selected
  // entry (see below) -- whether something is "missing" is now purely a
  // selectedTargets question, not "is a log source open for it".
  const tracked = currentlyTrackedTargets(hostKey);
  const trackedIdByName = new Map([...tracked.containers, ...tracked.services].map((t) => [t.name, t.id]));
  const containerNames = new Set(containers.map((c) => c.name));
  const serviceNames = new Set(services.map((s) => s.name));
  const missingContainers = [...selectedTargets.containers]
    .filter((name) => !containerNames.has(name))
    .map((name) => ({ name, id: trackedIdByName.get(name) }));
  const missingServices = [...selectedTargets.services]
    .filter((name) => !serviceNames.has(name))
    .map((name) => ({ name, id: trackedIdByName.get(name) }));
  renderDockerTargetGroup(box, "Swarm services (docker service logs)", services, "service", wasChecked, selectedTargets.services, missingServices);
  renderDockerTargetGroup(box, "Containers (docker logs)", containers, "container", wasChecked, selectedTargets.containers, missingContainers);
  if (!services.length && !containers.length && !missingServices.length && !missingContainers.length) {
    box.textContent = "nothing running";
  }
  updateDlgOkEnabled();
  if (closeMissing) {
    // Only ones with an actual open source to close (a selected name with
    // no matching tracked source -- e.g. restored from the file but never
    // actually re-opened this session -- has nothing to close).
    const gone = [...missingContainers, ...missingServices].filter((it) => it.id);
    if (gone.length) {
      const ids = new Set(gone.map((it) => it.id));
      // Closed and removed from state.sources directly (not a full
      // refreshAll() round-trip) -- we already know exactly which ids just
      // got confirmed gone, no need to wait on and reconcile against an
      // entire fresh /sources list just to reflect that. Logged, not
      // thrown, on failure: the checklist already shows it disabled either
      // way, and a close failing here (already gone server-side too, most
      // likely) shouldn't block the rest of the dialog from working.
      Promise.all(gone.map((it) => post("/close", { id: it.id }).catch((err) => console.error("close (missing container/service) failed:", err))))
        .then(() => {
          state.sources = state.sources.filter((s) => !ids.has(s.id));
          assignColorSlots();
          syncPanels();
          renderLegend();
          drawAll();
        });
    }
  }
}

// The containers/services already being followed for `hostKey`, derived
// from currently-open log sources (no live docker ps needed) -- what
// enterDockerHostEditMode pre-fills the checklist with immediately, before
// Refresh ever runs, so editing an existing daemon isn't a blank form.
function currentlyTrackedTargets(hostKey) {
  // hostKey itself may be a full "ssh://user@host[:port]" (its own embedded
  // slashes), so a regex expecting a single no-slash host segment would
  // wrongly stop at its first slash -- hostKey is already known exactly
  // here, so match this host's prefix directly instead (same fix as
  // currentDockerHost()'s truncation bug elsewhere in this file).
  const prefix = `docker://${hostKey}/`;
  const containers = [], services = [];
  for (const s of state.sources) {
    const path = s.path || "";
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.startsWith("container/")) containers.push({ name: s.name, id: s.id });
    else if (rest.startsWith("service/")) services.push({ name: s.name, id: s.id });
  }
  return { containers, services };
}

async function listContainers() {
  $("docker-error").textContent = "";
  renderActivityLog(null);
  const host = normalizeDockerHost($("docker-host").value);
  const sshKey = $("docker-ssh-key").value.trim() || null;
  dockerHostKeys.set(host || "local", sshKey);
  // spelled out explicitly (rather than just "Connecting to <host>…") since
  // that phrasing reads as if *this browser page* opens a connection to
  // <host> -- it never does (fetch() can't even speak ssh://): the CTTC
  // server at 127.0.0.1 is the only thing this page ever talks to; it's the
  // server that then runs `docker -H ssh://user@host ...` on <host>'s behalf.
  const label = host
    ? `Asking the CTTC server (127.0.0.1:${PORT}) to reach ${host} over ssh…`
    : `Asking the CTTC server (127.0.0.1:${PORT}) for local containers…`;
  const t0 = Date.now();
  const status = $("docker-status");
  status.textContent = label;
  // ssh connections can take a while (or hang) before the server even
  // responds -- without this, "Refresh" looks identical whether it's about
  // to succeed, still connecting, or has silently wedged.
  const tick = setInterval(() => {
    status.textContent = `${label} (${Math.round((Date.now() - t0) / 1000)}s)`;
  }, 1000);
  // disabled for the whole attempt (not just the button) so the host string
  // can't be edited out from under an in-flight fetch -- re-enabled in both
  // the success and failure paths below, never left stuck disabled. Every
  // other control is disabled for the duration too (see setDockerFormEnabled)
  // and only re-enabled on success, since a stale answer for a *different*
  // host (or the same host before it changed) shouldn't stay selectable.
  $("docker-host").disabled = true;
  $("btn-ps-refresh").disabled = true;
  setDockerFormEnabled(false);
  try {
    const r = await post("/docker/ps", { host, ssh_key: sshKey });
    clearInterval(tick);
    status.textContent = "";
    renderActivityLog(r.log);

    // Closing anything no longer wanted happens in one of two targeted
    // ways, not by wiping every previously-tracked container/service on
    // any successful fetch (that used to run here, and directly fought
    // renderDockerTargets' own diff -- it would close and refreshAll()
    // *before* the diff ever saw the pre-fetch state, so a still-selected
    // container could never be told apart from one that's actually gone):
    // dlg-ok's own submit-time `toClose` closes whatever's unticked for
    // *this* host once the user actually confirms Set/Update Docker
    // Daemon, and renderDockerTargets' `closeMissing` below closes only
    // what this live fetch just proved is actually gone from the daemon
    // itself.
    renderDockerTargets(r.containers, r.services, host || "local", { closeMissing: true });

    const t = await get("/transforms").catch(() => ({ transforms: [] }));
    const tbox = $("transforms-list");
    // A Refresh rebuilds this list from scratch (the set of installed
    // transforms could have changed) -- carry over whatever the user had
    // already ticked, same as the docker-targets checklist's own
    // wasChecked, so a Refresh never silently discards a deliberate pick.
    const wasChecked = new Map();
    for (const cb of tbox.querySelectorAll("input[type=checkbox]")) wasChecked.set(cb.value, cb.checked);
    tbox.innerHTML = t.transforms.length ? "" : "none found in server/transforms/";
    for (const tr of t.transforms) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = tr.name;
      // json_message and parse_level are on by default -- turning raw JSON
      // log lines and bare level tagging into something readable is the
      // common case, not an opt-in; anything else (e.g. drop_healthchecks)
      // stays opt-in as before.
      cb.checked = wasChecked.has(tr.name) ? wasChecked.get(tr.name) : DEFAULT_ON_TRANSFORMS.has(tr.name);
      label.append(cb, ` ${tr.name} `);
      const doc = document.createElement("span");
      doc.className = "tdoc";
      doc.textContent = tr.doc || "";
      label.appendChild(doc);
      tbox.appendChild(label);
    }
    setDockerFormEnabled(true);
  } catch (err) {
    clearInterval(tick);
    status.textContent = "";
    $("docker-targets").innerHTML = "";
    renderActivityLog(err.log);
    // A bare network-level failure (fetch() itself rejected -- server
    // unreachable, tunnel down, connection reset with zero bytes sent) has
    // no err.serverResponded and a browser-generated message that isn't
    // useful on its own. Anything the CTTC server actually responded to
    // (err.serverResponded) means the 127.0.0.1 hop succeeded and it was
    // the server's own ssh/docker call (or an unexpected server-side bug)
    // that failed -- spelled out so it's unambiguous which of the two hops
    // broke. Deliberately NOT keyed on err.log: a plain 500 (an unhandled
    // exception, not a DockerPsError) has no log either, but the server did
    // respond.
    $("docker-error").textContent = err.serverResponded
      ? `The CTTC server reached out to ${host || "the local daemon"} and failed: ${String(err.message || err)}`
      : `Could not reach the CTTC server itself at 127.0.0.1:${PORT} (${String(err.message || err)}) — check the connection/tunnel.`;
  } finally {
    // Edit mode locked host/ssh-key/browse on purpose (see
    // enterDockerHostEditMode) -- a Refresh re-probing the same daemon must
    // leave them locked, not spring back open the moment the request ends.
    if (!dockerDaemonEditMode) {
      $("docker-host").disabled = false;
      $("docker-ssh-key").disabled = false;
      $("docker-ssh-key-browse").disabled = false;
    }
    $("btn-ps-refresh").disabled = false;
    // Success or failure, the attempt is done and its activity log (if any)
    // is in place above -- Show activity can unlock now regardless of which
    // branch ran (see dockerFetchAttempted/syncActivityToggleEnabled).
    dockerFetchAttempted = true;
    syncActivityToggleEnabled();
  }
}

$("btn-ps-refresh").onclick = () => listContainers();
$("docker-host").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    listContainers();
  }
});

// Cancelling out of Edit mode must not leave dockerDaemonEditMode stuck
// true for the *next* time the dialog opens -- btn-set already overwrites it
// unconditionally on open (both its create and edit-mode branches), so this is belt-and-braces
// consistency (see br-DHOST-001/BUG-0067), not the fix for a currently
// reachable bug on its own.
$("dlg-cancel").onclick = () => {
  dlg.close();
  dockerDaemonEditMode = false;
};

$("dlg-ok").onclick = async () => {
  const transforms = chosenTransforms();
  try {
    const host = normalizeDockerHost($("docker-host").value);
    const sshKey = $("docker-ssh-key").value.trim() || null;
    dockerHostKeys.set(host || "local", sshKey);
    const hostKey = host || "local";
    // :not(:disabled) excludes the "no longer available" entries
    // (renderDockerTargetGroup's `missing`) -- checked=true there only to
    // show "this was selected", never meant to actually be (re-)submitted
    // for a container that doesn't exist anymore.
    const logs = [...$("docker-targets").querySelectorAll("input:checked:not(:disabled)")].map((cb) => ({
      name: cb.value,
      type: cb.dataset.type,
    }));
    // "Set" syncs exactly to this checklist: any container/service log
    // already being followed for this host that isn't checked now gets
    // closed, not just left running alongside whatever's newly picked.
    const keep = new Set(logs.map((l) => `docker://${hostKey}/${l.type}/${l.name}`));
    // hostKey itself may be a full "ssh://user@host[:port]" (its own
    // slashes), so a capture-group regex here would wrongly stop at the
    // first slash inside it -- hostKey is already known exactly, so just
    // match this host's prefix directly instead of re-extracting it.
    const hostPrefix = `docker://${hostKey}/`;
    const toClose = state.sources.filter((s) => {
      const p = s.path || "";
      return (
        p.startsWith(hostPrefix) &&
        /^(container|service)\//.test(p.slice(hostPrefix.length)) &&
        !keep.has(p)
      );
    });
    for (const s of toClose) await post("/close", { id: s.id });

    // Telemetry (per-container docker stats and host CPU/MEM/NET) is
    // always collected once a daemon is set -- no dedicated section/toggle
    // for it in this dialog anymore, just the toolbar/Settings' own
    // Frequency field (dockerPollIntervalSecs).
    const collectReq = {
      host, stats: true, logs, transforms,
      host_stats: true,
      ssh_key: sshKey,
      interval: dockerPollIntervalSecs,
    };
    await post("/docker/collect", collectReq);
    // remember this collection request so it can be restored on next launch
    const sessions = prefs.get("lastDockerSessions", []);
    sessions.push(collectReq);
    prefs.set("lastDockerSessions", sessions);
    // Separate, durable catalog of every daemon ever configured -- unlike
    // lastDockerSessions (an unde-duped auto-reconnect-on-launch list that
    // Disconnect Docker Host removes entries from), this is keyed by host
    // and never touched by Disconnect, only by Remove Docker Host -- see
    // dockerHostHistory()/populateDockerHostHistory() (Load Docker Host) and
    // removeDockerDaemon() below.
    const saved = prefs.get("savedDockerDaemons", {});
    saved[hostKey] = { ...collectReq, lastUsed: Date.now() };
    prefs.set("savedDockerDaemons", saved);
    // gateways.json's own record of "which Docker hosts were created using
    // this gateway" (see recordDockerHostForGateway) -- additive to
    // savedDockerDaemons above, not a replacement for it; best-effort since
    // there's nothing useful to do here if it fails (the connection above
    // already succeeded, so this is purely bookkeeping).
    try {
      await window.cttc?.recordDockerHost?.({ hostKey, host, sshKey });
    } catch (err) {
      console.error("could not record Docker host against the active gateway:", err);
    }
    // Every entry actually present in the checklist (checked or not, minus
    // the disabled/gone ones) gets its legend track state set explicitly to
    // match -- not just the checked ones. Only ever promoting to "sel" and
    // never demoting back to "mut" left a just-unchecked container stuck
    // showing as selected (still plotted/still in the legend's selected
    // group) even though it was no longer in `logs` at all.
    for (const cb of $("docker-targets").querySelectorAll("input[type=checkbox]:not(:disabled)")) {
      setTrack(cb.value, cb.checked ? "sel" : "mut");
    }
    // ...and, separately, the durable per-daemon record consulted the next
    // time Set/Edit Docker Host opens for this host (see selectedTargets
    // / loadSelectedTargets) -- "on the way out" per the spec, on every
    // successful Set/Update, regardless of edit vs. create mode.
    selectedTargets = {
      containers: new Set(logs.filter((l) => l.type === "container").map((l) => l.name)),
      services: new Set(logs.filter((l) => l.type === "service").map((l) => l.name)),
    };
    await saveSelectedTargets(hostKey, {
      containers: [...selectedTargets.containers],
      services: [...selectedTargets.services],
    });
    dlg.close();
    // Legend/graph must reflect the just-saved selection immediately, not
    // just after the next SSE-driven refresh -- refreshAll() re-derives
    // both from state.track (see trackStateOf/allSvcSeries) and the fresh
    // /sources list, which is also the moment a brand-new container's
    // panel/telemetry actually appears.
    refreshAll();
  } catch (err) {
    alert(String(err.message || err));
  }
};

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

// The toolbar's "Frequency" field -- how often (seconds) Connect/Update
// Docker Host polls the daemon for stats/logs. Persisted so it survives
// restarts; applied to every future Connect/Update Docker Host submission
// (dockerPollIntervalSecs, used in the dlg-ok handler above). Doesn't push
// a live update to an already-open collector on its own -- Update Docker
// Host (Edit) is still what applies a changed interval to one already
// running (see server.py's _update_poll_interval).
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
}
setLiveTrackEnabled(liveTrackEnabled); // apply the persisted value to both fields on load

// Shows a message in the bottom app-status-bar for a fixed duration, then
// reverts it -- unlike notifyEvent's normal callers (one-off background
// events), this one expires on its own. Only reverts if nothing else has
// since overwritten it.
function flashStatus(msg, ms) {
  $("app-status-bar-text").textContent = msg;
  recordStatusBarHistory(msg);
  setTimeout(() => {
    if ($("app-status-bar-text").textContent === msg) $("app-status-bar-text").textContent = "";
  }, ms);
}

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

// Settings and Preferences, one dialog: a left-hand pane list (mac System
// Settings-style, see .mac-settings in style.css) with the selected pane's
// fields on the right -- opened via the shared data-action dispatch (see
// RENDERER_ACTIONS' "open-settings"/"open-theme" entries below), each
// jumping straight to its own pane.
function selectPreferencesPane(paneId) {
  for (const item of dlgPreferences.querySelectorAll(".mac-settings-item")) {
    item.dataset.active = String(item.dataset.pane === paneId);
  }
  for (const pane of dlgPreferences.querySelectorAll(".mac-settings-pane")) {
    pane.hidden = pane.id !== paneId;
  }
  if (paneId === "pane-preferences") prefillPreferencesPane();
}
for (const item of dlgPreferences.querySelectorAll(".mac-settings-item")) {
  item.onclick = () => selectPreferencesPane(item.dataset.pane);
}
function openPreferencesDialog(paneId) {
  selectPreferencesPane(paneId);
  dlgPreferences.showModal();
}
function openSettingsDialog() {
  openPreferencesDialog("pane-settings");
}
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

/* ── New Gateway / Edit Gateways ──────────────────────────────────────────
   One dialog, two modes -- ported from the old gateway-setup.html/js (a
   separate window loaded with ?mode=new or ?mode=edit): now that both live
   in this same window as an ordinary <dialog> (like Settings), the mode is
   just a JS variable set when opening rather than a URL/page reload, and
   "close" is dlgGatewaySetup.close() rather than window.close(). The
   first-run/no-local-docker wizard is unaffected -- it still runs in its
   own separate window (there's no main window yet at that point to host a
   dialog in) and still uses the original gateway-setup.html/js. */
const dlgGatewaySetup = $("dlg-gateway-setup");
let gwMode = "new"; // "new" | "edit"
let gwGateways = [];

function gwKeyOf(g) {
  return `${g.host}:${g.port}`;
}
function gwSelectedGateway() {
  return gwGateways.find((g) => gwKeyOf(g) === $("gw-select").value);
}

for (const radio of document.querySelectorAll('input[name="gw-key-mode"]')) {
  radio.onchange = () => {
    const paste = radio.value === "paste" && radio.checked;
    $("gw-key-path").disabled = paste;
    $("gw-btn-browse").disabled = paste;
    $("gw-key-paste").disabled = !paste;
  };
}
for (const radio of document.querySelectorAll('input[name="gw-image-source"]')) {
  radio.onchange = () => {
    $("gw-image-ref-row").hidden = radio.value !== "registry" || !radio.checked;
    $("gw-image-tarball-row").hidden = radio.value !== "tarball" || !radio.checked;
  };
}
$("gw-btn-browse").onclick = async () => {
  const paths = await window.cttc.pickFiles("Choose your SSH private key");
  if (paths.length) $("gw-key-path").value = paths[0];
};
$("gw-image-tarball-browse").onclick = async () => {
  const paths = await window.cttc.pickFiles("Choose the server image .tar.gz");
  if (paths.length) $("gw-image-tarball-path").value = paths[0];
};
$("gw-btn-cancel").onclick = () => dlgGatewaySetup.close();
$("gw-btn-activity-toggle").onclick = () => {
  $("gw-activity-log").hidden = !$("gw-activity-log").hidden;
  $("gw-btn-activity-toggle").textContent = $("gw-activity-log").hidden ? "Show activity" : "Hide activity";
};
if (!POPOUT_KIND) {
  window.cttc?.onSetupLog?.((line) => {
    $("gw-activity").hidden = false;
    $("gw-activity-log").textContent += ($("gw-activity-log").textContent ? "\n" : "") + line;
    $("gw-activity-log").scrollTop = $("gw-activity-log").scrollHeight;
  });
}

// Edit mode only. Every field this touches (ssh/key + image + Connect) is
// disabled until something is actually picked from the dropdown -- rather
// than hiding the form outright, so it's obvious at a glance that there's
// more here once a gateway is chosen. "This machine" (embedded) is
// filtered out of the dropdown entirely by gwLoadGatewaysForEdit -- every
// entry reachable here is a real, editable remote or local-docker gateway,
// so isRemote below is effectively always true, but the check is left in
// place as a defensive fallback rather than assumed.
function gwFillFormForEdit(g) {
  $("gw-error").hidden = true;
  const sshFields = [
    $("gw-ssh-user"), $("gw-ssh-host"), $("gw-ssh-port"), $("gw-key-path"), $("gw-btn-browse"), $("gw-key-paste"),
    ...document.querySelectorAll('input[name="gw-key-mode"]'),
  ];
  const imageFields = [
    ...document.querySelectorAll('input[name="gw-image-source"]'),
    $("gw-image-ref"), $("gw-image-tarball-browse"), $("gw-image-tarball-path"),
  ];

  if (!g) {
    for (const el of [...sshFields, ...imageFields]) el.disabled = true;
    $("gw-btn-connect").disabled = true;
    $("gw-ssh-user").value = "";
    $("gw-ssh-host").value = "";
    $("gw-key-path").value = "";
    return;
  }

  $("gw-btn-connect").disabled = false;
  for (const el of imageFields) el.disabled = false;
  const isRemote = g.mode !== "embedded";
  for (const el of sshFields) el.disabled = !isRemote;
  $("gw-btn-connect").textContent = isRemote ? "Save changes" : "Update image";
  if (isRemote) {
    const at = g.sshTarget.lastIndexOf("@");
    $("gw-ssh-user").value = at === -1 ? "" : g.sshTarget.slice(0, at);
    $("gw-ssh-host").value = at === -1 ? g.sshTarget : g.sshTarget.slice(at + 1);
    $("gw-ssh-port").value = g.sshPort || 22;
    document.querySelector('input[name="gw-key-mode"][value="path"]').checked = true;
    $("gw-key-paste").disabled = true;
    $("gw-key-path").value = g.sshKey || "";
  } else {
    $("gw-ssh-user").value = "";
    $("gw-ssh-host").value = "";
    $("gw-key-path").value = "";
  }
}

// "This machine" (the embedded/local gateway, always present -- see main.js's
// recordGateway({mode: "embedded", label: "This machine", ...})) has no
// connection settings to edit and must never be uninstalled: it isn't a
// gateway *entry* the user added, it's just always there. Filtered out here
// (a plain, stubbable function -- see the E2E spec), not from
// window.cttc.getGateways() itself, since the toolbar's gateway-switcher
// dropdown still needs to offer switching *to* it.
function editableGateways(gateways) {
  return gateways.filter((g) => g.mode !== "embedded");
}

async function gwLoadGatewaysForEdit() {
  gwGateways = editableGateways(await window.cttc.getGateways());
  const prevKey = $("gw-select").value;
  $("gw-select").innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "— Select a gateway —";
  $("gw-select").appendChild(placeholder);
  for (const g of gwGateways) {
    const opt = document.createElement("option");
    opt.value = gwKeyOf(g);
    const loc = g.port == null ? g.host : `${g.host}:${g.port}`;
    opt.textContent = `${g.label || g.host} (${loc})${g.active ? " — active" : ""}`;
    $("gw-select").appendChild(opt);
  }
  $("gw-select").value = gwGateways.some((g) => gwKeyOf(g) === prevKey) ? prevKey : "";
  gwFillFormForEdit(gwSelectedGateway());
}
$("gw-select").onchange = () => gwFillFormForEdit(gwSelectedGateway());

/* ── Uninstall Gateway: its own dialog (sidebar → Gateway → Uninstall
   Gateway…), split out from Edit Gateway's old inline Uninstall button so
   picking a gateway to uninstall isn't tangled up with editing one's ssh/
   image settings. Reuses the exact same editableGateways()-filtered
   dropdown listing and window.cttc.uninstallGateway(g) call/result
   handling Edit Gateway's button used to. */
const dlgGatewayUninstall = $("dlg-gateway-uninstall");
let gwUninstallGateways = [];

function gwUninstallSelectedGateway() {
  return gwUninstallGateways.find((g) => gwKeyOf(g) === $("gw-uninstall-select").value);
}

async function gwLoadGatewaysForUninstall() {
  gwUninstallGateways = editableGateways(await window.cttc.getGateways());
  const select = $("gw-uninstall-select");
  const prevKey = select.value;
  select.innerHTML = '<option value="">— pick a gateway to uninstall —</option>';
  for (const g of gwUninstallGateways) {
    const opt = document.createElement("option");
    opt.value = gwKeyOf(g);
    const loc = g.port == null ? g.host : `${g.host}:${g.port}`;
    opt.textContent = `${g.label || g.host} (${loc})${g.active ? " — active" : ""}`;
    select.appendChild(opt);
  }
  select.value = gwUninstallGateways.some((g) => gwKeyOf(g) === prevKey) ? prevKey : "";
  $("gw-uninstall-delete").disabled = !select.value;
  $("gw-uninstall-error").hidden = true;
  $("gw-uninstall-status").textContent = "";
}
$("gw-uninstall-select").onchange = () => {
  $("gw-uninstall-delete").disabled = !$("gw-uninstall-select").value;
};
$("gw-uninstall-close").onclick = () => dlgGatewayUninstall.close();
$("gw-uninstall-delete").onclick = async () => {
  const g = gwUninstallSelectedGateway();
  if (!g) return;
  if (!confirm(`Uninstall ${g.label || g.host}? This stops and removes its container.`)) return;
  $("gw-uninstall-error").hidden = true;
  $("gw-uninstall-select").disabled = true;
  $("gw-uninstall-delete").disabled = true;
  $("gw-uninstall-status").textContent = "Uninstalling, please wait…";
  const result = await window.cttc.uninstallGateway(g);
  $("gw-uninstall-select").disabled = false;
  $("gw-uninstall-status").textContent = "";
  if (!result.ok) {
    $("gw-uninstall-error").textContent = result.error;
    $("gw-uninstall-error").hidden = false;
    $("gw-uninstall-delete").disabled = false;
    return;
  }
  await gwLoadGatewaysForUninstall();
};
async function openUninstallGatewayDialog() {
  await gwLoadGatewaysForUninstall();
  dlgGatewayUninstall.showModal();
}

function gwReadImageSource() {
  const mode = document.querySelector('input[name="gw-image-source"]:checked').value;
  if (mode === "registry") return { type: "registry", ref: $("gw-image-ref").value.trim() };
  if (mode === "tarball") return { type: "tarball", path: $("gw-image-tarball-path").value };
  return null; // "default" -- let the server side resolve its usual fallback
}

$("gw-form").onsubmit = async (e) => {
  e.preventDefault();
  const gw = gwMode === "edit" ? gwSelectedGateway() : null;
  if (gwMode === "edit" && !gw) return; // nothing picked yet -- button is disabled anyway
  const isEmbeddedEdit = gwMode === "edit" && gw.mode === "embedded";

  $("gw-error").hidden = true;
  $("gw-activity-log").textContent = "";

  const keyMode = document.querySelector('input[name="gw-key-mode"]:checked').value;
  const imageSource = gwReadImageSource();
  const payload = {
    sshUser: $("gw-ssh-user").value.trim(),
    sshHost: $("gw-ssh-host").value.trim(),
    sshPort: Number($("gw-ssh-port").value),
    keyMode,
    keyPath: keyMode === "path" ? $("gw-key-path").value : null,
    keyContents: keyMode === "paste" ? $("gw-key-paste").value : null,
    imageSource,
  };
  if (!isEmbeddedEdit && keyMode === "path" && !payload.keyPath) {
    $("gw-error").textContent = "Choose a private key file, or switch to pasting its contents.";
    $("gw-error").hidden = false;
    return;
  }
  if (!isEmbeddedEdit && keyMode === "paste" && !payload.keyContents.trim()) {
    $("gw-error").textContent = "Paste the private key's contents, or switch to a file.";
    $("gw-error").hidden = false;
    return;
  }
  if (imageSource?.type === "tarball" && !imageSource.path) {
    $("gw-error").textContent = "Choose a .tar.gz file, or switch to a registry reference / the bundled image.";
    $("gw-error").hidden = false;
    return;
  }
  if (imageSource?.type === "registry" && !imageSource.ref) {
    $("gw-error").textContent = "Enter an image reference (repo:tag), or switch to the bundled image.";
    $("gw-error").hidden = false;
    return;
  }

  $("gw-form").hidden = true;
  $("gw-wait").hidden = false;
  $("gw-btn-connect").disabled = true;

  const result =
    gwMode === "edit"
      ? await window.cttc.saveGatewayEdit({ ...payload, key: gwKeyOf(gw), mode: gw.mode })
      : await window.cttc.addGateway(payload);

  if (!result.ok) {
    $("gw-form").hidden = false;
    $("gw-wait").hidden = true;
    $("gw-btn-connect").disabled = false;
    $("gw-error").textContent = result.error;
    $("gw-error").hidden = false;
    return;
  }
  if (gwMode === "edit") {
    // stays open (unlike New Gateway, saving here doesn't necessarily need
    // to close anything) -- refresh so the dropdown/prefill reflect what
    // was just saved
    $("gw-form").hidden = false;
    $("gw-wait").hidden = true;
    await gwLoadGatewaysForEdit();
  } else {
    // gateway-add-submit already offered a restart on the main-process
    // side (see main.js) -- nothing left to do here but close
    dlgGatewaySetup.close();
  }
};

function openNewGatewayDialog() {
  gwMode = "new";
  $("gw-title").textContent = "New Gateway";
  $("gw-intro").hidden = false;
  $("gw-select-row").hidden = true;
  $("gw-btn-connect").textContent = "Connect";
  $("gw-btn-connect").disabled = false;
  $("gw-wait-msg").textContent = "Connecting, please wait…";
  $("gw-form").hidden = false;
  $("gw-wait").hidden = true;
  $("gw-error").hidden = true;
  $("gw-activity").hidden = true;
  $("gw-activity-log").textContent = "";
  $("gw-form").reset();
  dlgGatewaySetup.showModal();
}

async function openEditGatewaysDialog() {
  gwMode = "edit";
  $("gw-title").textContent = "Edit Gateways";
  $("gw-intro").hidden = true;
  $("gw-select-row").hidden = false;
  $("gw-wait-msg").textContent = "Applying changes, please wait…";
  $("gw-form").hidden = false;
  $("gw-wait").hidden = true;
  $("gw-error").hidden = true;
  $("gw-activity").hidden = true;
  $("gw-activity-log").textContent = "";
  await gwLoadGatewaysForEdit();
  dlgGatewaySetup.showModal();
}

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
/* ── Events: watch CPU/MEM/NET thresholds or a log regex on chosen systems,
   snapshot or record automatically when the condition is met ────────────
   "Gateway"-hosted events are registered on the server (server/events.py)
   and keep watching even if this window closes; "this app"-hosted events
   are evaluated right here against data the renderer already has (or a
   small targeted fetch for it), and only watch while this window is open.
   Either way, triggering reuses the same primitives the manual Capture
   Metrics/Record features already use (GET /files/download, POST
   /session/start) -- an event is just an automatic way to call them. */

const UI_EVENTS_KEY = "uiEvents";
function loadUiEvents() {
  return prefs.get(UI_EVENTS_KEY, []);
}
function saveUiEvents(list) {
  prefs.set(UI_EVENTS_KEY, list);
}

const dlgEventForm = $("dlg-event-form");
const dlgEventList = $("dlg-event-list");

// null while creating a brand-new event; {id, hosted} while dlg-event-form
// is instead editing an existing one (see openEventEditForm) -- the same
// form and the same submit button (#dlg-event-create) serve both, since an
// edit is just a create() whose fields start pre-filled and whose submit
// calls update() instead.
let editingEvent = null;

function resetEventForm() {
  renderEventSystemsPicker();
  $("event-name").value = "";
  $("event-hosted").value = "gateway";
  $("event-hosted").disabled = false;
  $("event-conditions").innerHTML = "";
  addEventConditionRow();
  syncEventMatchRowVisibility();
  $("event-action-kind").value = "snapshot";
  $("event-action-minutes").value = "5";
  $("event-action-duration").value = "10";
  $("event-safe").checked = false;
  $("event-max-keep").value = "86400";
  syncEventActionFields();
  $("event-max-keep-row").hidden = true;
}

function openEventCreateDialog() {
  editingEvent = null;
  resetEventForm();
  $("event-form-title").textContent = "Create Event";
  $("dlg-event-create").textContent = "Create event";
  dlgEventForm.showModal();
}
$("btn-event-create").onclick = openEventCreateDialog;
$("dlg-event-form-cancel").onclick = () => dlgEventForm.close();

// Edit Events > Update on a row: same form, pre-filled from the event's
// current fields; `hosted` can't be changed here (moving an event from
// local to gateway or back isn't supported -- create a new one instead).
function openEventEditForm(ev, hosted) {
  editingEvent = { id: hosted === "gateway" ? ev.event_id : ev.id, hosted };
  resetEventForm();
  $("event-name").value = ev.name;
  $("event-hosted").value = hosted;
  $("event-hosted").disabled = true;
  const sourceIds = new Set(hosted === "gateway" ? ev.source_ids : ev.sourceIds);
  for (const cb of document.querySelectorAll("[data-event-system]")) cb.checked = sourceIds.has(cb.value);

  $("event-conditions").innerHTML = "";
  for (const cond of ev.conditions) {
    addEventConditionRow();
    const row = $("event-conditions").lastElementChild;
    row.querySelector('[data-field="type"]').value = cond.type;
    row.querySelector('[data-field="type"]').dispatchEvent(new Event("change"));
    if (cond.type === "metric") {
      row.querySelector('[data-field="metric"]').value = cond.metric;
      row.querySelector('[data-field="op"]').value = cond.op;
      row.querySelector('[data-field="threshold"]').value = cond.threshold;
    } else {
      row.querySelector('[data-field="pattern"]').value = cond.pattern;
    }
  }
  syncEventMatchRowVisibility();
  $("event-match").value = ev.match;

  $("event-action-kind").value = ev.action.kind;
  syncEventActionFields();
  $("event-action-minutes").value = ev.action.minutes || 5;
  $("event-action-duration").value = ev.action.duration_minutes || 10;
  $("event-safe").checked = !!ev.action.safe;
  $("event-max-keep-row").hidden = !ev.action.safe;
  $("event-max-keep").value = ev.action.max_keep_seconds || 86400;

  $("event-form-title").textContent = "Edit Event";
  $("dlg-event-create").textContent = "Save changes";
  dlgEventList.close();
  dlgEventForm.showModal();
}

async function openEventListDialog() {
  await refreshEventsList();
  dlgEventList.showModal();
}
$("btn-event-edit").onclick = openEventListDialog;
$("dlg-event-list-close").onclick = () => dlgEventList.close();

function renderEventSystemsPicker() {
  const box = $("event-systems");
  box.innerHTML = "";
  for (const s of state.sources) {
    const label = document.createElement("label");
    label.className = "ctl block";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = s.id;
    cb.dataset.eventSystem = "1";
    label.appendChild(cb);
    label.append(` ${s.name} (${s.kind})`);
    box.appendChild(label);
  }
  if (!state.sources.length) box.textContent = "No open sources yet -- events will monitor everything once sources exist.";
}
function selectedEventSystems() {
  return [...document.querySelectorAll('[data-event-system]:checked')].map((cb) => cb.value);
}

// an event can carry more than one condition (see events.py's `match`) --
// each row here is one condition (metric threshold or log regex), added/
// removed freely; "Trigger when" (any/all) only matters -- and so is only
// shown -- once there's more than one row.
function addEventConditionRow() {
  const box = $("event-conditions");
  const row = document.createElement("div");
  row.className = "keys-box";
  row.dataset.conditionRow = "1";
  row.innerHTML = `
    <label class="ctl">Condition
      <select data-field="type">
        <option value="metric">Metric threshold</option>
        <option value="log">Log regular expression</option>
      </select>
    </label>
    <span data-fields="metric">
      <label class="ctl">Metric
        <select data-field="metric">
          <option value="cpu">CPU %</option>
          <option value="mem">MEM %</option>
          <option value="net">NET B/s</option>
        </select>
      </label>
      <label class="ctl">Op
        <select data-field="op">
          <option value=">">&gt;</option>
          <option value="<">&lt;</option>
          <option value=">=">&gt;=</option>
          <option value="<=">&lt;=</option>
          <option value="=">=</option>
        </select>
      </label>
      <label class="ctl">Threshold <input data-field="threshold" type="number" step="any" value="80" /></label>
    </span>
    <span data-fields="log" hidden>
      <label class="ctl block">Regex <input data-field="pattern" type="text" placeholder="e.g. ERROR|FATAL" /></label>
    </span>
    <button type="button" data-remove-condition>Remove</button>
  `;
  row.querySelector('[data-field="type"]').onchange = (e) => {
    const isMetric = e.target.value === "metric";
    row.querySelector('[data-fields="metric"]').hidden = !isMetric;
    row.querySelector('[data-fields="log"]').hidden = isMetric;
  };
  row.querySelector("[data-remove-condition]").onclick = () => {
    row.remove();
    syncEventMatchRowVisibility();
  };
  box.appendChild(row);
  syncEventMatchRowVisibility();
}
$("event-add-condition").onclick = addEventConditionRow;
function syncEventMatchRowVisibility() {
  $("event-match-row").hidden = $("event-conditions").children.length < 2;
}

function syncEventActionFields() {
  const isSnapshot = $("event-action-kind").value === "snapshot";
  $("event-action-minutes-row").hidden = !isSnapshot;
  $("event-action-duration-row").hidden = isSnapshot;
}
$("event-action-kind").onchange = syncEventActionFields;
$("event-safe").onchange = (e) => { $("event-max-keep-row").hidden = !e.target.checked; };

function buildEventConditions() {
  return [...document.querySelectorAll("[data-condition-row]")].map((row) => {
    const type = row.querySelector('[data-field="type"]').value;
    if (type === "metric") {
      return {
        type: "metric",
        metric: row.querySelector('[data-field="metric"]').value,
        op: row.querySelector('[data-field="op"]').value,
        threshold: Number(row.querySelector('[data-field="threshold"]').value),
      };
    }
    return { type: "log", pattern: row.querySelector('[data-field="pattern"]').value };
  });
}
function buildEventAction() {
  const kind = $("event-action-kind").value;
  return {
    kind,
    minutes: kind === "snapshot" ? Number($("event-action-minutes").value) : null,
    duration_minutes: kind === "recording" ? Number($("event-action-duration").value) : null,
    safe: $("event-safe").checked,
    max_keep_seconds: $("event-safe").checked ? Number($("event-max-keep").value) : null,
  };
}

$("dlg-event-create").onclick = async () => {
  const name = $("event-name").value.trim() || "unnamed event";
  const sourceIds = selectedEventSystems();
  const conditions = buildEventConditions();
  const action = buildEventAction();
  const match = $("event-match").value;
  if (!conditions.length) { notifyEvent("add at least one condition"); return; }
  // Gateway-hosted conditions are validated server-side (events.py's
  // _validate: a bad regex or a NaN-turned-null threshold both 400 there) --
  // UI-hosted ones have no server to reject them, so an invalid value would
  // otherwise be stored to localStorage as-is: a NaN/blank threshold
  // silently breaks every future comparison (ui-EVT-003), and an invalid
  // regex throws uncaught from uiEventTick's setInterval callback on every
  // tick, which (since that throw aborts the loop before saveUiEvents runs)
  // silently stops evaluating and persisting cursor progress for every OTHER
  // UI-hosted event too, not just this one (ui-EVT-004).
  //
  // Validated against the raw field values, not `conditions` (already built
  // via Number(...)/read as-is above): a `type="number"` input silently
  // sanitizes anything it can't parse (empty included) down to "" rather
  // than leaving it as typed, and Number("") is 0 -- a legitimate threshold,
  // not something Number.isFinite would ever catch -- so "was this field
  // actually left blank/unparseable" can only be answered from its raw
  // string, before that coercion already happened.
  const isUiHosted = editingEvent ? editingEvent.hosted !== "gateway" : $("event-hosted").value !== "gateway";
  if (isUiHosted) {
    for (const row of document.querySelectorAll("[data-condition-row]")) {
      const type = row.querySelector('[data-field="type"]').value;
      if (type === "metric") {
        const raw = row.querySelector('[data-field="threshold"]').value;
        if (raw.trim() === "" || !Number.isFinite(Number(raw))) {
          notifyEvent("threshold must be a valid number");
          return;
        }
      } else {
        const pattern = row.querySelector('[data-field="pattern"]').value;
        try {
          new RegExp(pattern);
        } catch {
          notifyEvent(`invalid regex: ${pattern}`);
          return;
        }
      }
    }
  }
  try {
    if (editingEvent) {
      const { id, hosted } = editingEvent;
      if (hosted === "gateway") {
        await post(`/events/${id}/update`, { name, source_ids: sourceIds, conditions, match, action });
      } else {
        const list = loadUiEvents();
        const ev = list.find((x) => x.id === id);
        if (ev) Object.assign(ev, { name, sourceIds, conditions, match, action });
        saveUiEvents(list);
      }
      notifyEvent(`Event "${name}" updated`);
    } else if ($("event-hosted").value === "gateway") {
      await post("/events/create", { name, source_ids: sourceIds, conditions, match, action });
      notifyEvent(`Event "${name}" created`);
    } else {
      const list = loadUiEvents();
      list.push({
        id: `ui${Date.now()}`,
        name, sourceIds, conditions, match, action,
        enabled: true, status: "armed", armed: true,
        triggeredAt: null, triggerDetail: null, artifactPath: null,
        logCursors: {}, // {conditionIndex: {sourceId: rowsScanned}}
      });
      saveUiEvents(list);
      notifyEvent(`Event "${name}" created`);
    }
    dlgEventForm.close();
  } catch (err) {
    notifyEvent(`could not ${editingEvent ? "update" : "create"} event: ` + (err.message || err));
  }
};

// one row per event, gateway- and UI-hosted alike, each with its own
// enable/disable, reset (re-arm after a trigger), and delete/cancel
function renderEventRow(ev, hosted) {
  const row = document.createElement("div");
  row.className = "ctl block";
  const condText = (c) => (c.type === "metric" ? `${c.metric} ${c.op} ${c.threshold}` : `log ~ /${c.pattern}/`);
  const conditions = (ev.conditions || []).map(condText).join(ev.match === "all" ? " AND " : " OR ");
  const act = ev.action.kind === "snapshot" ? `snapshot (last ${ev.action.minutes}m)` : `record ${ev.action.duration_minutes}m`;
  row.textContent = `[${hosted}] ${ev.name} -- ${conditions} -> ${act} -- ${ev.status}${ev.status === "triggered" ? ` (${ev.trigger_detail || ev.triggerDetail || ""})` : ""} `;

  const mkBtn = (label, fn) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.type = "button";
    b.onclick = fn;
    return b;
  };
  const id = hosted === "gateway" ? ev.event_id : ev.id;
  row.appendChild(mkBtn("Update", () => openEventEditForm(ev, hosted)));
  row.appendChild(mkBtn(ev.enabled ? "Disable" : "Enable", async () => {
    if (hosted === "gateway") await post(`/events/${id}/${ev.enabled ? "disable" : "enable"}`, {});
    else { const list = loadUiEvents(); const e = list.find((x) => x.id === id); e.enabled = !e.enabled; saveUiEvents(list); }
    refreshEventsList();
  }));
  if (ev.status === "triggered") {
    row.appendChild(mkBtn("Reset", async () => {
      if (hosted === "gateway") await post(`/events/${id}/reset`, {});
      else { const list = loadUiEvents(); const e = list.find((x) => x.id === id); e.armed = true; e.status = "armed"; saveUiEvents(list); }
      refreshEventsList();
    }));
    const artifactId = hosted === "gateway" ? ev.artifact_id : ev.artifactPath;
    if (artifactId) {
      row.appendChild(mkBtn("Save…", async () => {
        try {
          if (hosted === "gateway") {
            const res = await fetch(`${API}/session/${artifactId}/download`, { headers: authHeaders() });
            if (!res.ok) throw new Error(`download failed: ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            const ext = res.headers.get("Content-Disposition")?.includes(".cttc-record") ? ".cttc-record" : ".cttc-metric";
            await saveBinaryFile(`${ev.name}-${id}${ext}`, bytes);
          } else if (window.cttc?.readFile) {
            const bytes = await window.cttc.readFile(artifactId);
            await saveBinaryFile(artifactId.split("/").pop(), bytes);
          }
        } catch (err) {
          notifyEvent("could not save event artifact: " + (err.message || err));
        }
      }));
    }
  }
  row.appendChild(mkBtn(hosted === "gateway" ? "Cancel" : "Delete", async () => {
    if (hosted === "gateway") await post(`/events/${id}/cancel`, {});
    else saveUiEvents(loadUiEvents().filter((x) => x.id !== id));
    refreshEventsList();
  }));
  return row;
}

async function refreshEventsList() {
  const box = $("events-list");
  box.innerHTML = "";
  try {
    const { event_ids } = await get("/events/list");
    for (const id of event_ids) {
      const ev = await get(`/events/${id}`);
      box.appendChild(renderEventRow(ev, "gateway"));
    }
  } catch {
    /* gateway may not support /events (older server) -- UI events still work */
  }
  for (const ev of loadUiEvents()) box.appendChild(renderEventRow(ev, "ui"));
  if (!box.children.length) box.textContent = "No events yet.";
}

/* ── UI-hosted event engine: evaluates conditions against data this window
   already has (or a small targeted fetch), triggers via the same
   /files/download + /session/start primitives the manual features use,
   and saves the result locally via window.cttc.saveEventArtifact (silent
   -- no save dialog, since nobody's necessarily watching a background
   trigger). Metric conditions read the last non-null bucket already in
   state.series (the chart's own live-tailing data); log conditions poll
   /logs for the tail added since the last check, same cursor idea as the
   gateway's own events.py. */
const _OPS_JS = {
  ">": (v, t) => v > t, "<": (v, t) => v < t,
  ">=": (v, t) => v >= t, "<=": (v, t) => v <= t, "=": (v, t) => v === t,
};
function uiEventMonitoredIds(ev) {
  return ev.sourceIds?.length ? ev.sourceIds : state.sources.map((s) => s.id);
}
function checkUiMetricCondition(ev, cond) {
  const ids = new Set(uiEventMonitoredIds(ev));
  const cmp = _OPS_JS[cond.op];
  for (const svc of state.series?.services || []) {
    if (!ids.has(svc.sid)) continue;
    const arr = svc[cond.metric] || [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null) return cmp(arr[i], cond.threshold) ? `${svc.sid}/${svc.name}: ${cond.metric}=${arr[i]}` : null;
    }
  }
  return null;
}
// a log condition only watches lines appended after its cursor -- cursors
// are keyed per condition index (not just source id) so two log conditions
// on the same source in one event never share (and so corrupt) each
// other's read position, mirroring events.py's own per-condition cursors
async function checkUiLogCondition(ev, cond, condIndex) {
  const pattern = new RegExp(cond.pattern);
  const cursors = (ev.logCursors[condIndex] ||= {});
  for (const sid of uiEventMonitoredIds(ev)) {
    const src = state.sources.find((s) => s.id === sid && s.kind === "log");
    if (!src) continue;
    const start = cursors[sid] || 0;
    try {
      const { total, rows } = await get(`/logs?source=${sid}&start=${start}&count=200`);
      cursors[sid] = total;
      for (const r of rows) if (pattern.test(r.text)) return `${sid}: matched ${JSON.stringify(r.text)}`;
    } catch { /* source may have closed since -- skip this tick */ }
  }
  return null;
}
// every condition is always evaluated (never short-circuited) so a log
// condition's cursor keeps advancing regardless of `match` or of an
// earlier condition already having fired -- mirrors events.py's _check()
async function checkUiConditions(ev) {
  const details = [];
  for (let i = 0; i < ev.conditions.length; i++) {
    const cond = ev.conditions[i];
    details.push(cond.type === "metric" ? checkUiMetricCondition(ev, cond) : await checkUiLogCondition(ev, cond, i));
  }
  const hits = details.filter((d) => d != null);
  if (ev.match === "all") return hits.length === ev.conditions.length ? hits.join("; ") : null;
  return hits[0] || null;
}

async function fireUiEvent(ev, detail) {
  ev.armed = false;
  ev.status = "triggered";
  ev.triggeredAt = Date.now();
  ev.triggerDetail = detail;
  ev.triggerCount = (ev.triggerCount || 0) + 1;
  notifyEvent(`Event "${ev.name}" fired (${detail})`);
  try {
    if (ev.action.kind === "snapshot") {
      const t1 = Date.now(), t0 = t1 - ev.action.minutes * 60000;
      const params = new URLSearchParams({ from: t0, to: t1, include_host: "1" });
      const res = await fetch(`${API}/files/download?${params}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`snapshot failed: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = `${ev.name}-${ev.id}.cttc-metric`;
      const opts = { safe: ev.action.safe, maxKeepMs: ev.action.max_keep_seconds ? ev.action.max_keep_seconds * 1000 : null };
      ev.artifactPath = window.cttc?.saveEventArtifact ? await window.cttc.saveEventArtifact(name, bytes, opts) : null;
    } else {
      const { session_id } = await post("/session/start", {
        duration_minutes: ev.action.duration_minutes, safe: ev.action.safe, max_keep_seconds: ev.action.max_keep_seconds,
      });
      ev.artifactPath = session_id; // resolved to a real local path once the recording completes, see uiEventTick's poll
      ev._pendingGatewaySessionId = session_id;
    }
  } catch (err) {
    notifyEvent(`event "${ev.name}" trigger failed: ` + (err.message || err));
  }
  saveUiEvents(loadUiEvents().map((x) => (x.id === ev.id ? ev : x)));
}

// once a UI-hosted recording action's gateway session completes, fetch the
// bytes and replace the placeholder session id with a real local path
async function resolvePendingUiRecordings() {
  const list = loadUiEvents();
  let changed = false;
  for (const ev of list) {
    if (!ev._pendingGatewaySessionId) continue;
    try {
      const st = await get(`/session/${ev._pendingGatewaySessionId}/status`);
      if (!st.ready) continue;
      const res = await fetch(`${API}/session/${ev._pendingGatewaySessionId}/download`, { headers: authHeaders() });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = `${ev.name}-${ev.id}.cttc-record`;
      const opts = { safe: ev.action.safe, maxKeepMs: ev.action.max_keep_seconds ? ev.action.max_keep_seconds * 1000 : null };
      ev.artifactPath = window.cttc?.saveEventArtifact ? await window.cttc.saveEventArtifact(name, bytes, opts) : null;
      delete ev._pendingGatewaySessionId;
      changed = true;
    } catch { /* not ready yet, or gateway unreachable this tick */ }
  }
  if (changed) saveUiEvents(list);
}

// gateway-hosted events trigger entirely server-side (see events.py's own
// tick()) -- this window only finds out by polling, so it has to remember
// each event's last-seen status itself to notice the armed -> triggered
// transition (and only notify once per transition, not every poll).
const gatewayEventLastStatus = new Map();
async function pollGatewayEventTriggers() {
  try {
    const { event_ids } = await get("/events/list");
    for (const id of event_ids) {
      const st = await get(`/events/${id}`);
      const last = gatewayEventLastStatus.get(id);
      if (st.status === "triggered" && last !== "triggered") {
        notifyEvent(`Event "${st.name}" fired (${st.trigger_detail || ""})`);
      }
      gatewayEventLastStatus.set(id, st.status);
    }
    for (const id of [...gatewayEventLastStatus.keys()]) {
      if (!event_ids.includes(id)) gatewayEventLastStatus.delete(id); // cancelled elsewhere
    }
  } catch { /* gateway may be unreachable this tick, or not support /events/* yet */ }
}

// An event keeps watching until disabled or deleted -- there's no one-shot
// "fires once and waits" state. To avoid re-firing (and re-snapshotting/
// re-recording) on every tick for as long as a condition happens to stay
// true, firing is edge-triggered via `ev.armed` (mirrors events.py's own
// `_armed` latch): only a not-met -> met transition fires; once met,
// `armed` goes false until the condition is seen not-met again.
async function uiEventTick() {
  if (POPOUT_KIND) return; // one evaluator per app instance is enough
  await resolvePendingUiRecordings();
  await pollGatewayEventTriggers();
  const list = loadUiEvents();
  for (const ev of list) {
    if (!ev.enabled) continue;
    const detail = await checkUiConditions(ev);
    if (detail) {
      if (ev.armed !== false) await fireUiEvent(ev, detail);
      ev.status = "triggered";
    } else {
      ev.armed = true;
      ev.status = "armed";
    }
  }
  saveUiEvents(list); // persists log cursor advances even without a trigger
}
if (!POPOUT_KIND) setInterval(uiEventTick, 3000);

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
    clearTimeout(statusBarClearTimer);
    $("app-status-bar-text").textContent = "";
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
  if (view === "live") {
    setLiveHidden(false);
    return;
  }
  state.activeSamplePath = view;
  setLiveHidden(true);
}

// Closes every loaded sample/recording source outright (live collection,
// per its own docstring, was never stopped -- there's nothing else "live"
// to resume) -- setLiveHidden(false) then follows automatically from
// refreshAll() once no sample sources remain.
$("btn-back-to-live").onclick = async () => {
  const sampleSources = state.sources.filter((s) => s.live === false);
  await Promise.all(sampleSources.map((s) => post("/close", { id: s.id })));
  await refreshAll();
};

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
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  if (isMac) {
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
    const mod = isMac ? e.metaKey : e.ctrlKey;
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


refreshAll().then(async () => {
  if (POPOUT_KIND) return; // popout windows never restore/set sources on their own
  if (state.sources.length === 0) {
    // nothing open yet (fresh install, or the last session's sources are all
    // closed): try to reopen the containers/services collected last time.
    const sessions = prefs.get("lastDockerSessions", []);
    if (sessions.length) {
      try {
        await Promise.all(sessions.map((req) => post("/docker/collect", req)));
        await refreshAll();
      } catch { /* remembered host(s) unreachable; fall through below */ }
    }
  }
  if (state.sources.length === 0) $("btn-set").click(); // still nothing: prompt right away
});
connectSSE();

/* ── Gateway/Docker Host pills (status bar) close each other's overlay
   (status popup, switcher dropdown, or right-click actions menu) the
   moment one of them opens its own -- each overlay anchors to its own
   wrapper's edge, so two open at once could otherwise visually run into
   each other or into unrelated controls. The pill (button) itself is
   never hidden -- only ever a *different* pill's already-open overlay,
   never the one that just opened. */
function gatewayMenuOpen() {
  const dropdown = $("gateway-dropdown");
  return (dropdown ? !dropdown.hidden : false) || document.getElementById("ctxmenu")?.dataset.owner === "gateway";
}
function gatewayHasOverlay() {
  const popup = $("connection-info-popup");
  return (popup ? !popup.hidden : false) || gatewayMenuOpen();
}
function closeGatewayOverlay() {
  const popup = $("connection-info-popup");
  if (popup) popup.hidden = true;
  const dropdown = $("gateway-dropdown");
  if (dropdown && !dropdown.hidden) {
    dropdown.hidden = true;
    $("server-status")?.classList.remove("open");
  }
  if (document.getElementById("ctxmenu")?.dataset.owner === "gateway") closeCtxMenu();
}
function dockerHostMenuOpen() {
  const dropdown = $("docker-host-dropdown");
  return (dropdown ? !dropdown.hidden : false) || document.getElementById("ctxmenu")?.dataset.owner === "dockerhost";
}
function dockerHostHasOverlay() {
  const popup = $("docker-host-info-popup");
  return (popup ? !popup.hidden : false) || dockerHostMenuOpen();
}
function closeDockerHostOverlay() {
  const popup = $("docker-host-info-popup");
  if (popup) popup.hidden = true;
  const dropdown = $("docker-host-dropdown");
  if (dropdown && !dropdown.hidden) {
    dropdown.hidden = true;
    $("docker-host-status")?.classList.remove("open");
  }
  if (document.getElementById("ctxmenu")?.dataset.owner === "dockerhost") closeCtxMenu();
}
const TOOLBAR_PILLS = {
  gateway: { hasOverlay: gatewayHasOverlay, closeOverlay: closeGatewayOverlay },
  dockerhost: { hasOverlay: dockerHostHasOverlay, closeOverlay: closeDockerHostOverlay },
};
// Called right after a pill (actingId: "gateway"/"dockerhost") opens its
// own overlay, closing every *other* pill's overlay -- never its own, and
// never the pill (button) itself. Takes the acting pill explicitly rather
// than inferring "whichever is engaged": none of these overlays (dropdown,
// right-click menu, status popup) self-close on their own, so it's
// entirely possible for a *different* pill's overlay to still be
// genuinely open (not just stale) at the exact moment this one opens --
// inferring priority from array order would arbitrarily close whichever
// one happened to come first instead of the one that isn't the pill
// actually acting right now.
function syncPillPeerVisibility(actingId) {
  for (const [id, pill] of Object.entries(TOOLBAR_PILLS)) {
    if (id !== actingId && pill.hasOverlay()) pill.closeOverlay();
  }
}

// Gateway/Docker Host pills' "Current Status" right-click entry -- no
// action-bar button of its own to clone an icon from (ctxMenu's usual
// convention), so this is passed as raw markup instead.
const CLIPBOARD_ICON_SVG = '<svg viewBox="0 0 512 512" fill="currentColor" aria-hidden="true"><path d="M174.618,245.394c-5.857-5.858-15.355-5.858-21.213,0l-49.394,49.394l-19.394-19.394c-5.857-5.858-15.355-5.858-21.213,0 c-5.858,5.858-5.858,15.355,0,21.213l30.002,30c2.929,2.929,6.768,4.393,10.606,4.393s7.678-1.464,10.606-4.393l60-60 C180.476,260.749,180.476,251.252,174.618,245.394z"/><path d="M174.618,365.394c-5.857-5.858-15.355-5.858-21.213,0l-49.394,49.394l-19.394-19.394c-5.857-5.858-15.355-5.858-21.213,0 c-5.858,5.858-5.858,15.355,0,21.213l30.002,30c2.929,2.929,6.768,4.393,10.606,4.393s7.678-1.464,10.606-4.393l60-60 C180.476,380.749,180.476,371.252,174.618,365.394z"/><path d="M159.62,185.394L140.226,166l19.393-19.393c5.858-5.858,5.858-15.355,0-21.213c-5.857-5.858-15.355-5.858-21.213,0 l-19.394,19.394l-19.394-19.394c-5.857-5.858-15.355-5.858-21.213,0c-5.858,5.858-5.858,15.355,0,21.213L97.799,166 l-19.393,19.393c-5.858,5.858-5.858,15.356,0,21.214c5.857,5.857,15.355,5.858,21.213,0l19.394-19.394l19.394,19.394 c5.857,5.857,15.355,5.858,21.213,0C165.478,200.749,165.478,191.252,159.62,185.394z"/><path d="M498.833,149.62c-17.55-17.54-46.09-17.54-63.64,0c-2.73,2.73-69.69,69.7-73.18,73.18V75c0-24.81-20.19-45-45-45h-47.58 c-6.19-17.46-22.87-30-42.42-30h-92c-19.55,0-36.23,12.54-42.42,30h-47.58c-24.81,0-45,20.19-45,45v392c0,24.81,20.19,45,45,45 h272c24.81,0,45-20.19,45-45V350.08l83.79-83.79l10.6,10.61c5.87,5.86,5.87,15.35,0,21.21l-63.64,63.64 c-5.85,5.86-5.85,15.36,0,21.22c5.86,5.85,15.36,5.86,21.22,0l63.64-63.64c17.58-17.59,17.59-46.05,0-63.64l-10.61-10.61 l31.82-31.82C516.372,195.72,516.372,167.17,498.833,149.62z M135.012,30h92c8.27,0,15,6.73,15,15s-6.73,15-15,15h-92 c-8.27,0-15-6.73-15-15S126.742,30,135.012,30z M332.013,467c0,8.27-6.73,15-15,15h-272c-8.27,0-15-6.73-15-15V75 c0-8.27,6.73-15,15-15h47.58c6.19,17.46,22.87,30,42.42,30h92c19.55,0,36.23-12.54,42.42-30h47.58c8.27,0,15,6.73,15,15v177.8 l-108.95,108.95c-1.65,1.65-2.89,3.66-3.63,5.87l-21.21,63.64c-1.8,5.39-0.39,11.33,3.62,15.35c4.03,4.02,9.97,5.41,15.35,3.62 l63.64-21.21c2.21-0.74,4.22-1.98,5.87-3.63l21.21-21.21l24.1-24.1V467z M254.883,372.36l21.21,21.21l-8.1,8.11l-31.82,10.6 l10.61-31.82L254.883,372.36z M297.302,372.36l-21.21-21.21l127.28-127.28l21.21,21.21L297.302,372.36z M477.622,192.05 l-31.82,31.82l-21.22-21.22l31.82-31.82c5.85-5.84,15.37-5.84,21.22,0C483.472,176.68,483.472,186.2,477.622,192.05z"/></svg>';

/* ── server status indicator (status bar, just left of History) ──────────
   Polls /health independently of connectSSE's own stream so it still shows
   "down" if the SSE connection itself is what's wedged. Only present in the
   main window -- harmless no-op elsewhere since $() returns null. */
(() => {
  const el = $("server-status");
  if (!el) return;
  const btn = $("server-status-btn");
  // Static for the life of this window (HOST/PORT are set once, from the
  // URL main.js loaded it with) -- where the gateway actually is, not just
  // whether it's reachable, matters most for "remote" mode (see
  // docs/architecture/remote-server.md), where it's easy to forget which
  // host is actually being talked to. HOST/PORT alone can't tell a tunneled
  // connection apart from a genuinely local one though (both are
  // 127.0.0.1) -- getConnectionInfo (below) fills that gap. Kept out of the
  // pill's own visible text (see setState) -- surfaced only as a tooltip,
  // for anyone hovering, not printed inline next to the dot.
  const statusHost = HOST === "127.0.0.1" ? "localhost" : HOST;
  let locationLabel = PORT == null || PORT === "null" ? statusHost : `${statusHost}:${PORT}`;

  // Tunneled connections talk over 127.0.0.1 (HOST/PORT above), but showing
  // "localhost" there would hide which gateway is actually active -- swap
  // in the real gateway host:port + a "(tunnel)" suffix once
  // getConnectionInfo confirms that's what this connection is.
  // connectionType/gateway identity/ssh info aren't in the URL's host=&port=
  // to begin with (those are just the client-facing address), so they're
  // fetched separately from main.js's connection state.
  let connectionInfo = null;
  async function loadConnectionInfo() {
    if (!window.cttc?.getConnectionInfo) return;
    connectionInfo = await window.cttc.getConnectionInfo();
    if (connectionInfo.connectionType === "remote-tunnel") {
      const loc = connectionInfo.gatewayPort == null
        ? connectionInfo.gatewayHost
        : `${connectionInfo.gatewayHost}:${connectionInfo.gatewayPort}`;
      locationLabel = `${loc} (tunnel)`;
      btn.title = `${locationLabel} — Switch gateway…`;
    }
  }
  loadConnectionInfo();

  const popup = $("connection-info-popup");
  function renderInfoRow(label, val) {
    const row = document.createElement("div");
    row.className = "cip-row";
    const l = document.createElement("span");
    l.className = "cip-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "cip-val";
    v.textContent = val;
    row.append(l, v);
    return row;
  }
  // "Current Status" (right-click, see below): the same connection detail
  // this used to show on hover (Connection/Gateway/ssh target/port) --
  // moved behind a click per explicit user direction ("hover tag" showing
  // nothing anymore). Async (loadConnectionInfo awaits a real IPC round
  // trip) -- the popup itself only appears once that resolves, which
  // naturally lands after the triggering click has finished dispatching,
  // so the "click outside closes it" listener added at the end never sees
  // that same click as the one that should close it.
  function showGatewayStatus() {
    if (!popup) return;
    loadConnectionInfo().then(() => {
      popup.innerHTML = "";
      popup.appendChild(renderInfoRow("Connection", connectionInfo.connectionType));
      if (connectionInfo.connectionType !== "local") {
        popup.appendChild(renderInfoRow("Gateway", `${connectionInfo.gatewayHost}:${connectionInfo.gatewayPort}`));
      }
      if (connectionInfo.connectionType === "remote-tunnel") {
        const sep = document.createElement("div");
        sep.className = "cip-sep";
        popup.appendChild(sep);
        popup.appendChild(renderInfoRow("ssh target", connectionInfo.sshTarget));
        if (connectionInfo.sshPort) popup.appendChild(renderInfoRow("ssh port", String(connectionInfo.sshPort)));
        popup.appendChild(renderInfoRow("forwarded port", `localhost:${connectionInfo.port}`));
      }
      popup.hidden = false;
      syncPillPeerVisibility("gateway");
      document.addEventListener("click", function onOutside(e) {
        if (!el.contains(e.target)) popup.hidden = true;
      }, { once: true });
    });
  }
  // Right-click: New/Edit/Uninstall Gateway, the same actions the action
  // bar's Gateway group already exposes, plus Current Status (ctxMenu is
  // the shared generic context-menu helper, also used by the legend/
  // chart-time menus).
  el.addEventListener("contextmenu", (e) => {
    if (popup) popup.hidden = true; // don't show both at once
    ctxMenu(e, [
      ["New Gateway…", () => openNewGatewayDialog(), '[data-action="new-gateway"]'],
      ["Edit Gateway", () => openEditGatewaysDialog(), '[data-action="edit-gateways"]'],
      ["Uninstall Gateway…", () => openUninstallGatewayDialog(), '[data-action="uninstall-gateway"]'],
      "separator",
      ["Current Status", showGatewayStatus, CLIPBOARD_ICON_SVG],
    ], "gateway");
    syncPillPeerVisibility("gateway");
  });

  const HEALTH_POLL_MS = 5000;
  // The status pill itself only ever shows a colored dot -- the gateway
  // location lives in this tooltip instead (see locationLabel above), and
  // failure text goes to the bottom status bar (notifyEvent), not a
  // tooltip nobody's necessarily hovering over.
  const setState = (state) => {
    el.dataset.state = state;
    btn.title = `${locationLabel} — Switch gateway…`;
  };
  let checking = false;
  // The last *confirmed* (up/down) state, for edge-detecting the
  // notifyEvent transition -- el.dataset.state itself gets a transient
  // "checking" flash first (below), which would otherwise erase "down"
  // before this same call learns whether it recovered.
  let lastConfirmed = null;
  const check = async () => {
    // setInterval doesn't wait for a previous call to finish -- a slow
    // /health round trip overlapping the next tick could otherwise race
    // two checks against the same dataset.state/notifyEvent, flapping the
    // down/up transition text. One in-flight check at a time.
    if (checking) return;
    checking = true;
    try {
      // Only flash "checking" when we don't already know the answer --
      // once "up", routine re-polls shouldn't flicker the dot on every
      // request.
      if (el.dataset.state !== "up") setState("checking");
      try {
        await get("/health");
        if (lastConfirmed === "down") notifyEvent("Gateway connection restored");
        lastConfirmed = "up";
        setState("up");
      } catch (err) {
        // only notify on the down transition -- not every 5s re-poll
        // while it stays down
        if (lastConfirmed !== "down") notifyEvent(`Gateway connection failed: ${err.message || err}`);
        lastConfirmed = "down";
        setState("down");
      }
    } finally {
      checking = false;
    }
  };
  check();
  setInterval(check, HEALTH_POLL_MS);
})();

/* ── gateway dropdown (click the status pill) ─────────────────────────────
   Lists every gateway this client has ever actually connected to (see
   lib/gateway-registry.js, recorded server-side in main.js right after a
   connect succeeds) so switching back to one doesn't mean re-typing an ssh
   target from scratch. Picking a non-active one re-verifies it's still up
   (main.js's switch-gateway) before writing connection.json and offering a
   restart -- never blind-trusts a stale entry. */
(() => {
  const wrap = $("server-status");
  const btn = $("server-status-btn");
  const dropdown = $("gateway-dropdown");
  if (!wrap || !window.cttc?.getGateways) return;

  const close = () => {
    wrap.classList.remove("open");
    dropdown.hidden = true;
  };

  const render = (gateways) => {
    dropdown.innerHTML = "";
    if (!gateways.length) {
      const empty = document.createElement("div");
      empty.className = "gateway-empty";
      empty.textContent = "No other gateways yet — Run Setup to add one.";
      dropdown.appendChild(empty);
      return;
    }
    gateways.forEach((g, i) => {
      if (i > 0) {
        const sep = document.createElement("div");
        sep.className = "gateway-item-sep";
        dropdown.appendChild(sep);
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "gateway-item";
      item.dataset.active = String(!!g.active);
      const label = document.createElement("span");
      label.className = "gateway-item-label";
      label.textContent = g.label || g.host;
      const loc = document.createElement("span");
      loc.className = "gateway-item-loc";
      const locHost = g.host === "127.0.0.1" ? "localhost" : g.host;
      loc.textContent = g.port == null ? locHost : `${locHost}:${g.port}`;
      item.append(label, loc);
      if (!g.active) {
        item.onclick = async () => {
          close();
          notifyEvent(`Switching to ${g.label || g.host}…`);
          const r = await window.cttc.switchGateway(g);
          if (!r.ok) notifyEvent(r.error);
        };
      }
      dropdown.appendChild(item);
    });
    // Passive per-item reachability, checked fresh every time the dropdown
    // opens -- purely informational (including for the active entry, if
    // it's the one that's gone down): never triggers a switch on its own,
    // just flags the item so it's visible before you try it, or notice the
    // gateway you're already on has stopped responding.
    const items = [...dropdown.querySelectorAll(".gateway-item")];
    gateways.forEach((g, i) => {
      window.cttc.checkGateway(g).then((ok) => {
        items[i].dataset.reachable = String(ok);
      });
    });
  };

  btn.onclick = async (e) => {
    e.stopPropagation();
    if (wrap.classList.contains("open")) {
      close();
      return;
    }
    const infoPopup = $("connection-info-popup");
    if (infoPopup) infoPopup.hidden = true; // don't show both at once
    wrap.classList.add("open");
    dropdown.hidden = false;
    render(await window.cttc.getGateways());
    syncPillPeerVisibility("gateway");
  };
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();

/* ── Docker host dropdown (click the pill beside the gateway one) ────────
   Lists every Docker host ever Connected/Updated (dockerHostHistory(), the
   same catalog behind Connect Docker Host's own "Load Docker Host" picker),
   flagging whichever one is currently connected. Picking a different one
   reuses that dialog's Load Docker Host step to pre-fill it -- since only
   one Docker host is ever connected at a time (see currentDockerHost),
   this confirms disconnecting the current one first via the same confirm()
   Disconnect itself already asks, never silently dropping it. The pill's
   dot/tooltip (syncPill) track the connection live, independent of the
   dropdown ever having been opened -- see refreshDockerHostPill. */
(() => {
  const wrap = $("docker-host-status");
  const btn = $("docker-host-status-btn");
  const dropdown = $("docker-host-dropdown");
  if (!wrap) return;

  const close = () => {
    wrap.classList.remove("open");
    dropdown.hidden = true;
  };

  const openHost = async (hostKey) => {
    close();
    if (hasDockerDaemon()) {
      await $("btn-clear-sources").onclick();
      if (hasDockerDaemon()) return; // confirm declined -- leave the current host connected
    }
    openNewDockerHostDialog(); // nothing connected now -- opens New Docker Host (its "Load Docker Host"
                               // select is still populated even though the row itself stays hidden, see
                               // openNewDockerHostDialog -- driving it programmatically here is unaffected)
    $("docker-host-history").value = hostKey;
    await $("docker-host-history").onchange();
  };

  const render = () => {
    const active = syncPill();
    dropdown.innerHTML = "";
    const history = dockerHostHistory();
    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "gateway-empty";
      empty.textContent = "No Docker hosts yet — New Docker Host to add one.";
      dropdown.appendChild(empty);
      return;
    }
    history.forEach((entry, i) => {
      if (i > 0) {
        const sep = document.createElement("div");
        sep.className = "gateway-item-sep";
        dropdown.appendChild(sep);
      }
      const item = document.createElement("button");
      item.type = "button";
      item.className = "gateway-item";
      item.dataset.active = String(entry.hostKey === active);
      const label = document.createElement("span");
      label.className = "gateway-item-label";
      label.textContent = entry.hostKey === "local" ? "localhost" : entry.hostKey.replace(/^ssh:\/\//, "");
      item.appendChild(label);
      if (entry.hostKey !== active) item.onclick = () => openHost(entry.hostKey);
      dropdown.appendChild(item);
    });
  };

  // "Current Status" (right-click, see below): SSH connection/key + which
  // transforms are on for the connected host (see server/transforms/*.py
  // -- exactly these three exist today), styled like the Gateway pill's
  // own info popup (same shared CSS class) -- moved behind a click per
  // explicit user direction ("hover tag" showing nothing anymore).
  const infoPopup = $("docker-host-info-popup");
  const TRANSFORM_NAMES = ["drop_healthchecks", "json_message", "parse_level"];
  function renderInfoRow(label, val) {
    const row = document.createElement("div");
    row.className = "cip-row";
    const l = document.createElement("span");
    l.className = "cip-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "cip-val";
    v.textContent = val;
    row.append(l, v);
    return row;
  }
  function showDockerHostStatus() {
    if (!infoPopup) return;
    const active = hasDockerDaemon() ? currentDockerHost() || "local" : null;
    infoPopup.innerHTML = "";
    if (active == null) {
      infoPopup.appendChild(renderInfoRow("Docker host", "not connected"));
    } else {
      const entry = prefs.get("savedDockerDaemons", {})[active];
      const label = active === "local" ? "localhost" : active.replace(/^ssh:\/\//, "");
      infoPopup.appendChild(renderInfoRow("SSH Connection", label));
      infoPopup.appendChild(renderInfoRow("SSH Key", entry?.ssh_key || "---"));
      const sep = document.createElement("div");
      sep.className = "cip-sep";
      infoPopup.appendChild(sep);
      for (const name of TRANSFORM_NAMES) {
        infoPopup.appendChild(renderInfoRow(name.replace(/_/g, " "), entry?.transforms?.includes(name) ? "True" : "False"));
      }
    }
    infoPopup.hidden = false;
    syncPillPeerVisibility("dockerhost");
    // Deferred to the next task: showDockerHostStatus runs synchronously
    // as part of the ctxmenu item's own click, which is still bubbling
    // when this returns -- attaching the listener before that finishes
    // would let this same click immediately count as the "outside click"
    // that closes what it just opened.
    setTimeout(() => {
      document.addEventListener("click", function onOutside(e) {
        if (!wrap.contains(e.target)) infoPopup.hidden = true;
      }, { once: true });
    }, 0);
  }
  // Right-click: New/Edit/Remove Docker Host -- the same actions the action
  // bar's Docker Host group already exposes, plus Current Status.
  wrap.addEventListener("contextmenu", (e) => {
    if (infoPopup) infoPopup.hidden = true; // don't show both at once
    ctxMenu(e, [
      ["New Docker Host…", () => openNewDockerHostDialog(), "#btn-set"],
      ["Edit Docker Host", () => openEditDockerHostDialog(), "#btn-edit-docker-host"],
      ["Remove Docker Host…", () => $("btn-remove-docker-daemon").click(), "#btn-remove-docker-daemon"],
      "separator",
      ["Current Status", showDockerHostStatus, CLIPBOARD_ICON_SVG],
    ], "dockerhost");
    syncPillPeerVisibility("dockerhost");
  });

  // Updates the dot/tooltip alone -- cheap enough to run on every
  // state.sources refresh (see refreshDockerHostPill), unlike render()'s
  // full dropdown rebuild, which only needs to happen while it's open.
  // Returns the active hostKey (or null), since render() needs it too.
  const syncPill = () => {
    const active = hasDockerDaemon() ? currentDockerHost() || "local" : null;
    wrap.dataset.state = active ? "up" : "";
    const label = active == null ? null : active === "local" ? "localhost" : active.replace(/^ssh:\/\//, "");
    btn.title = label ? `${label} — Manage Docker hosts…` : "Manage Docker hosts…";
    return active;
  };
  refreshDockerHostPill = syncPill;
  syncPill(); // reflect whatever's already connected as of page load, before any click

  btn.onclick = (e) => {
    e.stopPropagation();
    if (wrap.classList.contains("open")) {
      close();
      return;
    }
    if (infoPopup) infoPopup.hidden = true; // don't show both at once
    wrap.classList.add("open");
    dropdown.hidden = false;
    render();
    syncPillPeerVisibility("dockerhost");
  };
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();

