"use strict";

/* ── server connection ──────────────────────────────────────────────────── */

const PORT = new URLSearchParams(location.search).get("port") || "8765";
// 127.0.0.1 covers embedded/local-container mode; main.js passes the actual
// server host for "remote" mode (client talks directly over HTTP -- no ssh
// tunnel/port-forward, see docs/architecture/remote-server.md).
const HOST = new URLSearchParams(location.search).get("host") || "127.0.0.1";
const API = `http://${HOST}:${PORT}`;

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
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(API + path, { method: "POST", body: JSON.stringify(body || {}) });
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
  cursorT: null,          // clicked time
  hoverX: null,           // crosshair pixel x (plot coords) or null
  hoverStrip: null,
  windowMs: 5000,
  series: null,           // /series payload for current view
  ticks: new Map(),       // log source id -> counts[]
  visible: new Map(),     // series name -> bool
  hiddenSamples: new Set(), // loaded .cttc-metric/.cttc-record path -> hidden (whole-file toggle)
  hoverGroup: "svc",      // strip group under the pointer: "svc" | "host"
  chartStyle: prefs.get("chartStyle", "lines"), // "lines" | "bars"
  showHost: prefs.get("showHost", true),
  showLanes: prefs.get("showLanes", false), // per-log-source "entry occurred here" bars, between telemetry and host
  track: prefs.get("track", {}),           // series name -> "sel" | "mut" | "hid"
  showOthers: prefs.get("showOthers", true), // list not-selected containers in legend
  poppedOut: new Set(),   // "telemetry" and/or log source ids moved to their own window
};

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
let stripH = prefs.get("stripH", 96); // strip height; the splitter resizes it

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
// One of the theme's 8 fixed --series-N colors, assigned the first time a
// given series name is seen and never reassigned afterward (see
// assignColorSlots(), which seeds this map in a stable sort order so colors
// don't shuffle around as sources come and go). Past 8 concurrent series,
// everything additional folds to a shared --muted gray rather than cycling
// back through colors and creating ambiguous duplicates.
function colorFor(name) {
  if (!slotByName.has(name)) slotByName.set(name, slotByName.size);
  const slot = slotByName.get(name);
  const css = getComputedStyle(document.documentElement);
  if (slot >= 8) return css.getPropertyValue("--muted").trim(); // fold past 8: muted
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
   Per stay-the-course/sampled-vs-live-data.md: live data stays a solid,
   full-saturation line/fill; data coming from a loaded .cttc-metric/
   .cttc-record sample is
   grayed + dashed/hatched instead. Each *sample file* (source id) gets its
   own gray level + dash rhythm, so several loaded samples stay visually
   distinguishable from each other and from live data. */

const sampleSlotBySid = new Map();
function sampleSlot(sid) {
  if (!sampleSlotBySid.has(sid)) sampleSlotBySid.set(sid, sampleSlotBySid.size);
  return sampleSlotBySid.get(sid);
}
const SAMPLE_DASH_PATTERNS = [[6, 4], [2, 3], [9, 3, 2, 3], [1, 2.5], [10, 3, 3, 3]];
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
// text to append after a container/source name when it comes from a loaded
// .cttc-metric/.cttc-record sample, e.g. "api — sample-2026-07-18.cttc-metric"
function sampleFileLabel(sid) {
  const src = state.sources.find((s) => s.id === sid);
  if (!src || src.live !== false) return "";
  const base = basename(src.path);
  return base ? ` — ${base}` : "";
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
// true if this source belongs to a loaded .cttc-metric/.cttc-record file the
// user has toggled
// off via the sample-files switch in the legend (see renderSampleFiles()) --
// checked everywhere a sample-sourced series/lane/panel might need hiding.
function isSampleHidden(sid) {
  const src = state.sources.find((s) => s.id === sid);
  return !!(src && src.live === false && state.hiddenSamples.has(src.path));
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
      return s.name === POPOUT_ID && !isSampleHidden(s.sid);
    }
    if (group === "svc" && trackStateOf(s) !== "sel") return false;
    if (isSampleHidden(s.sid)) return false;
    return !respectVisibility || state.visible.get(s.name) !== false;
  });
}

function allSvcSeries() {
  return (state.series?.services || []).filter((s) => !s.host);
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
  const showingHostArea = !hostBlockEl.hidden && state.showHost;
  $("host-loading").hidden = !(showingHostArea && hostLoading);
  hostChartsEl.hidden = !showingHostArea || hostLoading;
  $("host-nav").hidden = !showingHostArea || hostLoading;
  $("btn-host-toggle").textContent = state.showHost ? "\u25be" : "\u25b8";
  $("btn-host-toggle").title = state.showHost ? "Hide host telemetry" : "Show host telemetry";
  lanesEl.hidden = !state.showLanes;
  $("btn-lanes-toggle").textContent = state.showLanes ? "\u25be" : "\u25b8";
  $("btn-lanes-toggle").title = state.showLanes ? "Hide log entry markers" : "Show log entry markers";
  STRIPS.forEach((spec, i) => drawStrip(stripCanvases[i], spec, "svc", i === STRIPS.length - 1));
  if (hasHost && state.showHost && !hostBlockEl.hidden)
    STRIPS.forEach((spec, i) => drawStrip(hostCanvases[i], spec, "host", i === STRIPS.length - 1));
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
  if (state.chartStyle === "bars") {
    // histogram: one bar per non-empty bucket, translucent so overlapping
    // series stay readable. Sample-sourced series get a grayed hatch fill
    // instead of a solid one (see sample-vs-live styling above).
    const bw = Math.max(1, pw / px - 0.5);
    for (const s of services) {
      const live = isLiveSid(s.sid);
      if (live) {
        ctx.globalAlpha = services.length > 1 ? 0.55 : 0.85;
        ctx.fillStyle = colorFor(s.name);
      } else {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = hatchPattern(ctx, grayedColor(colorFor(s.name), s.sid), s.sid);
      }
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
    // and render truly isolated samples as dots. Live series are solid and
    // full-saturation; sample-sourced series are grayed + dashed, with the
    // dash rhythm/gray level unique per sample file.
    for (const s of services) {
      const arr = s[spec.key];
      const pts = [];
      for (let b = 0; b < arr.length; b++)
        if (arr[b] != null) pts.push([b, arr[b]]);
      if (!pts.length) continue;
      const spacing = Math.max(1, px / pts.length);
      const gapLimit = spacing * 4;
      const live = isLiveSid(s.sid);
      const color = live ? colorFor(s.name) : grayedColor(colorFor(s.name), s.sid);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = live ? 2 : 1.25;
      ctx.setLineDash(live ? [] : dashFor(s.sid));
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
  if (state.cursorT != null && state.view) {
    const x = tToX(state.cursorT);
    if (x >= MARGIN_L && x <= MARGIN_L + plotWidth()) {
      ctx.strokeStyle = themeVar("--accent");
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
}

/* ── density lanes (one per log source) ─────────────────────────────────── */

function drawLanes() {
  let logs = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id));
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
      canvas.title = s.name + sampleFileLabel(s.id);
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
// panel on that point in time, keeping the current zoom span
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
  c.addEventListener("wheel", (e) => handleWheelZoom(c, e), { passive: false });
}

/* ── legend ─────────────────────────────────────────────────────────────── */

/* ── legend context menu ────────────────────────────────────────────────── */

let ctxEl = null;
function closeCtxMenu() {
  ctxEl?.remove();
  ctxEl = null;
}
function ctxMenu(e, entries) {
  e.preventDefault();
  e.stopPropagation();
  closeCtxMenu();
  ctxEl = document.createElement("div");
  ctxEl.id = "ctxmenu";
  for (const [label, fn] of entries) {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => { closeCtxMenu(); fn(); };
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
          interval: 5,
        });
      } catch (err) {
        setStatus(String(err.message || err));
      }
    }
  }
  refreshAll();
}

