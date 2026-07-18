"use strict";

/* ── server connection ──────────────────────────────────────────────────── */

const PORT = new URLSearchParams(location.search).get("port") || "8765";
const API = `http://127.0.0.1:${PORT}`;

// a window can either be the main window (POPOUT_KIND == null) or a panel
// popped out into its own window: "telemetry" (the chart area) or "log"
// (a single log panel, identified by POPOUT_ID = source id).
const POPOUT_KIND = new URLSearchParams(location.search).get("popout") || null;
const POPOUT_ID = new URLSearchParams(location.search).get("id") || null;

async function get(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(API + path, { method: "POST", body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${path}: ${r.status}`);
  return j;
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
  follow: false,
  series: null,           // /series payload for current view
  ticks: new Map(),       // log source id -> counts[]
  visible: new Map(),     // series name -> bool
  hiddenSamples: new Set(), // loaded .cttc file path -> hidden (whole-file toggle)
  hoverGroup: "svc",      // strip group under the pointer: "svc" | "host"
  chartStyle: prefs.get("chartStyle", "lines"), // "lines" | "bars"
  showHost: prefs.get("showHost", true),
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

function fmtBytes(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + " GB/s";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + " MB/s";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + " kB/s";
  return v.toFixed(0) + " B/s";
}
function fmtClock(ms, withMs) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  let s = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (withMs) s += "." + p(d.getMilliseconds(), 3);
  return s;
}

/* ── categorical colors: fixed slot order, never cycled ─────────────────── */

const slotByName = new Map();
function colorFor(name) {
  if (!slotByName.has(name)) slotByName.set(name, slotByName.size);
  const slot = slotByName.get(name);
  const css = getComputedStyle(document.documentElement);
  if (slot >= 8) return css.getPropertyValue("--muted").trim(); // fold past 8: muted
  return css.getPropertyValue(`--series-${slot + 1}`).trim();
}
function themeVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ── sample vs. live styling ───────────────────────────────────────────────
   Per stay-the-course/sampled-vs-live-data.md: live data stays a solid,
   full-saturation line/fill; data coming from a loaded .cttc sample is
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

function isLiveSid(sid) {
  const src = state.sources.find((s) => s.id === sid);
  return !src || src.live !== false; // source unknown yet -> assume live
}
function basename(p) {
  return String(p || "").split("/").pop();
}
// text to append after a container/source name when it comes from a loaded
// .cttc sample, e.g. "api — sample-2026-07-18.cttc"
function sampleFileLabel(sid) {
  const src = state.sources.find((s) => s.id === sid);
  if (!src || src.live !== false) return "";
  const base = basename(src.path);
  return base ? ` — ${base}` : "";
}
// group every non-live source by its originating .cttc file, so the whole
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
function isSampleHidden(sid) {
  const src = state.sources.find((s) => s.id === sid);
  return !!(src && src.live === false && state.hiddenSamples.has(src.path));
}
function dashFor(sid) {
  return SAMPLE_DASH_PATTERNS[sampleSlot(sid) % SAMPLE_DASH_PATTERNS.length];
}
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

// this window is itself a popped-out panel: show only that panel, full-size.
if (POPOUT_KIND === "telemetry") document.body.classList.add("popout-telemetry");
if (POPOUT_KIND === "log") document.body.classList.add("popout-log");
if (POPOUT_KIND === "host") document.body.classList.add("popout-host");

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
$("btn-popback-telemetry").hidden = POPOUT_KIND !== "telemetry";
$("btn-popback-host").hidden = POPOUT_KIND !== "host";
$("btn-popback-telemetry").onclick = () => window.close();
$("btn-popback-host").onclick = () => window.close();

/* ── time/pixel mapping ─────────────────────────────────────────────────── */

function plotWidth() {
  // svc and host strips share the same geometry; fall back to whichever
  // container is actually visible (a host-only popout hides #charts).
  const el = chartsEl.clientWidth > 0 ? chartsEl : hostChartsEl;
  return Math.max(50, el.clientWidth - MARGIN_L - MARGIN_R);
}
function xToT(x) {
  const { t0, t1 } = state.view;
  return t0 + ((x - MARGIN_L) / plotWidth()) * (t1 - t0);
}
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
  const hostPoppedOut = !POPOUT_KIND && state.poppedOut.has("host");
  // a "telemetry"/"log" popout only ever shows containers, never the host.
  hostBlockEl.hidden = POPOUT_KIND === "host" ? false : (POPOUT_KIND != null || !hasHost || hostPoppedOut);
  hostChartsEl.hidden = !state.showHost;
  $("host-nav").hidden = !state.showHost;
  $("btn-host-toggle").textContent = state.showHost ? "\u25be" : "\u25b8";
  $("btn-host-toggle").title = state.showHost ? "Hide host telemetry" : "Show host telemetry";
  STRIPS.forEach((spec, i) => drawStrip(stripCanvases[i], spec, "svc", i === STRIPS.length - 1));
  if (hasHost && state.showHost && !hostBlockEl.hidden)
    STRIPS.forEach((spec, i) => drawStrip(hostCanvases[i], spec, "host", i === STRIPS.length - 1));
  drawLanes();
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
  const logs = state.sources.filter((s) => s.kind === "log" && !isSampleHidden(s.id));
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

const LANE_H = 18;

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
      ctx.fillRect(x, 3, Math.max(1, pw / n - 0.5), LANE_H - 6);
    }
    ctx.globalAlpha = 1;
  }
  drawVerticals(ctx, LANE_H);
}

function attachLaneEvents(c) {
  c.addEventListener("mousedown", (e) => timelineDown(c, e));
  c.addEventListener("mouseup", (e) => timelineUp(c, e));
  c.addEventListener("dblclick", (e) => {
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < MARGIN_L || !state.view) return;
    recenterOn(xToT(x));
  });
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
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtxMenu(); });

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
          ssh_key: prefs.get("sshKeys", {})[host] || null,
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

function legendItem(name, cls, label = name) {
  const item = document.createElement("span");
  item.className = "legend-item" + (cls ? " " + cls : "");
  const sw = document.createElement("span");
  sw.className = "legend-swatch";
  sw.style.background = cls === "disabled" ? "var(--muted)" : colorFor(name);
  item.append(sw, document.createTextNode(label));
  return item;
}

function legendChip(text) {
  const chip = document.createElement("span");
  chip.className = "legend-chip";
  chip.textContent = text;
  return chip;
}

// one row per loaded .cttc file, with a slide switch to show/hide everything
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

function renderLegend() {
  legendEl.innerHTML = "";
  renderSampleFiles();
  const all = allSvcSeries();
  const sel = all.filter((s) => trackStateOf(s) === "sel");
  const mut = all.filter((s) => trackStateOf(s) === "mut");
  const hid = all.filter((s) => trackStateOf(s) === "hid");

  for (const s of sel) {
    const sample = !isLiveSid(s.sid);
    const cls = (state.visible.get(s.name) === false ? "off " : "") + (sample ? "sample" : "");
    const item = legendItem(s.name, cls.trim(), s.name + sampleFileLabel(s.sid));
    if (sample) item.title = "from loaded .cttc metrics";
    item.onclick = () => {
      state.visible.set(s.name, state.visible.get(s.name) === false);
      relist();
    };
    item.oncontextmenu = (e) => ctxMenu(e, [
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

function setSampleArmed(v) {
  sampleArmed = v;
  $("btn-sample").classList.toggle("armed", v);
}

function timelineDown(c, e) {
  const rect = c.getBoundingClientRect();
  dragStart = e.clientX - rect.left;
  dragIsSample = e.shiftKey || sampleArmed;
  dragX = null;
}

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

function askExportOptions() {
  return new Promise((resolve) => {
    const hasHost = hasHostSeries();
    const cb = $("export-host");
    cb.checked = hasHost;
    $("export-host-note").textContent = hasHost
      ? "Currently being collected — included automatically unless you uncheck this."
      : "Not currently collected — checking this starts collecting it now (this past range won't have host data yet, but later saved metrics will).";
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

async function exportSample(t0, t1) {
  const opts = await askExportOptions();
  if (!opts) return;
  if (opts.includeHost && !opts.hadHost) {
    try {
      const host = currentDockerHost();
      await post("/docker/collect", {
        host, stats: false, host_stats: true, logs: [], transforms: [],
        ssh_key: prefs.get("sshKeys", {})[host] || null,
        interval: 5,
      });
    } catch (err) {
      setStatus("could not start host telemetry: " + (err.message || err));
    }
  }
  const name = `metrics-${new Date(t0).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.cttc`;
  let path = window.cttc?.saveFile ? await window.cttc.saveFile(name)
                                   : prompt("Save metrics as (.cttc):", name);
  if (!path) return;
  if (!path.endsWith(".cttc")) path += ".cttc";
  try {
    const r = await post("/sample/export", { path, from: t0, to: t1, include_host: opts.includeHost });
    setStatus(r.sources ? `metrics saved: ${r.path} (${r.sources} sources)`
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

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
    c.addEventListener("dblclick", (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < MARGIN_L || !state.view) return;
      recenterOn(xToT(x));
    });
    c.addEventListener("contextmenu", (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < MARGIN_L || !state.view) return;
      const t = xToT(x);
      ctxMenu(e, [
        ["📸 Take snapshot at this time", () => takeSnapshot(t)],
        ["🔍+ Zoom in here", () => zoomAt(t, 0.5)],
        ["🔍− Zoom out here", () => zoomAt(t, 2)],
        ["↺ Reset zoom", resetZoom],
      ]);
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
  // center the cursor (and with it every log panel) on the middle of the
  // data, matching what a double-click on the timeline does
  setCursor((state.range.min_ts + state.range.max_ts) / 2);
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

const DEFAULT_SPAN = 10 * 60 * 1000; // initial window: now ± 5 min

function pan(frac) {
  if (!state.view) return;
  const d = (state.view.t1 - state.view.t0) * frac;
  setView(state.view.t0 + d, state.view.t1 + d);
}

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
  $("cursor-label").textContent = "t = " + new Date(t).toISOString().replace("T", " ").replace("Z", " UTC");
  drawAll();
  for (const p of panels.values()) p.jumpTo(t);
  if (opts.broadcast !== false) window.cttc?.broadcastSync?.({ type: "cursor", t });
}

/* ── log panels (virtual scroll) ────────────────────────────────────────── */

const panels = new Map(); // source id -> Panel

class Panel {
  constructor(src) {
    this.src = src;
    this.total = src.total;
    this.pages = new Map(); // pageIdx -> rows | Promise
    this.cursorIdx = null;

    this.el = document.createElement("div");
    this.el.className = "panel";
    const head = document.createElement("div");
    head.className = "panel-head";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = src.name;
    name.title = src.path;
    this.sampleBadge = document.createElement("span");
    this.sampleBadge.className = "sample-badge";
    this.sampleBadge.title = "static data from loaded .cttc metrics";
    this.sampleBadge.hidden = true;
    this.countEl = document.createElement("span");
    this.countEl.className = "muted";
    this.errEl = document.createElement("span");
    this.errEl.className = "error";
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
      window.cttc.popout("log", src.id);
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
      popback.textContent = "⤴ Pop back";
      popback.title = "Pop back into the main window";
      popback.onclick = () => window.close();
      right.append(popback);
    }
    head.append(name, this.sampleBadge, this.countEl, this.errEl, searchToggle, right);

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
    this.body.appendChild(this.spacer);
    this.body.addEventListener("scroll", () => this.render());

    this.el.append(head, this.searchBar, this.body);
    this.update(src);
  }

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
    this.errEl.textContent = src.error ? ` ${src.error}` : "";
    this.spacer.style.height = this.total * ROWH + "px";
    this.render();
  }

  async page(idx) {
    if (this.pages.has(idx)) return this.pages.get(idx);
    const pr = get(`/logs?source=${this.src.id}&start=${idx * PAGE}&count=${PAGE}`).then((r) => {
      this.pages.set(idx, r.rows);
      return r.rows;
    });
    this.pages.set(idx, pr);
    return pr;
  }

  async render() {
    const h = this.body.clientHeight;
    const i0 = Math.max(0, Math.floor(this.body.scrollTop / ROWH) - 10);
    const i1 = Math.min(this.total - 1, Math.ceil((this.body.scrollTop + h) / ROWH) + 10);
    if (i1 < i0) return;
    const p0 = Math.floor(i0 / PAGE), p1 = Math.floor(i1 / PAGE);
    const pages = {};
    for (let p = p0; p <= p1; p++) pages[p] = await this.page(p);

    for (const r of this.body.querySelectorAll(".log-row")) r.remove();
    const frag = document.createDocumentFragment();
    for (let i = i0; i <= i1; i++) {
      const row = pages[Math.floor(i / PAGE)]?.[i % PAGE];
      if (!row) continue;
      const div = document.createElement("div");
      div.className = "log-row";
      div.style.top = i * ROWH + "px";
      if (state.cursorT != null && Math.abs(row.ts - state.cursorT) <= state.windowMs)
        div.classList.add("hl");
      if (i === this.cursorIdx) div.classList.add("cursor-row");
      if (/\b(ERROR|FATAL|CRIT)/i.test(row.text)) div.classList.add("lvl-error");
      else if (/\bWARN/i.test(row.text)) div.classList.add("lvl-warn");
      if (this.searchQuery && row.text.toLowerCase().includes(this.searchQuery)) div.classList.add("search-hit");
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = fmtClock(row.ts, true);
      div.appendChild(ts);
      div.appendChild(document.createTextNode(row.text.split("\n")[0]));
      div.title = new Date(row.ts).toISOString() + "\n" + row.text;
      div.onclick = () => setCursor(row.ts);
      frag.appendChild(div);
    }
    this.body.appendChild(frag);
  }

  async jumpTo(t) {
    try {
      const r = await get(`/index_at?source=${this.src.id}&t=${t}`);
      this.cursorIdx = r.index;
      this.body.scrollTop = Math.max(0, r.index * ROWH - this.body.clientHeight / 2 + ROWH / 2);
      this.render();
    } catch { /* source may have vanished */ }
  }

  async jumpToIndex(idx) {
    this.cursorIdx = idx;
    this.body.scrollTop = Math.max(0, idx * ROWH - this.body.clientHeight / 2 + ROWH / 2);
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

  scrollToEnd() {
    this.body.scrollTop = this.spacer.offsetHeight;
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
    const wasAtEnd = state.view && state.range && state.view.t1 >= state.range.max_ts;
    state.range = range;
    $("empty-state").hidden = state.sources.length > 0;
    syncPanels();
    if (range.min_ts != null && (!hadView || (state.follow && wasAtEnd !== false))) {
      if (!hadView) resetZoom();
      else if (state.follow) {
        const span = state.view.t1 - state.view.t0;
        setView(range.max_ts - span, range.max_ts);
        for (const p of panels.values()) p.scrollToEnd();
      }
    }
    await fetchSeries();
    setStatus(src.json_impl === "orjson" ? "" : "server running without orjson (slow parse)");
  } catch (err) {
    setStatus("server unreachable: " + err.message);
  }
}

function connectSSE() {
  const es = new EventSource(API + "/events");
  es.onmessage = () => scheduleRefresh();
  es.onerror = () => setStatus("reconnecting to server…");
  es.onopen = () => setStatus("");
}

/* ── add-sources dialog (Docker) ────────────────────────────────────────── */

const dlg = $("dlg-add");

function chosenTransforms() {
  return [...dlg.querySelectorAll("#transforms-list input:checked")].map((i) => i.value);
}

// A target that is already being collected can only be selected once: its
// checkbox is disabled while the matching source is open.
function openPaths() {
  return new Set(state.sources.map((s) => s.path));
}

function updateDockerDupes() {
  const hostKey = $("docker-host").value.trim() || "local";
  const paths = openPaths();
  for (const [cbId, noteId, path] of [
    ["docker-stats", "docker-stats-note", `docker://${hostKey}/stats`],
    ["docker-host-stats", "docker-host-stats-note", `docker://${hostKey}/host`],
  ]) {
    const dup = paths.has(path);
    $(cbId).disabled = dup;
    if (dup) $(cbId).checked = false;
    $(noteId).textContent = dup ? "— already collecting" : "";
  }
}

$("btn-add").onclick = async () => {
  $("docker-targets").innerHTML = "";
  $("docker-error").textContent = "";
  setContainersListed(false);
  updateDockerDupes();
  refreshSshKeyRow();
  try {
    const t = await get("/transforms");
    const box = $("transforms-list");
    box.innerHTML = t.transforms.length ? "" : "none found in server/transforms/";
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
      box.appendChild(label);
    }
  } catch { /* server down; dialog still usable once it's back */ }
  dlg.showModal();
};

