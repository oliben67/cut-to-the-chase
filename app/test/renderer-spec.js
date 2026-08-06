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

  /* ── formatLogEntryText: JSON log lines pretty-printed in the row tooltip
     (the compact virtualized row itself stays raw, unaffected) ──────────── */

  await T("formatLogEntryText leaves plain, non-JSON text alone", () => {
    eq(formatLogEntryText("plain text, not JSON at all"), "plain text, not JSON at all");
    eq(formatLogEntryText('{"unterminated": '), '{"unterminated": ');
    eq(formatLogEntryText("[1, 2, 3]"), "[1, 2, 3]", "a JSON array isn't a set of fields to pretty-print");
    eq(formatLogEntryText("{}"), "{}", "an empty object has no fields to show, left as-is");
  });

  await T("formatLogEntryText pretty-prints a plain JSON object, one 'key: value' line per field, defaulting to INFO", () => {
    const text = JSON.stringify({ a: "1", b: "2", c: "3" });
    eq(formatLogEntryText(text), "INFO:  a: 1\n        b: 2\n        c: 3");
  });

  await T("formatLogEntryText unwraps a log line that's been JSON-encoded an extra time by an upstream shipper", () => {
    const doubleEncoded = JSON.stringify(JSON.stringify({ a: "1", b: "2" }));
    eq(formatLogEntryText(doubleEncoded), "INFO:  a: 1\n        b: 2");
  });

  await T("formatLogEntryText prefers a well-known level-shaped key over a value that merely looks like a level token", () => {
    eq(formatLogEntryText(JSON.stringify({ level: "warning", status: "OK" })), "WARNING:  level: warning\n        status: OK");
    eq(formatLogEntryText(JSON.stringify({ lvl: "error", a: "1" })), "ERROR:  lvl: error\n        a: 1");
  });

  await T("formatLogEntryText falls back to scanning values for a recognized level token when no level-shaped key exists", () => {
    eq(formatLogEntryText(JSON.stringify({ uwsgi_status: "200", note: "ERROR" })), 'ERROR:  uwsgi_status: 200\n        note: ERROR');
  });

  await T("formatLogEntryText never mangles URLs/paths in a field's value -- only JSON's own escaping is undone", () => {
    const text = JSON.stringify({ uwsgi_uri: "/api/v2/pipeline/341074", uwsgi_referer: "https://cembalo.dev.finmod.eu.scor.local/r/" });
    const out = formatLogEntryText(text);
    ok(out.includes("uwsgi_uri: /api/v2/pipeline/341074"), out);
    ok(out.includes("uwsgi_referer: https://cembalo.dev.finmod.eu.scor.local/r/"), out);
  });

  await T("formatLogEntryText stringifies a nested object/array value inline rather than recursing into it", () => {
    eq(formatLogEntryText(JSON.stringify({ a: "1", tags: ["x", "y"] })), 'INFO:  a: 1\n        tags: ["x","y"]');
  });

  await T("a log row's tooltip uses formatLogEntryText's output, not the raw row text, alongside the ISO timestamp", async () => {
    const p = [...panels.values()][0];
    await p.render();
    const firstRow = p.body.querySelector(".log-row");
    ok(firstRow, "at least one row rendered");
    // dataIndexAt(0), not page(0)[0] -- logs display newest-first by
    // default (this.reversed), so the first *rendered* row is the highest
    // data index, not the lowest.
    const dataIdx = p.dataIndexAt(0);
    const page = await p.page(Math.floor(dataIdx / PAGE));
    const row = page[dataIdx % PAGE];
    eq(firstRow.title, new Date(row.ts).toISOString() + "\n" + formatLogEntryText(row.text)
      + "\n(ctrl/cmd-click to select, shift-click to select a range, right-click for actions)");
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
    // Edit Docker Host runs an immediate live Refresh on open (see
    // enterDockerHostEditMode) -- mocked here since this test isn't about
    // that probe itself, just the form's fields/labels.
    const realPost = post;
    const realGet = get;
    post = async (path, body) => (path === "/docker/ps" ? { containers: [], services: [], log: [] } : realPost(path, body));
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      eq(currentDockerHost(), "ssh://u@h", "host resolved correctly (not truncated to 'ssh:')");
      eq($("btn-set").disabled, false, "New Docker Host always stays enabled");
      eq($("btn-edit-docker-host").disabled, false, "Edit Docker Host enabled once a daemon is being watched");
      eq($("btn-clear-sources").disabled, false, "Remove enabled once a daemon is being watched");
      await enterDockerHostEditMode(currentDockerHost() || "local");
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

  await T("Edit/Disconnect Docker Host are disabled when no daemon is being watched, New Docker Host stays enabled", () => {
    ok(!hasDockerDaemon(), "no docker:// source open in this suite's baseline state");
    eq($("btn-set").disabled, false, "New Docker Host stays enabled -- always opens a blank create form");
    eq($("btn-edit-docker-host").disabled, true, "nothing to edit yet");
    eq($("btn-clear-sources").disabled, true, "nothing to disconnect yet");
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
    // The live daemon still has both -- Edit Docker Host runs an immediate
    // live Refresh on open (see enterDockerHostEditMode), so the pre-fill
    // and the confirmed post-Refresh state should agree.
    post = async (path, body) => {
      if (path === "/docker/ps") {
        return { containers: [{ id: "c", name: "demo-c" }], services: [{ id: "s", name: "demo-svc" }], log: [] };
      }
      return realPost(path, body);
    };
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      await enterDockerHostEditMode(currentDockerHost() || "local");
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
      // opening the locked edit view already runs this live probe automatically
      await enterDockerHostEditMode(currentDockerHost() || "local");
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
      // enterDockerHostEditMode's automatic Refresh on open already runs the
      // live probe above.
      await enterDockerHostEditMode(currentDockerHost() || "local");
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
      await enterDockerHostEditMode(currentDockerHost() || "local"); // runs the live probe above immediately
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
      await enterDockerHostEditMode(currentDockerHost() || "local"); // auto-refreshes immediately, no manual Refresh click needed
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

  await T("New Docker Host (create mode) is never left showing edit-mode labels/locks", () => {
    $("btn-set").click();
    try {
      eq($("docker-host").disabled, false, "host unlocked");
      eq($("docker-ssh-key").disabled, false, "ssh key unlocked");
      eq($("docker-ssh-key-browse").disabled, false, "browse unlocked");
      eq($("btn-ps-refresh").textContent, "Fetch Sources", "Fetch Sources label restored");
      eq($("dlg-ok").textContent, "Connect Docker Host", "confirm label restored");
      eq($("dlg-set-title").textContent, "New Docker Host", "dialog re-titled for creating, not editing");
      eq($("docker-host-history-row").hidden, true, "Load Docker Host never shown in New Docker Host");
    } finally {
      dlg.close();
    }
  });

  await T("New Docker Host always opens in create mode, never edit mode, regardless of whether a daemon is connected (br-DHOST-001/BUG-0067)", () => {
    ok(!hasDockerDaemon(), "sanity: baseline has no docker daemon connected");
    eq(dockerDaemonEditMode, false, "sanity: not already in edit mode from a prior test");
    $("btn-set").click();
    try {
      eq(dockerDaemonEditMode, false, "edit mode never entered -- nothing to edit");
      eq($("dlg-set-title").textContent, "New Docker Host", "dialog opened in create mode");
    } finally {
      dlg.close();
    }
  });

  await T("Disconnect always clears a stale edit-mode lock, regardless of whether the dialog happens to be open (br-DHOST-001/BUG-0067)", async () => {
    // #dlg-set is a showModal() dialog -- the toolbar's Disconnect button is
    // structurally unreachable while it's open, so the realistic trigger is
    // always "closed, but still carrying edit mode's lock state from before
    // it was closed" (Cancel/OK don't reset it either -- only opening does).
    // This mirrors that: an earlier Edit Docker Host session, closed, then
    // the daemon it was editing gets disconnected.
    ok(!dlg.open, "sanity: dialog is not open, matching showModal()'s modal-blocks-toolbar reality");
    dockerDaemonEditMode = true;
    $("docker-host").disabled = true;
    $("docker-ssh-key").disabled = true;
    $("docker-ssh-key-browse").disabled = true;
    const fakeSrc = { id: "__disc_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    const realConfirm = window.confirm;
    const realPost = post;
    window.confirm = () => true;
    post = async (path, body) => (path === "/close" ? {} : realPost(path, body));
    try {
      await $("btn-clear-sources").onclick();
      eq(dockerDaemonEditMode, false, "edit-mode flag cleared even though the dialog was never open to trigger the old dlg.open-gated reset");
      eq($("docker-host").disabled, false, "host unlocked");
      eq($("docker-ssh-key").disabled, false, "ssh key unlocked");
      eq($("docker-ssh-key-browse").disabled, false, "browse unlocked");
    } finally {
      window.confirm = realConfirm;
      post = realPost;
      state.sources = state.sources.filter((s) => s.id !== "__disc_test");
      syncDockerDaemonButtons();
    }
  });

  await T("New Docker Host after a real Disconnect opens unlocked, with Load Docker Host never shown (reported regression)", async () => {
    // Unlike the synthetic test above (which pre-sets dockerDaemonEditMode
    // and the .disabled flags directly), this drives the actual sequence a
    // user hits: really connected to a remote host (enterDockerHostEditMode
    // locks the fields for real) -> real Disconnect -> reopen via the real
    // btn-set click. Originally reported as: after Disconnect, both Docker
    // host and SSH key stayed disabled on reopen whenever Load Docker Host
    // had a previously-used entry to show and the user didn't pick one --
    // New Docker Host now never shows that picker at all (Edit Docker Host's
    // job instead), but must still always unlock the fields regardless.
    const savedBefore = prefs.get("savedDockerDaemons", {});
    prefs.set("savedDockerDaemons", { ...savedBefore, "ssh://u@h": { lastUsed: Date.now(), ssh_key: "/path/to/key" } });
    const fakeSrc = { id: "__reconnect_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons();
    const realPost = post;
    const realGet = get;
    const realConfirm = window.confirm;
    post = async (path, body) =>
      path === "/docker/ps" ? { containers: [], services: [], log: [] } : path === "/close" ? {} : realPost(path, body);
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    window.confirm = () => true;
    try {
      // Really connect/lock the fields first, same as opening Edit Docker
      // Host on the currently-active host would.
      await enterDockerHostEditMode(currentDockerHost() || "local");
      eq($("docker-host").disabled, true, "sanity: locked while editing the live daemon");
      dlg.close();

      // Real Disconnect, through the actual button handler.
      await $("btn-clear-sources").onclick();

      // Reopen via the real New Docker Host button -- no daemon left, so
      // this must take the create-mode branch, not edit mode.
      $("btn-set").click();
      try {
        eq(dockerDaemonEditMode, false, "create mode, not edit mode -- nothing left to edit");
        eq($("docker-host-history-row").hidden, true, "New Docker Host never shows Load Docker Host, history or not");
        eq($("docker-host").disabled, false, "host stays editable");
        eq($("docker-ssh-key").disabled, false, "ssh key stays editable");
        eq($("docker-ssh-key-browse").disabled, false, "browse stays enabled");
      } finally {
        dlg.close();
      }
    } finally {
      post = realPost;
      get = realGet;
      window.confirm = realConfirm;
      prefs.set("savedDockerDaemons", savedBefore);
      dockerHostKeys.delete("ssh://u@h");
      state.sources = state.sources.filter((s) => s.id !== "__reconnect_test");
      syncDockerDaemonButtons();
    }
  });

  await T("Disconnect still unlocks the dialog for next open even if closing one of several sources fails (reported regression)", async () => {
    // Disconnect closes every open source with Promise.all(...post("/close"...))
    // -- a remote host is disconnected precisely because it's flaky, so a
    // single failing/timing-out close among several is a realistic real-
    // world trigger, not a contrived one. The reset (dockerDaemonEditMode
    // + unlocking host/ssh-key/browse) lived *after* that await, inside the
    // same try -- one rejected close skipped straight to the catch's alert()
    // and left the dialog locked for whatever opened next, contradicting
    // ui-DHOST-026's "unconditionally clears" claim.
    dockerDaemonEditMode = true;
    $("docker-host").disabled = true;
    $("docker-ssh-key").disabled = true;
    $("docker-ssh-key-browse").disabled = true;
    const srcA = { id: "__partial_a", path: "docker://ssh://u@h/container/a", kind: "log", live: true };
    const srcB = { id: "__partial_b", path: "docker://ssh://u@h/container/b", kind: "log", live: true };
    state.sources.push(srcA, srcB);
    syncDockerDaemonButtons();
    const realPost = post;
    const realConfirm = window.confirm;
    const realAlert = window.alert;
    window.confirm = () => true;
    window.alert = () => {};
    post = async (path, body) => {
      if (path === "/close" && body.id === "__partial_b") return Promise.reject(new Error("connection reset"));
      return path === "/close" ? {} : realPost(path, body);
    };
    try {
      await $("btn-clear-sources").onclick();
      eq(dockerDaemonEditMode, false, "cleared even though one close call rejected");
      eq($("docker-host").disabled, false, "host unlocked even though one close call rejected");
      eq($("docker-ssh-key").disabled, false, "ssh key unlocked even though one close call rejected");
      eq($("docker-ssh-key-browse").disabled, false, "browse unlocked even though one close call rejected");
    } finally {
      post = realPost;
      window.confirm = realConfirm;
      window.alert = realAlert;
      state.sources = state.sources.filter((s) => s.id !== "__partial_a" && s.id !== "__partial_b");
      syncDockerDaemonButtons();
    }
  });

  await T("Cancelling out of Edit Docker Host clears dockerDaemonEditMode, so it can't leak into a later stale-lock scenario", async () => {
    const fakeSrc = { id: "__cancel_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons();
    const realPost = post;
    const realGet = get;
    post = async (path, body) => (path === "/docker/ps" ? { containers: [], services: [], log: [] } : realPost(path, body));
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      await enterDockerHostEditMode(currentDockerHost() || "local");
      eq(dockerDaemonEditMode, true, "sanity: now in edit mode");
      $("dlg-cancel").onclick();
      eq(dockerDaemonEditMode, false, "cleared on cancel, not left stuck for whatever opens the dialog next");
    } finally {
      post = realPost;
      get = realGet;
      state.sources = state.sources.filter((s) => s.id !== "__cancel_test");
      syncDockerDaemonButtons();
      dockerHostKeys.delete("ssh://u@h");
      if (dlg.open) dlg.close();
    }
  });

  await T("Show activity stays enabled for the local daemon (empty host) without needing a fetch first", () => {
    $("btn-set").click();
    try {
      eq($("docker-host").value, "", "sanity: fresh create-mode dialog starts with an empty (local) host");
      eq($("activity-toggle").disabled, false, "empty host is a complete, valid target on its own -- no fetch needed to unlock");
    } finally {
      dlg.close();
    }
  });

  await T("Show activity is disabled for a remote host until a Fetch attempt actually completes (br-DHOST-001/BUG-0067)", async () => {
    $("btn-set").click();
    try {
      $("docker-host").value = "u@h";
      $("docker-host").dispatchEvent(new Event("input"));
      eq($("activity-toggle").disabled, true, "nothing to show for an untested remote target yet");
      eq($("activity-toggle").checked, false, "force-unchecked when locked out");

      const realPost = post;
      post = async (path, body) =>
        path === "/docker/ps" ? Promise.reject(Object.assign(new Error("boom"), { serverResponded: false })) : realPost(path, body);
      try {
        await listContainers();
      } finally {
        post = realPost;
      }
      // Unlocked even though the attempt failed -- the activity log of a
      // failed attempt is exactly what Show activity is for, arguably more
      // than a successful one.
      eq($("activity-toggle").disabled, false, "unlocked once the attempt completes, success or not");
    } finally {
      dockerHostKeys.delete("ssh://u@h");
      dlg.close();
    }
  });

  await T("New Docker Host stays enabled regardless of whether a daemon is currently being watched -- always opens a blank create form, never edit mode", () => {
    ok(!hasDockerDaemon(), "no docker:// source open in this suite's baseline state");
    eq($("btn-set").disabled, false, "enabled -- nothing set yet");
    const fakeSrc = { id: "__setbtn_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons(); // a real app calls this via refreshAll() whenever state.sources changes
    try {
      eq($("btn-set").disabled, false, "still enabled once a daemon is already being watched -- New Docker Host never depends on it");
    } finally {
      state.sources = state.sources.filter((s) => s.id !== "__setbtn_test");
      syncDockerDaemonButtons();
      eq($("btn-set").disabled, false, "stays enabled once that daemon is gone too");
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
      ok(basename(sample.path).includes("cttc-e2e-sample.cttc-metric"), "source path reflects the loaded file");
      const groups = sampleFileGroups();
      eq(groups.length, 1, "one sample file group");
      ok(groups[0].ids.size >= 2, "group covers its sources");
      eq(isSampleHidden(sample.id), false, "the only loaded file becomes the active view (refreshAll's self-heal)");
      eq(state.activeSamplePath, sample.path, "sanity: refreshAll picked this file as the active view");
      state.activeSamplePath = "/some/other/path";
      eq(isSampleHidden(sample.id), true, "hidden once a *different* path is the active view");
      state.activeSamplePath = sample.path;
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
      ok($("app-status-bar-text").textContent.includes("metrics saved"), $("app-status-bar-text").textContent);
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
      ok($("app-status-bar-text").textContent.includes("canceled"), $("app-status-bar-text").textContent);
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

  await T("Open Recording is deduped like Load Data -- re-opening an already-open file is a no-op, not a pile of duplicate sources", async () => {
    // openRecording() used to call window.cttc.pickFiles directly with no
    // dedup at all -- every click re-uploaded and opened a brand-new,
    // independent set of sources for the same file, regardless of whether
    // it was already open (reported: "keeps piling up every time I open
    // it (containers repeat on the top above graph)").
    const t0 = R.min_ts;
    const res = await fetch(`${API}/sample/record`, {
      method: "POST", body: new Uint8Array(0),
      headers: { "X-CTTC-From": String(t0), "X-CTTC-To": String(t0 + 60000) },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const realPath = "/tmp/cttc-e2e-open-recording-dedup.cttc-record";
    await window.cttc.writeBinaryFile(realPath, bytes);

    const realPick = pickRecordingFiles;
    pickRecordingFiles = async () => [realPath];
    try {
      await openRecording();
      const opened = state.sources.filter((s) => s.path === `upload://${realPath.split("/").pop()}`);
      ok(opened.length > 0, "first open actually opened something");
      await openRecording(); // re-open the exact same file
      const stillOpen = state.sources.filter((s) => s.path === `upload://${realPath.split("/").pop()}`);
      eq(stillOpen.length, opened.length, "re-opening the same file changed nothing -- no duplicate sources");
    } finally {
      pickRecordingFiles = realPick;
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

  await T("Recording N sections then Stop while paused writes exactly N segments, not N+1", async () => {
    const realScratch = recordingScratchPath,
      realPick = pickRecordingSavePath,
      realRead = readRecordingBytes,
      realWrite = writeRecordingBytes;
    const store = {};
    const scratchPath = "/fake/scratch-n-sections.cttc-record";
    recordingScratchPath = async () => scratchPath;
    pickRecordingSavePath = async () => "/fake/e2e-n-sections.cttc-record";
    readRecordingBytes = async (p) => {
      if (!(p in store)) throw new Error("no such file");
      return store[p];
    };
    writeRecordingBytes = async (p, bytes) => { store[p] = bytes; };
    try {
      if (recording.status !== "idle") await stopRecording(); // clean baseline
      const N = 3;
      for (let i = 0; i < N; i++) {
        await startRecording(); // first iteration starts, rest resume
        await pauseRecording();
      }
      eq(recording.status, "paused", "ends paused -- Stop must not add a further segment");
      await stopRecording(); // pressed once, while already paused
      eq(recording.status, "idle");

      const finalBytes = store["/fake/e2e-n-sections.cttc-record"];
      const realPath = "/tmp/cttc-e2e-n-sections.cttc-record";
      await window.cttc.writeBinaryFile(realPath, finalBytes);
      const openRes = await post("/open", { files: [{ path: realPath }] });
      eq(openRes.needs_selection[0].segments.length, N, `expected exactly ${N} segments, one per Start/Pause cycle`);
    } finally {
      recordingScratchPath = realScratch;
      pickRecordingSavePath = realPick;
      readRecordingBytes = realRead;
      writeRecordingBytes = realWrite;
    }
  });

  await T("A brand-new recording does not inherit a previous recording's leftover segments from the shared scratch path (BUG-0076)", async () => {
    const realScratch = recordingScratchPath,
      realPick = pickRecordingSavePath,
      realRead = readRecordingBytes,
      realWrite = writeRecordingBytes;
    const store = {};
    // Both recordings reuse the *same* scratch path, matching real
    // production behavior (main.js's RECORDING_SCRATCH_PATH is one fixed
    // path for every recording, never re-chosen per session).
    const scratchPath = "/fake/shared-scratch.cttc-record";
    recordingScratchPath = async () => scratchPath;
    readRecordingBytes = async (p) => {
      if (!(p in store)) throw new Error("no such file");
      return store[p];
    };
    writeRecordingBytes = async (p, bytes) => { store[p] = bytes; };
    try {
      if (recording.status !== "idle") await stopRecording(); // clean baseline

      // First, complete and save a whole recording.
      pickRecordingSavePath = async () => "/fake/e2e-first-recording.cttc-record";
      await startRecording();
      await pauseRecording();
      await stopRecording();
      eq(recording.status, "idle");
      ok(store["/fake/e2e-first-recording.cttc-record"], "first recording saved");

      // Second, completely independent recording -- the scratch path on
      // disk still holds the first recording's finished bytes at this
      // point (stopRecording never clears it).
      pickRecordingSavePath = async () => "/fake/e2e-second-recording.cttc-record";
      await startRecording();
      await pauseRecording();
      await stopRecording();
      eq(recording.status, "idle");
      const secondBytes = store["/fake/e2e-second-recording.cttc-record"];
      ok(secondBytes, "second recording saved");

      const realPath = "/tmp/cttc-e2e-second-recording.cttc-record";
      await window.cttc.writeBinaryFile(realPath, secondBytes);
      const openRes = await post("/open", { files: [{ path: realPath }] });
      const segCount = openRes.needs_selection?.[0]?.segments?.length ?? 1;
      ok(segCount === 1, `expected exactly 1 segment in the second recording, got ${segCount}: ${JSON.stringify(openRes.needs_selection)}`);
      for (const id of openRes.opened) await post("/close", { id });
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
      ok($("app-status-bar-text").textContent.includes("interrupted"), $("app-status-bar-text").textContent);
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
      ok($("app-status-bar-text").textContent.includes("wasn't saved"), $("app-status-bar-text").textContent);
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

    // BUG-0077: switching segments used to leave the chart's view window
    // wherever it was (segment 0's own range), so segment 1's data --
    // genuinely loaded, per the assertions above -- fell entirely outside
    // what was actually drawn and looked empty.
    const seg1Starts = state.sources
      .filter((s) => activeRecordSections.openedIds.includes(s.id) && s.min_ts != null)
      .map((s) => s.min_ts);
    ok(seg1Starts.length > 0, "segment 1 has real, datable sources to check the view against");
    const seg1MinTs = Math.min(...seg1Starts);
    ok(
      state.view.t0 <= seg1MinTs && state.view.t1 >= seg1MinTs,
      `view must re-center on segment 1's own data (min_ts=${seg1MinTs}) after switching, not stay on segment 0's -- got view [${state.view.t0}, ${state.view.t1}]`
    );

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

  await T("The 'now' line does not advance/draw once a metric/recording is the active view (BUG-0078)", async () => {
    // Spy on the canvas 2D stroke calls to detect whether drawVerticals'
    // "now" marker (strokeStyle === nowLineColor) actually gets painted --
    // it's otherwise only observable as pixels, not DOM state.
    const realStroke = CanvasRenderingContext2D.prototype.stroke;
    const strokeStyles = [];
    CanvasRenderingContext2D.prototype.stroke = function (...args) {
      strokeStyles.push(this.strokeStyle);
      return realStroke.apply(this, args);
    };
    const realView = state.view;
    try {
      // A window guaranteed to straddle "now" regardless of where the
      // demo data's own range happens to sit relative to it.
      setView(Date.now() - 5 * 60000, Date.now() + 5 * 60000, { broadcast: false });

      eq(state.liveHidden, false, "starts in Live -- baseline for this test");
      strokeStyles.length = 0;
      drawAll();
      ok(strokeStyles.includes(nowLineColor), "now line drawn while Live is the active view (sanity check)");

      const res = await fetch(
        `${API}/files/download?from=${R.min_ts}&to=${R.max_ts}&include_host=0`,
        { headers: authHeaders() }
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      const realPath = "/tmp/cttc-e2e-now-line-hidden.cttc-metric";
      await window.cttc.writeBinaryFile(realPath, bytes);
      const r = await uploadAndResolveSegment(realPath);
      try {
        ok(r.opened.length >= 1, "sample opened");
        await refreshAll();
        eq(state.liveHidden, true, "now viewing a loaded metric");
        setView(Date.now() - 5 * 60000, Date.now() + 5 * 60000, { broadcast: false });

        strokeStyles.length = 0;
        drawAll();
        ok(
          !strokeStyles.includes(nowLineColor),
          "now line must not be drawn while a metric/recording is the active view, even though the window still straddles 'now'"
        );
      } finally {
        for (const sid of r.opened) await post("/close", { id: sid });
        await refreshAll();
      }
    } finally {
      CanvasRenderingContext2D.prototype.stroke = realStroke;
      if (realView) setView(realView.t0, realView.t1, { broadcast: false });
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

  /* ── export metrics: the active file's stats/logs as text or JSON ───────── */

  // Shared by every export-metrics test below: uploads the demo range as a
  // real .cttc-metric and resolves it into the active view, same pattern as
  // the metric(s)-dropdown/Back-to-live tests just above -- returns the
  // opened source ids so the caller's own finally can close them.
  async function loadMetricsFileForExportTest(name) {
    const res = await fetch(`${API}/files/download?from=${R.min_ts}&to=${R.max_ts}&include_host=0`, { headers: authHeaders() });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const realPath = `/tmp/cttc-e2e-${name}.cttc-metric`;
    await window.cttc.writeBinaryFile(realPath, bytes);
    const r = await uploadAndResolveSegment(realPath);
    await refreshAll();
    return r.opened;
  }

  await T("the export-metrics button is hidden while Live, shown once a metrics file is loaded", async () => {
    eq($("btn-export-metrics").hidden, true, "sanity: hidden in live mode");
    const opened = await loadMetricsFileForExportTest("visibility");
    try {
      eq($("btn-export-metrics").hidden, false, "shown once a metrics file is the active view");
    } finally {
      for (const sid of opened) await post("/close", { id: sid });
      await refreshAll();
      eq($("btn-export-metrics").hidden, true, "hidden again once back in live mode");
    }
  });

  await T("the export-metrics dialog: Next is gated on at least one checkbox, and Back returns to step 1", async () => {
    const opened = await loadMetricsFileForExportTest("flow");
    try {
      $("btn-export-metrics").click();
      try {
        eq(dlgExportMetrics.open, true, "dialog open");
        eq($("export-metrics-step1").hidden, false, "starts on step 1");
        eq($("export-metrics-step2").hidden, true);
        eq($("dlg-export-metrics-next").disabled, false, "both stats and logs checked by default");

        $("export-metrics-stats").checked = false;
        $("export-metrics-stats").dispatchEvent(new Event("change"));
        $("export-metrics-logs").checked = false;
        $("export-metrics-logs").dispatchEvent(new Event("change"));
        eq($("dlg-export-metrics-next").disabled, true, "Next disabled with nothing checked");

        $("export-metrics-logs").checked = true;
        $("export-metrics-logs").dispatchEvent(new Event("change"));
        eq($("dlg-export-metrics-next").disabled, false, "Next enabled again once logs alone is checked");

        // stats stays unchecked from above -- the granularity choice (only
        // meaningful for stats) must not appear in step 2.
        $("dlg-export-metrics-next").click();
        eq($("export-metrics-step1").hidden, true);
        eq($("export-metrics-step2").hidden, false);
        eq($("export-metrics-granularity-row").hidden, true, "no granularity choice when stats isn't included");

        $("dlg-export-metrics-back").click();
        eq($("export-metrics-step1").hidden, false, "Back returns to step 1");
        eq($("export-metrics-step2").hidden, true);

        $("export-metrics-stats").checked = true;
        $("export-metrics-stats").dispatchEvent(new Event("change"));
        $("dlg-export-metrics-next").click();
        eq($("export-metrics-granularity-row").hidden, false, "granularity choice shown once stats is included");
      } finally {
        dlgExportMetrics.close();
      }
    } finally {
      for (const sid of opened) await post("/close", { id: sid });
      await refreshAll();
    }
  });

  await T("the export-metrics dialog's format/granularity toggles swap which button is primary", async () => {
    const opened = await loadMetricsFileForExportTest("toggles");
    try {
      $("btn-export-metrics").click();
      try {
        $("dlg-export-metrics-next").click();
        eq($("export-metrics-format-text").classList.contains("primary"), true, "text is the default format");
        $("export-metrics-format-json").click();
        eq($("export-metrics-format-json").classList.contains("primary"), true);
        eq($("export-metrics-format-text").classList.contains("primary"), false);
        eq(exportMetricsFormat, "json");

        eq($("export-metrics-granularity-summary").classList.contains("primary"), true, "summary is the default granularity");
        $("export-metrics-granularity-full").click();
        eq($("export-metrics-granularity-full").classList.contains("primary"), true);
        eq($("export-metrics-granularity-summary").classList.contains("primary"), false);
        eq(exportMetricsGranularity, "full");
      } finally {
        dlgExportMetrics.close();
        exportMetricsFormat = "text";
        exportMetricsGranularity = "summary";
      }
    } finally {
      for (const sid of opened) await post("/close", { id: sid });
      await refreshAll();
    }
  });

  // window.cttc is a contextBridge-exposed object -- read-only in the main
  // world by design (context isolation), so its methods can't be monkey-
  // patched the way plain app.js functions elsewhere in this file are.
  // Same reasoning as snapshotToText's own test (below, unaffected by this
  // change): exercise the formatting/data functions directly instead of
  // clicking the real Export/Save button, which would need a real native
  // save dialog. An earlier version of these three tests tried mocking
  // window.cttc.saveText/saveJson directly -- the resulting "Cannot assign
  // to read only property" throw happened *before* each test's own
  // `finally`, leaking that test's uploaded source into every test that
  // ran after it and cascading into unrelated failures elsewhere in the
  // suite ("too many values to unpack").
  await T("exportMetricsToText renders formatted content, including the stats field explanations", () => {
    const text = exportMetricsToText({
      generated_at: "2026-01-01T00:00:00.000Z",
      from: R.min_ts,
      to: R.max_ts,
      stats: {
        granularity: "summary",
        services: [{ name: "api", host: false, sid: "s1", count: 3, cpu: { min: 1, avg: 2, max: 3 }, mem: { min: 4, avg: 5, max: 6 }, mem_bytes: null, net: { min: 0, avg: 0, max: 0 } }],
      },
      logs: [{ source: "api", path: "api.log", rows: [{ ts: R.min_ts, text: "hello" }] }],
    });
    ok(text.includes("Metrics export @ 2026-01-01T00:00:00.000Z"), text);
    ok(text.includes("== Stats (summary) =="), text);
    ok(text.includes("cpu: percent of one CPU core in use"), "stats field explanation present verbatim");
    ok(text.includes("mem: percent of the container's own memory limit"), text);
    ok(text.includes("[api]"), text);
    ok(text.includes("cpu: min 1.0%  avg 2.0%  max 3.0%  (3 samples)"), text);
    ok(text.includes("== Logs =="), text);
    ok(text.includes("hello"), text);
  });

  await T("exportMetricsToText's full-time-series branch lists every sample instead of a summary", () => {
    const text = exportMetricsToText({
      generated_at: "2026-01-01T00:00:00.000Z", from: R.min_ts, to: R.max_ts,
      stats: { granularity: "full", services: [{ name: "api", host: false, sid: "s1", samples: [{ ts: R.min_ts, cpu: 10, mem: 20, mem_bytes: 1000, net: 5 }] }] },
    });
    ok(text.includes("== Stats (full time series) =="), text);
    ok(text.includes("cpu=10  mem=20  mem_bytes=1000  net=5"), text);
  });

  await T("gatherExportMetricsData scopes stats/logs to the active file's own range and sources", async () => {
    const opened = await loadMetricsFileForExportTest("gather");
    try {
      const range = activeViewRange();
      const data = await gatherExportMetricsData(true, true);
      eq(data.from, range.min_ts);
      eq(data.to, range.max_ts);
      eq(data.stats.granularity, "summary");
      ok(data.stats.services.length >= 1, "at least one service's stats included");
      ok(data.stats.services.every((s) => !isSampleHidden(s.sid) && !isLiveDataHidden(s.sid)), "no stats from another loaded file or Live");
      ok(Array.isArray(data.logs) && data.logs.length >= 1, "at least one log source included");
      ok(data.logs.every((l) => l.rows.every((r) => r.ts >= range.min_ts && r.ts <= range.max_ts)), "every log row within the active file's range");

      const statsOnly = await gatherExportMetricsData(true, false);
      ok(statsOnly.stats && !statsOnly.logs, "logs omitted when not requested");
      const logsOnly = await gatherExportMetricsData(false, true);
      ok(!logsOnly.stats && logsOnly.logs, "stats omitted when not requested");
    } finally {
      for (const sid of opened) await post("/close", { id: sid });
      await refreshAll();
    }
  });

  await T("Cancel closes the export-metrics dialog", async () => {
    const opened = await loadMetricsFileForExportTest("cancel");
    try {
      $("btn-export-metrics").click();
      eq(dlgExportMetrics.open, true, "sanity: dialog open");
      $("dlg-export-metrics-cancel").click();
      eq(dlgExportMetrics.open, false, "dialog closed");
    } finally {
      for (const sid of opened) await post("/close", { id: sid });
      await refreshAll();
    }
  });

  /* ── File menu: Load Data…/Export Metrics… ───────────────────────────────
     Both entries duplicate an existing action-bar/toolbar button rather
     than reimplementing it (#btn-load-sample / #btn-export-metrics), so
     coverage here is about the menu's own wiring -- dispatch and the cloned
     icon/disabled-state mirroring -- not the underlying flows themselves,
     which are already covered by the tests above/around btn-load-sample. */

  await T("File > Load Data…/Opened Data…/Export Metrics… carry an icon cloned from their action-bar/toolbar counterpart", () => {
    ok($("menu-load-metrics").querySelector(".ctxmenu-icon svg"), "Load Data… has a cloned icon");
    ok($("menu-opened-data").querySelector(".ctxmenu-icon svg"), "Opened Data… has a cloned icon");
    ok($("menu-export-metrics").querySelector(".ctxmenu-icon svg"), "Export Metrics… has a cloned icon");
  });

  await T("File > Export Metrics… is disabled while Live, enabled once a metrics file is loaded", async () => {
    eq($("menu-export-metrics").disabled, true, "sanity: disabled in live mode");
    const opened = await loadMetricsFileForExportTest("menu-visibility");
    try {
      eq($("menu-export-metrics").disabled, false, "enabled once a metrics file is the active view");
    } finally {
      for (const sid of opened) await post("/close", { id: sid });
      await refreshAll();
      eq($("menu-export-metrics").disabled, true, "disabled again once back in live mode");
    }
  });

  await T("File > Export Metrics… opens the same dialog as the toolbar button", async () => {
    const opened = await loadMetricsFileForExportTest("menu-open-dialog");
    try {
      $("menu-export-metrics").click();
      try {
        eq(dlgExportMetrics.open, true, "dialog opened via the File menu entry");
      } finally {
        dlgExportMetrics.close();
      }
    } finally {
      for (const sid of opened) await post("/close", { id: sid });
      await refreshAll();
    }
  });

  await T("File > Load Data… reuses the sidebar's Load Data flow", async () => {
    const out = "/tmp/cttc-e2e-menu-load.cttc-metric";
    await post("/sample/export", { path: out, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    const realPick = pickAnalysisFiles;
    try {
      pickAnalysisFiles = async () => [out];
      $("menu-load-metrics").click();
      await sleep(200);
      const path = `upload://${basename(out)}`;
      ok(sampleFileGroups().find((g) => g.path === path), "file opened via the File menu's Load Data… entry");
      eq(state.activeSamplePath, path, "became the active view");
    } finally {
      pickAnalysisFiles = realPick;
      for (const s of state.sources.filter((s) => s.path === `upload://${basename(out)}`)) {
        await post("/close", { id: s.id });
      }
      await refreshAll();
    }
  });

  /* ── Opened Data: switch among currently open files (#btn-opened-data in
     the sidebar, #menu-opened-data in the File menu) ─────────────────────── */

  // Exports and loads two distinct sample files, leaving both open -- B
  // (loaded last) becomes the active view, same as Load Data's own
  // behavior -- returns their upload:// paths for assertions/cleanup.
  async function openTwoSamplesForOpenedDataTest(name) {
    const outA = `/tmp/cttc-e2e-opened-data-${name}-a.cttc-metric`;
    const outB = `/tmp/cttc-e2e-opened-data-${name}-b.cttc-metric`;
    await post("/sample/export", { path: outA, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    await post("/sample/export", { path: outB, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    const realPick = pickAnalysisFiles;
    try {
      pickAnalysisFiles = async () => [outA];
      await $("btn-load-sample").onclick();
      pickAnalysisFiles = async () => [outB];
      await $("btn-load-sample").onclick();
    } finally {
      pickAnalysisFiles = realPick;
    }
    return { pathA: `upload://${basename(outA)}`, pathB: `upload://${basename(outB)}` };
  }
  async function closeOpenedDataTestFiles(pathA, pathB) {
    for (const s of state.sources.filter((s) => s.path === pathA || s.path === pathB)) {
      await post("/close", { id: s.id });
    }
    await refreshAll();
  }

  // The two tests below share one upload of two files each (rather than
  // each test uploading its own pair) -- e2e uploads are the slow part of
  // this suite and the harness enforces a fixed wall-clock budget across
  // the whole spec (see main.js's 120s "global timeout"), so duplicating
  // that setup per assertion isn't free the way it would be in a unit test.

  await T("Opened Data lists every currently open file, pre-selects the active view, and Open switches to the selection", async () => {
    const { pathA, pathB } = await openTwoSamplesForOpenedDataTest("open-flow");
    try {
      eq(state.activeSamplePath, pathB, "sanity: B is the active view before switching");
      $("btn-opened-data").click();
      eq(dlgOpenedData.open, true, "dialog open");
      const values = [...$("opened-data-select").options].map((o) => o.value);
      ok(values.includes(pathA) && values.includes(pathB), "both open files listed");
      eq($("opened-data-select").value, pathB, "pre-selects the active view (B, opened last)");
      eq($("dlg-opened-data-open").disabled, false, "Open enabled once a file is open");

      $("opened-data-select").value = pathA;
      $("dlg-opened-data-open").click();
      eq(dlgOpenedData.open, false, "dialog closed after Open");
      eq(state.activeSamplePath, pathA, "switched to A");
    } finally {
      if (dlgOpenedData.open) dlgOpenedData.close();
      await closeOpenedDataTestFiles(pathA, pathB);
    }
  });

  await T("Cancel closes Opened Data without switching, and double-clicking the select opens the selection directly", async () => {
    const { pathA, pathB } = await openTwoSamplesForOpenedDataTest("dblclick-cancel");
    try {
      $("btn-opened-data").click();
      $("opened-data-select").value = pathA;
      $("dlg-opened-data-cancel").click();
      eq(dlgOpenedData.open, false, "dialog closed after Cancel");
      eq(state.activeSamplePath, pathB, "still on B -- Cancel didn't switch");

      $("btn-opened-data").click();
      $("opened-data-select").value = pathA;
      $("opened-data-select").dispatchEvent(new Event("dblclick"));
      eq(dlgOpenedData.open, false, "dialog closed after double-click");
      eq(state.activeSamplePath, pathA, "switched to A via double-click");
    } finally {
      if (dlgOpenedData.open) dlgOpenedData.close();
      await closeOpenedDataTestFiles(pathA, pathB);
    }
  });

  await T("Opened Data shows a disabled placeholder when nothing is open", () => {
    const realGroups = sampleFileGroups;
    try {
      sampleFileGroups = () => [];
      populateOpenedDataSelect();
      eq($("opened-data-select").disabled, true, "select disabled with nothing open");
      eq($("dlg-opened-data-open").disabled, true, "Open disabled with nothing open");
      eq($("opened-data-select").options.length, 1, "one placeholder option");
      eq($("opened-data-select").options[0].disabled, true, "placeholder itself isn't pickable");
    } finally {
      sampleFileGroups = realGroups;
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
      await until(() => $("app-status-bar-text").textContent.includes("/tmp/x.zip"), "status reflects the result");
      ok($("app-status-bar-text").textContent.includes("erased"));
    } finally {
      shipLogsViaMain = real;
    }
  });

  await T("ship-logs reports a cancel without claiming success", async () => {
    const real = shipLogsViaMain;
    shipLogsViaMain = async () => ({ canceled: true });
    try {
      $("btn-ship-logs").click();
      await until(() => $("app-status-bar-text").textContent.includes("canceled"), "status reflects the cancel");
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
      ok($("app-status-bar-text").textContent.includes("threshold"), "status explains why");
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
      ok($("app-status-bar-text").textContent.includes("invalid regex"), "status explains why");
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
      ok(
        $("server-status-btn").title.endsWith("Switch gateway…") && !$("server-status-btn").title.includes("boom"),
        "pill tooltip stays location + generic action text, no error text"
      );
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

  await T("gateway dropdown separates each entry with a divider, one fewer than the row count", async () => {
    $("server-status-btn").click();
    await sleep(50);
    try {
      const items = $("gateway-dropdown").querySelectorAll(".gateway-item");
      const seps = $("gateway-dropdown").querySelectorAll(".gateway-item-sep");
      eq(seps.length, Math.max(0, items.length - 1), "one separator between each pair of entries, none trailing");
    } finally {
      document.body.click();
    }
  });

  await T("hovering the Gateway pill shows nothing anymore", async () => {
    mouse($("server-status"), "mouseenter", 5);
    await sleep(20);
    try {
      ok($("connection-info-popup").hidden, "no popup on hover");
    } finally {
      mouse($("server-status"), "mouseleave", 5);
    }
  });

  await T("right-clicking the Gateway pill opens New/Edit/Uninstall Gateway plus Current Status, separated by a divider", async () => {
    mouse($("server-status"), "contextmenu", 5);
    try {
      ok($("connection-info-popup").hidden, "info popup not shown just from opening the menu");
      const menu = document.getElementById("ctxmenu");
      ok(menu, "actions menu open");
      const buttons = [...menu.querySelectorAll("button")];
      const labels = buttons.map((b) => b.textContent);
      ok(labels.some((l) => l.includes("New Gateway")), labels.join(", "));
      ok(labels.some((l) => l === "Edit Gateway"), labels.join(", "));
      ok(labels.some((l) => l.includes("Uninstall Gateway")), labels.join(", "));
      ok(labels.some((l) => l === "Current Status"), labels.join(", "));
      ok(buttons.every((b) => b.querySelector(".ctxmenu-icon svg")), "every entry has an icon to the left of its label");
      ok(buttons.every((b) => !b.disabled), "the Gateway pill's action entries are never gated, mirroring their always-enabled sidebar buttons");
      const statusBtn = buttons.find((b) => b.textContent === "Current Status");
      ok(statusBtn.previousElementSibling?.classList.contains("ctxmenu-sep"), "Current Status is preceded by a divider, separating it from the action entries");
    } finally {
      document.body.click(); // closes the ctxmenu synchronously
      if (dlgGatewaySetup.open) dlgGatewaySetup.close();
    }
  });

  await T("clicking Current Status on the Gateway pill's right-click menu shows the connection info above the button", async () => {
    mouse($("server-status"), "contextmenu", 5);
    const menu = document.getElementById("ctxmenu");
    [...menu.querySelectorAll("button")].find((b) => b.textContent === "Current Status").click();
    await sleep(20); // loadConnectionInfo() is awaited before the popup renders
    try {
      ok(!$("connection-info-popup").hidden, "popup shown after clicking Current Status");
      const text = $("connection-info-popup").textContent;
      ok(text.includes("Connection"), `Connection row present: ${text}`);
      const popupRect = $("connection-info-popup").getBoundingClientRect();
      const btnRect = $("server-status-btn").getBoundingClientRect();
      ok(popupRect.bottom <= btnRect.top, `popup (bottom ${popupRect.bottom}) sits above the button (top ${btnRect.top})`);
    } finally {
      document.body.click();
      ok($("connection-info-popup").hidden, "clicking outside closes the popup");
    }
  });

  /* ── Docker Host pill: Current Status, right-click actions, click separators ── */

  await T("hovering the Docker Host pill shows nothing anymore", () => {
    mouse($("docker-host-status"), "mouseenter", 5);
    try {
      ok($("docker-host-info-popup").hidden, "no popup on hover");
    } finally {
      mouse($("docker-host-status"), "mouseleave", 5);
    }
  });

  const openDockerHostCurrentStatus = () => {
    mouse($("docker-host-status"), "contextmenu", 5);
    const menu = document.getElementById("ctxmenu");
    [...menu.querySelectorAll("button")].find((b) => b.textContent === "Current Status").click();
  };

  await T("Current Status on the Docker Host pill shows 'not connected' when nothing is watched", async () => {
    ok(!hasDockerDaemon(), "sanity: nothing connected in this suite's baseline state");
    openDockerHostCurrentStatus();
    await sleep(0); // the outside-click listener is registered via setTimeout(0) to dodge the same-click race (see showDockerHostStatus)
    try {
      ok(!$("docker-host-info-popup").hidden, "popup shown after clicking Current Status");
      ok($("docker-host-info-popup").textContent.includes("not connected"), $("docker-host-info-popup").textContent);
      const popupRect = $("docker-host-info-popup").getBoundingClientRect();
      const btnRect = $("docker-host-status-btn").getBoundingClientRect();
      ok(popupRect.bottom <= btnRect.top, `popup (bottom ${popupRect.bottom}) sits above the button (top ${btnRect.top})`);
    } finally {
      document.body.click();
      ok($("docker-host-info-popup").hidden, "clicking outside closes the popup");
    }
  });

  await T("Current Status on the Docker Host pill shows SSH connection/key and which transforms are on", () => {
    const saved = prefs.get("savedDockerDaemons", {});
    prefs.set("savedDockerDaemons", { ...saved, "ssh://u@h": { ssh_key: "/path/to/key", transforms: ["json_message"], lastUsed: Date.now() } });
    const fakeSrc = { id: "__hover_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons();
    try {
      openDockerHostCurrentStatus();
      const text = $("docker-host-info-popup").textContent;
      ok(text.includes("SSH Connection") && text.includes("u@h"), text);
      ok(text.includes("SSH Key") && text.includes("/path/to/key"), text);
      ok(text.includes("drop healthchecks") && text.includes("False"), text);
      ok(text.includes("json message") && text.includes("True"), text);
      ok(text.includes("parse level") && text.includes("False"), text);
    } finally {
      document.body.click();
      state.sources = state.sources.filter((s) => s.id !== "__hover_test");
      syncDockerDaemonButtons();
      prefs.set("savedDockerDaemons", saved);
    }
  });

  await T("Current Status on the Docker Host pill shows '---' for an unset SSH key", () => {
    const saved = prefs.get("savedDockerDaemons", {});
    prefs.set("savedDockerDaemons", { ...saved, local: { transforms: [], lastUsed: Date.now() } });
    const fakeSrc = { id: "__hover_local_test", path: "docker://local/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons();
    try {
      openDockerHostCurrentStatus();
      const text = $("docker-host-info-popup").textContent;
      ok(text.includes("SSH Connection") && text.includes("localhost"), text);
      ok(text.includes("SSH Key") && text.includes("---"), text);
    } finally {
      document.body.click();
      state.sources = state.sources.filter((s) => s.id !== "__hover_local_test");
      syncDockerDaemonButtons();
      prefs.set("savedDockerDaemons", saved);
    }
  });

  await T("right-clicking the Docker Host pill opens New/Edit/Remove plus Current Status, separated by a divider; Edit/Remove mirror the sidebar's disabled state", async () => {
    ok(!hasDockerDaemon(), "sanity: nothing connected in this suite's baseline state");
    // Forced empty rather than assumed -- by this point in the suite other
    // tests may have legitimately left real saved hosts in the catalog
    // (Set/Update Docker Host persists on a successful connect), so an
    // un-isolated "sanity: nothing saved" assumption here would be flaky.
    const saved = prefs.get("savedDockerDaemons", {});
    prefs.set("savedDockerDaemons", {});
    syncDockerDaemonButtons();
    try {
      ok($("btn-edit-docker-host").disabled, "sanity: sidebar's own Edit Docker Host is disabled with nothing connected");
      ok($("btn-remove-docker-daemon").disabled, "sanity: sidebar's own Remove Docker Host is disabled with no saved hosts");
      mouse($("docker-host-status"), "contextmenu", 5);
      try {
        const menu = document.getElementById("ctxmenu");
        ok(menu, "actions menu open");
        const buttons = [...menu.querySelectorAll("button")];
        const labels = buttons.map((b) => b.textContent);
        ok(labels.some((l) => l.includes("New Docker Host")), labels.join(", "));
        ok(labels.some((l) => l === "Edit Docker Host"), labels.join(", "));
        ok(labels.some((l) => l.includes("Remove Docker Host")), labels.join(", "));
        ok(labels.some((l) => l === "Current Status"), labels.join(", "));
        ok(buttons.every((b) => b.querySelector(".ctxmenu-icon svg")), "every entry has an icon to the left of its label");
        const statusBtn = buttons.find((b) => b.textContent === "Current Status");
        ok(statusBtn.previousElementSibling?.classList.contains("ctxmenu-sep"), "Current Status is preceded by a divider, separating it from the action entries");
        const editBtn = buttons.find((b) => b.textContent === "Edit Docker Host");
        const removeBtn = buttons.find((b) => b.textContent.includes("Remove Docker Host"));
        ok(editBtn.disabled, "Edit Docker Host disabled in the menu, mirroring its sidebar button");
        ok(removeBtn.disabled, "Remove Docker Host disabled in the menu, mirroring its sidebar button");
        editBtn.click();
        eq(dlg.open, false, "disabled -- clicking it does nothing, nothing connected to edit");
      } finally {
        document.body.click();
        if (dlg.open) dlg.close();
      }
    } finally {
      prefs.set("savedDockerDaemons", saved);
      syncDockerDaemonButtons();
    }
  });

  await T("right-clicking the Docker Host pill's Edit Docker Host opens edit mode when a daemon is connected", async () => {
    const fakeSrc = { id: "__ctx_edit_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons();
    const realPost = post;
    const realGet = get;
    post = async (path, body) => (path === "/docker/ps" ? { containers: [], services: [], log: [] } : realPost(path, body));
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      mouse($("docker-host-status"), "contextmenu", 5);
      const menu = document.getElementById("ctxmenu");
      const editBtn = [...menu.querySelectorAll("button")].find((b) => b.textContent === "Edit Docker Host");
      ok(!editBtn.disabled, "Edit Docker Host enabled in the menu now that a daemon is connected");
      editBtn.click();
      await sleep(20);
      eq(dlg.open, true, "dialog opened");
      eq($("dlg-set-title").textContent, "Edit Docker Host", "opened in edit mode");
    } finally {
      post = realPost;
      get = realGet;
      state.sources = state.sources.filter((s) => s.id !== "__ctx_edit_test");
      syncDockerDaemonButtons();
      if (dlg.open) dlg.close();
    }
  });

  await T("right-clicking the Docker Host pill's Remove Docker Host is enabled once a host is saved", () => {
    const saved = prefs.get("savedDockerDaemons", {});
    prefs.set("savedDockerDaemons", { "ssh://u@h": { lastUsed: Date.now(), transforms: [] } });
    syncDockerDaemonButtons();
    try {
      ok(!$("btn-remove-docker-daemon").disabled, "sanity: sidebar's own Remove Docker Host is enabled with a saved host");
      mouse($("docker-host-status"), "contextmenu", 5);
      const menu = document.getElementById("ctxmenu");
      const removeBtn = [...menu.querySelectorAll("button")].find((b) => b.textContent.includes("Remove Docker Host"));
      ok(!removeBtn.disabled, "Remove Docker Host enabled in the menu now that a host is saved");
    } finally {
      document.body.click();
      prefs.set("savedDockerDaemons", saved);
      syncDockerDaemonButtons();
    }
  });

  await T("Docker Host dropdown separates each entry with a divider", () => {
    const saved = prefs.get("savedDockerDaemons", {});
    prefs.set("savedDockerDaemons", {
      "ssh://a@h": { lastUsed: 2, transforms: [] },
      "ssh://b@h": { lastUsed: 1, transforms: [] },
    });
    try {
      $("docker-host-status-btn").click();
      const items = $("docker-host-dropdown").querySelectorAll(".gateway-item");
      const seps = $("docker-host-dropdown").querySelectorAll(".gateway-item-sep");
      eq(items.length, 2, "both saved hosts listed");
      eq(seps.length, 1, "one divider between the two entries");
    } finally {
      document.body.click();
      prefs.set("savedDockerDaemons", saved);
    }
  });

  /* ── Gateway/Docker Host pills close each other's overlay while either is
     engaged -- the pill (button) itself is never hidden, only ever a
     *different* pill's own already-open tooltip/dropdown/menu. ─────────── */

  const pillVisible = (el) => getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";

  const openGatewayCurrentStatus = () => {
    mouse($("server-status"), "contextmenu", 5);
    const menu = document.getElementById("ctxmenu");
    [...menu.querySelectorAll("button")].find((b) => b.textContent === "Current Status").click();
  };

  await T("opening the Docker Host pill's Current Status closes the Gateway pill's own popup, but never hides the Gateway pill", async () => {
    openGatewayCurrentStatus();
    await sleep(20); // Gateway's Current Status is async (loadConnectionInfo), unlike Docker Host's
    ok(!$("connection-info-popup").hidden, "Gateway's own status popup shown first");
    openDockerHostCurrentStatus();
    try {
      ok(pillVisible($("server-status")), "Gateway pill's own control stays fully visible");
      ok($("server-status-btn").disabled !== true, "Gateway pill's button stays interactive");
      ok($("connection-info-popup").hidden, "Gateway's popup closed now that Docker Host is engaged");
    } finally {
      document.body.click();
    }
  });

  await T("opening the Gateway pill's Current Status closes the Docker Host pill's own popup, but never hides the Docker Host pill", async () => {
    openDockerHostCurrentStatus();
    ok(!$("docker-host-info-popup").hidden, "Docker Host's own status popup shown first");
    openGatewayCurrentStatus();
    await sleep(20);
    try {
      ok(pillVisible($("docker-host-status")), "Docker Host pill's own control stays fully visible");
      ok($("docker-host-info-popup").hidden, "Docker Host's popup closed now that Gateway is engaged");
    } finally {
      document.body.click();
    }
  });

  await T("right-clicking the Docker Host pill closes the Gateway pill's own dropdown, but never hides the Gateway pill", () => {
    // None of these overlays self-close on their own -- only an outside
    // click or a peer pill engaging closes them -- so this genuinely
    // exercises the cross-pill close (nothing else would ever close it).
    $("server-status-btn").click();
    ok(!$("gateway-dropdown").hidden, "Gateway's own dropdown shown first");
    mouse($("docker-host-status"), "contextmenu", 5);
    try {
      ok(pillVisible($("server-status")), "Gateway pill's own control stays fully visible");
      ok($("gateway-dropdown").hidden, "Gateway's dropdown closed now that Docker Host's actions menu is open");
    } finally {
      document.body.click(); // closes the ctxmenu and, if still open, the dropdown
    }
  });

  await T("clicking the Docker Host pill's switcher closes the Gateway pill's own dropdown, but never hides the Gateway pill", () => {
    $("server-status-btn").click();
    ok(!$("gateway-dropdown").hidden, "Gateway's own dropdown shown first");
    $("docker-host-status-btn").click();
    try {
      ok(pillVisible($("server-status")), "Gateway pill's own control stays fully visible");
      ok($("gateway-dropdown").hidden, "Gateway's dropdown closed now that Docker Host's switcher is open");
    } finally {
      document.body.click(); // outside click closes whatever's still open
    }
  });

  await T("Edit Docker Host: picking a different saved host from Load Docker Host swaps the checklist but leaves host/ssh-key locked", async () => {
    // Confirmed behavior: unlike New Docker Host, Edit Docker Host's Load
    // Docker Host stays visible+enabled, but picking a different entry only
    // re-targets which host's checklist is being edited -- it must never
    // unlock the connection-string fields, since editing is about which
    // containers/services to follow for an already-identified host, not
    // retyping its connection string.
    const saved = prefs.get("savedDockerDaemons", {});
    prefs.set("savedDockerDaemons", {
      ...saved,
      "ssh://u@h": { ssh_key: "/path/to/key", transforms: [], lastUsed: Date.now() },
      "ssh://other@h2": { ssh_key: "/other/key", transforms: [], lastUsed: Date.now() - 1000 },
    });
    const fakeSrc = { id: "__editpick_test", path: "docker://ssh://u@h/stats", kind: "stats", live: true };
    state.sources.push(fakeSrc);
    syncDockerDaemonButtons();
    dockerHostKeys.set("ssh://u@h", "/path/to/key");
    const realPost = post;
    const realGet = get;
    post = async (path, body) => (path === "/docker/ps" ? { containers: [], services: [], log: [] } : realPost(path, body));
    get = async (path) => (path === "/transforms" ? { transforms: [] } : realGet(path));
    try {
      await enterDockerHostEditMode(currentDockerHost() || "local");
      eq($("docker-host-history-row").hidden, false, "Load Docker Host visible in Edit mode");
      eq($("docker-host").disabled, true, "sanity: locked while editing");
      $("docker-host-history").value = "ssh://other@h2";
      await $("docker-host-history").onchange();
      eq($("docker-host").value, "other@h2", "checklist context switched to the picked host");
      eq($("docker-ssh-key").value, "/other/key", "ssh key field reflects the picked host's own saved key");
      eq($("docker-host").disabled, true, "still locked -- picking a host in Edit mode never unlocks the connection string");
      eq($("docker-ssh-key").disabled, true, "ssh key still locked too");
      eq($("docker-ssh-key-browse").disabled, true, "browse still locked too");
    } finally {
      post = realPost;
      get = realGet;
      dockerHostKeys.delete("ssh://u@h");
      state.sources = state.sources.filter((s) => s.id !== "__editpick_test");
      syncDockerDaemonButtons();
      prefs.set("savedDockerDaemons", saved);
      dlg.close();
      $("btn-set").click();
      dlg.close();
    }
  });

  /* ── Exactly one view (Live or one loaded file) visible at a time ──────── */

  await T("Load Data auto-switches to the newly opened file, hiding (not disposing) whatever was active before", async () => {
    const out1 = "/tmp/cttc-e2e-view-a.cttc-metric";
    const out2 = "/tmp/cttc-e2e-view-b.cttc-metric";
    await post("/sample/export", { path: out1, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    await post("/sample/export", { path: out2, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    const realPick = pickAnalysisFiles;
    try {
      pickAnalysisFiles = async () => [out1];
      await $("btn-load-sample").onclick();
      const pathA = `upload://${basename(out1)}`;
      let groupA = sampleFileGroups().find((g) => g.path === pathA);
      ok(groupA, "file A opened");
      eq(state.activeSamplePath, pathA, "A became the active view");
      ok([...groupA.ids].every((id) => !isSampleHidden(id)), "A's sources visible");

      pickAnalysisFiles = async () => [out2];
      await $("btn-load-sample").onclick();
      const pathB = `upload://${basename(out2)}`;
      const groupB = sampleFileGroups().find((g) => g.path === pathB);
      ok(groupB, "file B opened");
      eq(state.activeSamplePath, pathB, "B became the active view");
      ok([...groupB.ids].every((id) => !isSampleHidden(id)), "B's sources visible");
      groupA = sampleFileGroups().find((g) => g.path === pathA);
      ok([...groupA.ids].every((id) => isSampleHidden(id)), "A's sources now hidden");
      ok(state.sources.some((s) => groupA.ids.has(s.id)), "A's sources still open server-side, not disposed");
    } finally {
      pickAnalysisFiles = realPick;
      for (const s of state.sources.filter((s) => s.path === `upload://${basename(out1)}` || s.path === `upload://${basename(out2)}`)) {
        await post("/close", { id: s.id });
      }
      await refreshAll();
    }
  });

  await T("Legend and log panels show only the active view's own containers, never piling up across loads or live (BUG-0082)", async () => {
    const out1 = "/tmp/cttc-e2e-legend-a.cttc-metric";
    const out2 = "/tmp/cttc-e2e-legend-b.cttc-metric";
    await post("/sample/export", { path: out1, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    await post("/sample/export", { path: out2, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    const realPick = pickAnalysisFiles;
    try {
      pickAnalysisFiles = async () => [out1];
      await $("btn-load-sample").onclick();
      renderLegend();
      syncPanels();
      const legendA = [...$("legend").querySelectorAll(".legend-item")].map((i) => i.textContent);
      ok(new Set(legendA).size === legendA.length, `no duplicate legend entries after loading one file: ${legendA}`);
      ok(legendA.length > 0, "sanity: the loaded file's own containers are listed");
      ok(legendA.every((l) => !l.includes(".cttc-metric") && !l.includes(".cttc-record")), `legend labels must not append the originating file's name: ${legendA}`);
      const visibleA = [...panels.values()].filter((p) => !p.el.hidden).map((p) => p.src.name);
      ok(visibleA.length > 0, "sanity: at least one log panel visible for the loaded file");

      pickAnalysisFiles = async () => [out2];
      await $("btn-load-sample").onclick();
      renderLegend();
      syncPanels();
      const legendB = [...$("legend").querySelectorAll(".legend-item")].map((i) => i.textContent);
      eq(
        legendB.length, legendA.length,
        `switching to a second file must not accumulate the first file's (or Live's) legend entries -- was ${JSON.stringify(legendA)}, now ${JSON.stringify(legendB)}`
      );
      const visibleB = [...panels.values()].filter((p) => !p.el.hidden).map((p) => p.src.name);
      eq(visibleB.length, visibleA.length, "same number of visible log panels for the newly active file, not accumulated");
      const hiddenCount = [...panels.values()].filter((p) => p.el.hidden).length;
      ok(hiddenCount >= visibleA.length, "the first file's (and Live's) panels still exist, just correctly hidden -- not disposed");
    } finally {
      pickAnalysisFiles = realPick;
      for (const s of state.sources.filter((s) => s.path === `upload://${basename(out1)}` || s.path === `upload://${basename(out2)}`)) {
        await post("/close", { id: s.id });
      }
      await refreshAll();
    }
  });

  await T("Re-opening an already-open file switches to its existing view instead of duplicating or no-op'ing", async () => {
    const outA = "/tmp/cttc-e2e-view-reopen-a.cttc-metric";
    const outB = "/tmp/cttc-e2e-view-reopen-b.cttc-metric";
    await post("/sample/export", { path: outA, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    await post("/sample/export", { path: outB, from: R.min_ts, to: R.min_ts + 5 * 60000 });
    const pathA = `upload://${basename(outA)}`;
    const pathB = `upload://${basename(outB)}`;
    const realPick = pickAnalysisFiles;
    try {
      pickAnalysisFiles = async () => [outA];
      await $("btn-load-sample").onclick();
      const idsA = new Set(state.sources.filter((s) => s.path === pathA).map((s) => s.id));

      pickAnalysisFiles = async () => [outB];
      await $("btn-load-sample").onclick(); // B becomes active, A hidden
      eq(state.activeSamplePath, pathB, "sanity: B is active");

      pickAnalysisFiles = async () => [outA]; // re-"open" A -- already open
      await $("btn-load-sample").onclick();
      eq(state.activeSamplePath, pathA, "switched back to A's existing view");
      const idsAAfter = new Set(state.sources.filter((s) => s.path === pathA).map((s) => s.id));
      eq(idsAAfter.size, idsA.size, "no duplicate sources -- same set as before");
      ok([...idsAAfter].every((id) => idsA.has(id)), "exact same source ids, not re-uploaded");
    } finally {
      pickAnalysisFiles = realPick;
      for (const s of state.sources.filter((s) => s.path === pathA || s.path === pathB)) {
        await post("/close", { id: s.id });
      }
      await refreshAll();
    }
  });

  await T("viewing a loaded file locks resetZoom/the navigator to that file's own range, not the combined one", async () => {
    // System Observability spec's "Synchronization Continuity": the log
    // viewer must always be locked to the current metric's own temporal
    // window -- exercised here via resetZoom/totalSpanBounds, which the
    // navigator and the log panel's own bounds both derive from.
    const out = "/tmp/cttc-e2e-view-range-scope.cttc-metric";
    await post("/sample/export", { path: out, from: R.min_ts, to: R.min_ts + 60000 });
    const path = `upload://${basename(out)}`;
    const realPick = pickAnalysisFiles;
    try {
      pickAnalysisFiles = async () => [out];
      await $("btn-load-sample").onclick();
      eq(state.activeSamplePath, path, "sanity: the narrow file is the active view");

      const scoped = activeViewRange();
      const fullSpan = R.max_ts - R.min_ts;
      const scopedSpan = scoped.max_ts - scoped.min_ts;
      ok(scopedSpan < fullSpan / 2, `scoped span (${scopedSpan}) should be far narrower than the full demo range (${fullSpan})`);

      resetZoom();
      ok(state.view.t1 - state.view.t0 < fullSpan / 2, "resetZoom fit only the active file's own range");
      ok(state.view.t0 >= R.min_ts - fullSpan, "didn't drift into the unrelated combined range");

      const { lo, hi } = totalSpanBounds();
      ok(hi - lo < fullSpan / 2, "navigator span locked to the file, not stretched out to 'now'");

      setActiveView("live");
      eq(state.liveHidden, false, "sanity: back to Live");
      const backToFull = activeViewRange();
      eq(backToFull, state.range, "Live uses the full combined range again");
    } finally {
      pickAnalysisFiles = realPick;
      for (const s of state.sources.filter((s) => s.path === path)) await post("/close", { id: s.id });
      await refreshAll();
      resetZoom();
    }
  });

  await T("host block shows the loading state before first host sample, titled for the local machine", () => {
    state.sources.push({ id: "__hload", kind: "stats", is_host: true,
                         path: "docker://local/host", live: true, name: "host@local" });
    try {
      drawAll();
      eq(hostBlockEl.hidden, false, "host block appears");
      eq($("host-loading").hidden, false, "loading indicator shown");
      eq(hostChartsEl.hidden, true, "charts hidden while loading");
      eq($("host-title").textContent, "Host telemetry — localhost", "titled for the local daemon");
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
