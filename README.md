# Cut to the Chase (CTTC)

Correlate container telemetry (CPU / memory / network) with service logs —
and the docker host's own vitals — on one shared, clickable timeline. Metric
charts on top, an event-density lane per log source, host telemetry at the
bottom, and one scrollable panel per service log below.

**Click anywhere on a chart (or lane) at time t → every log panel jumps to
its entries at t** and highlights the ± window around it.

![CTTC with the cursor on a worker spike: charts on top, density lanes, and
log panels that have jumped to that moment, with ERROR/WARN rows
edge-colored](docs/images/app-overview.png)

In short, CTTC can:

- **collect live from Docker** — local daemon or remote over `ssh://` (with
  an SSH-key picker), following container/service logs and polling
  `docker stats` plus the host machine's own CPU/MEM/NET;
- **open files** — `docker logs -t` output, JSONL logs, `docker stats`
  JSONL, tailed live with rotation handled;
- **navigate time** — shared cursor, zoom/pan/recenter gestures, a
  scrollbar-style timeline navigator, line or histogram charts, a
  three-state container legend, searchable virtual-scrolled log panels,
  pop-out windows that stay in sync;
- **capture and share** — point-in-time snapshots (TXT/JSON), and
  drag-selected time ranges exported as `.cttc` metrics files — optionally
  **encrypted** for a chosen recipient, with a built-in key manager;
- **reshape logs at ingest** via drop-in Python transform modules.

**📖 All usage documentation lives in the [User Manual](MANUAL.md)** —
every feature, the interactions reference, the server API for scripting,
and troubleshooting.

## Run

```sh
cd app
npm install          # once (Electron)
npm start            # uv provisions server/.venv on first run
# or open files straight away:
npm start -- path/to/stats.jsonl path/to/service.log
```

Or with [Task](https://taskfile.dev): `task install`, then `task start`.

Requirements: Node + Electron (npm), [`uv`](https://docs.astral.sh/uv/), and
the `docker` CLI if you use the Docker collector.

### Demo

```sh
cd app
uv run --project server demo/generate_demo.py            # 30 min of correlated history
npm start -- demo/data/stats.jsonl demo/data/c3_api.log demo/data/c3_worker.log
```

The demo contains CPU/MEM/NET spikes with matching log bursts so the
click-to-correlate flow is immediately visible. Add `--live` to the
generator to keep it appending.

## Repository layout

- [MANUAL.md](MANUAL.md) — the user manual.
- [app/](app/) — the application.
  - [app/main.js](app/main.js) — Electron main process: spawns the Python
    server via `uv run`, opens the renderer with the server's port.
  - [app/server/server.py](app/server/server.py) — Python server (deps via
    **uv**, JSON via **orjson**): ingestion/normalization, tailing, docker +
    host collectors, series bucketing, `.cttc` export/load + encryption,
    SSE. Binds `127.0.0.1` only.
  - [app/renderer/](app/renderer/) — dependency-free canvas charting +
    virtual-scrolled log panels.
  - [app/server/transforms/](app/server/transforms/) — drop-in transform
    modules.
  - [app/demo/](app/demo/) — correlated demo-data generator.
  - [app/test/](app/test/) — the in-app renderer E2E spec and runner.

## Tests

- **Server** — `task test:server`: 150+ tests, 100% line coverage of
  `server.py` (parsers, ingestion, collectors with mocked subprocesses,
  samples + encryption, every HTTP endpoint incl. SSE, `main()`).
- **Renderer** — `task test:e2e`: launches the real app on fresh demo data
  and runs `app/test/renderer-spec.js` inside the window; prints pass/fail
  plus V8 byte-coverage of `app.js`.
- `task test` runs both.

## Development / verification hooks

Environment variables understood by the Electron main process:

- `CTTC_SCREENSHOT=/path.png` — capture the window ~4 s after load, then quit.
- `CTTC_EVAL='<js>'` — run arbitrary JS in the renderer before the capture.
- `CTTC_CURSOR_OFFSET=<ms>` — set the cursor at `range.min + offset` first.
- `CTTC_TEST=<spec.js>` — run a test spec inside the window (used by
  `task test:e2e`) and exit non-zero on failures.

Note for VS Code terminals: the extension host exports
`ELECTRON_RUN_AS_NODE`, which turns the Electron binary into plain Node —
unset it (`task start` already does).