/* ── load .cttc metrics (separate from the Docker "Add sources" flow) ──── */

$("btn-load-sample").onclick = async () => {
  let paths = [];
  if (window.cttc?.pickFiles) paths = await window.cttc.pickFiles();
  else {
    const p = prompt("Path to .cttc metrics file:");
    if (p) paths = [p];
  }
  const open = openPaths();
  const files = paths.filter((p) => p.endsWith(".cttc") && !open.has(p));
  if (!files.length) return;
  try {
    const r = await post("/open", { files: files.map((path) => ({ path, live: false })) });
    if (r.errors?.length) alert(r.errors.map((e) => `${e.path}: ${e.error}`).join("\n"));
    await refreshAll();
    resetZoom(); // show the full timeline, including the newly loaded metrics
  } catch (err) {
    alert(String(err.message || err));
  }
};

/* ── ssh key selection (ssh:// docker hosts) ────────────────────────────── */

const BROWSE = "__browse__";

function currentSshKey() {
  const v = $("ssh-key").value;
  return $("ssh-key-row").hidden || !v || v === BROWSE ? null : v;
}

function rememberSshKey() {
  const host = $("docker-host").value.trim();
  if (!host) return;
  const map = prefs.get("sshKeys", {});
  map[host] = currentSshKey();
  prefs.set("sshKeys", map);
}