/* ── legend ─────────────────────────────────────────────────────────────── */

// One legend entry: a color swatch (colorFor(name), or gray if `cls`
// includes "disabled") + a text label. `name` drives the swatch color and
// click/right-click wiring in renderLegend(); `label` is what's actually
// displayed, which can differ (e.g. appending the originating sample
// file's name via sampleFileLabel()).
function legendItem(name, cls, label = name) {
  const item = document.createElement("span");
  item.className = "legend-item" + (cls ? " " + cls : "");
  const sw = document.createElement("span");
  sw.className = "legend-swatch";
  sw.style.background = cls === "disabled" ? "var(--muted)" : colorFor(name);
  item.append(sw, document.createTextNode(label));
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

// one row per loaded .cttc-metric/.cttc-record file, with a slide switch to
// show/hide everything
// from that file (charts, lanes, panels) in a single click
function renderSampleFiles() {
  const groups = sampleFileGroups();
  if (!groups.length) return;
  const box = document.createElement("div");
  box.id = "sample-files";
  for (const g of groups) {
    const hidden = state.hiddenSamples.has(g.path);
    const row = document.createElement("label");
    row.className = "ctl switch-row sample-file-row";
    row.title = g.path;
    const sw = document.createElement("span");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hidden;
    cb.onchange = () => {
      if (cb.checked) state.hiddenSamples.delete(g.path);
      else state.hiddenSamples.add(g.path);
      relist();
    };
    const track = document.createElement("span");
    track.className = "switch-track";
    const thumb = document.createElement("span");
    thumb.className = "switch-thumb";
    track.appendChild(thumb);
    sw.append(cb, track);
    const label = document.createElement("span");
    label.textContent = `${basename(g.path)} ${hidden ? "(hidden)" : "(shown)"}`;
    row.append(sw, label);
    box.appendChild(row);
  }
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

function seriesPopoutMenuEntry(s) {
  return window.cttc?.popout
    ? [[`⧉ Open “${s.name}” in its own window`, () => openSeriesPopout(s.name)]]
    : [];
}

function renderLegend() {
  legendEl.innerHTML = "";
  renderSampleFiles();
  let all = allSvcSeries();
  // a series popout's legend shows just its one series, always as selected
  if (POPOUT_KIND === "series") all = all.filter((s) => s.name === POPOUT_ID);
  const sel = all.filter((s) => POPOUT_KIND === "series" || trackStateOf(s) === "sel");
  const mut = POPOUT_KIND === "series" ? [] : all.filter((s) => trackStateOf(s) === "mut");
  const hid = POPOUT_KIND === "series" ? [] : all.filter((s) => trackStateOf(s) === "hid");

  for (const s of sel) {
    const sample = !isLiveSid(s.sid);
    const cls = (state.visible.get(s.name) === false ? "off " : "") + (sample ? "sample" : "");
    const item = legendItem(s.name, cls.trim(), s.name + sampleFileLabel(s.sid));
    if (sample) item.title = "from loaded .cttc-metric/.cttc-record data";
    item.onclick = () => {
      state.visible.set(s.name, state.visible.get(s.name) === false);
      relist();
    };
    item.oncontextmenu = (e) => ctxMenu(e, [
      ...seriesPopoutMenuEntry(s),
      [`Unselect “${s.name}” (keep listed, disabled)`, () => { setTrack(s.name, "mut"); relist(); }],
      [`Hide “${s.name}” entirely`, () => { setTrack(s.name, "hid"); relist(); }],
    ]);
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
    const m = /^docker:\/\/([^/]+)\//.exec(s.path || "");
    if (m) return m[1] === "local" ? null : m[1];
  }
  return null;
}

const dlgExport = $("dlg-export");

async function askExportOptions() {
  const hasHost = hasHostSeries();
  const cb = $("export-host");
  cb.checked = hasHost;
  $("export-host-note").textContent = hasHost
    ? "Currently being collected — included automatically unless you uncheck this."
    : "Not currently collected — checking this starts collecting it now (this past range won't have host data yet, but later saved metrics will).";
  return new Promise((resolve) => {
    const done = (ok) => {
      dlgExport.close();
      $("dlg-export-ok").onclick = null;
      $("dlg-export-cancel").onclick = null;
      resolve(ok ? { includeHost: cb.checked, hadHost: hasHost } : null);
    };
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
        interval: 5,
      });
    } catch (err) {
      setStatus("could not start host telemetry: " + (err.message || err));
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
    const res = await fetch(`${API}/files/download?${params}`);
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `download failed: ${res.status}`);
    const sourceCount = Number(res.headers.get("X-CTTC-Source-Count") || 0);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const path = await saveBinaryFile(name, bytes);
    if (!path) { setStatus("metrics export canceled"); return; }
    setStatus(sourceCount ? `metrics saved: ${path} (${sourceCount} sources)`
                          : "metrics saved, but no data in the selected range");
  } catch (err) {
    setStatus("metrics export failed: " + (err.message || err));
  }
}

