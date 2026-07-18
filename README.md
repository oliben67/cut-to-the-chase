# Cut to the Chase (CTTC)

Correlate container telemetry (CPU / memory / network) with service logs — and
the docker host's own vitals — on one shared, clickable timeline. Metric charts
on top, an event-density lane per log source, host telemetry at the bottom, and
one scrollable panel per service log below.

**Click anywhere on a chart (or lane) at time t → every log panel jumps to its
entries at t** and highlights the ± window around it. Click a log line to move
the cursor to that line's time instead.

```
┌───────────────────────────────────────────────┐
│  CPU % ────────╱╲──────────│──────────────    │  ← charts (click = set cursor t)
│  MEM % ────────────────────│──────────────    │
│  NET   ────────╱╲──────────│──────────────    │
│  api   ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮│▮▮▮▮▮▮▮▮          │  ← density lanes
│  Host telemetry   [hide]                      │
│  CPU % ──────╱─╲───────────│──────────────    │  ← docker host vitals
├───────────────────────────────────────────────┤  ← drag to resize
│  api log        ····· [t] ·····               │  ← panels scroll to t,
│  worker log     ····· [t] ·····               │    highlight ±window
└───────────────────────────────────────────────┘
```

## Features

- **Shared cursor** across charts, density lanes, and log panels; log rows are
  level-colored (ERROR/WARN) and virtually scrolled, so multi-million-line
  files stay smooth. Panels show the newest entry on top by default; a ⬆/⬇
  toggle in each panel's header reverses that to oldest-on-top. Ctrl/Cmd-click
  a row to select it (shift-click to select a range); right-click a selection
  to get the same **capture metrics / take snapshot / zoom / reset zoom** menu
  as the charts, centered on the selected entries' timestamp(s).
- **Line plot or histogram** rendering for every metric strip (toolbar 〜/▤
  slider).
- **Timeline navigation**: drag to zoom, double-click any point on the charts
  or log density lanes to re-center every panel on that time, *reset zoom* to
  fit the full data range. The view starts centered on now (± 5 min).
- **Resizable layout**: drag the divider between charts and log panels to trade
  chart height for log space.
- **Docker collection** from the local daemon or a remote one over
  `ssh://user@host`, with an **SSH key menu** (keys found in `~/.ssh`, or
  browse for one) — the choice is remembered per host. Container/service logs
  are followed with `docker logs -f -t` / `docker service logs -f -t`; stats
  are polled with `docker stats` on a chosen interval. Each successful
  ＋ Add sources request is remembered and replayed automatically the next
  time the app starts with no sources open; **🗑 Clear sources** closes
  everything currently open and forgets that remembered set, for a clean
  start. With no sources at all (first launch, or right after clearing), the
  ＋ Add sources dialog opens on its own.
- **Host telemetry**, on by default when collecting from docker: CPU / MEM /
  NET of the docker host itself (psutil for the local machine, `/proc` over
  ssh for remote hosts), rendered in its own strip group at the bottom of the
  chart block with a hide/show toggle. Shows a "⏳ Loading host telemetry…"
  placeholder until the first reading comes in.
- **Three-state container legend** — `docker stats` reports every container on
  a host, but only the containers you *selected* in ＋ Add sources are plotted:
  - **selected** — normal legend entry, plotted; click to dim/undim,
    right-click to unselect or hide.
  - **not selected** — grouped behind an `others (N)` chip, listed grayed-out;
    **right-click → Track** starts plotting its telemetry *and* following its
    logs; right-click → Hide removes it from the list.
  - **hidden** — filtered out entirely; a `hidden (N)` chip restores them.
- **Samples**: **shift+drag** on the timeline (or right-click a chart →
  **✂ Capture metrics** and drag) to export the selected time range — logs and
  metrics of every open source, host included — as a zipped **`.cttc`** file.
  Load a `.cttc` back via the toolbar's **📂 Load sample** button to analyze it
  later. The save dialog can **encrypt the file for a stored key** (“Encrypt
  for” menu); loading an encrypted file prompts for the private key.
- **🔑 Keys** (toolbar): manage the encryption keys in `~/.cttc/keys/` —
  generate an RSA keypair for yourself, import public keys others share with
  you, copy your public key to share, delete keys (with a loud warning when a
  private key is involved).
- **Duplicate guards**: a container, stats collector, host-telemetry collector,
  or file that is already being collected shows as *already added* and can't be
  added twice.
- **Transforms**: user-written Python modules applied to log records at ingest
  (see below).
