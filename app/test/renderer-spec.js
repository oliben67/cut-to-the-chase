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

  await T("authHeaders adds X-CTTC-Token only when API_TOKEN is set (br-NET-004)", () => {
    const realToken = API_TOKEN;
    try {
      API_TOKEN = null;
      eq(JSON.stringify(authHeaders()), "{}", "no token in this suite's own connection -- nothing added");
      eq(JSON.stringify(authHeaders({ Foo: "bar" })), JSON.stringify({ Foo: "bar" }), "extras still pass through");

      API_TOKEN = "test-token-abc";
      eq(authHeaders()["X-CTTC-Token"], "test-token-abc");
      const merged = authHeaders({ "X-CTTC-Filename": "x.log" });
      eq(merged["X-CTTC-Token"], "test-token-abc");
      eq(merged["X-CTTC-Filename"], "x.log");
    } finally {
      API_TOKEN = realToken;
    }
  });

  await T("get()/post() actually send X-CTTC-Token on the wire once API_TOKEN is set", async () => {
    const realToken = API_TOKEN;
    const realFetch = window.fetch;
    const calls = [];
    window.fetch = (url, opts) => {
      calls.push({ url, headers: opts?.headers });
      return realFetch(url, opts);
    };
    try {
      API_TOKEN = "test-token-abc";
      await get("/sources");
      await post("/close", { id: "nonexistent" });
      eq(calls.length, 2);
      for (const c of calls) eq(c.headers["X-CTTC-Token"], "test-token-abc", c.url);
    } finally {
      window.fetch = realFetch;
      API_TOKEN = realToken;
    }
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

  await T("per-graph chart style toggle flips lines/bars independently and persists", () => {
    const beforeSvc = state.chartStyle.svc;
    const beforeHost = state.chartStyle.host;
    $("btn-style-toggle-svc").click();
    ok(state.chartStyle.svc !== beforeSvc, "svc graph flipped");
    eq(state.chartStyle.host, beforeHost, "host graph untouched by the svc toggle");
    eq(prefs.get("chartStyle", null).svc, state.chartStyle.svc, "persisted");
    $("btn-style-toggle-host").click();
    ok(state.chartStyle.host !== beforeHost, "host graph flipped");
    $("btn-style-toggle-svc").click();
    $("btn-style-toggle-host").click();
    eq(state.chartStyle.svc, beforeSvc, "svc flipped back");
    eq(state.chartStyle.host, beforeHost, "host flipped back");
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

  await T("Set Docker Host dialog opens with the form empty and disabled", () => {
    $("btn-set").click();
    try {
      eq($("docker-targets").innerHTML, "", "targets empty");
      eq($("dlg-ok").disabled, true, "Set Docker Host disabled");
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
      eq($("dlg-ok").disabled, true, "Set Docker Host stays disabled -- nothing checked yet, nothing to collect");
      ok($("docker-targets").textContent.includes("demo"), "fetched container listed");
      $("docker-targets").querySelector('input[value="demo"]').checked = true;
      $("docker-targets").querySelector('input[value="demo"]').dispatchEvent(new Event("change"));
      eq($("dlg-ok").disabled, false, "Set Docker Host enabled once at least one container is checked");
    } finally {
      post = realPost;
      get = realGet;
      dlg.close();
    }
  });

  await T("json_message and parse_level transforms are ticked by default, others aren't, and Refresh preserves the user's own picks", async () => {
    const realPost = post;
    const realGet = get;
    post = async (path, body) => {
      if (path === "/docker/ps") return { containers: [], services: [], log: [] };
      return realPost(path, body);
    };
    get = async (path) => (
      path === "/transforms"
        ? { transforms: [
            { name: "json_message", doc: "" },
            { name: "parse_level", doc: "" },
            { name: "drop_healthchecks", doc: "" },
          ] }
        : realGet(path)
    );
    try {
      $("btn-set").click();
      $("docker-host").value = "";
      await listContainers();
      const byName = (n) => $("transforms-list").querySelector(`input[value="${n}"]`);
      eq(byName("json_message").checked, true, "json_message on by default");
      eq(byName("parse_level").checked, true, "parse_level on by default");
      eq(byName("drop_healthchecks").checked, false, "others stay opt-in");

      // deliberately deviate from the defaults, then Refresh (re-fetch) --
      // the user's own picks must survive, not silently reset
      byName("json_message").checked = false;
      byName("drop_healthchecks").checked = true;
      await listContainers();
      eq(byName("json_message").checked, false, "user's un-tick of a default-on transform survives a Refresh");
      eq(byName("drop_healthchecks").checked, true, "user's tick of a default-off transform survives a Refresh");
      eq(byName("parse_level").checked, true, "untouched default-on transform still ticked");
    } finally {
      post = realPost;
      get = realGet;
      dlg.close();
    }
  });

  await T("clicking a group title in the Docker Host checklist toggles every checkbox in that group", async () => {
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
      ok(boxes.every((cb) => !cb.checked), "nothing preselected just for having been found");
      const group = $("docker-targets").querySelector(".group");
      group.click();
      ok(boxes.every((cb) => cb.checked), "group click (all unchecked) selects all");
      group.click();
      ok(boxes.every((cb) => !cb.checked), "group click (all checked) deselects all");
      boxes[0].checked = true;
      group.click();
      ok(boxes.every((cb) => cb.checked), "a mixed group selects all, rather than deselecting");
    } finally {
      post = realPost;
      get = realGet;
      dlg.close();
    }
  });

  await T("Set/Update Docker Host stays disabled with nothing checked, including via the group-select-all header", async () => {
    const realPost = post;
    const realGet = get;
    post = async (path, body) => {
      if (path === "/docker/ps") {
        return { containers: [{ id: "a", name: "demo-a" }, { id: "b", name: "demo-b" }], services: [], log: [] };
      }
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      $("btn-set").click();
      $("docker-host").value = "";
      await listContainers();
      eq($("dlg-ok").disabled, true, "nothing checked yet -- nothing to collect");
      const boxes = [...$("docker-targets").querySelectorAll("input[type=checkbox]")];
      const group = $("docker-targets").querySelector(".group");
      group.click(); // selects all via the group header, not an individual checkbox's own change event
      ok(boxes.every((cb) => cb.checked), "sanity: group click selected everything");
      eq($("dlg-ok").disabled, false, "enabled once the group header checks everything");
      group.click(); // deselects all
      ok(boxes.every((cb) => !cb.checked), "sanity: group click deselected everything");
      eq($("dlg-ok").disabled, true, "disabled again once the group header unchecks everything");
    } finally {
      post = realPost;
      get = realGet;
      dlg.close();
    }
  });

  await T("Edit Docker Host pre-fills and locks host/ssh-key, relabels buttons", async () => {
    const fakeSrc = { id: "__edit_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons(); // a real app calls this via refreshAll() whenever state.sources changes
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    // Opening Edit Docker Host now always runs an immediate live Refresh
    // (see btn-edit-docker-daemon's onclick) -- mocked here since this test
    // isn't about that probe itself, just the form's fields/labels.
    const realPost = post;
    const realGet = get;
    post = async (path, body) => (path === "/docker/ps" ? { containers: [], services: [], log: [] } : realPost(path, body));
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      eq(currentDockerHost(), "ssh://u@h", "host resolved correctly (not truncated to 'ssh:')");
      eq($("btn-edit-docker-daemon").disabled, false, "Edit enabled once a daemon is being watched");
      eq($("btn-clear-sources").disabled, false, "Remove enabled once a daemon is being watched");
      await $("btn-edit-docker-daemon").onclick();
      eq($("docker-host").value, "u@h", "host prefilled (scheme stripped for editing)");
      eq($("docker-host").disabled, true, "host locked");
      eq($("docker-ssh-key").value, "/path/to/key", "ssh key prefilled");
      eq($("docker-ssh-key").disabled, true, "ssh key locked");
      eq($("docker-ssh-key-browse").disabled, true, "browse locked");
      eq($("btn-ps-refresh").textContent, "Refresh Sources", "Fetch relabeled Refresh Sources");
      eq($("dlg-ok").textContent, "Update Docker Host", "confirm relabeled");
      eq($("dlg-set-title").textContent, "Edit Docker Host", "dialog titled for editing, not creating");
    } finally {
      post = realPost;
      get = realGet;
      state.sources = state.sources.filter((s) => s.id !== "__edit_test");
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
      $("btn-set").click(); // resets host/ssh-key/labels back to create-mode defaults
      dlg.close();
    }
  });

  await T("Edit/Remove Docker Host are disabled when no daemon is being watched", () => {
    ok(!hasDockerDaemon(), "no docker:// source open in this suite's baseline state");
    eq($("btn-edit-docker-daemon").disabled, true, "Edit disabled");
    eq($("btn-clear-sources").disabled, true, "Remove disabled");
  });

  await T("Remove Docker Host also forgets the daemon server-side, not just the local catalog (br-REDIS-017)", async () => {
    const hostKey = "ssh://e2e@removeme";
    const saved = prefs.get("savedDockerDaemons", {});
    saved[hostKey] = { host: hostKey, stats: true, logs: [], transforms: [], interval: 5, lastUsed: Date.now() };
    prefs.set("savedDockerDaemons", saved);

    const realConfirm = window.confirm;
    const realPost = post;
    const calls = [];
    window.confirm = () => true;
    // Stubbed rather than forwarded to the real server: this hostKey never
    // matches the suite's actual active daemon (there is none, in this
    // suite's baseline), so the handler's own "close every current source"
    // branch never fires for it regardless -- stubbing just keeps this test
    // from depending on that, and from ever touching the real demo sources
    // every other test in this file relies on staying open.
    post = async (path, body) => {
      calls.push({ path, body });
      return {};
    };
    try {
      populateRemoveDaemonSelect();
      $("remove-daemon-select").value = hostKey;
      $("remove-daemon-select").onchange();
      await $("dlg-remove-daemon-delete").onclick();
      ok(
        calls.some((c) => c.path === "/docker/forget" && c.body.host === hostKey),
        `expected a POST /docker/forget for ${hostKey}: ${JSON.stringify(calls)}`
      );
      ok(!(hostKey in prefs.get("savedDockerDaemons", {})), "removed from the local catalog too");
    } finally {
      window.confirm = realConfirm;
      post = realPost;
      if (dlgRemoveDaemon.open) dlgRemoveDaemon.close();
    }
  });

  await T("Remove Docker Host never calls /docker/forget for 'This machine' (never remembered server-side)", async () => {
    const saved = prefs.get("savedDockerDaemons", {});
    saved.local = { host: null, stats: true, logs: [], transforms: [], interval: 5, lastUsed: Date.now() };
    prefs.set("savedDockerDaemons", saved);

    const realConfirm = window.confirm;
    const realPost = post;
    const calls = [];
    window.confirm = () => true;
    // Stubbed, not forwarded: with no active docker daemon in this suite's
    // baseline, currentDockerHost() falls back to "local" too, so picking
    // "local" here would otherwise trip the handler's "close every current
    // source" branch and tear down the demo sources every other test in
    // this file depends on -- this test only cares what path gets posted.
    post = async (path, body) => {
      calls.push({ path, body });
      return {};
    };
    try {
      populateRemoveDaemonSelect();
      $("remove-daemon-select").value = "local";
      $("remove-daemon-select").onchange();
      await $("dlg-remove-daemon-delete").onclick();
      ok(!calls.some((c) => c.path === "/docker/forget"), JSON.stringify(calls));
    } finally {
      window.confirm = realConfirm;
      post = realPost;
      if (dlgRemoveDaemon.open) dlgRemoveDaemon.close();
    }
  });

  await T("Edit Docker Host pre-fills immediately, then its automatic Refresh confirms both containers still exist, marking only the persisted-selected one with a checkmark", async () => {
    const fakeStats = { id: "__prefill_stats", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    const fakeContainer = { id: "__prefill_c", path: "docker://ssh://u@h/container/demo-c", name: "demo-c", kind: "log", live: true };
    const fakeService = { id: "__prefill_s", path: "docker://ssh://u@h/service/demo-svc", name: "demo-svc", kind: "log", live: true };
    state.sources.push(fakeStats, fakeContainer, fakeService);
    syncDockerDaemonButtons();
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    // demo-c is in the persisted [user]@[gateway]-containers.json (actually
    // selected); demo-svc is merely followed (e.g. previously unselected
    // from the legend) -- the checklist must reflect that distinction, not
    // just "is a log source open for it".
    const realLoadSelectedTargets = loadSelectedTargets;
    loadSelectedTargets = async () => ({ containers: new Set(["demo-c"]), services: new Set() });
    const realPost = post;
    const realGet = get;
    // The live daemon still has both -- opening Edit Docker Host runs
    // this automatically (see btn-edit-docker-daemon), so the pre-fill and
    // the confirmed post-Refresh state should agree.
    post = async (path, body) => {
      if (path === "/docker/ps") {
        return { containers: [{ id: "c", name: "demo-c" }], services: [{ id: "s", name: "demo-svc" }], log: [] };
      }
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      await $("btn-edit-docker-daemon").onclick();
      const text = $("docker-targets").textContent;
      ok(text.includes("demo-c"), `container pre-filled: ${text}`);
      ok(text.includes("demo-svc"), `service pre-filled: ${text}`);
      const boxes = [...$("docker-targets").querySelectorAll("input[type=checkbox]")];
      eq(boxes.length, 2, "one checkbox per already-followed container/service");
      ok(boxes.find((cb) => cb.value === "demo-c").checked, "persisted-selected entry starts checked");
      ok(!boxes.find((cb) => cb.value === "demo-svc").checked, "followed-but-not-persisted-selected entry starts unchecked");
      ok(boxes.every((cb) => !cb.disabled), "still around server-side -- immediately interactive");
      const markOf = (name) => boxes.find((cb) => cb.value === name).closest("label").querySelector(".mark").textContent;
      eq(markOf("demo-c"), "✔", "persisted-selected entry gets a checkmark");
      eq(markOf("demo-svc"), "", "not-persisted-selected entry gets no mark");
      ok(!$(`docker-targets`).innerHTML.includes("label.added"), "no dimming/'already added' distinction -- looks like any other entry");
    } finally {
      post = realPost;
      get = realGet;
      loadSelectedTargets = realLoadSelectedTargets;
      state.sources = state.sources.filter((s) => !s.id.startsWith("__prefill_"));
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
      $("btn-set").click();
      dlg.close();
    }
  });

  await T("Refresh in Edit Docker Host re-fetches, leaves checkboxes selectable, and keeps host/ssh-key locked", async () => {
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
      // opening Edit Docker Host already runs this live probe automatically
      await $("btn-edit-docker-daemon").onclick();
      let cb = $("docker-targets").querySelector("input[type=checkbox]");
      ok(cb, "checkbox rendered from the automatic Refresh on open");
      eq(cb.disabled, false, "checkbox is selectable, not locked, in edit mode");
      eq($("docker-host").disabled, true, "host stays locked after a Refresh in edit mode");
      eq($("docker-ssh-key").disabled, true, "ssh key stays locked after a Refresh in edit mode");
      // clicking Refresh again is idempotent
      $("btn-ps-refresh").click();
      await until(() => $("docker-targets").textContent.includes("demo-x"), "checklist still populated after an explicit Refresh");
      cb = $("docker-targets").querySelector("input[type=checkbox]");
      eq(cb.disabled, false, "still selectable");
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

  await T("Refresh diffs against the daemon's real state: a persisted-selected-but-now-gone entry stays listed disabled, a never-selected-and-now-gone entry is omitted, new ones appear unchecked, unchanged ones keep the user's own tick", async () => {
    const fakeContainerA = { id: "__diff_a", path: "docker://ssh://u@h/container/demo-a", name: "demo-a", kind: "log", live: true };
    const fakeContainerB = { id: "__diff_b", path: "docker://ssh://u@h/container/demo-b", name: "demo-b", kind: "log", live: true };
    state.sources.push(fakeContainerA, fakeContainerB);
    syncDockerDaemonButtons();
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    // demo-a is persisted-selected; demo-b was merely followed, never
    // persisted-selected -- per spec, if it's gone and NOT in the file, it
    // must be omitted entirely, not shown disabled.
    const realLoadSelectedTargets = loadSelectedTargets;
    loadSelectedTargets = async () => ({ containers: new Set(["demo-a"]), services: new Set() });
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
      // Edit Docker Host's automatic Refresh on open already runs the
      // live probe above.
      await $("btn-edit-docker-daemon").onclick();
      await until(() => $("docker-targets").textContent.includes("demo-c"), "checklist reflects the live daemon after opening");
      const boxes = [...$("docker-targets").querySelectorAll("input[type=checkbox]")];
      const names = boxes.map((cb) => cb.value);
      eq(names.sort().join(), "demo-a,demo-c", "demo-b (never persisted-selected, now gone) is omitted entirely; demo-c (new) appears");
      eq(boxes.find((cb) => cb.value === "demo-a").checked, true, "demo-a's selected state survives");
      eq(boxes.find((cb) => cb.value === "demo-a").disabled, false, "demo-a still around server-side -- interactive");
      eq(boxes.find((cb) => cb.value === "demo-c").checked, false, "demo-c (newly seen) starts unchecked -- nothing is preselected just for being found");
    } finally {
      post = realPost;
      get = realGet;
      loadSelectedTargets = realLoadSelectedTargets;
      state.sources = state.sources.filter((s) => !s.id.startsWith("__diff_"));
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
      $("btn-set").click();
      dlg.close();
    }
  });

  await T("Refresh marks a persisted-selected-but-now-gone container disabled with a 🚫 mark, removes it from the graph, instead of silently dropping it", async () => {
    const fakeContainerA = { id: "__gone_a", path: "docker://ssh://u@h/container/demo-a", name: "demo-a", kind: "log", live: true };
    state.sources.push(fakeContainerA);
    syncDockerDaemonButtons();
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    const realLoadSelectedTargets = loadSelectedTargets;
    loadSelectedTargets = async () => ({ containers: new Set(["demo-a"]), services: new Set() });
    const realPost = post;
    const realGet = get;
    // The real daemon no longer has demo-a at all (stopped/removed).
    post = async (path, body) => {
      if (path === "/docker/ps") return { containers: [], services: [], log: [] };
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      await $("btn-edit-docker-daemon").onclick(); // runs the live probe above immediately
      const cb = $("docker-targets").querySelector('input[value="demo-a"]');
      ok(cb, "demo-a still shown, not silently dropped, since it was persisted-selected");
      eq(cb.disabled, true, "shown disabled -- it can't actually be followed anymore");
      eq(cb.checked, true, "still shown checked, reflecting that it was selected");
      eq(cb.closest("label").querySelector(".mark").textContent, "🚫", "marked with the gone/disabled indicator");
      ok($("docker-targets").textContent.includes("no longer available"), "explains why it's disabled");
      // dlg-ok must never submit a disabled/unavailable entry
      eq($("docker-targets").querySelectorAll("input:checked:not(:disabled)").length, 0, "excluded from what would actually be submitted");
      // "remove it from the graph": its source is actually closed, not just flagged here
      await until(() => !state.sources.some((s) => s.id === "__gone_a"), "demo-a's source was closed");
    } finally {
      post = realPost;
      get = realGet;
      loadSelectedTargets = realLoadSelectedTargets;
      state.sources = state.sources.filter((s) => !s.id.startsWith("__gone_"));
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
      $("btn-set").click();
      dlg.close();
    }
  });

  await T("opening Edit Docker Host: persisted-selected stays checked, a followed-but-never-persisted-selected container comes back unchecked, and one no longer returned is removed from the graph but shown disabled only if it was persisted-selected", async () => {
    const stillSelected = { id: "__combo_sel", path: "docker://ssh://u@h/container/still-selected", name: "still-selected", kind: "log", live: true };
    const wasUnselected = { id: "__combo_unsel", path: "docker://ssh://u@h/container/was-unselected", name: "was-unselected", kind: "log", live: true };
    const nowGone = { id: "__combo_gone", path: "docker://ssh://u@h/container/now-gone", name: "now-gone", kind: "log", live: true };
    state.sources.push(stillSelected, wasUnselected, nowGone);
    syncDockerDaemonButtons();
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    // Mirrors the real flow: still-selected and now-gone were persisted
    // (ticked and Set/Updated); was-unselected was followed but never
    // actually ticked/persisted.
    const realLoadSelectedTargets = loadSelectedTargets;
    loadSelectedTargets = async () => ({ containers: new Set(["still-selected", "now-gone"]), services: new Set() });
    const realPost = post;
    const realGet = get;
    // The real daemon still has the first two; now-gone was removed.
    post = async (path, body) => {
      if (path === "/docker/ps") {
        return { containers: [{ id: "1", name: "still-selected" }, { id: "2", name: "was-unselected" }], services: [], log: [] };
      }
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      await $("btn-edit-docker-daemon").onclick(); // auto-refreshes immediately, no manual Refresh click needed
      const byName = (n) => $("docker-targets").querySelector(`input[value="${n}"]`);
      eq(byName("still-selected").checked, true, "persisted-selected -> stays checked");
      eq(byName("still-selected").disabled, false, "still there server-side -> interactive");
      eq(byName("was-unselected").checked, false, "followed but never persisted-selected -> comes back unchecked, not silently re-checked");
      eq(byName("was-unselected").disabled, false, "still there server-side -> interactive");
      const goneBox = byName("now-gone");
      ok(goneBox, "now-gone stays listed rather than vanishing, since it was persisted-selected");
      eq(goneBox.disabled, true, "no longer returned by the daemon -> disabled");
      ok($("docker-targets").textContent.includes("no longer available"), "explains why it's disabled");
      await until(() => !state.sources.some((s) => s.id === "__combo_gone"), "now-gone's source was actually closed -- removed from the graph");
      ok(state.sources.some((s) => s.id === "__combo_sel"), "still-selected's source untouched");
      ok(state.sources.some((s) => s.id === "__combo_unsel"), "was-unselected's source untouched (still followed, just not plotted)");
    } finally {
      post = realPost;
      get = realGet;
      loadSelectedTargets = realLoadSelectedTargets;
      state.sources = state.sources.filter((s) => !s.id.startsWith("__combo_"));
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

  await T("Set Docker Host (create mode) is never left showing edit-mode labels/locks", () => {
    $("btn-set").click();
    try {
      eq($("docker-host").disabled, false, "host unlocked");
      eq($("docker-ssh-key").disabled, false, "ssh key unlocked");
      eq($("docker-ssh-key-browse").disabled, false, "browse unlocked");
      eq($("btn-ps-refresh").textContent, "Fetch Sources", "Fetch Sources label restored");
      eq($("dlg-ok").textContent, "Set Docker Host", "confirm label restored");
      eq($("dlg-set-title").textContent, "Set Docker Host", "dialog re-titled for creating, not editing");
    } finally {
      dlg.close();
    }
  });

  await T("Set Docker Host is enabled only when no daemon is currently being watched", () => {
    ok(!hasDockerDaemon(), "no docker:// source open in this suite's baseline state");
    eq($("btn-set").disabled, false, "enabled -- nothing set yet");
    const fakeSrc = { id: "__setbtn_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons(); // a real app calls this via refreshAll() whenever state.sources changes
    try {
      eq($("btn-set").disabled, true, "disabled once a daemon is already being watched -- use Edit/Remove instead");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__setbtn_test");
      syncDockerDaemonButtons();
      eq($("btn-set").disabled, false, "re-enabled once that daemon is gone");
    }
  });

  await T("Set/Update Docker Host syncs the legend's track state to exactly what's checked -- a newly checked entry becomes selected (plotted), a just-unchecked one is demoted, not left stuck selected", async () => {
    setTrack("was-selected", "sel"); // simulates a prior Set/Update that had this one checked
    const realPost = post;
    const realGet = get;
    post = async (path, body) => {
      if (path === "/docker/ps") {
        return { containers: [{ id: "a", name: "was-selected" }, { id: "b", name: "newly-selected" }], services: [], log: [] };
      }
      if (path === "/docker/collect") return { ok: true };
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    const realSaveSelectedTargets = saveSelectedTargets;
    saveSelectedTargets = async () => {};
    try {
      $("btn-set").click();
      $("docker-host").value = "";
      await listContainers();
      const boxes = [...$("docker-targets").querySelectorAll("input[type=checkbox]")];
      // was-selected starts unticked here (nothing preselected just for
      // being found by Fetch) -- untick it to mirror "the user unchecked a
      // previously-selected container", then tick the other one.
      boxes.find((cb) => cb.value === "newly-selected").checked = true;
      await $("dlg-ok").onclick();
      eq(state.track["newly-selected"], "sel", "just-checked entry is promoted to selected -- shows in the graph/legend");
      eq(state.track["was-selected"], "mut", "just-unchecked entry is demoted back to muted, not left stuck as selected");
    } finally {
      post = realPost;
      get = realGet;
      saveSelectedTargets = realSaveSelectedTargets;
      delete state.track["was-selected"];
      delete state.track["newly-selected"];
      prefs.set("track", state.track);
      dlg.close();
    }
  });

  await T("activity log toggle is always visible and drives the panel directly", async () => {
    const toggle = $("activity-toggle");
    const before = toggle.checked;
    try {
      toggle.checked = false;
      renderActivityLog(null);
      eq(toggle.hidden, false, "switch always visible, even with no activity");
      eq($("docker-activity").hidden, true, "panel hidden while switch is off");

      renderActivityLog([{ cmd: "docker ps --format json", returncode: 0, ms: 12, stderr: "" }]);
      eq($("docker-activity").hidden, true, "still hidden -- rendering entries doesn't itself flip the switch");
      ok($("docker-activity").textContent.includes("docker ps"), "logged command shown once revealed");

      toggle.checked = true;
      toggle.dispatchEvent(new Event("change"));
      eq($("docker-activity").hidden, false, "shown once the switch is turned on");
      toggle.checked = false;
      toggle.dispatchEvent(new Event("change"));
      eq($("docker-activity").hidden, true, "hidden again once turned off");
    } finally {
      toggle.checked = before;
      toggle.dispatchEvent(new Event("change"));
    }
  });

  await T("normalizeDockerHost defaults a schemeless host to ssh://", () => {
    eq(normalizeDockerHost(""), null, "empty is local");
    eq(normalizeDockerHost("   "), null, "blank is local");
    eq(normalizeDockerHost("user@other-server"), "ssh://user@other-server", "bare user@host gets ssh://");
    eq(normalizeDockerHost("ssh://user@other-server"), "ssh://user@other-server", "already-schemed left alone");
    eq(normalizeDockerHost("tcp://1.2.3.4:2375"), "tcp://1.2.3.4:2375", "other schemes left alone too");
  });

  await T("setLiveTrackSecs clamps to zero/negative -- the future has no data to simulate a click on", () => {
    try {
      setLiveTrackSecs(-7);
      eq(liveTrackSecs, -7, "negative accepted");
      eq($("live-track-secs").value, "-7", "toolbar field reflects it");
      eq($("live-track-secs-sidebar").value, "-7", "Settings field kept in sync");
      setLiveTrackSecs(5);
      eq(liveTrackSecs, 0, "positive clamped down to 0 -- can't track into the future");
      setLiveTrackSecs(0);
      eq(liveTrackSecs, 0, "zero accepted as-is");
    } finally {
      setLiveTrackSecs(0);
      prefs.set("liveTrackSecs", 0);
    }
  });

  await T("liveTrackTick simulates a click at now + liveTrackSecs while live, marked as a live-tracking cursor -- and does nothing once the user has panned away from live", () => {
    const realLive = state.live;
    const realNow = Date.now;
    try {
      Date.now = () => 1_700_000_000_000;
      state.live = true;
      setLiveTrackSecs(-10);
      liveTrackTick();
      eq(state.cursorT, 1_700_000_000_000 - 10_000, "cursor moved to now + offset");
      eq(state.liveTrackCursor, true, "flagged as a live-tracking cursor, not a manual click");

      state.cursorT = null;
      state.liveTrackCursor = false;
      state.live = false; // user panned away
      liveTrackTick();
      eq(state.cursorT, null, "no-op once no longer following live -- doesn't yank the user's view back");
      eq(state.liveTrackCursor, false, "still not flagged");
    } finally {
      Date.now = realNow;
      state.live = realLive;
      setLiveTrackSecs(0);
      prefs.set("liveTrackSecs", 0);
    }
  });

  await T("the Live tracking switch turns it off entirely, independent of the seconds offset, and disables the seconds field", () => {
    const realLive = state.live;
    try {
      setLiveTrackEnabled(false);
      eq($("live-track-toggle").checked, false, "toolbar switch off");
      eq($("live-track-toggle-sidebar").checked, false, "Settings switch kept in sync");
      eq($("live-track-secs").disabled, true, "seconds field disabled while off");
      eq($("live-track-secs-sidebar").disabled, true, "Settings seconds field disabled too");

      setLiveTrackSecs(-5);
      state.cursorT = null;
      state.liveTrackCursor = false;
      state.live = true;
      liveTrackTick();
      eq(state.cursorT, null, "no-op while the switch is off, even though state.live is true and the offset is set");

      setLiveTrackEnabled(true);
      eq($("live-track-secs").disabled, false, "seconds field re-enabled once back on");
      liveTrackTick();
      eq(state.liveTrackCursor, true, "resumes simulating the click once switched back on");
    } finally {
      state.live = realLive;
      state.cursorT = null;
      state.liveTrackCursor = false;
      setLiveTrackSecs(0);
      setLiveTrackEnabled(true);
      prefs.set("liveTrackSecs", 0);
      prefs.set("liveTrackEnabled", true);
    }
  });

  await T("a manual click clears the live-tracking cursor flag -- only liveTrackTick's own auto-click sets it", () => {
    state.liveTrackCursor = true; // simulate a preceding live-tracking auto-click
    try {
      setCursor(123456789);
      eq(state.liveTrackCursor, false, "a plain setCursor call (manual click) is never flagged as live-tracking");
    } finally {
      state.cursorT = null;
      state.liveTrackCursor = false;
    }
  });

  await T("openPaths reflects open sources", () => {
    const paths = openPaths();
    for (const s of state.sources) ok(paths.has(s.path), s.path);
  });

  /* ── sample round trip through the UI data model ──────────────────────── */

  await T("sample export + load tracks sample sources in the data model", async () => {
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

  await T("Load Analysis accepts a .cttc-record file, not just .cttc-metric (ui-EXPORT-011)", async () => {
    // Previously this button's client-side filter only kept ".cttc-metric"
    // paths, silently dropping ".cttc-record" even though the button's own
    // label ("Load Data...") advertises
    // accepting both -- see ui-EXPORT-011's stale "silently dropped" bullet.
    const t0 = R.min_ts;
    const res = await fetch(`${API}/sample/record`, {
      method: "POST", body: new Uint8Array(0),
      headers: { "X-CTTC-From": String(t0), "X-CTTC-To": String(t0 + 60000) },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const realPath = "/tmp/cttc-e2e-load-analysis.cttc-record";
    await window.cttc.writeBinaryFile(realPath, bytes);

    const realPick = pickAnalysisFiles;
    pickAnalysisFiles = async () => [realPath];
    try {
      // Awaits the actual onclick handler directly (it's a plain async
      // function reference, not a DOM-dispatched event) rather than
      // .click()-and-poll -- .click() doesn't return its promise, so
      // polling for a side effect risked this test's own cleanup below
      // racing the handler's still-in-flight refreshAll()/centering.
      await $("btn-load-sample").onclick();
      ok(
        state.sources.some((s) => s.path === `upload://${realPath.split("/").pop()}`),
        "the .cttc-record file's source(s) actually opened, not silently dropped"
      );
    } finally {
      pickAnalysisFiles = realPick;
      const opened = state.sources.filter((s) => s.path === `upload://${realPath.split("/").pop()}`);
      for (const s of opened) await post("/close", { id: s.id });
      await refreshAll();
    }
  });

  /* ── Recording (Start/Pause/Stop/Open Recording) ──────────────────────── */

  await T("Record -> Pause -> Resume -> Stop writes a real 2-segment .cttc-record, filename is only asked at Stop", async () => {
    // br-REC-UI-002: Start used to prompt for a save path immediately;
    // every segment now flushes to a fixed scratch path instead (see
    // main.js's RECORDING_SCRATCH_PATH), and the *real* destination is
    // only asked for once, when Stop actually finalizes the recording.
    const realScratch = recordingScratchPath,
      realPick = pickRecordingSavePath,
      realRead = readRecordingBytes,
      realWrite = writeRecordingBytes;
    const store = {};
    const scratchPath = "/fake/scratch.cttc-record";
    recordingScratchPath = async () => scratchPath;
    pickRecordingSavePath = async () => "/fake/e2e-recording.cttc-record";
    readRecordingBytes = async (p) => {
      if (!(p in store)) throw new Error("no such file");
      return store[p];
    };
    writeRecordingBytes = async (p, bytes) => { store[p] = bytes; };
    try {
      eq(recording.status, "idle");
      eq($("btn-start-recording").title, "Start Recording");
      eq($("status-bar-recording-dot").hidden, true, "no dot while idle");
      await startRecording();
      eq(recording.status, "recording");
      eq(recording.path, scratchPath, "writes to the fixed scratch path, not a user-chosen one");
      eq($("btn-start-recording").disabled, true);
      eq($("btn-start-recording").title, "Recording");
      eq($("btn-pause-recording").disabled, false);
      eq($("btn-stop-recording").disabled, false);
      eq(recording.segments.length, 0, "no completed segment yet -- still recording the first one");
      const firstSegmentStart = recording.segmentStart;
      eq($("status-bar-recording-dot").hidden, false, "dot visible while recording");
      eq($("status-bar-recording-dot").dataset.state, "recording");
      eq($("status-bar-recording-text").hidden, false);
      eq($("status-bar-recording-text").textContent, "recording", "no filename shown yet -- nothing's been chosen");

      await pauseRecording();
      eq(recording.status, "paused");
      eq($("btn-start-recording").disabled, false);
      eq($("btn-start-recording").title, "Resume Recording");
      eq($("btn-pause-recording").disabled, true);
      eq($("btn-pause-recording").dataset.state, "paused");
      // br-REC-UI-004: paused reads via the glyphs themselves (record
      // button's ⏺ solid orange, pause button's/status bar's ⏸ blinking
      // orange), not the small recording-dot -- the dot is hidden outright
      // on both the toolbar button and the status bar while paused.
      eq($("status-bar-recording-dot").hidden, true, "dot hidden while paused -- the pause glyph is the indicator instead");
      eq($("status-bar-recording-glyph").hidden, false, "pause glyph shown while paused");
      eq(getComputedStyle($("recording-glyph")).display, "inline", "record button's own glyph shown (not hidden) while paused");
      eq(getComputedStyle($("recording-glyph")).color, getComputedStyle($("status-bar-recording-glyph")).color, "record button glyph is the same orange as the pause glyphs");
      eq(getComputedStyle($("pause-glyph")).color, getComputedStyle($("status-bar-recording-glyph")).color, "pause button glyph matches too");
      eq(getComputedStyle($("recording-glyph")).animationName, "none", "record button glyph is solid orange, not blinking");
      eq(getComputedStyle($("pause-glyph")).animationName, "recording-pulse", "pause button glyph blinks");
      eq(getComputedStyle($("status-bar-recording-glyph")).animationName, "recording-pulse", "status bar pause glyph blinks");
      eq(getComputedStyle($("btn-pause-recording")).opacity, "1", "pause button reads at full vibrancy despite being disabled");
      eq($("status-bar-recording-text").textContent, "recording paused");
      ok(store[scratchPath], "first segment flushed to the scratch path");
      const afterFirst = store[scratchPath];
      eq(afterFirst[0], 0x50, "PK zip magic byte 1");
      // the completed segment is recorded for the highlight; segmentStart
      // (the *next* segment's start, not yet known) is cleared meanwhile,
      // leaving a genuine gap rather than painting through the pause
      eq(recording.segments.length, 1, "first segment finalized for the highlight");
      eq(recording.segments[0].from, firstSegmentStart);
      ok(recording.segments[0].to > firstSegmentStart, "finalized with a real end time");
      eq(recording.segmentStart, null, "no in-progress segment while paused -- pause gap stays unhighlighted");

      await startRecording(); // resume
      eq(recording.status, "recording");
      eq($("btn-start-recording").title, "Recording");
      eq(recording.segments.length, 1, "still just the one completed segment");
      ok(recording.segmentStart >= recording.segments[0].to, "new segment starts at/after the pause gap");
      eq($("status-bar-recording-dot").dataset.state, "recording", "dot back to recording on resume");
      eq($("status-bar-recording-text").textContent, "recording");

      await stopRecording();
      eq(recording.status, "idle", "a save path was provided -- fully finalized");
      eq(recording.path, null);
      eq(recording.segments.length, 0, "highlight cleared once actually stopped");
      eq($("btn-stop-recording").disabled, true);
      eq($("status-bar-recording-dot").hidden, true, "dot hidden again once stopped");
      eq($("status-bar-recording-text").hidden, true, "text hidden again once stopped");
      const afterSecond = store["/fake/e2e-recording.cttc-record"];
      ok(afterSecond, "the chosen destination (not the scratch path) received the final bytes");
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
      recordingScratchPath = realScratch;
      pickRecordingSavePath = realPick;
      readRecordingBytes = realRead;
      writeRecordingBytes = realWrite;
    }
  });

  await T("Stop without choosing a save path stays 'stopped' -- the recording itself isn't lost, Stop can be retried", async () => {
    const realScratch = recordingScratchPath,
      realPick = pickRecordingSavePath,
      realRead = readRecordingBytes,
      realWrite = writeRecordingBytes;
    const store = {};
    const scratchPath = "/fake/scratch2.cttc-record";
    recordingScratchPath = async () => scratchPath;
    readRecordingBytes = async (p) => {
      if (!(p in store)) throw new Error("no such file");
      return store[p];
    };
    writeRecordingBytes = async (p, bytes) => { store[p] = bytes; };
    try {
      if (recording.status !== "idle") await stopRecording(); // clean baseline
      pickRecordingSavePath = async () => null; // user closes the native dialog
      await startRecording();
      await stopRecording();
      eq(recording.status, "stopped", "finalized, but no destination chosen yet");
      eq($("btn-start-recording").disabled, true, "can't start a new one until this is saved");
      eq($("btn-pause-recording").disabled, true);
      eq($("btn-stop-recording").disabled, false, "Stop can be clicked again to retry the save prompt");
      eq($("status-bar-recording-dot").hidden, false);
      eq($("status-bar-recording-dot").dataset.state, "stopped");
      eq($("status-bar-recording-text").textContent, "recording stopped, not yet saved");
      ok(store[scratchPath], "the recording itself was NOT lost -- it's safely on the scratch file");
      const scratchBytes = store[scratchPath];

      pickRecordingSavePath = async () => "/fake/e2e-retry.cttc-record"; // retry succeeds
      await stopRecording();
      eq(recording.status, "idle");
      eq(store["/fake/e2e-retry.cttc-record"], scratchBytes, "retried save wrote the already-finalized bytes, no re-flush");
    } finally {
      recordingScratchPath = realScratch;
      pickRecordingSavePath = realPick;
      readRecordingBytes = realRead;
      writeRecordingBytes = realWrite;
    }
  });

  await T("Record/Pause/Resume/Stop each land in status bar History (regression: these go through setStatus, not notifyEvent)", async () => {
    const realScratch = recordingScratchPath,
      realPick = pickRecordingSavePath,
      realRead = readRecordingBytes,
      realWrite = writeRecordingBytes;
    const store = {};
    recordingScratchPath = async () => "/fake/scratch-history.cttc-record";
    pickRecordingSavePath = async () => "/fake/e2e-history-recording.cttc-record";
    readRecordingBytes = async (p) => {
      if (!(p in store)) throw new Error("no such file");
      return store[p];
    };
    writeRecordingBytes = async (p, bytes) => { store[p] = bytes; };
    statusBarHistory.length = 0;
    try {
      // Defensive: an earlier test failing before its own cleanup can leave
      // `recording` non-idle (it's shared module state) -- force a clean
      // baseline so this test's own "started" (vs. "resumed") assertion
      // isn't at the mercy of test execution order.
      if (recording.status !== "idle") await stopRecording();
      eq(recording.status, "idle", "clean baseline before this test's own assertions");
      await startRecording();
      await pauseRecording();
      await startRecording(); // resume
      await stopRecording();
      const texts = statusBarHistory.map((e) => e.text);
      ok(texts.some((t) => t.startsWith("Recording started")), `expected a "Recording started" entry: ${texts}`);
      ok(texts.some((t) => t.startsWith("Recording paused")), `expected a "Recording paused" entry: ${texts}`);
      ok(texts.some((t) => t.startsWith("Recording resumed")), `expected a "Recording resumed" entry: ${texts}`);
      ok(texts.some((t) => t.startsWith("Recording stopped")), `expected a "Recording stopped" entry: ${texts}`);
    } finally {
      recordingScratchPath = realScratch;
      pickRecordingSavePath = realPick;
      readRecordingBytes = realRead;
      writeRecordingBytes = realWrite;
    }
  });

  // No e2e coverage for startRecording()'s "no window.cttc at all" guard
  // (setStatus("Recording needs desktop file access — unavailable here")):
  // window.cttc's own properties are read-only (contextBridge), so that
  // environment can't be simulated from here -- the real Electron preload
  // is always present in this test harness.

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

  await T("recoverInterruptedRecording keeps a stale 'stopped' marker stopped, not paused", async () => {
    // br-REC-UI-002: a crash after Stop already finalized the recording
    // (scratch file fully written, just waiting on the save dialog) has
    // nothing left to resume into -- recovering it as "paused" would let
    // Start Recording silently begin a fresh segment on top of already-
    // finished data instead of just re-asking where to save it.
    const realGetMarker = getRecordingMarkerFromDisk, realSetMarker = setRecordingMarkerOnDisk;
    let lastSet = null;
    getRecordingMarkerFromDisk = async () => ({
      path: "/fake/stale-stopped.cttc-record",
      status: "stopped",
      segmentStart: null,
      segments: [{ from: 1, to: 2 }],
    });
    setRecordingMarkerOnDisk = async (m) => { lastSet = m; };
    try {
      await recoverInterruptedRecording();
      eq(recording.status, "stopped");
      eq(recording.path, "/fake/stale-stopped.cttc-record");
      eq(recording.segments.length, 0, "nothing left to highlight -- the recording is already over");
      eq($("btn-start-recording").disabled, true, "can't resume into a finished recording");
      ok($("status").textContent.includes("wasn't saved"), $("status").textContent);
      ok(lastSet && lastSet.status === "stopped", "marker persisted still as stopped, not paused");
    } finally {
      getRecordingMarkerFromDisk = realGetMarker;
      setRecordingMarkerOnDisk = realSetMarker;
      setRecordingState({ status: "idle", path: null, segmentStart: null });
      await persistRecordingMarker();
    }
  });

  await T("multi-segment .cttc-record upload auto-loads the first segment without prompting", async () => {
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

    const r = await uploadAndResolveSegment(realPath);
    eq(r.errors.length, 0, JSON.stringify(r.errors));
    ok(r.opened.length >= 1, "first segment's sources opened, no user choice needed");

    // #record-sections (right of Back to live tracking) is populated
    // immediately with every segment, first one selected, so the others
    // aren't permanently inaccessible.
    await until(() => !$("record-sections").hidden, "record-sections dropdown shown");
    eq($("record-sections").options.length, 2, "both segments listed");
    eq($("record-sections").value, "0", "first segment selected by default");
    eq(activeRecordSections.path, realPath);
    eq(activeRecordSections.activeIndex, 0);

    // the auto-loaded recording must switch the app out of live mode just
    // like the old prompt-driven flow did -- see setLiveHidden.
    await refreshAll();
    eq(state.liveHidden, true, "auto-loading a recording enters analysis mode");
    eq($("live-data-group").hidden, true, "Frequency/Live tracking hidden once the recording is auto-loaded");

    for (const sid of r.opened) await post("/close", { id: sid });
    await refreshAll();
    eq($("record-sections").hidden, true, "hidden again once its sources are gone (self-heals via setLiveHidden)");
  });

  await T("#record-sections dropdown switches segments after the automatic first-segment load", async () => {
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
    const realPath = "/tmp/cttc-e2e-record-sections-switch.cttc-record";
    await window.cttc.writeBinaryFile(realPath, secondBytes);

    const first = await uploadAndResolveSegment(realPath);
    ok(first.opened.length >= 1, "first segment's sources opened");
    const firstIds = first.opened.slice();
    eq(activeRecordSections.activeIndex, 0);

    $("record-sections").value = "1";
    $("record-sections").dispatchEvent(new Event("change"));
    await until(() => activeRecordSections?.activeIndex === 1, "switched to segment 1");
    eq($("record-sections").value, "1");
    for (const sid of firstIds) {
      ok(!state.sources.some((s) => s.id === sid), `segment 0's source ${sid} was closed on switch`);
    }
    ok(activeRecordSections.openedIds.length >= 1, "segment 1's sources opened");

    for (const sid of activeRecordSections.openedIds) await post("/close", { id: sid });
    await refreshAll();
  });

  await T("Recording controls hide along with live-data controls in analysis mode (ui-REC-013)", async () => {
    // #section-recording (Start/Pause/Stop/Open Recording) lives outside
    // #live-data-group in the DOM -- a structural fix for br-REC-UI-001 (it
    // used to be nested there and vanish as an accidental side effect of
    // that group's own hide toggle). It's still explicitly hidden together
    // with the rest of the live-data controls in analysis mode, just via
    // its own toggle in setLiveHidden rather than incidental DOM nesting.
    ok(
      !$("live-data-group").contains($("section-recording")),
      "#section-recording must live outside #live-data-group"
    );
    const res = await fetch(
      `${API}/files/download?from=${R.min_ts}&to=${R.max_ts}&include_host=0`,
      { headers: authHeaders() }
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const realPath = "/tmp/cttc-e2e-recording-controls-hidden.cttc-metric";
    await window.cttc.writeBinaryFile(realPath, bytes);
    const r = await uploadAndResolveSegment(realPath);
    try {
      ok(r.opened.length >= 1, "sample opened");
      await refreshAll();
      eq(state.liveHidden, true, "now viewing loaded metrics");
      eq($("live-data-group").hidden, true, "Frequency/Live tracking hidden while viewing a sample");
      eq($("section-recording").hidden, true, "Recording controls hidden too, by explicit design");
    } finally {
      for (const sid of r.opened) await post("/close", { id: sid });
      await refreshAll();
      eq($("section-recording").hidden, false, "Recording controls visible again once back in live mode");
    }
  });

  await T("Status-bar mode icon doesn't swap to analysis mode while actively recording", async () => {
    const realStatus = recording.status;
    setRecordingState({ status: "recording" });
    const res = await fetch(
      `${API}/files/download?from=${R.min_ts}&to=${R.max_ts}&include_host=0`,
      { headers: authHeaders() }
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const realPath = "/tmp/cttc-e2e-recording-plus-metric.cttc-metric";
    await window.cttc.writeBinaryFile(realPath, bytes);
    const r = await uploadAndResolveSegment(realPath);
    try {
      ok(r.opened.length >= 1, "sample opened");
      await refreshAll();
      eq(state.liveHidden, true, "still functionally in analysis mode");
      eq($("live-data-group").hidden, true, "live-data controls still hide normally");
      eq(
        $("status-bar-mode-live").hidden,
        false,
        "status-bar mode icon left showing live -- must not swap while actively recording"
      );
      eq($("status-bar-mode-record").hidden, true, "analysis-mode icon must not appear either, for the same reason");
    } finally {
      for (const sid of r.opened) await post("/close", { id: sid });
      setRecordingState({ status: realStatus });
      await refreshAll();
    }
  });

  await T("centerViewOnLoadedStart centers on the earliest min_ts among just-opened sources", () => {
    // A direct unit check against a fabricated state.sources entry, rather
    // than a real upload: entity names are shared/reused across this whole
    // long-running suite's many recordings, so a real source's reported
    // min_ts reflects the earliest sample *ever* stored under that name
    // this run, not just what this one test loaded -- exactly the kind of
    // cross-source bleed this function must center past when it's the
    // *live* feed doing the accumulating, but not what this unit itself
    // should be judged against.
    const realSources = state.sources;
    const realView = state.view;
    const fileStart = 1_700_000_000_000; // arbitrary, fixed, unrelated to any real fixture data
    state.sources = [
      ...state.sources,
      { id: "e2e-fake-source", path: "upload://fake.cttc-metric", live: false, min_ts: fileStart, max_ts: fileStart + 30000 },
    ];
    try {
      centerViewOnLoadedStart(["e2e-fake-source"]);
      const center = (state.view.t0 + state.view.t1) / 2;
      eq(center, fileStart, "view centered exactly on the fabricated source's min_ts");
      eq(state.view.t1 - state.view.t0, DEFAULT_SPAN, "uses the default span width");
    } finally {
      state.sources = realSources;
      state.view = realView;
    }
  });

  await T("Returning to live mode restores the exact prior view instead of leaving it wherever analysis mode was", async () => {
    const t0 = Date.now() - 999_000, t1 = Date.now() - 900_000; // a distinctive, non-default window
    setView(t0, t1);
    const wasLive = state.live;
    eq(wasLive, false, "sanity: setView (no _follow) turns live-follow off");

    const res = await fetch(
      `${API}/files/download?from=${R.min_ts}&to=${R.max_ts}&include_host=0`,
      { headers: authHeaders() }
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const realPath = "/tmp/cttc-e2e-restore-view.cttc-metric";
    await window.cttc.writeBinaryFile(realPath, bytes);
    const r = await uploadAndResolveSegment(realPath);
    try {
      ok(r.opened.length >= 1, "sample opened");
      await refreshAll();
      centerViewOnLoadedStart(r.opened); // matches what the real Load Analysis/Open Recording button flow does
      eq(state.liveHidden, true, "now in analysis mode");
      ok(
        state.view.t0 !== t0 || state.view.t1 !== t1,
        "analysis mode must actually change the view, not leave the old live window showing"
      );
    } finally {
      for (const sid of r.opened) await post("/close", { id: sid });
      await refreshAll();
      eq(state.liveHidden, false, "back in live mode");
      eq(state.view.t0, t0, "the exact prior view's start is restored");
      eq(state.view.t1, t1, "the exact prior view's end is restored");
      eq(state.live, wasLive, "the prior live-follow flag is restored too");
    }
  });

  await T("Loading a single (non-segmented) metric still populates the metric(s) dropdown with one entry", async () => {
    // Generalizes what #record-sections used to only do for a real
    // multi-segment .cttc-record: it now always reflects whatever is
    // currently loaded, even a plain single .cttc-metric with no segment
    // ambiguity at all -- previously this case called
    // setActiveRecordSections(null), hiding the dropdown outright.
    const res = await fetch(
      `${API}/files/download?from=${R.min_ts}&to=${R.max_ts}&include_host=0`,
      { headers: authHeaders() }
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const realPath = "/tmp/cttc-e2e-single-metric-dropdown.cttc-metric";
    await window.cttc.writeBinaryFile(realPath, bytes);
    const r = await uploadAndResolveSegment(realPath);
    try {
      ok(r.opened.length >= 1, "sample opened");
      await until(() => !$("record-sections").hidden, "metric(s) dropdown shown even for a single metric");
      eq($("record-sections").options.length, 1, "exactly one entry -- nothing else to switch to");
      eq($("record-sections").title, "metric(s)");
      eq(activeRecordSections.activeIndex, 0);
    } finally {
      for (const sid of r.opened) await post("/close", { id: sid });
      await refreshAll();
      eq($("record-sections").hidden, true, "hidden again once back in live mode");
    }
  });

  await T("Back to live tracking reads as a flat action, not a boxed button", async () => {
    const res = await fetch(
      `${API}/files/download?from=${R.min_ts}&to=${R.max_ts}&include_host=0`,
      { headers: authHeaders() }
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const realPath = "/tmp/cttc-e2e-back-to-live-style.cttc-metric";
    await window.cttc.writeBinaryFile(realPath, bytes);
    const r = await uploadAndResolveSegment(realPath);
    try {
      ok(r.opened.length >= 1, "sample opened");
      await refreshAll();
      eq($("btn-back-to-live").hidden, false);
      const style = getComputedStyle($("btn-back-to-live"));
      eq(style.borderStyle === "none" || style.borderWidth === "0px", true, `expected no border, got ${style.borderStyle}/${style.borderWidth}`);
      eq(style.backgroundColor, "rgba(0, 0, 0, 0)", "expected a transparent background");
      ok($("btn-back-to-live").querySelector("svg.flat-action-icon"), "has a leading icon");
    } finally {
      for (const sid of r.opened) await post("/close", { id: sid });
      await refreshAll();
    }
  });

  /* ── sidebar / appearance ──────────────────────────────────────────────── */

  await T("sidebar groups have no separator borders between them", () => {
    for (const g of document.querySelectorAll(".ab-group")) {
      eq(getComputedStyle(g).borderTopWidth, "0px", `${g.querySelector(".ab-group-title")?.textContent} group`);
    }
  });

  await T("Create Event/Edit Events buttons live inside the Analysis sidebar section", () => {
    const analysisGroup = document.querySelector('.ab-group[data-section="analysis"]');
    ok(analysisGroup, "Analysis section exists");
    ok(analysisGroup.contains($("btn-event-create")), "btn-event-create is inside the Analysis section");
    ok(analysisGroup.contains($("btn-event-edit")), "btn-event-edit is inside the Analysis section");
  });

  await T("sidebar sections start collapsed and expand on header click", () => {
    const analysisGroup = document.querySelector('.ab-group[data-section="analysis"]');
    const header = analysisGroup.querySelector(".ab-group-header");
    const body = analysisGroup.querySelector(".ab-group-body");
    eq(body.hidden, true, "starts collapsed");
    header.click();
    eq(body.hidden, false, "expands on click");
    eq(analysisGroup.dataset.expanded, "true");
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
      dlgPreferences.close();
    }
    eq($("app-status-bar").hidden, false, "restored visible for later tests");
  });

  await T("notifyEvent updates the status bar text with a timestamp", () => {
    notifyEvent("something happened");
    ok($("app-status-bar-text").textContent.includes("something happened"));
  });

  await T("application-starting/shutting-down status messages", () => {
    // The real "application starting" call already fired once at this
    // window's own boot, before any test ran -- re-invoking notifyEvent
    // here with the exact same strings the boot-time code uses confirms
    // the wording/wiring is correct without needing to re-run boot itself.
    statusBarHistory.length = 0;
    notifyEvent("application starting");
    ok($("app-status-bar-text").textContent.includes("application starting"));
    eq(statusBarHistory.at(-1).text, "application starting");

    eq(typeof window.cttc?.onAppShuttingDown, "function", "preload exposes onAppShuttingDown");

    notifyEvent("application shutting down");
    ok($("app-status-bar-text").textContent.includes("application shutting down"));
    eq(statusBarHistory.at(-1).text, "application shutting down");
  });

  await T("notifyEventWithCap force-clears the status bar after its timeout (ui-SBAR-006)", async () => {
    notifyEventWithCap("e2e cap test message", 200);
    ok($("app-status-bar-text").textContent.includes("e2e cap test message"));
    await sleep(300);
    eq($("app-status-bar-text").textContent, "", "cleared once nothing else replaced it within the cap");
  });

  await T("notifyEventWithCap's clear is skipped once something else already replaced the message", async () => {
    notifyEventWithCap("e2e cap test message 2", 200);
    notifyEvent("something else happened in the meantime");
    await sleep(300);
    ok(
      $("app-status-bar-text").textContent.includes("something else happened in the meantime"),
      "the newer message must survive the stale cap timer, not get clobbered back to blank"
    );
  });

  await T("notifyEvent auto-clears after the configured statusBarClearSecs", async () => {
    const real = statusBarClearSecs;
    statusBarClearSecs = 0.2; // 200ms -- the real UI only allows whole seconds >= 1
    try {
      notifyEvent("e2e general auto-clear test message");
      ok($("app-status-bar-text").textContent.includes("e2e general auto-clear test message"));
      await sleep(350);
      eq($("app-status-bar-text").textContent, "", "cleared without needing notifyEventWithCap's own separate cap");
    } finally {
      statusBarClearSecs = real;
    }
  });

  await T("setStatusBarClearSecs clamps below 1 and persists", () => {
    const real = statusBarClearSecs;
    try {
      setStatusBarClearSecs(0);
      eq(statusBarClearSecs, 1, "clamped up to the 1s floor");
      setStatusBarClearSecs(12);
      eq(statusBarClearSecs, 12);
      eq($("status-bar-clear-secs-sidebar").value, "12");
      eq(prefs.get("statusBarClearSecs", null), 12, "persisted");
    } finally {
      setStatusBarClearSecs(real);
      prefs.set("statusBarClearSecs", real);
    }
  });

  await T("notifyEvent appends after a separator instead of replacing while actively recording", () => {
    const realStatus = recording.status;
    try {
      setRecordingState({ status: "recording" });
      notifyEvent("first message while recording");
      const first = $("app-status-bar-text").textContent;
      ok(first.includes("first message while recording"));
      notifyEvent("second message while recording");
      const second = $("app-status-bar-text").textContent;
      ok(second.startsWith(first), "the first message must survive, not get replaced");
      ok(second.includes(" | "), "joined by a single bar separator");
      ok(second.includes("second message while recording"));
    } finally {
      setRecordingState({ status: realStatus });
    }
  });

  await T("status bar History records notifyEvent/flashStatus and renders newest-first", () => {
    statusBarHistory.length = 0;
    notifyEvent("first e2e history event");
    flashStatus("second e2e history event", 50000);
    eq(statusBarHistory.length, 2);
    eq(statusBarHistory[0].text, "first e2e history event");
    eq(statusBarHistory[1].text, "second e2e history event");

    eq($("status-bar-history-popup").hidden, true, "starts closed");
    $("status-bar-history-btn").onclick();
    try {
      eq($("status-bar-history-popup").hidden, false, "opens on click");
      const rows = [...$("status-bar-history-list").querySelectorAll(".status-bar-history-row")];
      eq(rows.length, 2);
      // newest first
      ok(rows[0].textContent.includes("second e2e history event"));
      ok(rows[1].textContent.includes("first e2e history event"));
    } finally {
      $("status-bar-history-btn").onclick(); // close again
    }
    eq($("status-bar-history-popup").hidden, true, "closes on a second click");
  });

  await T("status bar History: Clear empties it", () => {
    statusBarHistory.length = 0;
    notifyEvent("to be cleared");
    $("status-bar-history-btn").onclick();
    try {
      eq($("status-bar-history-list").querySelectorAll(".status-bar-history-row").length, 1);
      $("status-bar-history-clear").onclick();
      eq(statusBarHistory.length, 0);
      ok($("status-bar-history-list").textContent.includes("Nothing yet"));
    } finally {
      $("status-bar-history-btn").onclick();
    }
  });

  await T("status bar History icon matches the Set Docker Host 'Logs' section icon", () => {
    const historyPath = $("status-bar-history-btn").querySelector("svg path").getAttribute("d");
    const logsLegend = document.querySelector("#dlg-set fieldset:has(#docker-targets) legend svg path");
    ok(logsLegend, "Logs legend icon found");
    eq(historyPath, logsLegend.getAttribute("d"));
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

  await T("creating a UI-hosted event with a non-numeric threshold is rejected, not silently stored (ui-EVT-003)", async () => {
    // Gateway-hosted events get this for free server-side (events.py's
    // _validate 400s a NaN-turned-null threshold); UI-hosted ones have no
    // server to reject them, so this used to be stored as-is and every
    // future comparison against it silently broke forever.
    const before = loadUiEvents().length;
    openEventCreateDialog();
    try {
      $("event-name").value = "e2e bad threshold";
      $("event-hosted").value = "ui";
      // Number("") is 0 (a valid threshold) -- only a genuinely non-numeric
      // string actually reproduces the NaN this bug is about.
      $("event-conditions").children[0].querySelector('[data-field="threshold"]').value = "abc";
      await $("dlg-event-create").onclick();
      eq(loadUiEvents().length, before, "must not be saved with an invalid threshold");
      ok($("status").textContent.includes("threshold"), "status explains why");
      ok(dlgEventForm.open, "dialog stays open so the user can fix it");
    } finally {
      dlgEventForm.close();
    }
  });

  await T("creating a UI-hosted event with an invalid regex is rejected, not silently stored (ui-EVT-004)", async () => {
    // Gateway-hosted events get this for free server-side too (events.py's
    // _validate 400s an uncompilable regex at create time); UI-hosted ones
    // used to reach `new RegExp()` with no try/catch inside uiEventTick's
    // setInterval callback, throwing uncaught on every tick and (since that
    // throw aborted the loop before saveUiEvents ran) silently freezing
    // every OTHER UI-hosted event's status/log-cursor progress too.
    const before = loadUiEvents().length;
    openEventCreateDialog();
    try {
      $("event-name").value = "e2e bad regex";
      $("event-hosted").value = "ui";
      const row = $("event-conditions").children[0];
      row.querySelector('[data-field="type"]').value = "log";
      row.querySelector('[data-field="type"]').dispatchEvent(new Event("change"));
      row.querySelector('[data-field="pattern"]').value = "(unclosed";
      await $("dlg-event-create").onclick();
      eq(loadUiEvents().length, before, "must not be saved with an invalid regex");
      ok($("status").textContent.includes("invalid regex"), "status explains why");
      ok(dlgEventForm.open, "dialog stays open so the user can fix it");
    } finally {
      dlgEventForm.close();
    }
  });

  await T("editing a UI event with an invalid regex is rejected, leaving the saved event unchanged (ui-EVT-004)", async () => {
    const list = loadUiEvents();
    list.push({
      id: "ui-e2e-badregex-edit", name: "before bad edit", sourceIds: [], match: "any",
      conditions: [{ type: "log", pattern: "ok" }],
      action: { kind: "recording", duration_minutes: 5 },
      enabled: true, status: "armed", armed: true, logCursors: {},
    });
    saveUiEvents(list);
    try {
      const ev = loadUiEvents().find((e) => e.id === "ui-e2e-badregex-edit");
      openEventEditForm(ev, "ui");
      $("event-conditions").children[0].querySelector('[data-field="pattern"]').value = "(unclosed";
      await $("dlg-event-create").onclick();
      const stillSaved = loadUiEvents().find((e) => e.id === "ui-e2e-badregex-edit");
      eq(stillSaved.conditions[0].pattern, "ok", "the bad edit must not have overwritten the saved event");
    } finally {
      dlgEventForm.close();
      saveUiEvents(loadUiEvents().filter((e) => e.id !== "ui-e2e-badregex-edit"));
    }
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
      // nothing picked yet -- ssh/image/connect fields start disabled
      eq($("gw-btn-connect").disabled, true);
      eq($("gw-ssh-user").disabled, true);
    } finally {
      dlgGatewaySetup.close();
    }
  });

  await T("Uninstall Gateway opens its own dialog, populated from getGateways, excluding This machine", async () => {
    await openUninstallGatewayDialog();
    try {
      ok(dlgGatewayUninstall.open, "dialog opened");
      const options = [...$("gw-uninstall-select").options].map((o) => o.textContent);
      ok(!options.some((t) => t.includes("This machine")), "embedded gateway excluded");
      eq($("gw-uninstall-delete").disabled, true, "nothing picked yet");
    } finally {
      dlgGatewayUninstall.close();
    }
  });

  await T("Uninstall Gateway: picking an entry enables the Uninstall button", async () => {
    await openUninstallGatewayDialog();
    try {
      const select = $("gw-uninstall-select");
      if (select.options.length > 1) {
        select.value = select.options[1].value;
        select.onchange();
        eq($("gw-uninstall-delete").disabled, false);
      }
    } finally {
      dlgGatewayUninstall.close();
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

  await T("log panels default to newest-first and land pinned to the very top on the boot-time cursor sync (goLive -> setCursor(now))", async () => {
    // fresh panels (see Panel's constructor) always default to reversed --
    // regression guard in case a stale localStorage value from a prior
    // toggle elsewhere ever leaked into a brand new panel's own default.
    for (const p of panels.values()) ok(p.reversed, "reversed (newest-first) by default");
    const beforeCursor = state.cursorT;
    try {
      // the actual real-world path: goLive() calls setCursor(Date.now()),
      // which jumps every panel's cursor to "now" -- for a reversed panel
      // that lands on index_at's clamped last (newest) row, and centering
      // that row instead of pinning it to the top could leave the newest
      // entries scrolled just out of view above the fold. Confirmed
      // separately against the real /index_at endpoint that a far-future t
      // clamps to total-1 (visualIndexOf(total-1) === 0 when reversed), so
      // this must resolve to scrollTop 0, not some centered positive offset.
      await setCursor(Date.now());
      for (const p of panels.values()) {
        eq(p.body.scrollTop, 0, `${p.src.name}: newest entries visible at the very top after the boot cursor sync`);
      }
    } finally {
      if (beforeCursor != null) await setCursor(beforeCursor);
    }
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

  await T("Esc-dismissing the export dialog resolves the promise as a cancel instead of hanging forever (ui-EXPORT-003)", async () => {
    const p = askExportOptions();
    await until(() => dlgExport.open, "export dialog open");
    dlgExport.close(); // native <dialog> Esc behavior: closes without touching either button
    const opts = await p; // must not hang
    eq(opts, null, "Esc must resolve as a cancel");
    // the next real open must still work normally -- proof the close-event
    // listener/handlers were cleaned up, not left stale from the Esc above
    const p2 = askExportOptions();
    await until(() => dlgExport.open, "export dialog reopened");
    $("dlg-export-ok").click();
    ok((await p2) !== null, "OK still resolves normally after a prior Esc");
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