/* ── snapshots: telemetry + nearby log entries at one point in time ──────
   Right-click a chart -> "Take snapshot at this time". /point already
   aggregates every currently open stats source (all containers *and* all
   docker hosts), so "all the other servers at the same time" comes for
   free; the dialog's checkbox only narrows it back down to the currently
   selected series if unchecked. */

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
async function computeSlice(t, { includeAll, includeLogs, ctxLines }) {
  const r = await get(`/point?t=${t}`);
  let services = Object.entries(r.services || {}).map(([name, v]) => ({ name, ...v }));
  if (!includeAll) {
    const selected = new Set(allSvcSeries().filter((s) => trackStateOf(s) === "sel").map((s) => s.name));
    services = services.filter((s) => s.host || selected.has(s.name));
  }
  services.sort((a, b) => (b.host - a.host) || a.name.localeCompare(b.name));

  let logs = [];
  if (includeLogs) {
    const logSources = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id));
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
  const includeAll = $("snap-all-sources").checked;
  const includeLogs = $("snap-logs").checked;
  const panOn = $("snap-panorama-on").checked;
  const panUnit = $("snap-panorama-unit").value; // "entries" | "seconds"
  const panValue = panOn ? Math.max(0, Number($("snap-panorama-value").value) || 0) : 0;
  const ctxLines = panUnit === "entries" ? panValue : 0;
  const panSec = panUnit === "seconds" ? panValue : 0;
  const opts = { includeAll, includeLogs, ctxLines };

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
$("snap-all-sources").onchange = () => currentSnapshot && refreshSnapshot(currentSnapshot.t);
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
    if (path) setStatus("snapshot saved: " + path);
  } catch (err) {
    setStatus("snapshot save failed: " + (err.message || err));
  }
};
$("dlg-snapshot-save-txt").onclick = async () => {
  if (!currentSnapshot) return;
  const name = `snapshot-${new Date(currentSnapshot.t).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.txt`;
  const text = snapshotToText(currentSnapshot);
  try {
    const path = window.cttc?.saveText ? await window.cttc.saveText(name, text) : null;
    if (path) setStatus("snapshot saved: " + path);
  } catch (err) {
    setStatus("snapshot save failed: " + (err.message || err));
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
    c.addEventListener("wheel", (e) => handleWheelZoom(c, e), { passive: false });
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

function setView(t0, t1, opts = {}) {
  if (t1 - t0 < 200) return; // 200ms minimum zoom
  state.view = { t0, t1 };
  scheduleSeriesFetch();
  drawAll();
  if (opts.broadcast !== false) window.cttc?.broadcastSync?.({ type: "view", t0, t1 });
}

function resetZoom() {
  if (!state.range || state.range.min_ts == null) return;
  const pad = Math.max(1000, (state.range.max_ts - state.range.min_ts) * 0.01);
  setView(state.range.min_ts - pad, state.range.max_ts + pad);
  // place the cursor (and with it every log panel) on now, not mid-range --
  // "now" is where a user resetting zoom almost always wants to look next
  setCursor(Date.now());
}

// double-clicking anywhere on the timeline (charts or log density lanes)
// re-centers every panel on that exact point in time, keeping the current
// zoom span.
function recenterOn(t) {
  if (!state.view) return;
  const span = state.view.t1 - state.view.t0;
  setView(t - span / 2, t + span / 2);
}

// zoom in/out around a given point in time (from the chart's right-click
// menu): factor < 1 narrows the span (zoom in), factor > 1 widens it.
function zoomAt(t, factor) {
  if (!state.view) return;
  const span = (state.view.t1 - state.view.t0) * factor;
  setView(t - span / 2, t + span / 2);
}

// zoom in/out around `t`, keeping `t` itself fixed at the same point in the
// view rather than re-centering on it -- what a wheel/trackpad zoom needs so
// the spot under the cursor doesn't jump on every notch (mirrors zoomAt(),
// which recenters instead, for the right-click menu's "Zoom in/out here").
function zoomAtAnchored(t, factor) {
  if (!state.view) return;
  const { t0, t1 } = state.view;
  setView(t - (t - t0) * factor, t + (t1 - t) * factor);
}

// mouse-wheel / trackpad zoom over a chart or density lane: scroll down
// (deltaY > 0) zooms out, scroll up zooms in, anchored on the point under
// the cursor. ctrl/meta+wheel is left alone (trackpad pinch-zoom sends wheel
// events with ctrlKey set on most platforms -- browsers reserve that
// gesture for page zoom, and hijacking it would fight the OS).
const WHEEL_ZOOM_FACTOR = 1.15;
function handleWheelZoom(c, e) {
  if (!state.view || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = x >= MARGIN_L ? xToT(x) : (state.view.t0 + state.view.t1) / 2;
  zoomAtAnchored(t, e.deltaY > 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR);
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
  let lo = state.range?.min_ts, hi = state.range?.max_ts;
  if (lo == null || hi == null) {
    lo = state.view ? state.view.t0 : now - DEFAULT_SPAN / 2;
    hi = state.view ? state.view.t1 : now + DEFAULT_SPAN / 2;
  }
  if (state.view) { lo = Math.min(lo, state.view.t0); hi = Math.max(hi, state.view.t1); }
  lo = Math.min(lo, now);
  hi = Math.max(hi, now);
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
}

function attachTimelineNav(navEl) {
  const track = navEl.querySelector(".tl-track");
  const thumb = navEl.querySelector(".tl-thumb");
  const nowLabel = navEl.querySelector(".tl-now-label");

  nowLabel.addEventListener("click", (e) => {
    e.stopPropagation();
    centerOnNow();
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
    setStatus(String(err));
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
  $("cursor-label-text").textContent = "t = " + new Date(t).toISOString().replace("T", " ").replace("Z", " UTC");
  drawAll();
  for (const p of panels.values()) p.jumpTo(t);
  if (opts.broadcast !== false) window.cttc?.broadcastSync?.({ type: "cursor", t });
}

/* ── log panels (virtual scroll) ────────────────────────────────────────── */

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
    popout.onclick = () => {
      state.poppedOut.add(src.id);
      syncPanels();
      window.cttc.popout("log", src.id, popoutView());
    };
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "✕";
    close.title = "Close source";
    close.onclick = async () => { await post("/close", { id: src.id }); refreshAll(); };
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
        div.classList.add("hl");
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
      div.title = new Date(row.ts).toISOString() + "\n" + row.text
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
    p.el.hidden = isSampleHidden(s.id);
  }
}

/* ── refresh / SSE ──────────────────────────────────────────────────────── */

// the single status-line message in the toolbar (server connectivity,
// export/save results, ...) -- always replaces whatever was there before.
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
    assignColorSlots(); // before anything draws, so slots don't depend on draw order
    const hadView = !!state.view;
    state.range = range;
    $("empty-state").hidden = state.sources.length > 0;
    syncPanels();
    if (range.min_ts != null && !hadView) {
      if (POPOUT_KIND) {
        // popout fallback (no view handed over): fit quietly, never yank the
        // opener's view via a broadcast
        const pad = Math.max(1000, (range.max_ts - range.min_ts) * 0.01);
        setView(range.min_ts - pad, range.max_ts + pad, { broadcast: false });
      } else {
        resetZoom();
      }
    }
    await fetchSeries();
    setStatus(src.json_impl === "orjson" ? "" : "server running without orjson (slow parse)");
  } catch (err) {
    setStatus("server unreachable: " + err.message);
  }
}

// Opens the server's /events stream (see route_events in server.py): every
// message just means "something changed, go refetch" -- this deliberately
// carries no payload of its own, so a debounced refreshAll() (via
// scheduleRefresh()) is always what actually pulls new data, keeping one
// single code path for both the SSE-driven and manual-action refresh cases.
function connectSSE() {
  const es = new EventSource(API + "/events");
  es.onmessage = () => scheduleRefresh();
  es.onerror = () => setStatus("reconnecting to server…");
  es.onopen = () => setStatus("");
}

/* ── set-sources dialog (Docker) ────────────────────────────────────────── */

const dlg = $("dlg-set");

// SSH key actually used for each docker host reached via "Set Sources" --
// keyed the same way as source paths (host string, or "local"). Populated
// when a host is (re)connected from the dialog; follow-up /docker/collect
// calls for that same host (startTracking, exportSample) that don't go
// through the dialog reuse it instead of silently dropping back to null.
const dockerHostKeys = new Map();

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
// (see updateDockerDupes below) must stay disabled regardless of duplicate
// state, since typing alone (docker-host's oninput -> updateDockerDupes)
// must never re-enable a control ahead of an actual fetch.
let dockerFormFetched = false;

function updateDockerDupes() {
  const hostKey = normalizeDockerHost($("docker-host").value) || "local";
  const paths = openPaths();
  const statsDup = paths.has(`docker://${hostKey}/stats`);
  $("docker-stats").disabled = statsDup || !dockerFormFetched;
  if (statsDup) $("docker-stats").checked = false;
  $("docker-stats-note").textContent = statsDup ? "— already collecting" : "";
  // host telemetry is always requested now (no checkbox to disable) -- the
  // note just says so when it's already open for this host.
  $("docker-host-stats-note").textContent = paths.has(`docker://${hostKey}/host`) ? "— already collecting" : "";
}

// Every control except Docker host / SSH key / Fetch starts empty and
// disabled -- there's nothing to configure until Fetch has actually shown
// what's running on the host currently typed in (see setDockerFormEnabled),
// so nothing here is populated or enabled speculatively.
$("btn-set").onclick = () => {
  $("docker-targets").innerHTML = "";
  $("transforms-list").innerHTML = "none found in server/transforms/";
  $("docker-error").textContent = "";
  setDockerFormEnabled(false);
  updateDockerDupes();
  renderActivityLog(null);
  dlg.showModal();
};

// Toggles every "what to collect" control except Docker host/SSH key/Fetch
// itself -- there's nothing meaningful to set until Fetch has shown what's
// actually on the host, and re-fetching (a different host, or the same one
// after it changed) means the previous answer no longer applies either.
function setDockerFormEnabled(enabled) {
  dockerFormFetched = enabled;
  $("docker-stats").disabled = !enabled;
  $("docker-interval").disabled = !enabled;
  $("dlg-ok").disabled = !enabled;
  for (const cb of $("docker-targets").querySelectorAll("input")) cb.disabled = !enabled;
  for (const cb of $("transforms-list").querySelectorAll("input")) cb.disabled = !enabled;
}

// close every open source and forget the remembered last-session containers,
// so the next launch starts with nothing and the set-sources dialog opens.
$("btn-clear-sources").onclick = async () => {
  if (!state.sources.length) return; // nothing to clear -- no point asking
  if (!confirm(`Close all ${state.sources.length} open source${state.sources.length === 1 ? "" : "s"}? This can't be undone.`)) return;
  try {
    await Promise.all(state.sources.map((s) => post("/close", { id: s.id })));
    prefs.set("lastDockerSessions", []);
    await refreshAll();
  } catch (err) {
    alert(String(err.message || err));
  }
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
  const headers = { "X-CTTC-Filename": filename };
  if (segment != null) headers["X-CTTC-Segment"] = String(segment);
  const res = await fetch(`${API}/files/upload`, { method: "POST", body: bytes, headers });
  return res.json().catch(() => ({ opened: [], errors: [{ path: filename, error: `upload failed: ${res.status}` }] }));
}

const dlgSegmentPick = $("dlg-segment-pick");

// Shows the multi-segment picker and resolves to the chosen index, or null
// if cancelled. `segments` is the needs_selection entry's own list:
// [{index, from, to, created, source_count}].
function pickSegment(segments) {
  const box = $("segment-pick-list");
  box.innerHTML = "";
  return new Promise((resolve) => {
    const done = (index) => {
      dlgSegmentPick.close();
      $("dlg-segment-pick-cancel").onclick = null;
      resolve(index);
    };
    for (const seg of segments) {
      const btn = document.createElement("button");
      btn.type = "button";
      const range = document.createElement("span");
      range.className = "seg-range";
      range.textContent = `${fmtIso(seg.from)} — ${fmtIso(seg.to)}`;
      const meta = document.createElement("span");
      meta.className = "seg-meta";
      meta.textContent = `${seg.source_count} source(s)${seg.created ? " · recorded " + fmtIso(new Date(seg.created).getTime() || seg.created) : ""}`;
      btn.append(range, meta);
      btn.onclick = () => done(seg.index);
      box.appendChild(btn);
    }
    $("dlg-segment-pick-cancel").onclick = () => done(null);
    dlgSegmentPick.showModal();
  });
}

// Shared by "Load metrics" and "Open Recording": upload once, and if the
// server comes back asking which segment (a multi-segment recording, see
// merge_sample_bytes/MultiSegmentSample), show the picker and re-upload
// with that choice instead of silently picking one or giving up.
async function uploadAndResolveSegment(path) {
  const first = await uploadFile(path);
  if (!first.needs_selection?.length) return first;
  const index = await pickSegment(first.needs_selection[0].segments);
  if (index == null) return { opened: [], errors: [] }; // cancelled
  return uploadFile(path, index);
}

$("btn-load-sample").onclick = async () => {
  let paths = [];
  if (window.cttc?.pickFiles) paths = await window.cttc.pickFiles();
  else {
    const p = prompt("Path to .cttc-metric file:");
    if (p) paths = [p];
  }
  const open = openPaths();
  const files = paths.filter(
    (p) => p.endsWith(".cttc-metric") && !open.has(`upload://${basename(p)}`)
  );
  if (!files.length) return;
  try {
    const errors = [];
    for (const path of files) errors.push(...((await uploadAndResolveSegment(path)).errors || []));
    if (errors.length) alert(errors.map((e) => `${e.path}: ${e.error}`).join("\n"));
    await refreshAll();
    resetZoom(); // show the full timeline, including the newly loaded metrics
  } catch (err) {
    alert(String(err.message || err));
  }
};

/* ── Recording (Start/Pause/Stop/Open Recording, Recording menu) ─────────
   Each Record→Pause span is flushed as one more segment into the same
   .cttc-record archive via /sample/record (byte-oriented, mirroring Capture
   metrics/Load metrics -- no shared-filesystem assumption), rather than
   each span becoming its own file. A path is chosen once, at Start
   Recording; every later flush overwrites that same local file. */

const recording = { status: "idle", path: null, segmentStart: null };

function syncRecordingMenu() {
  $("btn-start-recording").dataset.state = recording.status;
  $("btn-start-recording").disabled = recording.status === "recording";
  $("btn-pause-recording").disabled = recording.status !== "recording";
  $("btn-stop-recording").disabled = recording.status === "idle";
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
      : { path: recording.path, status: recording.status, segmentStart: recording.segmentStart }
  );
}