- **Instant hover hints**: every button and control shows its purpose right
  next to the cursor as soon as you hover it — no waiting on the browser's
  native tooltip delay.

## Repository layout

- [app/](app/) — the application.
  - [app/main.js](app/main.js) — Electron main process: spawns the Python
    server via `uv run`, opens the renderer with the server's port.
  - [app/server/server.py](app/server/server.py) — Python server (deps managed
    by **uv**, JSON via **orjson**): parses & normalizes every record (unique
    `uid`, epoch-ms `ts`), tails files, follows docker log streams, polls
    docker + host stats, buckets series for the chart width, binary-searches
    log indexes, exports/loads `.cttc` samples, pushes SSE change events.
    Binds `127.0.0.1` only.
  - [app/renderer/](app/renderer/) — dependency-free canvas charting +
    virtual-scrolled log panels; talks only to the local server.
  - [app/server/transforms/](app/server/transforms/) — drop-in transform
    modules.
  - [app/demo/](app/demo/) — correlated demo-data generator.

## Run

```sh
cd app
npm install          # once (Electron)
npm start            # uv provisions server/.venv (orjson, psutil) on first run
# or open files straight away:
npm start -- path/to/stats.jsonl path/to/service.log
```

Or with [Task](https://taskfile.dev): `task install`, then `task start`.

Requirements: Node + Electron (npm), [`uv`](https://docs.astral.sh/uv/), and
the `docker` CLI if you use the Docker collector.

## Getting data in

**Command-line arguments** — `npm start -- path/to/stats.jsonl path/to/service.log`
opens any mix of:
- `docker stats` JSONL (one JSON object per line with a `timestamp` field) or
  a whole JSON array of those entries,
- service logs from `docker logs -t` / `docker service logs -t` (RFC3339
  timestamp prefix),
- JSONL logs (timestamp taken from `timestamp`/`ts`/`time`/`@timestamp`/…).

Lines without their own timestamp (stack traces, wrapped output) are appended
to the previous entry. Files opened this way are tailed for new lines by
default (`--static` disables that); log rotation/truncation is handled.

**📂 Load sample** (toolbar) — pick one or more **`.cttc`** sample files
exported from the app; they open as static (non-tailed) sources alongside
whatever else is already open.

**＋ Add sources → Docker** — attach to a daemon directly. Leave the host empty
for the local daemon, or use `ssh://user@host` — an SSH-key selector appears
listing the private keys in `~/.ssh` (default = your ssh config / agent; the
docker CLI has no identity-file flag, so the server shims `ssh` on `PATH` for
its docker subprocesses). List the containers / swarm services, tick the ones
to follow, and choose whether to collect `docker stats` telemetry and host
telemetry on an interval. Stats snapshots are timestamped **UTC on arrival**.

Timestamps without a timezone are assumed UTC; start the server with
`--naive-tz local` if your files carry local times. The UI renders times in
your local timezone; the cursor readout in the toolbar shows UTC.

## Interactions

| Action | Effect |
|---|---|
| **🗑 Clear sources** | close every open source and forget the remembered last-session containers |
| click chart / lane | set cursor at t; all panels jump to t and highlight ±window |
| click log row | move cursor to that row's time |
| ctrl/cmd-click log row | add/remove that row from the selection |
| shift-click log row | select the range from the last-clicked row |
| right-click a selected log row | menu: capture metrics / take snapshot / zoom in / zoom out / reset zoom, centered on the selection's timestamp(s) |
| drag on chart / lane | zoom to selection (blue band) |
| **shift+drag** (or right-click → `✂ Capture metrics` then drag) | export the selected range as a `.cttc` sample (orange band) |
| double-click chart / lane | re-center every panel on that point in time |
| right-click chart / lane | menu: capture metrics / take snapshot / zoom in / zoom out / reset zoom |
| drag timeline-nav thumb | pan the view |
| click timeline-nav track | jump/re-center the view there |
| click "now" on the timeline-nav | center the view on the present, keeping the span |
| 〜/▤ slider | switch chart rendering style (lines vs. histogram) |
| drag divider above log panels | resize charts vs. logs |
| ⬆/⬇ on a log panel | reverse that panel between newest-first (default) and oldest-first |
| frequency | sampling frequency: size of the ± highlight window around t |
| legend entry (click) | dim/undim a selected series |
| legend entry (right-click) | track / unselect / hide a container |
| `others (N)` chip | expand/collapse not-selected containers |
| `hidden (N)` chip | restore hidden containers |
| Host telemetry hide/show | collapse the host strip group |

Chart style, strip height, host-panel visibility, container tracking states,
per-host SSH keys, and the last set of ＋ Add sources requests (replayed on
the next launch if nothing else is open) persist across launches.

## Samples (`.cttc`)

A sample is a zip archive: `manifest.json` (version, time range, source
inventory), `logs/*.jsonl` (`{ts, text}` rows), and `stats/*.json` (per-service
metric tuples, host flag and swarm-service info preserved). Export covers every
currently open source, sliced to the selected range; loading rehydrates them as
static (non-tailed) sources.

## Transforms (dynamic Python modules)

Drop a `.py` file into [app/server/transforms/](app/server/transforms/) and it
appears in the Add-sources dialog; checked transforms are applied, in order, to
every record of the log sources you add. Modules are reloaded each time sources
are opened — edit and re-add, no restart needed. Contract:

```python
def transform(record):        # {"ts": epoch_ms, "text": str, "fields": dict, "source": str}
    ...
    return record             # or a list of records, or None to drop the line
```

Shipped examples: `parse_level` (tag `fields["level"]`), `drop_healthchecks`,
`json_message` (compact rendering of JSON log lines). A crashing transform
never kills ingest — the error is recorded on the affected record.

## Demo

```sh
cd app
uv run --project server demo/generate_demo.py            # 30 min of correlated history
uv run --project server demo/generate_demo.py --live     # …and keep appending (test follow mode)
npm start -- demo/data/stats.jsonl demo/data/c3_api.log demo/data/c3_worker.log
```

The demo contains CPU/MEM/NET spikes with matching log bursts (request storms,
OutOfMemoryError cascades) so the click-to-correlate flow is immediately
visible.

## Server API (for scripting)

```
GET  /sources · /range · /series?from&to&px · /logs?source&start&count
     /index_at?source&t · /ticks?source&from&to&px · /logs/find?source&q&start&dir
     /point?t · /transforms · /ssh/keys · /cttc/keys · /events (SSE)
POST /open · /close · /docker/ps · /docker/collect · /sample/export
     /cttc/keys/generate · /cttc/keys/import · /cttc/keys/delete · /shutdown
```

`/series` entries carry `host` (host-telemetry flag), `sid` (source id) and
`ttype` (`container` | `service`). `/docker/collect` accepts `host`, `stats`,
`host_stats`, `logs: [{name, type}]`, `transforms`, `interval`, `ssh_key`.
`/sample/export` takes `{path, from, to, include_host, public_key}` — with a
`public_key` (a stored key name or raw PEM — pick one in the save-metrics
dialog's “Encrypt for” menu) the sample is encrypted
(RSA-OAEP-wrapped AES-256-GCM); `/open` then needs `private_key` for that
file, and reports `encrypted: true` in its error entry when it's missing.
Keys live in `~/.cttc/keys/`. All timestamps are epoch milliseconds. The
server binds `127.0.0.1` only.

## Tests

- **Server** — `task test:server` (or `cd app/server && uv run --group dev
  pytest --cov=server`): ~150 tests covering parsers, ingestion, transforms,
  the docker/ssh collectors (subprocesses fully mocked), sample
  export/load/encryption, every HTTP endpoint incl. SSE, and `main()` —
  at 100% line coverage of `server.py`.
- **Renderer** — `task test:e2e` (or `npm run test:e2e`): launches the real
  app on fresh demo data and runs `app/test/renderer-spec.js` inside the
  window — view math, toolbar controls, legend track states, drag
  zoom/sample/recenter gestures on the actual canvases, tooltips, log panels,
  snapshots, the add-sources dialog logic, and a sample export/reload round
  trip. Prints a result line plus V8 byte-coverage of `app.js`; exit code 0
  means every assertion passed.
- `task test` runs both.

## Development / verification hooks

Environment variables understood by the Electron main process:

- `CTTC_SCREENSHOT=/path.png` — capture the window ~4 s after load, then quit
  (headless-ish smoke test).
- `CTTC_EVAL='<js>'` — run arbitrary JS in the renderer before the capture.
- `CTTC_CURSOR_OFFSET=<ms>` — set the cursor at `range.min + offset` before the
  capture.
- `CTTC_TEST=<spec.js>` — run a test spec inside the window (used by
  `task test:e2e`), print `CTTC_TEST_RESULTS {...}` with pass/fail counts and
  app.js coverage, and exit non-zero on failures.

Note for VS Code terminals: the extension host exports `ELECTRON_RUN_AS_NODE`,
which turns the Electron binary into plain Node — unset it (the Taskfile's
`task start` already does).
