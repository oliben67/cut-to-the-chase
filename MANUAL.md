# CTTC — User Manual

Cut to the Chase (CTTC) correlates container telemetry (CPU / memory /
network) with service logs — and the docker host's own vitals — on one
shared, clickable timeline.

This manual covers every feature of the app. For a quick overview and
installation, see the [README](README.md).

## Contents

- [Concepts](#concepts)
- [Getting started](#getting-started)
- [The main window](#the-main-window)
- [Adding sources](#adding-sources)
  - [Collecting from Docker](#collecting-from-docker)
  - [Remote hosts over SSH](#remote-hosts-over-ssh)
  - [Loading metrics files](#loading-metrics-files)
  - [Opening files from the command line](#opening-files-from-the-command-line)
  - [Clearing sources](#clearing-sources)
- [Reading the telemetry](#reading-the-telemetry)
  - [Metric strips](#metric-strips)
  - [The container legend](#the-container-legend)
  - [Density lanes](#density-lanes)
  - [Host telemetry](#host-telemetry)
- [Navigating time](#navigating-time)
  - [The cursor and the frequency window](#the-cursor-and-the-frequency-window)
  - [Zooming and panning](#zooming-and-panning)
  - [The timeline navigator](#the-timeline-navigator)
- [Working with logs](#working-with-logs)
- [Snapshots](#snapshots)
- [Capturing and sharing metrics (.cttc)](#capturing-and-sharing-metrics-cttc)
- [Encryption keys](#encryption-keys)
- [Pop-out windows](#pop-out-windows)
- [Transforms](#transforms)
- [Interactions reference](#interactions-reference)
- [What is remembered between launches](#what-is-remembered-between-launches)
- [Scripting the server](#scripting-the-server)
- [Troubleshooting](#troubleshooting)

---

## Concepts

- **Source** — anything that feeds the timeline: a followed container log, a
  `docker stats` collector, a host-telemetry collector, or an opened file.
- **Cursor** — the currently selected point in time. Click anywhere on a
  chart or density lane at time *t* and **every log panel jumps to its
  entries at *t***, highlighting the ± frequency window around it.
- **Live vs. sample data** — live sources keep updating; data loaded from a
  `.cttc` metrics file is static and drawn grayed + dashed/hatched so it is
  always distinguishable from live series.
- **View** — the visible time window. All charts, lanes, and the host panel
  share one view; popped-out windows stay in sync with it.

## Getting started

Launch the app (see the [README](README.md) for installation). With nothing
open, the *Add sources* dialog appears automatically. From there you attach
to a Docker daemon; or use **📂 Load metrics** to open a saved `.cttc` file
instead.

If you collected from Docker before, the app **restores those collections on
launch** automatically.

Hover any control for a short built-in hint; the `?` next to *frequency*
opens the relevant section of this manual.

## The main window

![The CTTC main window: the cursor sits on a c3_worker spike; both log panels
have jumped to that moment, highlighting the ± frequency window, with ERROR
and WARN rows edge-colored](docs/images/app-overview.png)

From top to bottom:

1. **Toolbar** — ＋ Add sources, 🗑 Clear sources, 📂 Load metrics, 🔑 Keys,
   the *frequency* window, the 〜/▤ chart-style switch, and (right) the
   cursor's UTC readout.
2. **Telemetry** — the container legend, then the CPU % / MEM % / NET metric
   strips. In the screenshot the vertical blue line is the **cursor**,
   placed on one of `c3_worker`'s spikes. The ⧉ button pops the whole block
   into its own window.
3. **Timeline navigator** — the scrollbar-like track showing the current
   view within the whole available range, with **now** as a click target.
4. **Density lanes** — one row of tick marks per log source, darker where
   entries are denser.
5. **Host telemetry** (when collected — not shown above) — the docker host's
   own CPU/MEM/NET in a collapsible strip group with its own navigator.
6. **Log panels** — one per log source, below the divider. Both panels above
   have jumped to the cursor's time: the blue-tinted rows are inside the ±
   frequency window, and `c3_worker` shows why the spike happened —
   edge-colored `WARN job … slow` and `ERROR … OutOfMemoryError` rows.

Drag the divider between charts and log panels to trade chart height for log
space; the position is remembered.

## Adding sources

### Collecting from Docker

![The Add sources dialog: docker host field, telemetry checkboxes, poll
interval, and the transforms list](docs/images/dlg-add-sources.png)

**＋ Add sources** attaches to a Docker daemon. Leave the host field empty
for the local daemon. The dialog lists the running containers and swarm
services (use **Refresh** to re-list); tick the ones whose logs you want to
follow. Logs are streamed with `docker logs -f -t` (or
`docker service logs -f -t` for swarm services).

Two checkboxes control telemetry, both on by default:

- **collect `docker stats` telemetry** — polls CPU/MEM/NET for *every*
  container on the host on the chosen interval. Only the containers you
  ticked are *plotted*; the rest wait in the legend's *others* group (see
  [The container legend](#the-container-legend)).
- **collect host telemetry** — CPU/MEM/NET of the docker host machine
  itself, shown in its own strip group at the bottom.

Anything already being collected shows as *already added* and cannot be
added twice. Ticked transforms (see [Transforms](#transforms)) apply to the
new log sources.

### Remote hosts over SSH

Enter `ssh://user@host` (optionally `:port`) as the Docker host. An **SSH
key** selector appears listing the private keys found in `~/.ssh` — pick one,
choose *default* to use your ssh config / agent, or *browse…* for a key file
elsewhere. The choice is remembered per host.

Container logs and stats go through docker's native SSH transport. Host
telemetry is read from the remote's `/proc` over the same ssh credentials.

### Loading metrics files

**📂 Load metrics** opens one or more `.cttc` files previously captured with
the app (see [Capturing and sharing metrics](#capturing-and-sharing-metrics-cttc)).
They open as **static** sources: their series draw grayed and dashed, their
log panels carry a *sample* badge, and the legend gains one switch per loaded
file to show/hide everything from that file at once.

If a file is **encrypted**, you are prompted for the private key — give the
name of a key stored in `~/.cttc/keys/` (see [Encryption keys](#encryption-keys))
or paste a full PEM.

### Opening files from the command line

`npm start -- path/to/stats.jsonl path/to/service.log` opens any mix of:

- `docker stats` JSONL (one JSON object per line with a `timestamp` field),
  or a whole JSON array of such entries;
- logs from `docker logs -t` / `docker service logs -t` (RFC3339 prefix);
- JSONL logs (timestamp read from `timestamp`/`ts`/`time`/`@timestamp`/
  `datetime`/`date` — strings or epoch numbers);
- `.cttc` metrics files.

Lines without their own timestamp (stack traces, wrapped output) attach to
the previous entry. Files are tailed for new lines; rotation and truncation
are handled. Start the server with `--static` to disable tailing, and with
`--naive-tz local` if your files carry local times without an offset
(otherwise naive timestamps are assumed UTC). Times render in your local
timezone; the toolbar cursor readout shows UTC.

### Clearing sources

**🗑 Clear sources** closes every open source (collectors are stopped) and
forgets the remembered docker sessions, giving you a clean slate.

## Reading the telemetry

### Metric strips

Three strips — **CPU %**, **MEM %**, and **NET** (bytes/sec) — plot one
series per selected container, max-merged per pixel so short spikes stay
visible when zoomed out. The **〜 lines / ▤ histogram** switch in the toolbar
changes the rendering style everywhere (bars are translucent so overlapping
series stay readable). Hover a strip for a tooltip listing each visible
series' value at that instant, sorted descending.

Series from loaded `.cttc` files draw **grayed and dashed** (hatched in
histogram mode), with a distinct gray level + dash rhythm per file, so live
and sampled data never look alike.

### The container legend

`docker stats` reports every container on a host, but only the containers
you *selected* are plotted. Each known container is in one of three states:

| State | Appearance | Meaning |
|---|---|---|
| **selected** | normal colored entry | plotted; click to dim/undim temporarily |
| **not selected** | grayed, behind the `others (N)` chip | telemetry arrives but is not plotted |
| **hidden** | only counted in the `hidden (N)` chip | ignored entirely |

Right-click a legend entry for actions:

- on a *selected* entry — **Unselect** (park it under *others*) or **Hide
  entirely**;
- on an *others* entry — **Track (logs + telemetry)**, which starts plotting
  it *and* begins following its logs from the same docker host, or **Hide
  entirely**;
- the `hidden (N)` chip lists hidden containers to **Restore**.

The `others (N)` chip itself expands/collapses the grayed list. All states
persist across launches.

When `.cttc` files are loaded, the legend also shows one **switch per file**
(labelled with the file name) that shows/hides all of that file's data at
once.

### Density lanes

Below the strips, each log source gets a lane of tick marks — one per log
entry, darker where entries are denser. Lanes share the strips' time axis
and support the same click / drag / double-click gestures.

### Host telemetry

When host telemetry is collected, a separate **Host telemetry** strip group
appears at the bottom of the chart block with its own CPU/MEM/NET strips and
its own timeline navigator. While the first reading is on its way you'll see
a brief ⏳ loading indicator. The ▾/▸ button collapses the group; ⧉ pops it
out into its own window. Its visibility choice persists.

## Navigating time

### The cursor and the frequency window

Click any chart or lane to place the **cursor** at that time: every log
panel scrolls to its entry nearest the cursor, and entries within the
**frequency** window (± N seconds, set in the toolbar) are highlighted.
Clicking a log row moves the cursor to that row's time instead.

### Zooming and panning

- **Drag** across a chart or lane to zoom into the selection (blue band).
- **Double-click** to re-center the view on that time, keeping the span.
- **Right-click** a chart for `🔍+ Zoom in here`, `🔍− Zoom out here`,
  `↺ Reset zoom` (fits the whole data range and re-centers the cursor on the
  middle, like a double-click), `📸 Take snapshot`, and `✂ Capture metrics`.

### The timeline navigator

The scrollbar-like track under the strips shows the current view as a thumb
within the whole available time range:

- **drag the thumb** to pan;
- **click the track** to jump there, keeping the span;
- **click "now"** (center of the track) to center the view on the present.

## Working with logs

Each log source gets a panel below the charts (virtual-scrolled — files with
millions of lines stay smooth). Rows with `ERROR`/`FATAL`/`CRIT` get a red
edge, `WARN` an amber one. The header shows the entry count and any applied
transforms; ✕ closes the source.

- **⬆ / ⬇ order** — newest-first (default) or oldest-first; applies to new
  panels too and persists.
- **🔍 search** — case-insensitive substring search with next/previous,
  wrapping around the whole log.
- **Selection** — ctrl/cmd-click rows to select them, shift-click to select
  a range. Right-click the selection for the timeline menu (snapshot,
  capture metrics, zoom in/out, reset zoom) **anchored on the selected
  entries' time span** — e.g. a snapshot centered on exactly those entries.
- **⧉ pop out** — move this log to its own window.

## Snapshots

Right-click a chart (or a log selection) → **📸 Take snapshot** to capture a
single point in time: every container's and host's telemetry values nearest
that instant, plus the nearby log entries from each source.

![A snapshot: per-source cpu/mem/net values at the chosen instant and the
nearest log entry from each source](docs/images/dlg-snapshot.png)

Options in the snapshot dialog:

- **Include all open containers/hosts** — untick to keep only the currently
  selected series;
- **Include nearby log entries**;
- **panorama** — enlarge the snapshot around the chosen time: by *entries*
  (wider log context per source) or by *seconds* (adds full extra slices N
  seconds before and after, for side-by-side comparison).

View the result as a **Raw** table or as **JSON**, and save it with
**💾 Save as TXT…** / **💾 Save as JSON…**.

## Capturing and sharing metrics (.cttc)

To save a time range for later analysis or to share it:

1. **Shift+drag** across the charts (or right-click → **✂ Capture metrics**,
   then drag) — the selection shows as an orange band.
2. In the **Save metrics** dialog choose whether to include host telemetry
   (if it isn't being collected yet, ticking the box starts it for future
   captures) and, optionally, an **Encrypt for** key.
3. Pick a destination — you get a single **`.cttc`** file containing the
   logs *and* metrics of every open source, sliced to the selected range.

A `.cttc` file is a zip: a manifest, one JSONL file per log source, and the
per-service metric series (host flag and swarm info preserved). If encrypted,
the zip is wrapped in AES-256-GCM under a one-time key that only the chosen
recipient's RSA private key can unwrap.

Load a `.cttc` back with **📂 Load metrics** — see
[Loading metrics files](#loading-metrics-files) for how sampled data is
displayed.

## Encryption keys

**🔑 Keys** manages the keys used to encrypt/decrypt `.cttc` files. They are
plain PEM files in `~/.cttc/keys/` (private keys are created owner-only,
mode 600 — the same trust model as `~/.ssh`).

![The Encryption keys dialog: a keypair with its public+private badge and
copy/delete actions, plus the generate and import forms](docs/images/dlg-keys.png)

- **Generate** — create an RSA-3072 keypair for yourself. Badge:
  `public + private`.
- **Import** — paste a public key someone shared with you, under a name of
  your choice. Badge: `public only`.
- **📋 Copy** — copy a public PEM to the clipboard, to share with others so
  *they* can encrypt metrics for *you*.
- **🗑 Delete** — remove a key. Deleting a keypair destroys the private key:
  any metrics encrypted for it become permanently unreadable, and the app
  warns loudly before doing it.

Typical exchange: your teammate clicks *Generate*, then *Copy*, and sends
you the PEM. You *Import* it under their name, capture metrics with
*Encrypt for → their name*, and send them the `.cttc`. Only they can open it.

## Pop-out windows

The ⧉ buttons move a panel into its own window:

- **Telemetry** (the whole chart block),
- **Host telemetry**,
- any **log panel**.

In addition, **right-click any container or loaded record in the legend →
“⧉ Open … in its own window”** to get a window dedicated to that single
series: its CPU/MEM/NET strips and its matching log density lane, whatever
its selection state in the main legend.

A new pop-out opens on **exactly the time range and cursor you were looking
at**. Popped-out windows talk to the same data and stay fully in sync —
moving the cursor or the view in one window moves it everywhere. Closing a pop-out
(with **⤴ Pop back** or the window's close button) returns focus to the
window it was opened from — the main window, or another pop-out if that is
where you opened it. Telemetry/host/log pop-outs are reintegrated into the
main window on close; series pop-outs are extra views, so nothing moves.

## Transforms

Transforms are user-written Python modules applied to every log record at
ingest. Drop a `.py` file into `app/server/transforms/` and it appears as a
checkbox in the *Add sources* dialog. Modules are reloaded every time
sources are opened — edit and re-add, no restart needed.

```python
def transform(record):   # {"ts": epoch_ms, "text": str, "fields": dict, "source": str}
    ...
    return record        # or a list of records (fan-out), or None to drop the line
```

Shipped examples: `parse_level` (tags `fields["level"]`),
`drop_healthchecks` (drops noisy probe lines), `json_message` (renders JSON
log lines as `LEVEL logger: message`). A crashing transform never kills
ingestion — the error is recorded on the affected record instead.

## Interactions reference

| Action | Effect |
|---|---|
| click chart / lane | set cursor at t; all panels jump to t and highlight the ± frequency window |
| click log row | move cursor to that row's time |
| ctrl/cmd-click log row | add/remove that row from the selection |
| shift-click log row | select the range from the last-clicked row |
| right-click log selection | snapshot / capture metrics centered on the selected entries |
| drag on chart / lane | zoom to selection (blue band) |
| shift+drag (or right-click → ✂ Capture metrics, then drag) | export the range as `.cttc` (orange band) |
| double-click chart / lane | re-center on that point in time |
| right-click chart / lane | zoom in / zoom out / reset zoom / snapshot / capture metrics |
| drag timeline-nav thumb | pan the view |
| click timeline-nav track | jump there, keeping the span |
| click "now" on the timeline-nav | center the view on the present |
| 〜 lines / ▤ histogram switch | change chart rendering style |
| drag divider above log panels | resize charts vs. logs |
| frequency | size of the ± highlight window around the cursor |
| legend entry click | dim/undim a selected series |
| legend entry right-click | track / unselect / hide a container, or open it in its own window |
| `others (N)` chip | expand/collapse not-selected containers |
| `hidden (N)` chip | restore hidden containers |
| sample-file switch in the legend | show/hide everything from that `.cttc` file |
| ▾/▸ on Host telemetry | collapse/expand the host strip group |
| ⬆/⬇ in a log panel | newest-first / oldest-first ordering |
| 🔍 in a log panel | search that log |
| ⧉ / ⤴ Pop back | pop a panel out / back in |

## What is remembered between launches

Chart style, strip height, host-panel visibility, container tracking states,
log ordering, the *others* list state, per-host SSH keys, and your docker
collections (restored automatically at startup; cleared by 🗑 Clear sources).

## Scripting the server

The app is backed by a local HTTP server (bound to `127.0.0.1` only; the
port is printed on startup). All timestamps are epoch milliseconds.

```
GET  /sources · /range · /series?from&to&px · /logs?source&start&count
     /index_at?source&t · /ticks?source&from&to&px · /logs/find?source&q&start&dir
     /point?t · /transforms · /ssh/keys · /cttc/keys · /events (SSE)
POST /open · /close · /docker/ps · /docker/collect · /sample/export
     /cttc/keys/generate · /cttc/keys/import · /cttc/keys/delete · /shutdown
```

Highlights:

- `/series` entries carry `host` (host-telemetry flag), `sid` (source id)
  and `ttype` (`container` | `service`).
- `/docker/collect` accepts `host`, `stats`, `host_stats`,
  `logs: [{name, type}]`, `transforms`, `interval`, `ssh_key`.
- `/sample/export` takes `{path, from, to, include_host, public_key}`;
  `/open` accepts `private_key` per file and flags encrypted files with
  `encrypted: true` in its error entries.
- `/point?t` returns each service's sample nearest `t` — handy for
  comparing an arbitrary moment against another one regardless of zoom.

## Troubleshooting

- **"could not start server via uv"** — install
  [uv](https://docs.astral.sh/uv/); it provisions the server's Python
  environment on first run.
- **"docker CLI not found on PATH"** — install the docker CLI, or use the
  app on files / `.cttc` metrics only.
- **The app opens as a plain terminal process / nothing appears** (VS Code
  terminals) — the extension host exports `ELECTRON_RUN_AS_NODE`, which
  turns Electron into plain Node. Unset it (`task start` already does).
- **Timestamps look shifted** — files with naive local timestamps need the
  server started with `--naive-tz local`.
- **An encrypted `.cttc` won't open** — you need the *private* key of the
  keypair it was encrypted for; a name from `~/.cttc/keys/` or a pasted PEM
  both work at the prompt. If that private key was deleted, the file cannot
  be recovered.
- **Host telemetry for a remote host shows an error** — host sampling
  supports the local daemon and `ssh://` hosts (Linux `/proc` on the remote
  side); `tcp://` daemons are not supported for host vitals.