function setRecordingState(next) {
  Object.assign(recording, next);
  syncRecordingMenu();
}

// Thin, individually reassignable wrappers around the three native-fs
// calls Recording needs -- same pattern as saveBinaryFile above, so tests
// can substitute an in-memory store instead of driving a real native save
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
    headers: { "X-CTTC-From": String(recording.segmentStart), "X-CTTC-To": String(t1) },
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
    const path = await pickRecordingSavePath();
    if (!path) {
      if (!window.cttc?.pickRecordingPath) setStatus("Recording needs desktop file access — unavailable here");
      return; // cancelled, or no native dialog available
    }
    setRecordingState({ status: "recording", path, segmentStart: Date.now() });
    setStatus(`Recording started — saving to ${path}`);
  } else {
    // resume from paused: same path, a new segment starts now
    setRecordingState({ status: "recording", segmentStart: Date.now() });
    setStatus("Recording resumed");
  }
  await persistRecordingMarker();
}

async function pauseRecording() {
  if (recording.status !== "recording") return;
  try {
    await flushRecordingSegment(Date.now());
    setRecordingState({ status: "paused", segmentStart: null });
    setStatus(`Recording paused — ${recording.path}`);
  } catch (err) {
    setStatus(`Could not pause recording: ${err.message || err}`);
    return; // stay "recording" -- the segment wasn't actually flushed
  }
  await persistRecordingMarker();
}