async function refreshSshKeyRow() {
  const host = $("docker-host").value.trim();
  const row = $("ssh-key-row");
  row.hidden = !host.startsWith("ssh://");
  if (row.hidden) return;
  const sel = $("ssh-key");
  const remembered = prefs.get("sshKeys", {})[host] ?? null;
  const chosen = sel.dataset.filled ? currentSshKey() : null;
  let keys = [];
  try {
    keys = (await get("/ssh/keys")).keys;
  } catch { /* server down; the default option still works */ }
  sel.innerHTML = "";
  const add = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  add("", "default (ssh config / agent)");
  for (const k of keys) add(k, k.replace(/^.*\/\.ssh\//, "~/.ssh/"));
  add(BROWSE, "browse…");
  const want = chosen || remembered;
  if (want && ![...sel.options].some((o) => o.value === want)) add(want, want);
  sel.value = want || "";
  sel.dataset.filled = "1";
}

$("ssh-key").onchange = async () => {
  const sel = $("ssh-key");
  if (sel.value === BROWSE) {
    const paths = window.cttc?.pickFiles ? await window.cttc.pickFiles() : [];
    if (paths.length) {
      const o = document.createElement("option");
      o.value = paths[0];
      o.textContent = paths[0];
      sel.insertBefore(o, sel.querySelector(`option[value="${BROWSE}"]`));
      sel.value = paths[0];
    } else {
      sel.value = "";
    }
  }
  rememberSshKey();
};

let containersListed = false;

function setContainersListed(listed) {
  containersListed = listed;
  $("btn-ps").checked = listed;
  $("btn-ps-label").textContent = listed ? "Hide containers" : "Show containers";
  $("btn-ps-refresh").hidden = !listed;
}

async function listContainers() {
  $("docker-error").textContent = "";
  const box = $("docker-targets");
  const host = $("docker-host").value.trim() || null;
  box.textContent = "listing…";
  try {
    const r = await post("/docker/ps", { host, ssh_key: currentSshKey() });
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
        cb.value = it.name;
        cb.dataset.type = type;
        label.append(cb, ` ${it.name} `);
        const extra = document.createElement("span");
        extra.className = "tdoc";
        extra.textContent = it.image || it.replicas || "";
        if (open.has(`docker://${hostKey}/${type}/${it.name}`)) {
          cb.disabled = true;
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
    setContainersListed(true);
  } catch (err) {
    box.innerHTML = "";
    $("docker-error").textContent = String(err.message || err);
    setContainersListed(false);
  }
}

$("btn-ps").onchange = (e) => {
  if (!e.target.checked) {
    $("docker-targets").innerHTML = "";
    $("docker-error").textContent = "";
    setContainersListed(false);
    return;
  }
  listContainers();
};

$("btn-ps-refresh").onclick = () => listContainers();
$("docker-host").oninput = () => {
  updateDockerDupes();
  refreshSshKeyRow();
};

$("dlg-cancel").onclick = () => dlg.close();

$("dlg-ok").onclick = async () => {
  const transforms = chosenTransforms();
  try {
    const host = $("docker-host").value.trim() || null;
    const logs = [...$("docker-targets").querySelectorAll("input:checked:not(:disabled)")].map((cb) => ({
      name: cb.value,
      type: cb.dataset.type,
    }));
    const stats = $("docker-stats").checked;
    const hostStats = $("docker-host-stats").checked;
    if (stats || hostStats || logs.length) {
      await post("/docker/collect", {
        host, stats, logs, transforms,
        host_stats: hostStats,
        ssh_key: currentSshKey(),
        interval: Number($("docker-interval").value) || 5,
      });
      // containers picked here are the "selected" set shown in the legend
      for (const l of logs) setTrack(l.name, "sel");
    }
    dlg.close();
    refreshAll();
  } catch (err) {
    alert(String(err.message || err));
  }
};

/* ── toolbar ────────────────────────────────────────────────────────────── */

$("win-secs").onchange = (e) => {
  state.windowMs = Math.max(0, Number(e.target.value) || 0) * 1000;
  for (const p of panels.values()) p.render();
};
$("chk-follow").onchange = (e) => {
  state.follow = e.target.checked;
  if (state.follow) refreshAll();
};
$("btn-sample").onclick = () => setSampleArmed(!sampleArmed);
$("btn-popout-telemetry").onclick = () => {
  state.poppedOut.add("telemetry");
  applyPopoutLayout();
  window.cttc.popout("telemetry");
};
$("btn-popout-host").onclick = () => {
  state.poppedOut.add("host");
  drawAll();
  window.cttc.popout("host");
};

function syncStyleButton() {
  $("btn-style").textContent = state.chartStyle === "bars" ? "▤ histogram" : "〜 lines";
}
$("btn-style").onclick = () => {
  state.chartStyle = state.chartStyle === "bars" ? "lines" : "bars";
  prefs.set("chartStyle", state.chartStyle);
  syncStyleButton();
  drawAll();
};

$("btn-host-toggle").onclick = () => {
  state.showHost = !state.showHost;
  prefs.set("showHost", state.showHost);
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
// panel windows start with no view so the first refreshAll() fits the full
// available range instead (they then track the opener via sync-broadcast).
if (!POPOUT_KIND) centerOnNow();
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

refreshAll();
connectSSE();
