// CTTC renderer E2E spec. Runs inside the app window via CTTC_TEST (see
// main.js): full access to app.js globals, the real DOM, and the real server
// (launched with the demo data files). Must evaluate to a promise resolving
// to {passed, failed, failures: [...]}.
(async () => {
  "use strict";
  const results = { passed: 0, failed: 0, failures: [] };
  const T = async (name, fn) => {
    try {
      await fn();
      results.passed++;
    } catch (e) {
      results.failed++;
      results.failures.push(`${name}: ${e && (e.message || e)}`);
    }
  };
  const ok = (v, msg) => { if (!v) throw new Error(msg || "expected truthy"); };
  const eq = (a, b, msg) => {
    if (a !== b) throw new Error(`${msg || "eq"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  };
  const near = (a, b, tol, msg) => {
    if (Math.abs(a - b) > tol) throw new Error(`${msg || "near"}: |${a} - ${b}| > ${tol}`);
  };
  const sleep = (n) => new Promise((r) => setTimeout(r, n));
  const until = async (cond, msg, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      if (cond()) return;
      await sleep(100);
    }
    throw new Error("timeout: " + msg);
  };
  const mouse = (el, type, x, y = 20, extra = {}) => {
    const bb = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true,
      clientX: bb.left + x, clientY: bb.top + y, buttons: 1, ...extra,
    }));
  };

  localStorage.clear();
  await until(() => state.range && state.range.min_ts != null, "server data loaded");
  await until(() => (state.series?.services || []).length > 0, "series loaded");
  const R = state.range;
  const MID = (R.min_ts + R.max_ts) / 2;

  /* ── pure helpers ─────────────────────────────────────────────────────── */

  await T("fmtBytes picks sensible units", () => {
    eq(fmtBytes(10), "10 B/s");
    eq(fmtBytes(1500), "1.5 kB/s");
    eq(fmtBytes(2.5e6), "2.5 MB/s");
    eq(fmtBytes(3e9), "3.0 GB/s");
  });

  await T("fmtClock renders with and without millis", () => {
    const t = new Date(2026, 0, 2, 3, 4, 5, 678).getTime();
    eq(fmtClock(t), "03:04:05");
    eq(fmtClock(t, true), "03:04:05.678");
  });

  await T("hexToRgb / grayedColor", () => {
    eq(JSON.stringify(hexToRgb("#ff0000")), "[255,0,0]");
    eq(hexToRgb("junk"), null);
    ok(grayedColor("#ff0000", "sX").startsWith("rgb("), "blends to rgb()");
    eq(grayedColor("junk", "sX"), "junk", "non-hex passes through");
  });

  await T("basename / escapeHtml / fmtIso", () => {
    eq(basename("/a/b/c.cttc-metric"), "c.cttc-metric");
    eq(basename(null), "");
    eq(escapeHtml('<a b="c">&\''), "&lt;a b=&quot;c&quot;&gt;&amp;&#39;");
    ok(fmtIso(0).endsWith(" UTC"));
  });

  await T("colorFor assigns stable slots and never folds to gray past 8", () => {
    const c1 = colorFor("__test_series_1");
    eq(colorFor("__test_series_1"), c1, "stable on repeat");
    const colors = [];
    for (let i = 1; i <= 12; i++) colors.push(colorFor("__test_series_" + i));
    // every one of the first 12 concurrent series gets its own distinct
    // color -- none of them (not just the first 8) may ever fold to the
    // shared --muted gray, which is reserved for actually disabled/
    // not-selected containers, not "the 9th+ live one".
    const muted = themeVar("--muted");
    ok(colors.every((c) => c !== muted), `no live series color may equal --muted: ${colors}`);
    ok(new Set(colors).size === colors.length, `every color must be distinct: ${colors}`);
    // stable on repeat past the 8-color curated palette too
    eq(colorFor("__test_series_10"), colors[9], "9th+ slot color stable on repeat");
  });

  /* ── view management ──────────────────────────────────────────────────── */

  await T("setView rejects sub-200ms spans", () => {
    setView(MID, MID + 60000);
    const before = { ...state.view };
    setView(MID, MID + 100);
    eq(state.view.t0, before.t0);
    eq(state.view.t1, before.t1);
  });

  await T("time <-> pixel mapping round-trips", () => {
    setView(MID - 30000, MID + 30000);
    near(xToT(tToX(MID + 12345)), MID + 12345, 100, "round trip");
  });

  await T("zoomAt scales the span around t", () => {
    setView(MID - 30000, MID + 30000);
    zoomAt(MID, 0.5);
    near(state.view.t1 - state.view.t0, 30000, 1, "halved");
    near((state.view.t0 + state.view.t1) / 2, MID, 1, "still centered");
  });

  await T("zoomAtAnchored keeps the anchor point fixed, unlike zoomAt", () => {
    setView(MID - 30000, MID + 30000);
    const anchor = MID + 10000; // off-center, so recentering would move it
    zoomAtAnchored(anchor, 0.5);
    near(state.view.t1 - state.view.t0, 30000, 1, "halved");
    near(anchor, state.view.t0 + (anchor - (MID - 30000)) * 0.5, 1, "anchor stayed put");
    // the anchor's position within the view (as a fraction of the span) is unchanged
    const before = { t0: MID - 30000, t1: MID + 30000 };
    const fracBefore = (anchor - before.t0) / (before.t1 - before.t0);
    const fracAfter = (anchor - state.view.t0) / (state.view.t1 - state.view.t0);
    near(fracBefore, fracAfter, 0.001, "anchor's relative position preserved");
  });

  await T("wheel over a chart zooms anchored on the cursor, not the view center", () => {
    setView(MID - 30000, MID + 30000);
    const canvas = document.querySelector("canvas[data-strip]");
    ok(canvas, "a strip canvas exists");
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width * 0.75; // off-center, right side
    const before = { ...state.view };
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: x, clientY: rect.top + 5, bubbles: true, cancelable: true }));
    ok(state.view.t1 - state.view.t0 < before.t1 - before.t0, "scrolling up (deltaY<0) zoomed in");

    setView(MID - 30000, MID + 30000);
    const before2 = { ...state.view };
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, clientX: x, clientY: rect.top + 5, bubbles: true, cancelable: true }));
    ok(state.view.t1 - state.view.t0 > before2.t1 - before2.t0, "scrolling down (deltaY>0) zoomed out");
  });

  await T("ctrl/meta+wheel over a chart is left alone (reserved for page zoom)", () => {
    setView(MID - 30000, MID + 30000);
    const canvas = document.querySelector("canvas[data-strip]");
    const rect = canvas.getBoundingClientRect();
    const before = { ...state.view };
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: rect.left + 10, clientY: rect.top + 5, ctrlKey: true, bubbles: true, cancelable: true }));
    eq(state.view.t0, before.t0);
    eq(state.view.t1, before.t1);
  });

  await T("recenterOn keeps span, moves center", () => {
    setView(MID - 30000, MID + 30000);
    recenterOn(R.min_ts);
    near((state.view.t0 + state.view.t1) / 2, R.min_ts, 1);
    near(state.view.t1 - state.view.t0, 60000, 1);
  });

  await T("centerOnNow centers on the present", () => {
    setView(MID, MID + 60000);
    centerOnNow();
    near((state.view.t0 + state.view.t1) / 2, Date.now(), 2000);
  });

  await T("setView turns state.live off unless called with _follow", () => {
    state.live = true;
    setView(MID, MID + 60000);
    ok(!state.live, "manual setView clears live");
    state.live = false;
    setView(MID, MID + 60000, { _follow: true });
    ok(!state.live, "_follow doesn't itself turn live on");
  });

  await T("followNow recenters ~5s behind now, keeping the span", () => {
    setView(MID, MID + 60000);
    const span = state.view.t1 - state.view.t0;
    followNow();
    near(state.view.t1 - state.view.t0, span, 5, "span preserved");
    near((state.view.t0 + state.view.t1) / 2, Date.now() - 5000, 2000, "centered ~5s behind now");
  });

  await T("goLive turns state.live on and jumps to the present", () => {
    state.live = false;
    setView(MID, MID + 60000);
    goLive();
    ok(state.live, "goLive sets state.live");
    near((state.view.t0 + state.view.t1) / 2, Date.now() - 5000, 2000, "centered ~5s behind now");
  });

  await T("resetZoom fits the data and places the cursor on now", () => {
    state.cursorT = null;
    resetZoom();
    ok(state.view.t0 < R.min_ts && state.view.t1 > R.max_ts, "view covers data + pad");
    near(state.cursorT, Date.now(), 2000, "cursor placed on now");
  });

  /* ── toolbar controls ─────────────────────────────────────────────────── */

  await T("chart style segmented control toggles lines/bars and persists", () => {
    const before = state.chartStyle;
    const other = before === "bars" ? "btn-style-lines" : "btn-style-histogram";
    $(other).click();
    ok(state.chartStyle !== before, "flipped");
    eq(prefs.get("chartStyle", null), state.chartStyle, "persisted");
    const back = before === "bars" ? "btn-style-histogram" : "btn-style-lines";
    $(back).click();
    eq(state.chartStyle, before, "flipped back");
  });

  await T("splitter drag changes strip height within clamps", () => {
    const before = stripH;
    const sp = $("splitter");
    mouse(sp, "mousedown", 5, 2);
    window.dispatchEvent(new MouseEvent("mousemove", { clientY: sp.getBoundingClientRect().top + 92, buttons: 1 }));
    window.dispatchEvent(new MouseEvent("mouseup", {}));
    ok(stripH !== before, `stripH moved (${before} -> ${stripH})`);
    ok(stripH >= 44 && stripH <= 320, "clamped");
    stripH = before;
    drawAll();
  });

  await T("timeline-nav 'now' label jumps live, centered 5s behind the present", () => {
    setView(MID, MID + 60000);
    document.querySelector("#chart-nav .tl-now-label").click();
    near((state.view.t0 + state.view.t1) / 2, Date.now() - 5000, 2000, "centered ~5s behind now");
    if (!state.live) throw new Error("expected state.live to be true after clicking 'now'");
  });

  await T("timeline-nav track click re-centers, keeping the span", () => {
    setView(MID - 30000, MID + 30000);
    const track = document.querySelector("#chart-nav .tl-track");
    const bb = track.getBoundingClientRect();
    track.dispatchEvent(new MouseEvent("click", {
      bubbles: true, clientX: bb.left + bb.width / 2, clientY: bb.top + 2,
    }));
    near(state.view.t1 - state.view.t0, 60000, 1, "span kept");
    const { lo, hi } = totalSpanBounds();
    near((state.view.t0 + state.view.t1) / 2, (lo + hi) / 2, (hi - lo) * 0.05, "centered on click");
  });

  /* ── track states & legend ────────────────────────────────────────────── */

  const names = allSvcSeries().map((s) => s.name);
  const NAME = names[0];

  await T("file-backed series default to selected", () => {
    for (const s of allSvcSeries()) eq(trackStateOf(s), "sel", s.name);
  });

  await T("docker-backed series default to not-selected", () => {
    state.sources.push({ id: "__fake_docker", path: "docker://local/stats", kind: "stats", live: true });
    try {
      eq(trackStateOf({ name: "__fake_c", sid: "__fake_docker" }), "mut");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__fake_docker");
    }
  });

  await T("legend renders three states with chips", () => {
    ok(names.length >= 3, "demo has 3 services");
    setTrack(names[1], "mut");
    setTrack(names[2], "hid");
    try {
      renderLegend();
      const txt = $("legend").innerText;
      ok(txt.includes("others (1)"), "others chip: " + txt);
      ok(txt.includes("hidden (1)"), "hidden chip: " + txt);
      ok($("legend").querySelector(".legend-item.disabled"), "disabled entry listed");
      eq(seriesOf("svc").length, names.length - 2, "only selected series plot");
    } finally {
      delete state.track[names[1]];
      delete state.track[names[2]];
      prefs.set("track", state.track);
      renderLegend();
    }
  });

  await T("legend click toggles series visibility", () => {
    renderLegend();
    const item = [...$("legend").querySelectorAll(".legend-item")].find((i) => i.textContent.includes(NAME));
    item.click();
    eq(state.visible.get(NAME), false, "dimmed");
    const n = seriesOf("svc").length;
    eq(n, names.length - 1, "hidden from plots");
    [...$("legend").querySelectorAll(".legend-item")].find((i) => i.textContent.includes(NAME)).click();
    eq(state.visible.get(NAME), true, "restored");
  });

  await T("legend click also hides/shows that container's log panel, in place", () => {
    const logSrc = state.sources.find((s) => s.kind === "log" && s.name === "c3_api");
    ok(logSrc, "c3_api log source is open in the demo");
    renderLegend();
    const item = [...$("legend").querySelectorAll(".legend-item")].find((i) => i.textContent.includes("c3_api"));
    ok(item, "c3_api legend entry present");
    const panel = panels.get(logSrc.id);
    ok(panel, "c3_api has an open panel");
    const indexBefore = [...panelsEl.children].indexOf(panel.el);
    try {
      item.click();
      eq(panel.el.hidden, true, "panel hidden");
      item.click();
      eq(panel.el.hidden, false, "panel visible again");
      eq([...panelsEl.children].indexOf(panel.el), indexBefore, "same slot as before");
    } finally {
      state.visible.delete("c3_api");
      syncPanels();
    }
  });

  await T("panel close button hides (not removes) the source, re-enabled via legend", async () => {
    const logSrc = state.sources.find((s) => s.kind === "log" && s.name === "c3_worker");
    ok(logSrc, "c3_worker log source is open in the demo");
    const panel = panels.get(logSrc.id);
    ok(panel, "c3_worker has an open panel");
    const closeBtn = panel.el.querySelector(".close");
    ok(closeBtn, "close button present");
    const sourcesBefore = state.sources.length;
    const realPost = post;
    const calls = [];
    post = async (path, body) => { calls.push(path); return realPost(path, body); };
    try {
      closeBtn.click();
      eq(calls.length, 0, "no server call made -- not a real /close");
      eq(panel.el.hidden, true, "panel hidden after close");
      eq(state.sources.length, sourcesBefore, "source not removed");
      ok(state.sources.some((s) => s.id === logSrc.id), "source still tracked (still collecting server-side)");
      renderLegend();
      const item = [...$("legend").querySelectorAll(".legend-item")].find((i) => i.textContent.includes("c3_worker"));
      ok(item, "still listed in legend (dimmed, not removed)");
      item.click();
      eq(panel.el.hidden, false, "panel reappears via the legend");
    } finally {
      post = realPost;
      state.visible.delete("c3_worker");
      syncPanels();
    }
  });

  await T("legend context menu opens and Escape closes it", async () => {
    renderLegend();
    const item = [...$("legend").querySelectorAll(".legend-item")].find((i) => i.textContent.includes(NAME));
    const bb = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bb.left + 5, clientY: bb.bottom + 3 }));
    ok(document.getElementById("ctxmenu"), "menu open");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    ok(!document.getElementById("ctxmenu"), "menu closed");
  });

  await T("seriesOf splits svc and host groups", () => {
    const saved = state.series;
    state.series = { px: 100, services: [
      { name: "__l", sid: "__none1", host: false, cpu: [], mem: [], net: [] },
      { name: "__h", sid: "__none2", host: true, cpu: [], mem: [], net: [] },
    ]};
    try {
      eq(seriesOf("svc").length, 1);
      eq(seriesOf("svc")[0].name, "__l");
      eq(seriesOf("host").length, 1);
      eq(hasHostSeries(), true);
    } finally {
      state.series = saved;
    }
  });

  await T("host block stays hidden without host series", () => {
    drawAll();
    eq(hostBlockEl.hidden, true);
  });

  /* ── timeline interactions on the real canvases ───────────────────────── */

  await T("click on a strip sets the cursor", async () => {
    setView(R.min_ts, R.max_ts);
    const c = stripCanvases[0];
    const x = tToX(MID);
    mouse(c, "mousedown", x);
    mouse(c, "mouseup", x);
    near(state.cursorT, MID, 60000, "cursor near clicked time");
    ok($("cursor-label").textContent.includes("UTC"), "cursor label set");
  });

  await T("drag on a strip zooms to the selection", () => {
    setView(R.min_ts, R.max_ts);
    const c = stripCanvases[0];
    const [xa, xb] = [tToX(MID - 120000), tToX(MID + 120000)];
    const want0 = xToT(xa), want1 = xToT(xb);
    mouse(c, "mousedown", xa);
    mouse(c, "mousemove", (xa + xb) / 2);
    mouse(c, "mouseup", xb);
    near(state.view.t0, want0, 1000);
    near(state.view.t1, want1, 1000);
  });

  await T("shift+drag routes to sample export", () => {
    setView(R.min_ts, R.max_ts);
    const real = exportSample;
    const calls = [];
    exportSample = (a, b) => calls.push([a, b]);
    try {
      const c = stripCanvases[0];
      mouse(c, "mousedown", tToX(MID - 60000), 20, { shiftKey: true });
      mouse(c, "mouseup", tToX(MID + 60000), 20, { shiftKey: true });
      eq(calls.length, 1, "exportSample called");
      ok(calls[0][0] < calls[0][1], "ordered range");
    } finally {
      exportSample = real;
    }
  });

  await T("'Capture metrics' context-menu entry arms the next drag for sample export", () => {
    const real = exportSample;
    const calls = [];
    exportSample = (a, b) => calls.push([a, b]);
    try {
      const c = stripCanvases[0];
      mouse(c, "contextmenu", tToX(MID));
      const menu = document.getElementById("ctxmenu");
      const item = [...menu.querySelectorAll("button")].find((b) => b.textContent.includes("Capture metrics"));
      ok(item, "menu has Capture metrics entry");
      item.click();
      ok(document.body.classList.contains("sample-armed"), "armed");
      mouse(c, "mousedown", tToX(MID - 60000));
      mouse(c, "mouseup", tToX(MID + 60000));
      eq(calls.length, 1);
      ok(!document.body.classList.contains("sample-armed"), "disarmed after use");
    } finally {
      exportSample = real;
    }
  });

  await T("double-click recenters on the clicked time", () => {
    setView(R.min_ts, R.max_ts);
    const span = state.view.t1 - state.view.t0;
    const c = stripCanvases[0];
    const t = MID + span / 4;
    mouse(c, "dblclick", tToX(t));
    near((state.view.t0 + state.view.t1) / 2, t, 2000);
  });

  await T("chart right-click offers snapshot/zoom entries", () => {
    setView(R.min_ts, R.max_ts);
    const c = stripCanvases[0];
    mouse(c, "contextmenu", tToX(MID));
    const menu = document.getElementById("ctxmenu");
    ok(menu, "menu open");
    const labels = [...menu.querySelectorAll("button")].map((b) => b.textContent).join("|");
    ok(labels.includes("snapshot"), labels);
    ok(labels.includes("Reset zoom"), labels);
    closeCtxMenu();
  });

  await T("tooltip appears over charted data", async () => {
    resetZoom();
    // wait for the refetch to catch up with the new window (120ms debounce)
    await until(() => state.series && Math.abs(state.series.from - state.view.t0) < 1000,
                "series matches reset view");
    const c = stripCanvases[0];
    mouse(c, "mousemove", tToX(MID), 30, { buttons: 0 });
    eq(tooltipEl.hidden, false, "tooltip visible over data");
    mouse(c, "mouseleave", 0);
    eq(tooltipEl.hidden, true, "hidden on leave");
  });

  /* ── log panels ───────────────────────────────────────────────────────── */

  await T("panels exist for each log source and jump to the cursor", async () => {
    const logs = state.sources.filter((s) => s.kind === "log");
    ok(logs.length >= 1, "demo logs open");
    eq(panels.size, logs.length);
    await setCursor(MID);
    await until(() => [...panels.values()].every((p) => p.cursorIdx != null), "panels jumped");
  });

  await T("log search endpoint finds entries", async () => {
    const sid = state.sources.find((s) => s.kind === "log").id;
    const r = await get(`/logs/find?source=${sid}&q=INFO&start=0`);
    ok(r.index != null && r.index >= 0, "found an INFO row");
    const none = await get(`/logs/find?source=${sid}&q=__no_such_text__`);
    eq(none.index, null);
  });

  await T("selecting log entries opens a time-anchored context menu, centered on their timestamps", async () => {
    const p = [...panels.values()][0];
    p.selected.clear();
    await p.render();
    let rows = [...p.body.querySelectorAll(".log-row")];
    ok(rows.length >= 2, "at least 2 rows rendered for the test");

    mouse(rows[0], "click", 5, 20, { ctrlKey: true });
    await until(() => p.selected.size === 1, "first row selected");
    rows = [...p.body.querySelectorAll(".log-row")];
    mouse(rows[1], "click", 5, 20, { ctrlKey: true });
    await until(() => p.selected.size === 2, "second row added to selection");

    rows = [...p.body.querySelectorAll(".log-row")];
    ok(rows[0].classList.contains("selected") && rows[1].classList.contains("selected"), "selected rows highlighted");

    const tsList = [...p.selected.values()];
    const expectedT = (Math.min(...tsList) + Math.max(...tsList)) / 2;

    const realSnapshot = takeSnapshot;
    let gotT = null;
    takeSnapshot = (t) => { gotT = t; };
    try {
      rows[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      const menu = document.getElementById("ctxmenu");
      ok(menu, "menu open");
      const items = [...menu.querySelectorAll("button")];
      const labels = items.map((b) => b.textContent).join("|");
      ok(labels.includes("Capture metrics"), labels);
      const snapItem = items.find((b) => b.textContent.includes("Take snapshot"));
      snapItem.click();
      eq(gotT, expectedT, "menu centered on selected entries' timestamps");
      eq(p.selected.size, 0, "selection cleared after the action");
    } finally {
      takeSnapshot = realSnapshot;
    }
  });

  await T("plain-clicking a log entry recenters the chart view on it", async () => {
    const p = [...panels.values()][0];
    p.selected.clear();
    setView(R.min_ts, R.min_ts + 60000); // arbitrary span, away from the row we'll click
    await p.render();
    const rows = [...p.body.querySelectorAll(".log-row")];
    ok(rows.length >= 1, "at least 1 row rendered for the test");

    const span = state.view.t1 - state.view.t0;
    mouse(rows[0], "click", 5, 20);
    await until(() => p.selected.size === 0, "click clears any selection");
    near(state.view.t1 - state.view.t0, span, 1, "span unchanged");
    ok(state.cursorT != null && Math.abs((state.view.t0 + state.view.t1) / 2 - state.cursorT) < 1,
      "view recentered on the clicked row's timestamp");
  });

  /* ── snapshots ────────────────────────────────────────────────────────── */

  await T("computeSlice returns telemetry and nearby log rows", async () => {
    const slice = await computeSlice(MID, { includeAll: true, includeLogs: true, ctxLines: 2 });
    ok(slice.services.length >= 1, "has services");
    ok(slice.logs.length >= 1, "has log slices");
    ok(slice.logs[0].rows.length >= 1 && slice.logs[0].rows.length <= 5, "ctx window respected");
  });

  await T("snapshotToText renders a readable report", () => {
    const txt = snapshotToText({
      t: MID, panoramaOn: true, panoramaUnit: "seconds", panoramaValue: 5,
      generated_at: "now",
      slices: [{ label: "at", t: MID,
        services: [{ name: "api", host: false, cpu: 1.5, mem: 2.5, net: 100, ts: MID }],
        logs: [{ source: "api", rows: [{ ts: MID, text: "hello\nworld" }] }] }],
    });
    ok(txt.includes("Snapshot @"), "header");
    ok(txt.includes("Panorama: +/- 5s"), "panorama line");
    ok(txt.includes("api") && txt.includes("1.5%"), "table");
    ok(txt.includes("hello") && !txt.includes("world"), "first log line only");
  });

  /* ── set-sources dialog logic ─────────────────────────────────────────── */

  await T("updateDockerDupes disables already-collected stats", () => {
    // dup-checking only matters once Fetch has actually run -- otherwise
    // every "what to collect" control stays disabled regardless (see
    // setDockerFormEnabled/dockerFormFetched), so simulate that precondition.
    setDockerFormEnabled(true);
    state.sources.push({ id: "__dup", path: "docker://local/stats", kind: "stats", live: true });
    try {
      $("docker-host").value = "";
      updateDockerDupes();
      eq($("docker-stats").disabled, true, "stats disabled");
      ok($("docker-stats-note").textContent.includes("already"), "note shown");
      // host telemetry has no checkbox to disable (always requested) -- just
      // a note when it's already open for this host, which it isn't here.
      eq($("docker-host-stats-note").textContent, "", "host stats note empty");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__dup");
      updateDockerDupes();
      eq($("docker-stats").disabled, false, "re-enabled");
      setDockerFormEnabled(false);
    }
  });

  await T("Set Docker Daemon dialog opens with the form empty and disabled", () => {
    $("btn-set").click();
    try {
      eq($("docker-targets").innerHTML, "", "targets empty");
      eq($("docker-stats").disabled, true, "stats disabled");
      eq($("docker-interval").disabled, true, "interval disabled");
      eq($("dlg-ok").disabled, true, "Set Docker Daemon disabled");
      // only Docker host / SSH key / Fetch stay usable up front
      eq($("docker-host").disabled, false, "host stays enabled");
      eq($("docker-ssh-key").disabled, false, "ssh key stays enabled");
      eq($("btn-ps-refresh").disabled, false, "fetch stays enabled");
    } finally {
      dlg.close();
    }
  });

  await T("Fetch lists only the current host's containers and enables the form", async () => {
    const realPost = post;
    const realGet = get;
    post = async (path, body) => {
      if (path === "/docker/ps") {
        return { containers: [{ id: "abc123", name: "demo", image: "nginx" }], services: [], log: [] };
      }
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      $("btn-set").click();
      $("docker-host").value = ""; // empty -- the gateway/local daemon is used
      await listContainers();
      eq($("docker-stats").disabled, false, "stats enabled after fetch");
      eq($("dlg-ok").disabled, false, "Set Docker Daemon enabled after fetch");
      ok($("docker-targets").textContent.includes("demo"), "fetched container listed");
    } finally {
      post = realPost;
      get = realGet;
      dlg.close();
    }
  });

  await T("clicking a group title in the Docker Daemon checklist toggles every checkbox in that group", async () => {
    const realPost = post;
    const realGet = get;
    post = async (path, body) => {
      if (path === "/docker/ps") {
        return {
          containers: [{ id: "a", name: "demo-a", image: "nginx" }, { id: "b", name: "demo-b", image: "nginx" }],
          services: [],
          log: [],
        };
      }
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      $("btn-set").click();
      $("docker-host").value = "";
      await listContainers();
      const boxes = [...$("docker-targets").querySelectorAll("input[type=checkbox]")];
      eq(boxes.length, 2, "both containers listed");
      ok(boxes.every((cb) => cb.checked), "checked by default");
      const group = $("docker-targets").querySelector(".group");
      group.click();
      ok(boxes.every((cb) => !cb.checked), "group click deselects all");
      group.click();
      ok(boxes.every((cb) => cb.checked), "group click re-selects all");
      boxes[0].checked = false;
      group.click();
      ok(boxes.every((cb) => cb.checked), "a mixed group selects all, rather than deselecting");
    } finally {
      post = realPost;
      get = realGet;
      dlg.close();
    }
  });

  await T("Edit Docker Daemon pre-fills and locks host/ssh-key, relabels buttons", () => {
    const fakeSrc = { id: "__edit_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons(); // a real app calls this via refreshAll() whenever state.sources changes
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    try {
      eq(currentDockerHost(), "ssh://u@h", "host resolved correctly (not truncated to 'ssh:')");
      eq($("btn-edit-docker-daemon").disabled, false, "Edit enabled once a daemon is being watched");
      eq($("btn-clear-sources").disabled, false, "Remove enabled once a daemon is being watched");
      $("btn-edit-docker-daemon").click();
      eq($("docker-host").value, "u@h", "host prefilled (scheme stripped for editing)");
      eq($("docker-host").disabled, true, "host locked");
      eq($("docker-ssh-key").value, "/path/to/key", "ssh key prefilled");
      eq($("docker-ssh-key").disabled, true, "ssh key locked");
      eq($("docker-ssh-key-browse").disabled, true, "browse locked");
      eq($("btn-ps-refresh").textContent, "Refresh", "Fetch relabeled Refresh");
      eq($("dlg-ok").textContent, "Update Docker Daemon", "confirm relabeled");
      eq($("dlg-set-title").textContent, "Edit Docker Daemon", "dialog titled for editing, not creating");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__edit_test");
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
      $("btn-set").click(); // resets host/ssh-key/labels back to create-mode defaults
      dlg.close();
    }
  });

  await T("Edit/Remove Docker Daemon are disabled when no daemon is being watched", () => {
    ok(!hasDockerDaemon(), "no docker:// source open in this suite's baseline state");
    eq($("btn-edit-docker-daemon").disabled, true, "Edit disabled");
    eq($("btn-clear-sources").disabled, true, "Remove disabled");
  });

  await T("Edit Docker Daemon pre-fills the checklist with already-followed containers/services before any Refresh", () => {
    const fakeStats = { id: "__prefill_stats", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    const fakeContainer = { id: "__prefill_c", path: "docker://ssh://u@h/container/demo-c", name: "demo-c", kind: "log", live: true };
    const fakeService = { id: "__prefill_s", path: "docker://ssh://u@h/service/demo-svc", name: "demo-svc", kind: "log", live: true };
    state.sources.push(fakeStats, fakeContainer, fakeService);
    syncDockerDaemonButtons();
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    try {
      $("btn-edit-docker-daemon").click();
      const text = $("docker-targets").textContent;
      ok(text.includes("demo-c"), `container pre-filled: ${text}`);
      ok(text.includes("demo-svc"), `service pre-filled: ${text}`);
      const boxes = [...$("docker-targets").querySelectorAll("input[type=checkbox]")];
      eq(boxes.length, 2, "one checkbox per already-followed container/service");
      ok(boxes.every((cb) => cb.checked), "pre-filled entries start checked");
      ok(boxes.every((cb) => !cb.disabled), "pre-filled entries are immediately interactive, no Refresh needed");
      ok($("docker-targets").querySelectorAll("label.added").length === 2, "both marked already added");
    } finally {
      state.sources = state.sources.filter((s) => !s.id.startsWith("__prefill_"));
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
      $("btn-set").click();
      dlg.close();
    }
  });

  await T("Refresh in Edit Docker Daemon re-fetches, leaves checkboxes selectable, and keeps host/ssh-key locked", async () => {
    const fakeSrc = { id: "__edit_test2", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons();
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    const realPost = post;
    const realGet = get;
    post = async (path, body) => {
      if (path === "/docker/ps") return { containers: [{ id: "x", name: "demo-x", image: "nginx" }], services: [], log: [] };
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      $("btn-edit-docker-daemon").click();
      $("btn-ps-refresh").click();
      await until(() => $("docker-targets").textContent.includes("demo-x"), "checklist populated after Refresh");
      const cb = $("docker-targets").querySelector("input[type=checkbox]");
      ok(cb, "checkbox rendered");
      eq(cb.disabled, false, "checkbox is selectable, not locked, in edit mode");
      eq($("docker-host").disabled, true, "host stays locked after a Refresh in edit mode");
      eq($("docker-ssh-key").disabled, true, "ssh key stays locked after a Refresh in edit mode");
    } finally {
      post = realPost;
      get = realGet;
      state.sources = state.sources.filter((s) => s.id !== "__edit_test2");
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
      $("btn-set").click();
      dlg.close();
    }
  });

  await T("Refresh diffs against the daemon's real state: gone containers drop, new ones appear checked, unchanged ones keep the user's own tick", async () => {
    const fakeContainerA = { id: "__diff_a", path: "docker://ssh://u@h/container/demo-a", name: "demo-a", kind: "log", live: true };
    const fakeContainerB = { id: "__diff_b", path: "docker://ssh://u@h/container/demo-b", name: "demo-b", kind: "log", live: true };
    state.sources.push(fakeContainerA, fakeContainerB);
    syncDockerDaemonButtons();
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    const realPost = post;
    const realGet = get;
    // The real daemon now only has demo-a (demo-b was removed) plus a
    // brand-new demo-c that was never tracked before.
    post = async (path, body) => {
      if (path === "/docker/ps") {
        return { containers: [{ id: "a", name: "demo-a" }, { id: "c", name: "demo-c" }], services: [], log: [] };
      }
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      $("btn-edit-docker-daemon").click();
      // pre-filled immediately from currentlyTrackedTargets, before any Refresh
      let names = [...$("docker-targets").querySelectorAll("input[type=checkbox]")].map((cb) => cb.value);
      eq(names.sort().join(), "demo-a,demo-b", "pre-filled with both already-tracked containers");
      // the user deliberately unchecks demo-a before refreshing
      const cbA = [...$("docker-targets").querySelectorAll("input[type=checkbox]")].find((cb) => cb.value === "demo-a");
      cbA.checked = false;
      $("btn-ps-refresh").click();
      await until(() => $("docker-targets").textContent.includes("demo-c"), "checklist updated after Refresh");
      const boxes = [...$("docker-targets").querySelectorAll("input[type=checkbox]")];
      names = boxes.map((cb) => cb.value);
      eq(names.sort().join(), "demo-a,demo-c", "demo-b (gone server-side) dropped, demo-c (new) appears");
      eq(boxes.find((cb) => cb.value === "demo-a").checked, false, "demo-a's deliberate uncheck survives the Refresh");
      eq(boxes.find((cb) => cb.value === "demo-c").checked, true, "demo-c (newly seen) starts checked");
    } finally {
      post = realPost;
      get = realGet;
      state.sources = state.sources.filter((s) => !s.id.startsWith("__diff_"));
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
      $("btn-set").click();
      dlg.close();
    }
  });

  await T("dockerHostKeys persists across restarts (regression: was in-memory only, lost the ssh key on relaunch)", () => {
    try {
      dockerHostKeys.set("ssh://persist-test@h", "/some/key/path");
      eq(prefs.get("dockerHostKeys", {})["ssh://persist-test@h"], "/some/key/path", "written to prefs, not just kept in memory");
    } finally {
      dockerHostKeys.delete("ssh://persist-test@h");
    }
  });

  await T("Set Docker Daemon (create mode) is never left showing edit-mode labels/locks", () => {
    $("btn-set").click();
    try {
      eq($("docker-host").disabled, false, "host unlocked");
      eq($("docker-ssh-key").disabled, false, "ssh key unlocked");
      eq($("docker-ssh-key-browse").disabled, false, "browse unlocked");
      eq($("btn-ps-refresh").textContent, "Fetch", "Fetch label restored");
      eq($("dlg-ok").textContent, "Set Docker Daemon", "confirm label restored");
      eq($("dlg-set-title").textContent, "Set Docker Daemon", "dialog re-titled for creating, not editing");
    } finally {
      dlg.close();
    }
  });

  await T("activity log toggle reflects the last docker/ps call", async () => {
    renderActivityLog(null);
    eq($("btn-activity-toggle").hidden, true, "hidden with no activity");
    eq($("docker-activity").hidden, true, "panel hidden with no activity");

    renderActivityLog([{ cmd: "docker ps --format json", returncode: 0, ms: 12, stderr: "" }]);
    eq($("btn-activity-toggle").hidden, false, "toggle shown once there's activity");
    ok($("docker-activity").textContent.includes("docker ps"), "logged command shown");

    $("btn-activity-toggle").click();
    eq($("docker-activity").hidden, false, "shown after toggle click");
    $("btn-activity-toggle").click();
    eq($("docker-activity").hidden, true, "hidden again after second click");
  });

  await T("normalizeDockerHost defaults a schemeless host to ssh://", () => {
    eq(normalizeDockerHost(""), null, "empty is local");
    eq(normalizeDockerHost("   "), null, "blank is local");
    eq(normalizeDockerHost("user@other-server"), "ssh://user@other-server", "bare user@host gets ssh://");
    eq(normalizeDockerHost("ssh://user@other-server"), "ssh://user@other-server", "already-schemed left alone");
    eq(normalizeDockerHost("tcp://1.2.3.4:2375"), "tcp://1.2.3.4:2375", "other schemes left alone too");
  });

  await T("openPaths reflects open sources", () => {
    const paths = openPaths();
    for (const s of state.sources) ok(paths.has(s.path), s.path);
  });

  /* ── sample round trip through the UI data model ──────────────────────── */

  await T("sample export + load shows grayed sample sources", async () => {
    const out = "/tmp/cttc-e2e-sample.cttc-metric";
    const r = await post("/sample/export", { path: out, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    ok(r.sources >= 2, "exported sources");
    const opened = (await post("/open", { files: [{ path: out }] })).opened;
    ok(opened.length >= 2, "reloaded sources");
    try {
      await refreshAll();
      const sample = state.sources.find((s) => s.live === false);
      ok(sample, "sample source present and static");
      eq(isLiveSid(sample.id), false);
      ok(sampleFileLabel(sample.id).includes("cttc-e2e-sample.cttc-metric"), "labeled with file");
      const groups = sampleFileGroups();
      eq(groups.length, 1, "one sample file group");
      ok(groups[0].ids.size >= 2, "group covers its sources");
      eq(isSampleHidden(sample.id), false);
      state.hiddenSamples.add(sample.path);
      eq(isSampleHidden(sample.id), true, "hide toggle honors path");
      state.hiddenSamples.delete(sample.path);
      ok(Array.isArray(dashFor(sample.id)), "dash pattern assigned");
      renderLegend();
      ok(document.getElementById("sample-files"), "sample chip row rendered");
    } finally {
      for (const sid of opened) await post("/close", { id: sid });
      await refreshAll();
    }
  });

  /* ── phase 3: /files/download + /files/upload client wiring ────────────── */

  await T("exportSample fetches real bytes from /files/download and hands them to saveBinaryFile", async () => {
    const realSave = saveBinaryFile;
    const realAsk = askExportOptions;
    let saved = null;
    saveBinaryFile = (name, bytes) => { saved = { name, bytes }; return "/tmp/" + name; };
    askExportOptions = async () => ({ includeHost: false, hadHost: false });
    try {
      await exportSample(R.min_ts, R.min_ts + 5 * 60000);
      ok(saved, "saveBinaryFile was called");
      ok(saved.name.endsWith(".cttc-metric"), saved.name);
      ok(saved.bytes instanceof Uint8Array && saved.bytes.length > 0, "got real bytes");
      eq(saved.bytes[0], 0x50, "PK zip magic byte 1"); // 'P'
      eq(saved.bytes[1], 0x4b, "PK zip magic byte 2"); // 'K'
      ok($("status").textContent.includes("metrics saved"), $("status").textContent);
    } finally {
      saveBinaryFile = realSave;
      askExportOptions = realAsk;
    }
  });

  await T("exportSample reports a cancel without touching the server response", async () => {
    const realSave = saveBinaryFile;
    const realAsk = askExportOptions;
    saveBinaryFile = () => null; // user closed the native dialog
    askExportOptions = async () => ({ includeHost: false, hadHost: false });
    try {
      await exportSample(R.min_ts, R.min_ts + 5 * 60000);
      ok($("status").textContent.includes("canceled"), $("status").textContent);
    } finally {
      saveBinaryFile = realSave;
      askExportOptions = realAsk;
    }
  });

  await T("uploadFile round-trips a real local log file through /files/upload", async () => {
    ok(window.cttc?.readFile, "preload readFile is present in the real app");
    const demoLog = state.sources.find((s) => s.kind === "log" && !basename(s.path).includes("worker"))?.path;
    ok(demoLog, "a real demo log path is open to upload");
    const r = await uploadFile(demoLog);
    ok(r.opened?.length === 1, JSON.stringify(r));
    eq(r.errors.length, 0);
    try {
      const src = (await get("/sources")).sources.find((s) => s.id === r.opened[0]);
      ok(src, "uploaded source is registered");
      eq(src.path, `upload://${basename(demoLog)}`, "synthetic display path");
      eq(src.live, false);
    } finally {
      await post("/close", { id: r.opened[0] });
    }
  });

  await T("Load metrics button's dedupe check accounts for the upload:// path scheme", () => {
    const open = openPaths();
    ok(!open.has("/some/local/never-opened.cttc-metric"), "sanity: local path form never matches");
  });

  /* ── Recording (Start/Pause/Stop/Open Recording) ──────────────────────── */

  await T("Record -> Pause -> Resume -> Stop writes a real 2-segment .cttc-record, menu state tracks it", async () => {
    const realPick = pickRecordingSavePath, realRead = readRecordingBytes, realWrite = writeRecordingBytes;
    const store = {};
    pickRecordingSavePath = async () => "/fake/e2e-recording.cttc-record";
    readRecordingBytes = async (p) => {
      if (!(p in store)) throw new Error("no such file");
      return store[p];
    };
    writeRecordingBytes = async (p, bytes) => { store[p] = bytes; };
    try {
      eq(recording.status, "idle");
      await startRecording();
      eq(recording.status, "recording");
      eq(recording.path, "/fake/e2e-recording.cttc-record");
      eq($("btn-start-recording").disabled, true);
      eq($("btn-pause-recording").disabled, false);
      eq($("btn-stop-recording").disabled, false);

      await pauseRecording();
      eq(recording.status, "paused");
      eq($("btn-start-recording").disabled, false);
      eq($("btn-pause-recording").disabled, true);
      ok(store["/fake/e2e-recording.cttc-record"], "first segment flushed to the in-memory store");
      const afterFirst = store["/fake/e2e-recording.cttc-record"];
      eq(afterFirst[0], 0x50, "PK zip magic byte 1");

      await startRecording(); // resume
      eq(recording.status, "recording");
      await stopRecording();
      eq(recording.status, "idle");
      eq(recording.path, null);
      eq($("btn-stop-recording").disabled, true);
      const afterSecond = store["/fake/e2e-recording.cttc-record"];
      ok(afterSecond.length >= afterFirst.length, "second segment appended, archive grew (or stayed same size)");

      // write the final in-memory bytes to a real path and confirm /open
      // recognizes it as a genuine 2-segment archive
      const realPath = "/tmp/cttc-e2e-recording.cttc-record";
      await window.cttc.writeBinaryFile(realPath, afterSecond);
      const openRes = await post("/open", { files: [{ path: realPath }] });
      eq(openRes.opened.length, 0, "ambiguous -- nothing opened without a segment choice");
      eq(openRes.needs_selection.length, 1);
      eq(openRes.needs_selection[0].segments.length, 2, "both flushed segments present");
    } finally {
      pickRecordingSavePath = realPick;
      readRecordingBytes = realRead;
      writeRecordingBytes = realWrite;
    }
  });

  await T("Start Recording without a chosen path stays idle (dialog cancelled)", async () => {
    const realPick = pickRecordingSavePath;
    pickRecordingSavePath = async () => null; // user closed the native dialog
    try {
      await startRecording();
      eq(recording.status, "idle");
    } finally {
      pickRecordingSavePath = realPick;
    }
  });

  await T("Pause/Stop are no-ops when not recording", async () => {
    eq(recording.status, "idle");
    await pauseRecording(); // must not throw
    eq(recording.status, "idle");
    await stopRecording(); // must not throw
    eq(recording.status, "idle");
  });

  await T("recoverInterruptedRecording flips a stale 'recording' marker to paused", async () => {
    const realGetMarker = getRecordingMarkerFromDisk, realSetMarker = setRecordingMarkerOnDisk;
    let lastSet = null;
    getRecordingMarkerFromDisk = async () => ({ path: "/fake/stale.cttc-record", status: "recording", segmentStart: 123 });
    setRecordingMarkerOnDisk = async (m) => { lastSet = m; };
    try {
      await recoverInterruptedRecording();
      eq(recording.status, "paused");
      eq(recording.path, "/fake/stale.cttc-record");
      ok($("status").textContent.includes("interrupted"), $("status").textContent);
      ok(lastSet && lastSet.status === "paused", "corrected marker persisted as paused");
    } finally {
      getRecordingMarkerFromDisk = realGetMarker;
      setRecordingMarkerOnDisk = realSetMarker;
      setRecordingState({ status: "idle", path: null, segmentStart: null });
      await persistRecordingMarker();
    }
  });

  await T("multi-segment .cttc-record upload surfaces the picker, choosing a segment loads it", async () => {
    // build a real 2-segment recording server-side via /sample/record
    const t0 = R.min_ts;
    const firstRes = await fetch(`${API}/sample/record`, {
      method: "POST", body: new Uint8Array(0),
      headers: { "X-CTTC-From": String(t0), "X-CTTC-To": String(t0 + 60000) },
    });
    const firstBytes = new Uint8Array(await firstRes.arrayBuffer());
    const secondRes = await fetch(`${API}/sample/record`, {
      method: "POST", body: firstBytes,
      headers: { "X-CTTC-From": String(t0 + 60000), "X-CTTC-To": String(t0 + 120000) },
    });
    const secondBytes = new Uint8Array(await secondRes.arrayBuffer());

    // write to a real path (window.cttc.readFile itself is read-only and
    // can't be reassigned -- see docs/architecture's contextBridge note)
    // so uploadFile's real readFile call has real bytes to read.
    const realPath = "/tmp/cttc-e2e-multi-segment.cttc-record";
    await window.cttc.writeBinaryFile(realPath, secondBytes);

    const realPickSegment = pickSegment;
    let shownSegments = null;
    pickSegment = async (segments) => { shownSegments = segments; return 1; };
    try {
      const r = await uploadAndResolveSegment(realPath);
      ok(shownSegments, "picker was invoked");
      eq(shownSegments.length, 2, "both segments offered");
      eq(r.errors.length, 0, JSON.stringify(r.errors));
      ok(r.opened.length >= 1, "chosen segment's sources opened");
      for (const sid of r.opened) await post("/close", { id: sid });
      await refreshAll();
    } finally {
      pickSegment = realPickSegment;
    }
  });

  /* ── sidebar / appearance ──────────────────────────────────────────────── */

  await T("sidebar groups have no separator borders between them", () => {
    for (const g of document.querySelectorAll(".ab-group")) {
      eq(getComputedStyle(g).borderTopWidth, "0px", `${g.querySelector(".ab-group-title")?.textContent} group`);
    }
  });

  await T("Create Event/Edit Events buttons live inside the Metrics sidebar section", () => {
    const metricsGroup = document.querySelector('.ab-group[data-section="metrics"]');
    ok(metricsGroup, "Metrics section exists");
    ok(metricsGroup.contains($("btn-event-create")), "btn-event-create is inside the Metrics section");
    ok(metricsGroup.contains($("btn-event-edit")), "btn-event-edit is inside the Metrics section");
  });

  await T("sidebar sections start collapsed and expand on header click", () => {
    const metricsGroup = document.querySelector('.ab-group[data-section="metrics"]');
    const header = metricsGroup.querySelector(".ab-group-header");
    const body = metricsGroup.querySelector(".ab-group-body");
    eq(body.hidden, true, "starts collapsed");
    header.click();
    eq(body.hidden, false, "expands on click");
    eq(metricsGroup.dataset.expanded, "true");
    header.click();
    eq(body.hidden, true, "collapses again on a second click");
  });

  /* ── Ship logs (Settings > Collect CTTC Own Logs) ─────────────────────── */

  await T("ship-logs button is icon-only (no visible text) with a hover title", () => {
    const btn = $("btn-ship-logs");
    ok(btn, "button exists");
    eq(btn.title, "Ship logs");
    eq(btn.textContent.trim(), "", "no visible label -- icon only");
    ok(btn.querySelector("svg"), "has an icon");
  });

  await T("clicking ship-logs invokes the shipLogs wrapper and reports the result", async () => {
    const real = shipLogsViaMain;
    let called = false;
    shipLogsViaMain = async () => { called = true; return { ok: true, path: "/tmp/x.zip", fileCount: 2, erased: true }; };
    try {
      $("btn-ship-logs").click();
      await until(() => called, "shipLogs invoked");
      await until(() => $("status").textContent.includes("/tmp/x.zip"), "status reflects the result");
      ok($("status").textContent.includes("erased"));
    } finally {
      shipLogsViaMain = real;
    }
  });

  await T("ship-logs reports a cancel without claiming success", async () => {
    const real = shipLogsViaMain;
    shipLogsViaMain = async () => ({ canceled: true });
    try {
      $("btn-ship-logs").click();
      await until(() => $("status").textContent.includes("canceled"), "status reflects the cancel");
    } finally {
      shipLogsViaMain = real;
    }
  });

  /* ── status bar (event notifications) ─────────────────────────────────── */

  await T("status bar is shown by default and toggled from Appearance", () => {
    eq($("app-status-bar").hidden, false, "visible by default");
    openThemeDialog();
    try {
      eq($("theme-status-bar-toggle").checked, true);
      $("theme-status-bar-toggle").checked = false;
      $("theme-status-bar-toggle").dispatchEvent(new Event("change"));
      eq($("app-status-bar").hidden, true, "hidden once toggled off");
      eq(prefs.get("statusBarVisible"), false);
    } finally {
      $("theme-status-bar-toggle").checked = true;
      $("theme-status-bar-toggle").dispatchEvent(new Event("change"));
      dlgTheme.close();
    }
    eq($("app-status-bar").hidden, false, "restored visible for later tests");
  });

  await T("notifyEvent updates the status bar text with a timestamp", () => {
    notifyEvent("something happened");
    ok($("app-status-bar-text").textContent.includes("something happened"));
  });

  await T("creating an event notifies the status bar", async () => {
    openEventCreateDialog();
    try {
      $("event-name").value = "e2e status bar event";
      $("event-hosted").value = "ui";
      await $("dlg-event-create").onclick();
    } finally {
      dlgEventForm.close();
    }
    ok($("app-status-bar-text").textContent.includes("e2e status bar event"));
    const list = loadUiEvents();
    saveUiEvents(list.filter((e) => e.name !== "e2e status bar event")); // clean up
  });

  /* ── Events (gateway-hosted + UI-hosted, condition engine) ────────────── */

  await T("Create Event dialog opens, lists systems, and defaults to one condition row", () => {
    openEventCreateDialog();
    try {
      ok(dlgEventForm.open, "dialog opened");
      eq($("event-form-title").textContent, "Create Event");
      eq($("dlg-event-create").textContent, "Create event");
      ok($("event-systems").children.length > 0, "systems checkboxes populated from state.sources");
      eq($("event-conditions").children.length, 1, "starts with one condition row");
      eq($("event-match-row").hidden, true, "match row hidden with only one condition");
    } finally {
      dlgEventForm.close();
    }
  });

  await T("+ Add condition reveals the match row; Remove hides it again", () => {
    openEventCreateDialog();
    try {
      $("event-add-condition").click();
      eq($("event-conditions").children.length, 2);
      eq($("event-match-row").hidden, false, "match row shown once there are 2+ conditions");
      $("event-conditions").querySelector("[data-remove-condition]").click();
      eq($("event-conditions").children.length, 1);
      eq($("event-match-row").hidden, true);
    } finally {
      dlgEventForm.close();
    }
  });

  await T("buildEventConditions/buildEventAction read the form's real DOM state", () => {
    openEventCreateDialog();
    try {
      const row = $("event-conditions").children[0];
      row.querySelector('[data-field="metric"]').value = "mem";
      row.querySelector('[data-field="op"]').value = ">=";
      row.querySelector('[data-field="threshold"]').value = "42";
      eq(JSON.stringify(buildEventConditions()), JSON.stringify([{ type: "metric", metric: "mem", op: ">=", threshold: 42 }]));

      $("event-action-kind").value = "recording";
      $("event-action-kind").dispatchEvent(new Event("change"));
      $("event-action-duration").value = "7";
      $("event-safe").checked = true;
      $("event-safe").dispatchEvent(new Event("change"));
      $("event-max-keep").value = "3600";
      const action = buildEventAction();
      eq(action.kind, "recording");
      eq(action.duration_minutes, 7);
      eq(action.minutes, null);
      eq(action.safe, true);
      eq(action.max_keep_seconds, 3600);
    } finally {
      dlgEventForm.close();
    }
  });

  await T("creating a gateway-hosted event round-trips through POST /events/create", async () => {
    openEventCreateDialog();
    try {
      $("event-name").value = "e2e cpu high";
      $("event-hosted").value = "gateway";
      const row = $("event-conditions").children[0];
      row.querySelector('[data-field="threshold"]').value = "95";
      $("event-action-minutes").value = "3";
      await $("dlg-event-create").onclick();
      const { event_ids } = await get("/events/list");
      ok(event_ids.length > 0, "at least one gateway event registered");
      const st = await get(`/events/${event_ids[event_ids.length - 1]}`);
      eq(st.name, "e2e cpu high");
      eq(st.conditions[0].threshold, 95);
      eq(st.action.minutes, 3);
      await post(`/events/${st.event_id}/cancel`, {});
    } finally {
      dlgEventForm.close();
    }
  });

  await T("creating a UI-hosted event persists it locally and lists it", async () => {
    const before = loadUiEvents().length;
    openEventCreateDialog();
    try {
      $("event-name").value = "e2e ui event";
      $("event-hosted").value = "ui";
      await $("dlg-event-create").onclick();
    } finally {
      dlgEventForm.close();
    }
    const list = loadUiEvents();
    eq(list.length, before + 1);
    eq(list[list.length - 1].name, "e2e ui event");
    eq(list[list.length - 1].armed, true, "starts armed/watching");
    saveUiEvents(list.slice(0, before)); // clean up after ourselves
  });

  await T("Edit Events lists both gateway and UI events with an Update button", async () => {
    await post("/events/create", {
      name: "e2e edit-list gw",
      conditions: [{ type: "metric", metric: "cpu", op: ">", threshold: 50 }],
      action: { kind: "recording", duration_minutes: 5 },
    });
    const list = loadUiEvents();
    list.push({
      id: "ui-e2e-edit", name: "e2e edit-list ui", sourceIds: [], match: "any",
      conditions: [{ type: "log", pattern: "x" }],
      action: { kind: "recording", duration_minutes: 5 },
      enabled: true, status: "armed", armed: true, logCursors: {},
    });
    saveUiEvents(list);
    try {
      await openEventListDialog();
      const text = $("events-list").textContent;
      ok(text.includes("e2e edit-list gw"), "gateway event listed");
      ok(text.includes("e2e edit-list ui"), "ui event listed");
      ok([...$("events-list").querySelectorAll("button")].some((b) => b.textContent === "Update"), "Update button present");
    } finally {
      dlgEventList.close();
      const gwIds = (await get("/events/list")).event_ids;
      for (const id of gwIds) {
        const st = await get(`/events/${id}`);
        if (st.name === "e2e edit-list gw") await post(`/events/${id}/cancel`, {});
      }
      saveUiEvents(loadUiEvents().filter((e) => e.id !== "ui-e2e-edit"));
    }
  });

  await T("Update on a UI event opens the form pre-filled and saves changes via editingEvent", async () => {
    const list = loadUiEvents();
    list.push({
      id: "ui-e2e-update", name: "before update", sourceIds: [], match: "any",
      conditions: [{ type: "metric", metric: "cpu", op: ">", threshold: 10 }],
      action: { kind: "recording", duration_minutes: 5 },
      enabled: true, status: "armed", armed: true, logCursors: {},
    });
    saveUiEvents(list);
    try {
      const ev = loadUiEvents().find((e) => e.id === "ui-e2e-update");
      openEventEditForm(ev, "ui");
      eq($("event-form-title").textContent, "Edit Event");
      eq($("dlg-event-create").textContent, "Save changes");
      eq($("event-name").value, "before update");
      eq($("event-hosted").disabled, true, "hosted can't change on edit");
      eq($("event-conditions").children[0].querySelector('[data-field="threshold"]').value, "10");

      $("event-name").value = "after update";
      await $("dlg-event-create").onclick();
      const updated = loadUiEvents().find((e) => e.id === "ui-e2e-update");
      eq(updated.name, "after update");
    } finally {
      saveUiEvents(loadUiEvents().filter((e) => e.id !== "ui-e2e-update"));
    }
  });

  await T("Update on a gateway event calls POST /events/{id}/update", async () => {
    const { event_id } = await post("/events/create", {
      name: "before gw update",
      conditions: [{ type: "metric", metric: "cpu", op: ">", threshold: 20 }],
      action: { kind: "recording", duration_minutes: 5 },
    });
    try {
      const ev = await get(`/events/${event_id}`);
      openEventEditForm(ev, "gateway");
      eq($("event-name").value, "before gw update");
      $("event-name").value = "after gw update";
      await $("dlg-event-create").onclick();
      const st = await get(`/events/${event_id}`);
      eq(st.name, "after gw update");
    } finally {
      await post(`/events/${event_id}/cancel`, {});
    }
  });

  await T("checkUiConditions: metric condition fires from state.series's latest bucket", () => {
    const realSeries = state.series;
    state.series = { services: [{ sid: "sX", name: "svc", cpu: [null, 10, 95], mem: [], net: [] }] };
    try {
      const ev = { sourceIds: ["sX"], conditions: [{ type: "metric", metric: "cpu", op: ">", threshold: 80 }], match: "any" };
      ok(checkUiMetricCondition(ev, ev.conditions[0]), "95 > 80 should match the latest non-null bucket");
      const evNoMatch = { sourceIds: ["sX"], conditions: [{ type: "metric", metric: "cpu", op: ">", threshold: 99 }], match: "any" };
      eq(checkUiMetricCondition(evNoMatch, evNoMatch.conditions[0]), null, "95 > 99 is false");
    } finally {
      state.series = realSeries;
    }
  });

  await T("checkUiConditions: match 'all' requires every condition, 'any' requires one", async () => {
    const realSeries = state.series;
    state.series = { services: [{ sid: "sX", name: "svc", cpu: [90], mem: [5], net: [] }] };
    try {
      const anyEv = {
        sourceIds: ["sX"], match: "any", logCursors: {},
        conditions: [
          { type: "metric", metric: "cpu", op: ">", threshold: 80 },
          { type: "metric", metric: "mem", op: ">", threshold: 999 },
        ],
      };
      ok(await checkUiConditions(anyEv), "any: one of two conditions met is enough");

      const allEv = {
        sourceIds: ["sX"], match: "all", logCursors: {},
        conditions: [
          { type: "metric", metric: "cpu", op: ">", threshold: 80 },
          { type: "metric", metric: "mem", op: ">", threshold: 999 },
        ],
      };
      eq(await checkUiConditions(allEv), null, "all: one unmet condition blocks the trigger");
    } finally {
      state.series = realSeries;
    }
  });

  await T("uiEventTick keeps watching: no refire while true, refires once cleared and re-met", async () => {
    const realSeries = state.series;
    const list = loadUiEvents();
    list.push({
      id: "ui-e2e-tick", name: "e2e tick event", sourceIds: ["sX"], match: "any", enabled: true,
      status: "armed", armed: true, logCursors: {},
      conditions: [{ type: "metric", metric: "cpu", op: ">", threshold: 80 }],
      action: { kind: "recording", duration_minutes: 5 },
    });
    saveUiEvents(list);
    const realPost = post;
    let sessionCalls = 0;
    post = async (path, body) => {
      if (path === "/session/start") { sessionCalls++; return { session_id: `fake-${sessionCalls}` }; }
      return realPost(path, body);
    };
    try {
      state.series = { services: [{ sid: "sX", name: "svc", cpu: [90], mem: [], net: [] }] };
      await uiEventTick();
      eq(loadUiEvents().find((e) => e.id === "ui-e2e-tick").triggerCount, 1, "fired once");

      await uiEventTick(); // still 90 -- must not refire
      eq(loadUiEvents().find((e) => e.id === "ui-e2e-tick").triggerCount, 1);

      state.series = { services: [{ sid: "sX", name: "svc", cpu: [10], mem: [], net: [] }] };
      await uiEventTick(); // condition clears
      const cleared = loadUiEvents().find((e) => e.id === "ui-e2e-tick");
      eq(cleared.status, "armed");
      eq(cleared.triggerCount, 1);

      state.series = { services: [{ sid: "sX", name: "svc", cpu: [95], mem: [], net: [] }] };
      await uiEventTick(); // met again -- keeps watching, no reset() needed
      eq(loadUiEvents().find((e) => e.id === "ui-e2e-tick").triggerCount, 2);
    } finally {
      post = realPost;
      state.series = realSeries;
      saveUiEvents(loadUiEvents().filter((e) => e.id !== "ui-e2e-tick"));
    }
  });

  /* ── popout wiring (buttons only; no real windows) ────────────────────── */

  await T("popout buttons visible in main window, popback hidden", () => {
    eq($("btn-popout-telemetry").hidden, false);
    eq($("btn-popback-telemetry").hidden, true);
    eq($("btn-popback-host").hidden, true);
    eq(POPOUT_KIND, null);
  });

  await T("icon buttons render at a visible size", () => {
    const bb = $("btn-popout-telemetry").getBoundingClientRect();
    ok(bb.width >= 20 && bb.height >= 20, `icon hit area ${bb.width}x${bb.height}`);
    const fs = parseFloat(getComputedStyle($("btn-popout-telemetry")).fontSize);
    ok(fs >= 15, `icon font ${fs}px`);
  });

  /* ── timeline nav ─────────────────────────────────────────────────────── */

  await T("timeline nav thumb tracks the view", () => {
    resetZoom();
    const thumb = document.querySelector("#chart-nav .tl-thumb");
    ok(thumb, "thumb exists");
    ok(thumb.style.left !== "" || thumb.style.width !== "", "thumb positioned");
  });

  /* ── newest features ──────────────────────────────────────────────────── */

  await T("frequency help button is wired to the help IPC", () => {
    ok(typeof $("btn-freq-help").onclick === "function", "button has a handler");
    ok(typeof window.cttc?.openHelp === "function", "openHelp exposed via preload");
  });

  /* ── New Gateway / Edit Gateways (in-window dialog, not a separate
     window/HTML page -- see app.js's openNewGatewayDialog/
     openEditGatewaysDialog) ───────────────────────────────────────────── */

  await T("New Gateway opens dlg-gateway-setup in 'new' mode", () => {
    openNewGatewayDialog();
    try {
      ok(dlgGatewaySetup.open, "dialog opened");
      eq($("gw-title").textContent, "New Gateway");
      eq($("gw-intro").hidden, false);
      eq($("gw-select-row").hidden, true);
      eq($("gw-btn-uninstall").hidden, true);
      eq($("gw-btn-connect").textContent, "Connect");
      eq(typeof window.cttc?.addGateway, "function", "addGateway exposed via preload");
      ok(!window.cttc?.newGateway, "old separate-window IPC method is gone");
    } finally {
      dlgGatewaySetup.close();
    }
  });

  await T("Edit Gateways opens dlg-gateway-setup in 'edit' mode, populated from getGateways", async () => {
    await openEditGatewaysDialog();
    try {
      ok(dlgGatewaySetup.open, "dialog opened");
      eq($("gw-title").textContent, "Edit Gateways");
      eq($("gw-intro").hidden, true);
      eq($("gw-select-row").hidden, false);
      eq($("gw-btn-uninstall").hidden, false);
      // nothing picked yet -- ssh/image/connect fields start disabled
      eq($("gw-btn-connect").disabled, true);
      eq($("gw-ssh-user").disabled, true);
    } finally {
      dlgGatewaySetup.close();
    }
  });

  await T("editableGateways excludes 'This machine' -- never updatable/uninstallable", () => {
    const input = [
      { mode: "embedded", host: "127.0.0.1", port: null, label: "This machine" },
      { mode: "ssh", host: "remote-host", port: 2222, label: "remote-host", sshTarget: "u@remote-host", active: false },
    ];
    const out = editableGateways(input);
    ok(!out.some((g) => g.mode === "embedded"), "'This machine' filtered out");
    eq(out.length, 1, "real gateway kept");
    eq(out[0].label, "remote-host", "the right one kept");
  });

  await T("Edit Gateways dropdown reflects editableGateways' filtering", async () => {
    await openEditGatewaysDialog();
    try {
      const labels = [...$("gw-select").options].map((o) => o.textContent);
      ok(!labels.some((l) => l.includes("This machine")), `"This machine" must not be selectable here: ${JSON.stringify(labels)}`);
    } finally {
      dlgGatewaySetup.close();
    }
  });

  await T("gw-btn-cancel closes the dialog without submitting", () => {
    openNewGatewayDialog();
    $("gw-btn-cancel").click();
    eq(dlgGatewaySetup.open, false);
  });

  await T("gateway connection failure notifies the status bar, not just the pill's tooltip", async () => {
    // capture notifyEvent's own calls rather than reading the DOM after the
    // fact -- other concurrent background notifiers (uiEventTick, etc.)
    // share the same status bar text and could overwrite a one-time
    // "restored" message before a DOM poll ever samples it.
    const realNotify = notifyEvent;
    const calls = [];
    notifyEvent = (msg) => { calls.push(msg); realNotify(msg); };
    const realGet = get;
    get = async (path) => { if (path === "/health") throw new Error("boom"); return realGet(path); };
    try {
      await until(() => $("server-status").dataset.state === "down", "went down", 100);
      ok(calls.some((m) => m.includes("Gateway connection failed")), JSON.stringify(calls));
      eq($("server-status-btn").title, "Switch gateway…", "pill tooltip stays generic, no error text");
      get = realGet;
      await until(() => $("server-status").dataset.state === "up", "recovered", 100);
      ok(calls.some((m) => m.includes("Gateway connection restored")), JSON.stringify(calls));
    } finally {
      get = realGet;
      notifyEvent = realNotify;
    }
  });

  /* ── gateway dropdown ──────────────────────────────────────────────────── */

  await T("gateway dropdown opens/closes, listing real (possibly empty) recorded gateways", async () => {
    ok(typeof window.cttc?.getGateways === "function", "getGateways exposed via preload");
    ok(typeof window.cttc?.switchGateway === "function", "switchGateway exposed via preload");
    eq($("gateway-dropdown").hidden, true, "starts closed");
    $("server-status-btn").click();
    await sleep(50); // dropdown render is async (awaits getGateways())
    eq($("gateway-dropdown").hidden, false, "opens on click");
    ok($("server-status").classList.contains("open"), "wrapper marked open");
    // real IPC round-trip against the actual (embedded, bare uv) test server
    // -- this dev/test launch path never calls recordGateway, so an empty
    // list is the expected, valid real-world response here, not a mock.
    const gateways = await window.cttc.getGateways();
    ok(Array.isArray(gateways), "getGateways returns an array");
    if (!gateways.length) {
      ok($("gateway-dropdown").querySelector(".gateway-empty"), "empty-state shown");
    }
    document.body.click(); // outside click
    eq($("gateway-dropdown").hidden, true, "closes on outside click");
    ok(!$("server-status").classList.contains("open"), "wrapper no longer marked open");
  });

  await T("host block shows the loading state before first host sample, titled for the local machine", () => {
    state.sources.push({ id: "__hload", kind: "stats", is_host: true,
                         path: "docker://local/host", live: true, name: "host@local" });
    try {
      drawAll();
      eq(hostBlockEl.hidden, false, "host block appears");
      eq($("host-loading").hidden, false, "loading indicator shown");
      eq(hostChartsEl.hidden, true, "charts hidden while loading");
      eq($("host-title").textContent, "Host telemetry — this machine", "titled for the local daemon");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__hload");
      drawAll();
      eq(hostBlockEl.hidden, true, "host block gone again");
    }
  });

  await T("host block is titled with the remote docker daemon's hostname", () => {
    state.sources.push({ id: "__hremote", kind: "stats", is_host: true,
                         path: "docker://ssh://u@example.com/host", live: true, name: "host@example.com" });
    try {
      drawAll();
      eq($("host-title").textContent, "Host telemetry — example.com", "titled with the bare hostname, no user@");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__hremote");
      drawAll();
    }
  });

  await T("log panel order toggle flips newest/oldest-first and persists", async () => {
    const p = [...panels.values()][0];
    const startReversed = p.reversed;
    ok(p.total >= 2, "panel has rows");
    eq(p.dataIndexAt(0), startReversed ? p.total - 1 : 0, "visual->data mapping");
    eq(p.visualIndexOf(p.dataIndexAt(5)), 5, "mapping is its own inverse");
    const toggle = [...p.el.querySelectorAll("button")].find(
      (b) => b.textContent === "⬆" || b.textContent === "⬇");
    ok(toggle, "order toggle present");
    toggle.click();
    eq(p.reversed, !startReversed, "flipped");
    eq(prefs.get("logNewestFirst", null), p.reversed, "persisted");
    eq(p.dataIndexAt(0), p.reversed ? p.total - 1 : 0, "mapping follows the flip");
    toggle.click();
    eq(p.reversed, startReversed, "restored");
  });

  await T("container list refresh button re-lists docker targets", () => {
    const real = listContainers;
    let calls = 0;
    listContainers = () => { calls++; };
    try {
      $("btn-ps-refresh").click();
      eq(calls, 1, "refresh re-lists");
    } finally {
      listContainers = real;
    }
  });

  await T("sidebar collapse toggle hides the groups and shrinks the rail, restore brings them back", () => {
    const actionBar = $("action-bar");
    const before = prefs.get("actionBarCollapsed", false);
    try {
      $("ab-collapse-toggle").click();
      eq(actionBar.dataset.collapsed, "true", "collapsed");
      eq(getComputedStyle($("app-body").querySelector(".ab-group")).display, "none", "groups hidden");
      eq(prefs.get("actionBarCollapsed", null), true, "persisted");
      ok(actionBar.getBoundingClientRect().width < 40, "rail actually shrinks, not just hides its contents");
      $("ab-collapse-toggle").click();
      eq(actionBar.dataset.collapsed, "false", "restored");
      ok(getComputedStyle($("app-body").querySelector(".ab-group")).display !== "none", "groups visible again");
    } finally {
      if (actionBar.dataset.collapsed !== String(before)) $("ab-collapse-toggle").click();
    }
  });

  await T("collapsing after a manual sidebar resize still shrinks the rail (regression: inline width from the splitter used to stick)", () => {
    const actionBar = $("action-bar");
    const beforeCollapsed = prefs.get("actionBarCollapsed", false);
    const beforeWidth = prefs.get("actionBarWidth", 210);
    try {
      actionBar.style.width = "300px"; // simulate a prior splitter drag
      prefs.set("actionBarWidth", 300);
      $("ab-collapse-toggle").click();
      ok(actionBar.getBoundingClientRect().width < 40, "collapsed rail ignores the leftover inline width");
      $("ab-collapse-toggle").click();
      near(actionBar.getBoundingClientRect().width, 300, 2, "restores the resized width");
    } finally {
      if (actionBar.dataset.collapsed !== String(beforeCollapsed)) $("ab-collapse-toggle").click();
      prefs.set("actionBarWidth", beforeWidth);
      actionBar.style.width = "";
    }
  });

  await T("dragging the sidebar splitter resizes it and persists", () => {
    const actionBar = $("action-bar");
    const splitter = $("action-bar-splitter");
    const before = prefs.get("actionBarWidth", 210);
    const rect = actionBar.getBoundingClientRect();
    try {
      splitter.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, clientX: rect.right, clientY: rect.top + 10,
      }));
      ok(splitter.classList.contains("dragging"), "drag started");
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: rect.right + 40, clientY: rect.top + 10 }));
      near(actionBar.getBoundingClientRect().width, rect.width + 40, 2, "widened live while dragging");
      window.dispatchEvent(new MouseEvent("mouseup", {}));
      ok(!splitter.classList.contains("dragging"), "drag ended");
      eq(prefs.get("actionBarWidth", null), Math.round(rect.width + 40), "persisted");
    } finally {
      prefs.set("actionBarWidth", before);
      actionBar.style.width = before + "px";
    }
  });

  await T("legend right-click offers a per-series pop-out", async () => {
    const real = openSeriesPopout;
    const calls = [];
    openSeriesPopout = (n) => calls.push(n);
    try {
      setTrack(names[1], "mut");
      renderLegend();
      let item = [...$("legend").querySelectorAll(".legend-item")].find((i) => i.textContent.includes(NAME));
      let bb = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bb.left + 4, clientY: bb.bottom + 2 }));
      let entry = [...document.querySelectorAll("#ctxmenu button")].find((b) => b.textContent.includes("its own window"));
      ok(entry, "entry offered on a selected container");
      entry.click();
      eq(calls[0], NAME, "pop-out requested for that container");
      item = $("legend").querySelector(".legend-item.disabled");
      bb = item.getBoundingClientRect();
      item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: bb.left + 4, clientY: bb.bottom + 2 }));
      entry = [...document.querySelectorAll("#ctxmenu button")].find((b) => b.textContent.includes("its own window"));
      ok(entry, "entry offered on a not-selected container too");
      closeCtxMenu();
    } finally {
      openSeriesPopout = real;
      delete state.track[names[1]];
      prefs.set("track", state.track);
      renderLegend();
    }
  });

  const dragDrop = (fromEl, toEl) => {
    const dt = new DataTransfer();
    fromEl.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
    toEl.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
    toEl.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    fromEl.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer: dt, screenX: window.screenX + 10, screenY: window.screenY + 10 }));
  };

  await T("dragging a legend entry reorders it and its matching log panel to match", () => {
    const before = { ...state.panelOrder };
    try {
      const items = () => [...$("legend").querySelectorAll(".legend-item")].filter((i) => !i.className.includes("disabled"));
      const all = items();
      ok(all.length >= 3, "at least 3 selected entries to make the reorder unambiguous");
      const dragged = all[0], target = all[2];
      const nameA = dragged.textContent, nameC = target.textContent;
      dragDrop(dragged, target);
      const after = items().map((i) => i.textContent);
      eq(after.indexOf(nameA), after.indexOf(nameC) - 1, "dragged entry now sits right before its drop target");
      // the matching log panels reordered in #panels the same way
      const panelNames = [...panelsEl.querySelectorAll(".panel .name")].map((n) => n.textContent);
      const ia = panelNames.indexOf(names.find((n) => nameA.includes(n)));
      const ic = panelNames.indexOf(names.find((n) => nameC.includes(n)));
      if (ia !== -1 && ic !== -1) eq(ia, ic - 1, "log panels reordered to match the legend");
    } finally {
      state.panelOrder = before;
      prefs.set("panelOrder", before);
      renderLegend();
      syncPanels();
    }
  });

  await T("dragging a log panel header out past the window's edge pops it out", () => {
    const sid = [...panels.keys()][0];
    const panel = panels.get(sid);
    const real = openLogPopout;
    const calls = [];
    openLogPopout = (id) => calls.push(id);
    try {
      const head = panel.el.querySelector(".panel-head");
      const dt = new DataTransfer();
      head.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      head.dispatchEvent(new DragEvent("dragend", {
        bubbles: true, cancelable: true, dataTransfer: dt,
        screenX: window.screenX - 500, screenY: window.screenY - 500,
      }));
      eq(calls.length, 1, "popout requested when dropped outside the window");
      eq(calls[0], sid, "for the dragged panel's source id");
    } finally {
      openLogPopout = real;
    }
  });

  await T("dragging a log panel's header shows the whole panel (header + body) as the drag ghost", () => {
    const sid = [...panels.keys()][0];
    const panel = panels.get(sid);
    const realSetDragImage = DataTransfer.prototype.setDragImage;
    const calls = [];
    DataTransfer.prototype.setDragImage = function (...args) { calls.push(args); };
    try {
      const head = panel.el.querySelector(".panel-head");
      const dt = new DataTransfer();
      head.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt, clientX: 10, clientY: 10 }));
      eq(calls.length, 1, "setDragImage called");
      eq(calls[0][0], panel.el, "drag image is the whole panel (header + body), not just the header");
    } finally {
      DataTransfer.prototype.setDragImage = realSetDragImage;
    }
  });

  await T("dragging a legend entry uses the entry itself as the drag ghost (no body to include)", () => {
    const item = [...$("legend").querySelectorAll(".legend-item")].find((i) => !i.className.includes("disabled"));
    const realSetDragImage = DataTransfer.prototype.setDragImage;
    let called = false;
    DataTransfer.prototype.setDragImage = function () { called = true; };
    try {
      const dt = new DataTransfer();
      item.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      ok(!called, "no custom drag image needed -- the browser's default (the entry itself) is already right");
    } finally {
      DataTransfer.prototype.setDragImage = realSetDragImage;
    }
  });

  await T("export dialog resolves host choice", async () => {
    const p = askExportOptions();
    await until(() => dlgExport.open, "export dialog open");
    $("export-host").checked = false;
    $("dlg-export-ok").click();
    const opts = await p;
    eq(opts.includeHost, false, "host choice returned");
  });

  await T("Hard Reset asks for confirmation first, and does nothing if declined", () => {
    const realConfirm = window.confirm;
    let asked = null;
    window.confirm = (msg) => { asked = msg; return false; };
    try {
      const before = state.sources.length;
      $("btn-hard-reset").click();
      ok(asked && asked.includes("cannot be undone"), "confirm() shown, warns it's irreversible");
      eq(state.sources.length, before, "declining leaves sources untouched");
    } finally {
      window.confirm = realConfirm;
    }
  });

  await T("clear-sources asks for confirmation first, and does nothing if declined", () => {
    const realConfirm = window.confirm;
    let asked = null;
    window.confirm = (msg) => { asked = msg; return false; };
    // Only enabled while a docker daemon is being watched (see
    // syncDockerDaemonButtons) -- this test is about the confirm/decline
    // behavior of the click handler itself, exercised directly regardless
    // of whether the demo's file-only sources would otherwise leave it
    // disabled.
    const wasDisabled = $("btn-clear-sources").disabled;
    $("btn-clear-sources").disabled = false;
    try {
      const before = state.sources.length;
      $("btn-clear-sources").click();
      ok(asked && asked.includes(String(before)), "confirm() was shown with the source count");
      eq(state.sources.length, before, "declining leaves sources untouched");
    } finally {
      window.confirm = realConfirm;
      $("btn-clear-sources").disabled = wasDisabled;
    }
  });

  // destructive — must stay the last test: closes every source, then reopens
  // the demo files so the app is left usable.
  await T("clear-sources button closes everything once confirmed", async () => {
    const files = state.sources
      .filter((s) => !String(s.path).startsWith("docker://"))
      .map((s) => ({ path: s.path, live: false }));
    ok(files.length >= 2, "have demo files to restore");
    const realConfirm = window.confirm;
    window.confirm = () => true;
    const wasDisabled = $("btn-clear-sources").disabled;
    $("btn-clear-sources").disabled = false;
    try {
      $("btn-clear-sources").click();
      await until(() => state.sources.length === 0, "all sources closed");
    } finally {
      window.confirm = realConfirm;
      $("btn-clear-sources").disabled = wasDisabled;
    }
    eq($("empty-state").hidden, false, "empty state visible again");
    await post("/open", { files });
    await refreshAll();
    ok(state.sources.length >= 2, "demo files restored");
  });

  // destructive and wipes localStorage -- must stay the very last test.
  await T("Hard Reset (confirmed) closes every source, clears localStorage, and reloads", async () => {
    const realConfirm = window.confirm;
    const realReload = reloadApp;
    const realPost = post;
    const closedIds = [];
    let reloaded = false;
    window.confirm = () => true;
    reloadApp = () => { reloaded = true; };
    post = async (path, body) => {
      if (path === "/close") { closedIds.push(body.id); return {}; }
      return realPost(path, body);
    };
    prefs.set("hardResetCanary", "should not survive");
    try {
      const expectedIds = state.sources.map((s) => s.id);
      $("btn-hard-reset").click();
      await until(() => reloaded, "reloadApp called");
      eq(closedIds.sort().join(), expectedIds.sort().join(), "every open source was closed");
      eq(prefs.get("hardResetCanary", null), null, "localStorage wiped");
    } finally {
      window.confirm = realConfirm;
      reloadApp = realReload;
      post = realPost;
    }
  });

  localStorage.clear();
  return results;
})();