async function stopRecording() {
  if (recording.status === "idle") return;
  const path = recording.path;
  try {
    if (recording.status === "recording") await flushRecordingSegment(Date.now());
    setStatus(`Recording stopped — ${path}`);
  } catch (err) {
    setStatus(`Could not finalize recording: ${err.message || err}`);
    return; // keep the in-flight state so the user can retry Stop
  }
  setRecordingState({ status: "idle", path: null, segmentStart: null });
  await persistRecordingMarker();
}

async function openRecording() {
  let paths = [];
  if (window.cttc?.pickFiles) paths = await window.cttc.pickFiles("Open Recording");
  else {
    const p = prompt("Path to a recorded .cttc-record file:");
    if (p) paths = [p];
  }
  const files = paths.filter((p) => p.endsWith(".cttc-record"));
  if (!files.length) return;
  try {
    const errors = [];
    for (const path of files) errors.push(...((await uploadAndResolveSegment(path)).errors || []));
    if (errors.length) alert(errors.map((e) => `${e.path}: ${e.error}`).join("\n"));
    await refreshAll();
    resetZoom();
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
  setRecordingState({ status: "paused", path: marker.path, segmentStart: null });
  await persistRecordingMarker();
  if (wasInterrupted) {
    setStatus(
      `A previous recording was interrupted and is now paused: ${marker.path} — Resume to continue, or Stop to finalize.`
    );
  }
}
recoverInterruptedRecording();

syncRecordingMenu();

$("btn-start-recording").onclick = () => startRecording();
$("btn-pause-recording").onclick = () => pauseRecording();
$("btn-stop-recording").onclick = () => stopRecording();
$("btn-open-recording").onclick = () => openRecording();

/* ── theme preferences (dlg-theme) ───────────────────────────────────────
   Reached via File > Preferences > Theme. Currently just the log-highlight
   color (the background + dotted top/bottom border painted on log rows
   within the sampling frequency window around the selected time — see
   Panel.render()'s "hl"/"hl-top"/"hl-bottom" classes). */

const DEFAULT_HL_COLOR = "#eaff00"; // light neon yellow
const dlgTheme = $("dlg-theme");

function applyHlColor(color) {
  document.documentElement.style.setProperty("--hl-color", color);
}
applyHlColor(prefs.get("hlColor", DEFAULT_HL_COLOR));

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

function openThemeDialog() {
  $("theme-hl-color").value = prefs.get("hlColor", DEFAULT_HL_COLOR);
  $("theme-status-bar-toggle").checked = statusBarEnabled;
  dlgTheme.showModal();
}
$("theme-hl-color").oninput = (e) => applyHlColor(e.target.value); // live preview
$("dlg-theme-reset").onclick = () => {
  $("theme-hl-color").value = DEFAULT_HL_COLOR;
  applyHlColor(DEFAULT_HL_COLOR);
  setThemeMode("light");
};
$("dlg-theme-save").onclick = () => {
  const color = $("theme-hl-color").value;
  prefs.set("hlColor", color);
  applyHlColor(color);
  dlgTheme.close();
};
$("dlg-theme-close").onclick = () => {
  applyHlColor(prefs.get("hlColor", DEFAULT_HL_COLOR)); // discard live preview
  dlgTheme.close();
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
  $("app-status-bar-text").textContent = "No event activity yet";
}
function notifyEvent(text) {
  $("app-status-bar-text").textContent = `${new Date().toLocaleTimeString()} — ${text}`;
}

/* ── docker host activity log (ssh:// connections) ──────────────────────── */

function renderActivityLog(entries) {
  const toggle = $("btn-activity-toggle");
  const pre = $("docker-activity");
  if (!entries || !entries.length) {
    toggle.hidden = true;
    pre.hidden = true;
    pre.textContent = "";
    return;
  }
  toggle.hidden = false;
  pre.textContent = entries
    .map((e) => `$ ${e.cmd}\n  → exit ${e.returncode} (${e.ms}ms)${e.stderr ? `\n  ${e.stderr}` : ""}`)
    .join("\n\n");
}

$("btn-activity-toggle").onclick = () => {
  const pre = $("docker-activity");
  const toggle = $("btn-activity-toggle");
  pre.hidden = !pre.hidden;
  toggle.textContent = pre.hidden ? "Show activity" : "Hide activity";
};

async function listContainers() {
  $("docker-error").textContent = "";
  renderActivityLog(null);
  const box = $("docker-targets");
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

    // A successful fetch means "here's what's actually running now" -- any
    // container/service still tracked from a previous fetch (this host or
    // a different one) no longer reflects that and must go, not linger
    // alongside the fresh list. Host-level telemetry (docker://.../stats,
    // docker://.../host) is not a container and is deliberately left alone
    // here -- it's the host we just fetched from, not something to drop.
    const stale = state.sources.filter((s) => /^docker:\/\/[^/]+\/(container|service)\//.test(s.path || ""));
    if (stale.length) {
      await Promise.all(stale.map((s) => post("/close", { id: s.id })));
      await refreshAll();
    }

    box.innerHTML = "";
    const open = openPaths();
    const hostKey = host || "local";
    const addGroup = (title, items, type) => {
      if (!items.length) return;
      const g = document.createElement("div");
      g.className = "group";
      g.textContent = title;
      box.appendChild(g);
      for (const it of items) {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true; // every detected container/service is followed by default
        cb.value = it.name;
        cb.dataset.type = type;
        label.append(cb, ` ${it.name} `);
        const extra = document.createElement("span");
        extra.className = "tdoc";
        extra.textContent = it.image || it.replicas || "";
        // Left checked-but-interactive (not disabled) even when already
        // being followed: "Set" always syncs exactly to what's checked here
        // (see dlg-ok), so unchecking an already-added item is how you stop
        // following it, rather than needing to close its panel separately.
        if (open.has(`docker://${hostKey}/${type}/${it.name}`)) {
          label.classList.add("added");
          extra.textContent = "already added";
        }
        label.appendChild(extra);
        box.appendChild(label);
      }
    };
    addGroup("Swarm services (docker service logs)", r.services, "service");
    addGroup("Containers (docker logs)", r.containers, "container");
    if (!r.services.length && !r.containers.length) box.textContent = "nothing running";

    const t = await get("/transforms").catch(() => ({ transforms: [] }));
    const tbox = $("transforms-list");
    tbox.innerHTML = t.transforms.length ? "" : "none found in server/transforms/";
    for (const tr of t.transforms) {
      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = tr.name;
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
    box.innerHTML = "";
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
    $("docker-host").disabled = false;
    $("btn-ps-refresh").disabled = false;
  }
}

$("btn-ps-refresh").onclick = () => listContainers();
$("docker-host").oninput = () => updateDockerDupes();
$("docker-host").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    listContainers();
  }
});

