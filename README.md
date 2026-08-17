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
  drag-selected time ranges exported as `.cttc-metric` metrics files — optionally
  **encrypted** for a chosen recipient, with a built-in key manager.

**📖 All usage documentation lives in the [User Manual](MANUAL.md)** —
every feature, the interactions reference, the server API for scripting,
and troubleshooting.

## Run

```sh
cd app
npm install          # once (Electron)
npm start            # starts the local gateway container (Docker required)
# or open files straight away:
npm start -- path/to/stats.jsonl path/to/service.log
```

Or with [Task](https://taskfile.dev): `task install`, then `task start`.

Requirements: Node + Electron (npm), and Docker (the gateway that collects
and stores logs/telemetry runs as a container — see
[app/server-logsump](app/server-logsump) — there is no non-Docker fallback).
[`uv`](https://docs.astral.sh/uv/) is only needed for the demo-data
generator below.

### Demo

```sh
cd app
uv run --project server-logsump demo/generate_demo.py    # 30 min of correlated history
npm start -- demo/data/stats.jsonl demo/data/c3_api.log demo/data/c3_worker.log
```

The demo contains CPU/MEM/NET spikes with matching log bursts so the
click-to-correlate flow is immediately visible. Add `--live` to the
generator to keep it appending.

## Repository layout

- [MANUAL.md](MANUAL.md) — the user manual.
- [app/](app/) — the application.
  - [app/main.js](app/main.js) — Electron main process: starts/connects to
    the gateway container (local or remote) and opens the renderer against
    its address.
  - [app/server-logsump](app/server-logsump) — the gateway server (a
    [log-sump](https://github.com/oliben67/log-sump) submodule): SSH-based
    Docker log/metric collection into Redis Streams, behind an authenticated
    HTTP API. Runs as a Docker container, never spawned bare.
  - [app/log-sump-extended](app/log-sump-extended) — CTTC-specific compat
    routes (chart/log-panel queries, recording sessions, condition-based
    events); a separate repo/submodule that installs
    [log-sump](https://github.com/oliben67/log-sump) as a real dependency
    and bakes these routes into its own Docker image at build time —
    that image, not `app/server-logsump`'s own, is what actually ships.
  - [app/renderer/](app/renderer/) — dependency-free canvas charting +
    virtual-scrolled log panels.
  - [app/demo/](app/demo/) — correlated demo-data generator.
  - [app/test/](app/test/) — the in-app renderer E2E spec and runner.

## Tests

- **Main process** — `task test:unit`: `app/lib/*.js` unit tests (Node's
  built-in test runner).
- **Renderer** — `task test:e2e`: launches the real app on fresh demo data
  and runs `app/test/renderer-spec.js` inside the window; prints pass/fail
  plus V8 byte-coverage of `app.js`.
- `task test` runs both. The gateway itself (`app/server-logsump`,
  `app/log-sump-extended`) has its own test suite in its own repo/submodule,
  run independently of `task test` here.

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
