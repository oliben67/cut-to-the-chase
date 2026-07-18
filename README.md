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
  files stay smooth.
- **Line plot or histogram** rendering for every metric strip (toolbar toggle).
- **Timeline navigation**: drag to zoom, `◀ / now / ▶` to pan half a window or
  re-center on the present, double-click / *reset zoom* to fit the data,
  *follow live* to pin the view to incoming data. The view starts centered on
  now (± 5 min).
- **Resizable layout**: drag the divider between charts and log panels to trade
  chart height for log space.
- **Docker collection** from the local daemon or a remote one over
  `ssh://user@host`, with an **SSH key menu** (keys found in `~/.ssh`, or
  browse for one) — the choice is remembered per host. Container/service logs
  are followed with `docker logs -f -t` / `docker service logs -f -t`; stats
  are polled with `docker stats` on a chosen interval.
- **Host telemetry**, on by default when collecting from docker: CPU / MEM /
  NET of the docker host itself (psutil for the local machine, `/proc` over
  ssh for remote hosts), rendered in its own strip group at the bottom of the
  chart block with a hide/show toggle.
- **Three-state container legend** — `docker stats` reports every container on
  a host, but only the containers you *selected* in ＋ Add sources are plotted:
  - **selected** — normal legend entry, plotted; click to dim/undim,
    right-click to unselect or hide.
  - **not selected** — grouped behind an `others (N)` chip, listed grayed-out;
    **right-click → Track** starts plotting its telemetry *and* following its
    logs; right-click → Hide removes it from the list.
  - **hidden** — filtered out entirely; a `hidden (N)` chip restores them.
- **Samples**: **shift+drag** on the timeline (or arm the `✂ sample` button and
  drag) to export the selected time range — logs and metrics of every open
  source, host included — as a zipped **`.cttc`** file. Load a `.cttc` back via
  ＋ Add sources → Files to analyze it later.
- **Duplicate guards**: a container, stats collector, host-telemetry collector,
  or file that is already being collected shows as *already added* and can't be
  added twice.
- **Transforms**: user-written Python modules applied to log records at ingest
  (see below).

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
- [scripts/](scripts/) — standalone shell/Python collectors that predate the
  app (`container-logs` writes `docker stats` JSONL, `jsonify-stats` converts
  to a JSON array, `analyze-logs` renders a terminal report, `remote.sh` runs a
  collector on a remote host). Their output files load straight into the app.

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

**＋ Add sources → Files** — open any mix of:
- `docker stats` JSONL (one JSON object per line with a `timestamp` field, as
  produced by `scripts/container-logs`) or a whole JSON array of those entries
  (as produced by `scripts/jsonify-stats`),
- service logs from `docker logs -t` / `docker service logs -t` (RFC3339
  timestamp prefix),
- JSONL logs (timestamp taken from `timestamp`/`ts`/`time`/`@timestamp`/…),
- **`.cttc` sample files** exported from the app (loaded as static sources).

Lines without their own timestamp (stack traces, wrapped output) are appended
to the previous entry. With *live* checked, files are tailed for new lines;
log rotation/truncation is handled.

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
| click chart / lane | set cursor at t; all panels jump to t and highlight ±window |
| click log row | move cursor to that row's time |
| drag on chart / lane | zoom to selection (blue band) |
| **shift+drag** (or `✂ sample` then drag) | export the selected range as a `.cttc` sample (orange band) |
| double-click / reset zoom | fit the full data range |
| ◀ / ▶ | pan half a window back / forward |
| now | center the view on the present, keeping the span |
| 〜 lines / ▤ histogram | switch chart rendering style |
| drag divider above log panels | resize charts vs. logs |
| window ± | size of the highlight window around t |
| follow live | keep the view pinned to the newest data, panels tail their end |
| legend entry (click) | dim/undim a selected series |
| legend entry (right-click) | track / unselect / hide a container |
| `others (N)` chip | expand/collapse not-selected containers |
| `hidden (N)` chip | restore hidden containers |
| Host telemetry hide/show | collapse the host strip group |

Chart style, strip height, host-panel visibility, container tracking states,
and per-host SSH keys persist across launches.

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
     /index_at?source&t · /ticks?source&from&to&px · /transforms
     /ssh/keys · /events (SSE)
POST /open · /close · /docker/ps · /docker/collect · /sample/export · /shutdown
```

`/series` entries carry `host` (host-telemetry flag), `sid` (source id) and
`ttype` (`container` | `service`). `/docker/collect` accepts `host`, `stats`,
`host_stats`, `logs: [{name, type}]`, `transforms`, `interval`, `ssh_key`.
`/sample/export` takes `{path, from, to}`. All timestamps are epoch
milliseconds. The server binds `127.0.0.1` only.

## Development / verification hooks

Environment variables understood by the Electron main process:

- `CTTC_SCREENSHOT=/path.png` — capture the window ~4 s after load, then quit
  (headless-ish smoke test).
- `CTTC_EVAL='<js>'` — run arbitrary JS in the renderer before the capture.
- `CTTC_CURSOR_OFFSET=<ms>` — set the cursor at `range.min + offset` before the
  capture.

Note for VS Code terminals: the extension host exports `ELECTRON_RUN_AS_NODE`,
which turns the Electron binary into plain Node — unset it (the Taskfile's
`task start` already does).