$("dlg-cancel").onclick = () => dlg.close();

$("dlg-ok").onclick = async () => {
  const transforms = chosenTransforms();
  try {
    const host = normalizeDockerHost($("docker-host").value);
    const sshKey = $("docker-ssh-key").value.trim() || null;
    dockerHostKeys.set(host || "local", sshKey);
    const hostKey = host || "local";
    const logs = [...$("docker-targets").querySelectorAll("input:checked")].map((cb) => ({
      name: cb.value,
      type: cb.dataset.type,
    }));
    // "Set" syncs exactly to this checklist: any container/service log
    // already being followed for this host that isn't checked now gets
    // closed, not just left running alongside whatever's newly picked.
    const keep = new Set(logs.map((l) => `docker://${hostKey}/${l.type}/${l.name}`));
    const toClose = state.sources.filter((s) => {
      const m = /^docker:\/\/([^/]+)\/(container|service)\/.+$/.exec(s.path || "");
      return m && m[1] === hostKey && !keep.has(s.path);
    });
    for (const s of toClose) await post("/close", { id: s.id });

    const stats = $("docker-stats").checked;
    // Host telemetry (CPU/MEM/NET) is always requested once a source's host
    // is set -- no separate opt-in checkbox to forget to tick.
    const collectReq = {
      host, stats, logs, transforms,
      host_stats: true,
      ssh_key: sshKey,
      interval: Number($("docker-interval").value) || 5,
    };
    await post("/docker/collect", collectReq);
    // remember this collection request so it can be restored on next launch
    const sessions = prefs.get("lastDockerSessions", []);
    sessions.push(collectReq);
    prefs.set("lastDockerSessions", sessions);
    // containers picked here are the "selected" set shown in the legend
    for (const l of logs) setTrack(l.name, "sel");
    dlg.close();
    refreshAll();
  } catch (err) {
    alert(String(err.message || err));
  }
};

