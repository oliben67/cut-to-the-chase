"use strict";

/* ── server connection ──────────────────────────────────────────────────── */

const PORT = new URLSearchParams(location.search).get("port") || "8765";
const API = `http://127.0.0.1:${PORT}`;

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
  hoverGroup: "svc",      // strip group under the pointer: "svc" | "host"
  chartStyle: prefs.get("chartStyle", "lines"), // "lines" | "bars"
  showHost: prefs.get("showHost", true),
  track: prefs.get("track", {}),           // series name -> "sel" | "mut" | "hid"
  showOthers: prefs.get("showOthers", true), // list not-selected containers in legend
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

/* ── layout references ──────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const chartsEl = $("charts"), lanesEl = $("lanes"), legendEl = $("legend");
const panelsEl = $("panels"), tooltipEl = $("tooltip");
const hostChartsEl = $("host-charts"), hostBlockEl = $("host-block");

/* ── time/pixel mapping ─────────────────────────────────────────────────── */

function plotWidth() {
  return Math.max(50, chartsEl.clientWidth - MARGIN_L - MARGIN_R);
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
    return !respectVisibility || state.visible.get(s.name) !== false;
  });
}

function allSvcSeries() {
  return (state.series?.services || []).filter((s) => !s.host);
}

function drawAll() {
  if (!state.view) return;
  const hasHost = seriesOf("host", false).length > 0;
  hostBlockEl.hidden = !hasHost;
  hostChartsEl.hidden = !state.showHost;
  $("btn-host-toggle").textContent = state.showHost ? "hide" : "show";
  STRIPS.forEach((spec, i) => drawStrip(stripCanvases[i], spec, "svc", i === STRIPS.length - 1));
  if (hasHost && state.showHost)
    STRIPS.forEach((spec, i) => drawStrip(hostCanvases[i], spec, "host", i === STRIPS.length - 1));
  drawLanes();
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
    // series stay readable
    const bw = Math.max(1, pw / px - 0.5);
    ctx.globalAlpha = services.length > 1 ? 0.55 : 0.85;
    for (const s of services) {
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
    // series lines (2px). Buckets are sparse when zoomed out (one sample every
    // N pixels), so connect across gaps up to ~4x the typical sample spacing
    // and render truly isolated samples as dots.
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
  const logs = state.sources.filter((s) => s.kind === "log");
  // rebuild DOM if the set changed
  const want = logs.map((s) => s.id).join(",");
  if (lanesEl.dataset.ids !== want) {
    lanesEl.dataset.ids = want;
    lanesEl.innerHTML = "";
    for (const s of logs) {
      const canvas = document.createElement("canvas");
      canvas.className = "lane-canvas";
      canvas.dataset.sid = s.id;
      canvas.title = s.path;
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
  const color = colorFor(src?.name || sid);
  if (counts) {
    const maxC = Math.max(1, ...counts);
    const n = counts.length;
    ctx.fillStyle = color;
    for (let b = 0; b < n; b++) {
      if (!counts[b]) continue;
      ctx.globalAlpha = 0.35 + 0.65 * (counts[b] / maxC);
      const x = MARGIN_L + (b / n) * pw;
      ctx.fillRect(x, 3, Math.max(1, pw / n - 0.5), LANE_H - 6);
    }
    ctx.globalAlpha = 1;
  }
  // source name inside the plot, like a strip title (identity also carried by hue)
  ctx.font = "600 10px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = themeVar("--text-secondary");
  ctx.fillText(src?.name || sid, MARGIN_L + 4, LANE_H - 6);
  drawVerticals(ctx, LANE_H);
}

function attachLaneEvents(c) {
  c.addEventListener("mousedown", (e) => timelineDown(c, e));
  c.addEventListener("mouseup", (e) => timelineUp(c, e));
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

function legendItem(name, cls) {
  const item = document.createElement("span");
  item.className = "legend-item" + (cls ? " " + cls : "");
  const sw = document.createElement("span");
  sw.className = "legend-swatch";
  sw.style.background = cls === "disabled" ? "var(--muted)" : colorFor(name);
  item.append(sw, document.createTextNode(name));
  return item;
}

function legendChip(text) {
  const chip = document.createElement("span");
  chip.className = "legend-chip";
  chip.textContent = text;
  return chip;
}

function relist() {
  renderLegend();
  drawAll();
}

function renderLegend() {
  legendEl.innerHTML = "";
  const all = allSvcSeries();
  const sel = all.filter((s) => trackStateOf(s) === "sel");
  const mut = all.filter((s) => trackStateOf(s) === "mut");
  const hid = all.filter((s) => trackStateOf(s) === "hid");

  for (const s of sel) {
    const item = legendItem(s.name, state.visible.get(s.name) === false ? "off" : "");
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

async function exportSample(t0, t1) {
  const name = `sample-${new Date(t0).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.cttc`;
  let path = window.cttc?.saveFile ? await window.cttc.saveFile(name)
                                   : prompt("Save sample as (.cttc):", name);
  if (!path) return;
  if (!path.endsWith(".cttc")) path += ".cttc";
  try {
    const r = await post("/sample/export", { path, from: t0, to: t1 });
    setStatus(r.sources ? `sample saved: ${r.path} (${r.sources} sources)`
                        : "sample saved, but no data in the selected range");
  } catch (err) {
    setStatus("sample export failed: " + (err.message || err));
  }
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
    c.addEventListener("dblclick", resetZoom);
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

function setView(t0, t1) {
  if (t1 - t0 < 200) return; // 200ms minimum zoom
  state.view = { t0, t1 };
  scheduleSeriesFetch();
  drawAll();
}

function resetZoom() {
  if (!state.range || state.range.min_ts == null) return;
  const pad = Math.max(1000, (state.range.max_ts - state.range.min_ts) * 0.01);
  setView(state.range.min_ts - pad, state.range.max_ts + pad);
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

async function setCursor(t) {
  state.cursorT = t;
  $("cursor-label").textContent = "t = " + new Date(t).toISOString().replace("T", " ").replace("Z", " UTC");
  drawAll();
  for (const p of panels.values()) p.jumpTo(t);
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
    this.countEl = document.createElement("span");
    this.countEl.className = "muted";
    this.errEl = document.createElement("span");
    this.errEl.className = "error";
    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "✕";
    close.title = "Close source";
    close.onclick = async () => { await post("/close", { id: src.id }); refreshAll(); };
    head.append(name, this.countEl, this.errEl, close);

    this.body = document.createElement("div");
    this.body.className = "panel-body";
    this.spacer = document.createElement("div");
    this.spacer.className = "panel-spacer";
    this.body.appendChild(this.spacer);
    this.body.addEventListener("scroll", () => this.render());

    this.el.append(head, this.body);
    this.update(src);
  }

  update(src) {
    this.src = src;
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

  scrollToEnd() {
    this.body.scrollTop = this.spacer.offsetHeight;
  }
}

function syncPanels() {
  const logs = state.sources.filter((s) => s.kind === "log");
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

/* ── add-sources dialog ─────────────────────────────────────────────────── */

const dlg = $("dlg-add");
let pickedFiles = [];
let activeTab = "files";

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
  pickedFiles = [];
  $("picked-files").innerHTML = "";
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
  } catch { /* server down; dialog still usable for files once it's back */ }
  dlg.showModal();
};

for (const tab of dlg.querySelectorAll(".tab")) {
  tab.onclick = () => {
    activeTab = tab.dataset.tab;
    for (const t of dlg.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    $("page-files").hidden = activeTab !== "files";
    $("page-docker").hidden = activeTab !== "docker";
  };
}

$("btn-pick").onclick = async () => {
  let paths = [];
  if (window.cttc?.pickFiles) paths = await window.cttc.pickFiles();
  else {
    const p = prompt("Path(s) to open, comma-separated:");
    if (p) paths = p.split(",").map((s) => s.trim()).filter(Boolean);
  }
  pickedFiles.push(...paths.filter((p) => !pickedFiles.includes(p)));
  const ul = $("picked-files");
  ul.innerHTML = "";
  const open = openPaths();
  for (const p of pickedFiles) {
    const li = document.createElement("li");
    li.textContent = p;
    if (open.has(p)) {
      li.classList.add("added");
      li.textContent = p + " — already open";
    }
    ul.appendChild(li);
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
  $("btn-ps").textContent = listed ? "Hide containers" : "List containers";
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

$("btn-ps").onclick = () => {
  if (containersListed) {
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
    if (activeTab === "files") {
      const open = openPaths();
      const files = pickedFiles.filter((p) => !open.has(p));
      if (files.length) {
        const live = $("files-live").checked;
        const r = await post("/open", {
          files: files.map((p) => ({ path: p, live, transforms })),
        });
        if (r.errors?.length) alert(r.errors.map((e) => `${e.path}: ${e.error}`).join("\n"));
      }
    } else {
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
$("btn-reset").onclick = resetZoom;
$("btn-sample").onclick = () => setSampleArmed(!sampleArmed);
$("btn-back").onclick = () => pan(-0.5);
$("btn-fwd").onclick = () => pan(0.5);
$("btn-now").onclick = centerOnNow;

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
centerOnNow(); // default view: the present, ± DEFAULT_SPAN/2
new ResizeObserver(() => {
  scheduleSeriesFetch();
  drawAll();
}).observe(chartsEl);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawAll);

refreshAll();
connectSSE();
