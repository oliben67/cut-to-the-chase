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
    eq(basename("/a/b/c.cttc"), "c.cttc");
    eq(basename(null), "");
    eq(escapeHtml('<a b="c">&\''), "&lt;a b=&quot;c&quot;&gt;&amp;&#39;");
    ok(fmtIso(0).endsWith(" UTC"));
  });

  await T("colorFor assigns stable slots and folds past 8", () => {
    const c1 = colorFor("__test_series_1");
    eq(colorFor("__test_series_1"), c1, "stable on repeat");
    for (let i = 2; i <= 10; i++) colorFor("__test_series_" + i);
    eq(colorFor("__test_series_10"), themeVar("--muted"), "9th+ folds to muted");
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

  await T("pan shifts by the given fraction of a span", () => {
    setView(MID, MID + 60000);
    pan(0.5);
    near(state.view.t0, MID + 30000, 1);
    pan(-0.5);
    near(state.view.t0, MID, 1);
  });

  await T("zoomAt scales the span around t", () => {
    setView(MID - 30000, MID + 30000);
    zoomAt(MID, 0.5);
    near(state.view.t1 - state.view.t0, 30000, 1, "halved");
    near((state.view.t0 + state.view.t1) / 2, MID, 1, "still centered");
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

  await T("resetZoom fits the data and centers the cursor mid-range", () => {
    state.cursorT = null;
    resetZoom();
    ok(state.view.t0 < R.min_ts && state.view.t1 > R.max_ts, "view covers data + pad");
    near(state.cursorT, MID, 1, "cursor centered like a double-click");
  });

  /* ── toolbar controls ─────────────────────────────────────────────────── */

  await T("chart style switch toggles lines/bars and persists", () => {
    const before = state.chartStyle;
    $("chk-style").click();
    ok(state.chartStyle !== before, "flipped");
    eq(prefs.get("chartStyle", null), state.chartStyle, "persisted");
    $("chk-style").click();
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

  await T("timeline-nav 'now' label centers on the present", () => {
    setView(MID, MID + 60000);
    document.querySelector("#chart-nav .tl-now-label").click();
    near((state.view.t0 + state.view.t1) / 2, Date.now(), 2000, "centered on now");
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

  /* ── add-sources dialog logic ─────────────────────────────────────────── */

  await T("updateDockerDupes disables already-collected stats", () => {
    state.sources.push({ id: "__dup", path: "docker://local/stats", kind: "stats", live: true });
    try {
      $("docker-host").value = "";
      updateDockerDupes();
      eq($("docker-stats").disabled, true, "stats disabled");
      ok($("docker-stats-note").textContent.includes("already"), "note shown");
      eq($("docker-host-stats").disabled, false, "host stats still allowed");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__dup");
      updateDockerDupes();
      eq($("docker-stats").disabled, false, "re-enabled");
    }
  });

  await T("ssh key row appears only for ssh:// hosts", async () => {
    $("docker-host").value = "ssh://deploy@example";
    await refreshSshKeyRow();
    eq($("ssh-key-row").hidden, false, "visible for ssh://");
    const opts = [...$("ssh-key").options].map((o) => o.value);
    ok(opts.includes(""), "default option");
    ok(opts.includes("__browse__"), "browse option");
    $("docker-host").value = "";
    await refreshSshKeyRow();
    eq($("ssh-key-row").hidden, true, "hidden for local");
  });

  await T("openPaths reflects open sources", () => {
    const paths = openPaths();
    for (const s of state.sources) ok(paths.has(s.path), s.path);
  });

  /* ── sample round trip through the UI data model ──────────────────────── */

  await T("sample export + load shows grayed sample sources", async () => {
    const out = "/tmp/cttc-e2e-sample.cttc";
    const r = await post("/sample/export", { path: out, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    ok(r.sources >= 2, "exported sources");
    const opened = (await post("/open", { files: [{ path: out }] })).opened;
    ok(opened.length >= 2, "reloaded sources");
    try {
      await refreshAll();
      const sample = state.sources.find((s) => s.live === false);
      ok(sample, "sample source present and static");
      eq(isLiveSid(sample.id), false);
      ok(sampleFileLabel(sample.id).includes("cttc-e2e-sample.cttc"), "labeled with file");
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

  await T("host block shows the loading state before first host sample", () => {
    state.sources.push({ id: "__hload", kind: "stats", is_host: true,
                         path: "docker://local/host", live: true, name: "host@local" });
    try {
      drawAll();
      eq(hostBlockEl.hidden, false, "host block appears");
      eq($("host-loading").hidden, false, "loading indicator shown");
      eq(hostChartsEl.hidden, true, "charts hidden while loading");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__hload");
      drawAll();
      eq(hostBlockEl.hidden, true, "host block gone again");
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

  // destructive — must stay the last test: closes every source, then reopens
  // the demo files so the app is left usable.
  await T("clear-sources button closes everything", async () => {
    const files = state.sources
      .filter((s) => !String(s.path).startsWith("docker://"))
      .map((s) => ({ path: s.path, live: false }));
    ok(files.length >= 2, "have demo files to restore");
    $("btn-clear-sources").click();
    await until(() => state.sources.length === 0, "all sources closed");
    eq($("empty-state").hidden, false, "empty state visible again");
    await post("/open", { files });
    await refreshAll();
    ok(state.sources.length >= 2, "demo files restored");
  });

  localStorage.clear();
  return results;
})();