/* ── toolbar ────────────────────────────────────────────────────────────── */

// Poll interval has two live controls now (toolbar + the Settings dialog's
// own copy) -- both need to stay in sync with each other and with a
// detached action-bar window's own copy (see onSetPollInterval below), so
// the actual state update lives in one place. A zero-second window would
// highlight nothing (or everything, depending on how the ± compare is
// read) -- 1s is the smallest interval that still means something.
function setWindowSecs(v) {
  const secs = Math.max(1, Math.floor(Number(v)) || 1);
  state.windowMs = secs * 1000;
  $("win-secs").value = secs;
  $("win-secs-sidebar").value = secs;
  for (const p of panels.values()) p.render();
}
// "input" (not "change") so it takes effect immediately as you type/adjust,
// rather than waiting for blur/Enter.
$("win-secs").oninput = (e) => setWindowSecs(e.target.value);
$("win-secs-sidebar").oninput = (e) => setWindowSecs(e.target.value);
if (!POPOUT_KIND) window.cttc?.onSetPollInterval?.((secs) => setWindowSecs(secs));

// Settings: a real dialog (like Appearance), not an inline foldout --
// opened via the shared data-action dispatch (see RENDERER_ACTIONS'
// "open-settings" entry below), same as Appearance's "open-theme".
const dlgSettings = $("dlg-settings");
function openSettingsDialog() {
  dlgSettings.showModal();
}
$("dlg-settings-close").onclick = () => dlgSettings.close();

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

// Edit mode only. Every field this touches (ssh/key + image + Connect/
// Uninstall) is disabled until something is actually picked from the
// dropdown -- rather than hiding the form outright, so it's obvious at a
// glance that there's more here once a gateway is chosen. "This machine"
// (embedded) has no ssh settings to edit -- those fields stay disabled, but
// Connect (relabeled "Update image") still re-provisions the local
// container with the chosen image.
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
    $("gw-btn-uninstall").disabled = true;
    $("gw-ssh-user").value = "";
    $("gw-ssh-host").value = "";
    $("gw-key-path").value = "";
    return;
  }

  $("gw-btn-connect").disabled = false;
  $("gw-btn-uninstall").disabled = false;
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

async function gwLoadGatewaysForEdit() {
  gwGateways = await window.cttc.getGateways();
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

$("gw-btn-uninstall").onclick = async () => {
  const g = gwSelectedGateway();
  if (!g) return;
  if (!confirm(`Uninstall ${g.label || g.host}? This stops and removes its container.`)) return;
  $("gw-error").hidden = true;
  $("gw-activity-log").textContent = "";
  $("gw-wait-msg").textContent = "Uninstalling, please wait…";
  $("gw-form").hidden = true;
  $("gw-wait").hidden = false;
  const result = await window.cttc.uninstallGateway(g);
  $("gw-wait").hidden = true;
  $("gw-form").hidden = false;
  $("gw-wait-msg").textContent = "Applying changes, please wait…";
  if (!result.ok) {
    $("gw-error").textContent = result.error;
    $("gw-error").hidden = false;
    return;
  }
  await gwLoadGatewaysForEdit();
};

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
  $("gw-btn-uninstall").hidden = true;
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
  $("gw-btn-uninstall").hidden = false;
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
// via the toolbar status + bottom status bar (a background-ish action, not
// unlike an event trigger, so it gets the same "did something happen"
// visibility there).
if (!POPOUT_KIND) {
  $("btn-ship-logs").onclick = async () => {
    try {
      const result = await shipLogsViaMain();
      if (!result) return;
      if (result.canceled) { setStatus("ship logs canceled"); return; }
      if (!result.ok) { setStatus(result.error || "could not ship logs"); return; }
      const msg = `shipped ${result.fileCount} log file${result.fileCount === 1 ? "" : "s"} to ${result.path}` +
        (result.erased ? " (local .cttc-log files erased)" : "");
      setStatus(msg);
      notifyEvent(msg);
    } catch (err) {
      setStatus("ship logs failed: " + (err.message || err));
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
  if (!conditions.length) { setStatus("add at least one condition"); return; }
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
      setStatus(`event "${name}" updated`);
      notifyEvent(`Event "${name}" updated`);
    } else if ($("event-hosted").value === "gateway") {
      await post("/events/create", { name, source_ids: sourceIds, conditions, match, action });
      setStatus(`event "${name}" created`);
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
      setStatus(`event "${name}" created`);
      notifyEvent(`Event "${name}" created`);
    }
    dlgEventForm.close();
  } catch (err) {
    setStatus(`could not ${editingEvent ? "update" : "create"} event: ` + (err.message || err));
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
            const res = await fetch(`${API}/session/${artifactId}/download`);
            if (!res.ok) throw new Error(`download failed: ${res.status}`);
            const bytes = new Uint8Array(await res.arrayBuffer());
            const ext = res.headers.get("Content-Disposition")?.includes(".cttc-record") ? ".cttc-record" : ".cttc-metric";
            await saveBinaryFile(`${ev.name}-${id}${ext}`, bytes);
          } else if (window.cttc?.readFile) {
            const bytes = await window.cttc.readFile(artifactId);
            await saveBinaryFile(artifactId.split("/").pop(), bytes);
          }
        } catch (err) {
          setStatus("could not save event artifact: " + (err.message || err));
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
      const res = await fetch(`${API}/files/download?${params}`);
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
    setStatus(`event "${ev.name}" trigger failed: ` + (err.message || err));
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
      const res = await fetch(`${API}/session/${ev._pendingGatewaySessionId}/download`);
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

// reflects state.chartStyle onto the lines/histogram segmented control --
// called on boot and whenever the style changes from elsewhere.
function syncStyleButton() {
  $("btn-style-lines").dataset.active = String(state.chartStyle !== "bars");
  $("btn-style-histogram").dataset.active = String(state.chartStyle === "bars");
}
function setChartStyle(style) {
  state.chartStyle = style;
  prefs.set("chartStyle", state.chartStyle);
  syncStyleButton();
  drawAll();
}
$("btn-style-lines").onclick = () => setChartStyle("lines");
$("btn-style-histogram").onclick = () => setChartStyle("bars");

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

/* splitter: dragging down grows the charts, dragging up grows the logs panel */
$("splitter").addEventListener("mousedown", (e) => {
  e.preventDefault();
  $("splitter").classList.add("dragging");
  const startY = e.clientY, startH = stripH;
  const groups = 1 + (!hostBlockEl.hidden && state.showHost ? 1 : 0);
  const move = (ev) => {
    stripH = Math.min(320, Math.max(44, startH + (ev.clientY - startY) / (STRIPS.length * groups)));
    drawAll();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    $("splitter").classList.remove("dragging");
    prefs.set("stripH", Math.round(stripH));
    scheduleSeriesFetch();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up, { once: true });
});

/* ── boot ───────────────────────────────────────────────────────────────── */

buildStrips();
syncStyleButton();
applyPopoutLayout();
// main window: default view is the present, ± DEFAULT_SPAN/2. Popped-out
// panel windows inherit the opener's exact view/cursor from the URL, so they
// open on the same time range without resetting (or broadcasting) anything;
// they then track the opener via sync-broadcast.
if (!POPOUT_KIND) {
  centerOnNow();
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
  if (msg.type === "cursor") setCursor(msg.t, { broadcast: false });
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
    "load-metrics": () => $("btn-load-sample").click(),
    "new-gateway": () => openNewGatewayDialog(),
    "edit-gateways": () => openEditGatewaysDialog(),
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
     left/right/top/bottom/detached) -- main window only: popouts hide the
     bar entirely (see body[class*="popout-"] in style.css) and have no
     business opening/closing the shared detached-bar window themselves. */
  const appBody = $("app-body");
  const actionBar = $("action-bar");
  if (!POPOUT_KIND && appBody && actionBar) {
    actionBar.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-action]");
      if (btn) runMenuAction(btn.dataset.action);
    });

    function setDock(dock) {
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
    }
    collapseToggle.onclick = () => setActionBarCollapsed(actionBar.dataset.collapsed !== "true");

    setDock(prefs.get("actionBarDock", "left"));
    setActionBarCollapsed(prefs.get("actionBarCollapsed", false));
    window.cttc?.onActionBarRedock?.(() => setDock(prefs.get("actionBarLastDock", "left")));

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

/* ── server status indicator (menu bar, flush right) ──────────────────────
   Polls /health independently of connectSSE's own stream so it still shows
   "down" if the SSE connection itself is what's wedged. Only present in the
   main window's menu bar -- harmless no-op elsewhere since $() returns null. */
(() => {
  const el = $("server-status");
  if (!el) return;
  // Static for the life of this window (HOST/PORT are set once, from the
  // URL main.js loaded it with) -- where the gateway actually is, not just
  // whether it's reachable, matters most for "remote" mode (see
  // docs/architecture/remote-server.md), where it's easy to forget which
  // host is actually being talked to. HOST/PORT alone can't tell a tunneled
  // connection apart from a genuinely local one though (both are
  // 127.0.0.1) -- getConnectionInfo (below) fills that gap.
  const statusHost = HOST === "127.0.0.1" ? "localhost" : HOST;
  $("server-status-location").textContent = PORT == null || PORT === "null" ? statusHost : `${statusHost}:${PORT}`;

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
      $("server-status-location").textContent = `${loc} (tunnel)`;
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
  el.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    if (!popup) return;
    await loadConnectionInfo(); // refresh -- may have switched gateways since the last popup
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
  });
  document.addEventListener("click", (e) => {
    if (popup && !popup.hidden && !popup.contains(e.target)) popup.hidden = true;
  });
  // Right-clicking elsewhere doesn't fire a "click" event (only left-click
  // does) -- without this, the popup would only ever close on a left click
  // or Escape, staying stuck open through a right-click anywhere else.
  document.addEventListener(
    "contextmenu",
    (e) => {
      if (popup && !popup.hidden && !el.contains(e.target)) popup.hidden = true;
    },
    true
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && popup) popup.hidden = true;
  });

  const HEALTH_POLL_MS = 5000;
  const btn = $("server-status-btn");
  // The status pill itself only ever shows a colored dot + "Switch
  // gateway…" -- the actual failure text goes to the bottom status bar
  // (notifyEvent), not a tooltip nobody's necessarily hovering over.
  const setState = (state) => {
    el.dataset.state = state;
    btn.title = "Switch gateway…";
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
    for (const g of gateways) {
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
          setStatus(`Switching to ${g.label || g.host}…`);
          const r = await window.cttc.switchGateway(g);
          if (!r.ok) setStatus(r.error);
        };
      }
      dropdown.appendChild(item);
    }
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
    wrap.classList.add("open");
    dropdown.hidden = false;
    render(await window.cttc.getGateways());
  };
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
})();
