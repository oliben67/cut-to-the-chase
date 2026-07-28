# CTTC — User Manual

Cut to the Chase (CTTC) correlates container telemetry (CPU / memory /
network) with service logs — and the docker host's own vitals — on one
shared, clickable timeline.

This manual covers every feature of the app. For a quick overview and
installation, see the [README](README.md). It ships next to the CTTC
executable (see [Getting help](#getting-help)) so it's available offline.

## Contents

- [Concepts](#concepts)
- [Getting started](#getting-started)
- [The sidebar](#the-sidebar)
- [The main window](#the-main-window)
- [Connecting to a Gateway](#connecting-to-a-gateway)
- [Adding sources](#adding-sources)
  - [Collecting from Docker](#collecting-from-docker)
  - [Remote hosts over SSH](#remote-hosts-over-ssh)
  - [Loading metrics files](#loading-metrics-files)
  - [Opening files from the command line](#opening-files-from-the-command-line)
  - [Removing the Docker Daemon](#removing-the-docker-daemon)
- [Reading the telemetry](#reading-the-telemetry)
  - [Metric strips](#metric-strips)
  - [The container legend](#the-container-legend)
  - [Density lanes](#density-lanes)
  - [Host telemetry](#host-telemetry)
- [Navigating time](#navigating-time)
  - [Live-following and the "now" line](#live-following-and-the-now-line)
  - [The cursor and the frequency window](#the-cursor-and-the-frequency-window)
  - [Zooming and panning](#zooming-and-panning)
  - [The timeline navigator](#the-timeline-navigator)
  - [The status bar](#the-status-bar)
- [Working with logs](#working-with-logs)
- [Snapshots](#snapshots)
- [Capturing and sharing metrics (.cttc-metric)](#capturing-and-sharing-metrics-cttc-metric)
- [Automating with events](#automating-with-events)
- [Encryption keys](#encryption-keys)
- [Pop-out windows](#pop-out-windows)
- [Transforms](#transforms)
- [Interactions reference](#interactions-reference)
- [What is remembered between launches](#what-is-remembered-between-launches)
- [Scripting the server](#scripting-the-server)
- [Getting help](#getting-help)
- [Troubleshooting](#troubleshooting)

---

## Concepts

- **Gateway** — the CTTC *server* backend: it ingests, buckets, and serves
  telemetry/logs over HTTP to the renderer you're looking at. It runs
  **embedded** (spawned locally, the default), as a **local Docker
  container**, or **provisioned onto a remote machine over SSH** — either
  way, the app talks to it the same way. See
  [Connecting to a Gateway](#connecting-to-a-gateway).
- **Docker Daemon** — the *target* whose containers/services you want
  telemetry and logs from. It can be the same machine as the gateway, or a
  different one reached over `ssh://`. Don't confuse the two: you can be
  connected to a gateway running on your laptop while it collects from a
  Docker daemon on a completely different server, or vice versa.
- **Source** — anything that feeds the timeline: a followed container log,
  a `docker stats` collector, a host-telemetry collector, or an opened file.
- **Cursor** — the currently selected point in time. Click anywhere on a
  chart or density lane at time *t* and **every log panel jumps to its
  entries at *t***, highlighting the ± frequency window around it.
- **Live vs. sample data** — live sources keep updating; data loaded from a
  `.cttc-metric` file is static and drawn grayed + dashed/hatched so it is
  always distinguishable from live series.
- **View** — the visible time window. All charts, lanes, and the host panel
  share one view; popped-out windows stay in sync with it. By default the
  view **live-follows the present** — see
  [Live-following and the "now" line](#live-following-and-the-now-line).

## Getting started

Launch the app (see the [README](README.md) for installation). On first run
a **gateway setup wizard** may appear — see
[Connecting to a Gateway](#connecting-to-a-gateway); skip it to use this
machine's own Docker (or none) directly.

With no sources open, the **Set Docker Daemon…** dialog (sidebar → Docker
Daemon) attaches to a Docker daemon; or use **Load Metrics…** (sidebar →
Metrics) to open a saved `.cttc-metric` file instead.

If you collected from Docker before, the app **restores those collections on
launch** automatically.

Hover any control for a short built-in hint. The manual is one click away
from the sidebar's **About CTTC** panel and the toolbar's `?` buttons — see
[Getting help](#getting-help).

## The sidebar

The sidebar (visible on the left in the screenshot under
[The main window](#the-main-window)) groups every action into four
collapsible sections:

- **Gateway** — New Gateway…, Edit Gateway (see
  [Connecting to a Gateway](#connecting-to-a-gateway)).
- **Docker Daemon** — Set Docker Daemon…, Edit Docker Daemon…, Remove
  Docker Daemon (see [Adding sources](#adding-sources)).
- **Metrics** — Load Metrics…, Create Event…, Edit Events… (see
  [Automating with events](#automating-with-events)).
- **Preferences** — Appearance…, Settings… (see
  [Live-following and the "now" line](#live-following-and-the-now-line) for
  the now-line's color/style controls, and [Encryption keys](#encryption-keys)
  for key management, reached from Settings).

Click a section's header to expand/collapse it; click its chevron or title
again to collapse. Below the sections, **About CTTC** and **Quit** are
always visible.

The bar itself can be:

- **docked** to any of the four edges of the window, or **detached** into
  its own floating window — use the small dock-position buttons at its top.
- **collapsed** to a thin rail (the ◂/▸ button at the top-left of the bar)
  when you want the chart area at full width; every section hides, leaving
  just the rail to expand it again.
- **resized** by dragging the thin splitter between the bar and the main
  content — the size is remembered per axis (width for left/right docking,
  height for top/bottom), independently of which edge it's currently docked
  to.

## The main window

![The CTTC main window: the cursor sits on a c3_worker spike; both log
panels have jumped to that moment, highlighting the ± frequency window,
with ERROR and WARN rows edge-colored, and the dotted "now" line visible on
the charts](docs/images/app-overview.png)

From top to bottom:

1. **Toolbar** — recording transport (⏺/⏸/⏹/⏏, see
   [Automating with events](#automating-with-events)), the **frequency**
   control (labelled *Frequency* — not to be confused with the *poll
   interval* field in Set/Edit Docker Daemon, which is the one that
   actually changes how often the server polls Docker; this one only sizes
   the ± highlight window, see
   [The cursor and the frequency window](#the-cursor-and-the-frequency-window)),
   the 〜/▤ chart-style switch, the current **view range**, and the
   cursor's UTC readout — see [The status bar](#the-status-bar).
2. **Telemetry** — the container legend, then the CPU % / MEM % / NET metric
   strips. In the screenshot the solid vertical line is the **cursor**,
   placed on one of `c3_worker`'s spikes; the **dotted line** further right
   is the **"now" marker** tracking real time (see
   [Live-following and the "now" line](#live-following-and-the-now-line)).
   The ⧉ button pops the whole block into its own window.
3. **Timeline navigator** — the scrollbar-like track showing the current
   view within the whole available range, with **now** as a click target
   that also resumes live-following.
4. **Density lanes** — one row of tick marks per log source, darker where
   entries are denser.
5. **Host telemetry** (when collected — not shown above) — the docker host's
   own CPU/MEM/NET in a collapsible strip group with its own navigator.
6. **Log panels** — one per log source, below the divider. Both panels above
   have jumped to the cursor's time: the blue-tinted rows are inside the ±
   frequency window, and `c3_worker` shows why the spike happened —
   edge-colored `WARN job … slow` and `ERROR … OutOfMemoryError` rows. A log
   panel's own **✕** hides it (and its matching legend entry) without
   stopping collection — see [The container legend](#the-container-legend).

Drag the divider between charts and log panels to trade chart height for log
space; the position is remembered.

## Connecting to a Gateway

A **Gateway** is where the CTTC server actually runs. Three modes:

- **Embedded** (default) — spawned locally as a subprocess; nothing to set
  up.
- **Local Docker container** — the packaged `cttc-gateway` image, run on
  this machine's own Docker.
- **Remote, over SSH** — provisioned onto another machine you control:
  CTTC connects with an SSH key, starts the gateway container there (or
  reuses one already running), and reaches it either directly or through an
  SSH tunnel if the remote port isn't otherwise reachable.

**New Gateway…** (sidebar → Gateway) walks through adding a remote one:
host, SSH key (a file already on this machine, or paste one directly), and
which gateway image to use (a registry reference, or a local tarball for
offline installs). **Skip — use this machine** bypasses all of this and
uses local Docker (or the embedded server if Docker isn't available).
**Edit Gateway** re-opens that same form for an existing entry — **"This
machine"** (the embedded/local gateway) is never listed here, since it has
no connection settings to change and can't be uninstalled; it's always
available from the toolbar's gateway status button instead, which switches
between every gateway you've connected to, including it.

**Uninstall** stops and removes the gateway's container **and its image**
(not just the container), streaming progress to the same activity log New
Gateway uses. If it reports an error, it also checks — and logs — whether
the container is actually still there, since `docker compose down` can
exit non-zero after partially succeeding.

Uninstalling the gateway you're **currently connected to** immediately
reconnects to this machine with no confirmation prompt: every open
dialog/form and everything on screen is already stale the moment it
succeeds (the gateway they belonged to is gone), so the whole app reloads
to a fresh starting point instead — no leftover sources, no lingering
`.cttc-metric`/`.cttc-record` sample data, nothing left pointing at a
gateway that no longer exists.

If a remote gateway becomes unreachable, CTTC automatically falls back to
an SSH tunnel and shows a "Restarting, please wait…" splash while it
reconnects — no action needed on your part.

## Adding sources

### Collecting from Docker

![The Set Docker Daemon dialog: docker host field, telemetry checkboxes,
poll interval, and the Fetch button that lists containers/services to
follow](docs/images/dlg-set-sources.png)

**Set Docker Daemon…** attaches to a Docker daemon. Leave the host field
empty for the local daemon (or the gateway's own host, if you're connected
to a remote gateway). Telemetry and logs are two independent kinds of data
CTTC can collect, so the dialog splits them into two sections.

- **📊 Telemetry** — two checkboxes:
  - **collect `docker stats` telemetry** — polls CPU/MEM/NET for *every*
    container on the host on the chosen **poll interval** (in seconds —
    this is the control that actually changes how often the server polls
    Docker, unlike the toolbar's *frequency* control). Only *selected*
    containers (see below) are actually *plotted*; the rest wait in the
    legend's *others* group (see [The container legend](#the-container-legend)).
    Changing it in **Edit Docker Daemon…** and clicking **Update Docker
    Daemon** takes effect immediately on the already-running collector, not
    just on a fresh one.
  - **collect host telemetry** — CPU/MEM/NET of the docker host machine
    itself, shown in its own strip group at the bottom.
- **📝 Logs** — click **Fetch** to list the running containers and swarm
  services for the entered host, grouped under **"Swarm services"** and
  **"Containers"** headings. **Nothing is ticked by default** — pick
  exactly what you want followed and plotted; ticking an item both starts
  following its logs (`docker logs -f -t`, or `docker service logs -f -t`
  for swarm services) *and* marks it *selected* so its telemetry plots
  immediately. You can always right-click a container later to track it
  (see [The container legend](#the-container-legend)). **Click a group's
  own heading** to select or deselect every checkbox in that group at once
  (a partially-ticked group selects all first, rather than deselecting).

Anything already being followed shows as *already added* but stays
checked/unchecked according to whether it's actually *selected* right
now, and stays interactive — unticking an already-followed container
stops following it, the same as if you'd closed its panel. Ticked
transforms (see [Transforms](#transforms)) apply to the new log sources.
**Set Docker Daemon** syncs exactly to what's checked here.

**Edit Docker Daemon…** and **Remove Docker Daemon** are only enabled once
a daemon is actually being watched — nothing to edit or remove otherwise.
Once one is set, **Edit Docker Daemon…** re-opens this same form with the
host and SSH key pre-filled and locked, **Fetch** relabelled **Refresh**
(just re-probes for new containers/services rather than starting over),
and the bottom button relabelled **Update Docker Daemon**. The checklist
itself isn't blank while you wait for a Refresh — it starts pre-filled with
every container/service already being followed, immediately interactive,
with only the ones actually **selected** (plotted) ticked — a container
you'd previously unselected from the legend stays listed but unticked,
matching its real state. **Refresh** diffs the checklist against the
daemon's actual current state rather than replacing it wholesale: a
container that was never selected and is now gone drops off the list
silently; one that **was selected** but has since stopped/disappeared
stays listed, ticked, and **disabled** with a "no longer available" note,
instead of vanishing without explanation; a genuinely new one appears
unticked (nothing is preselected just for being found); and anything
still there and unchanged keeps exactly whatever you last checked/
unchecked it to — Refresh never silently discards an in-progress edit.

### Remote hosts over SSH

Enter `ssh://user@host` (optionally `:port`) as the Docker host. An **SSH
key** selector appears listing the private keys found in `~/.ssh` — pick one,
choose *default* to use your ssh config / agent, or *browse…* for a key file
elsewhere. The choice is remembered per host.

Container logs and stats, and host telemetry (read from the remote's
`/proc`), all go over that same SSH connection.

### Loading metrics files

**Load Metrics…** (sidebar → Metrics) opens one or more `.cttc-metric` files
previously captured with the app (see
[Capturing and sharing metrics](#capturing-and-sharing-metrics-cttc-metric)).
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
- `.cttc-metric` metrics files.

Lines without their own timestamp (stack traces, wrapped output) attach to
the previous entry. Files are tailed for new lines; rotation and truncation
are handled. Start the server with `--static` to disable tailing, and with
`--naive-tz local` if your files carry local times without an offset
(otherwise naive timestamps are assumed UTC). Times render in your local
timezone; the toolbar cursor readout shows UTC.

### Removing the Docker Daemon

**Remove Docker Daemon** (sidebar → Docker Daemon) closes every open source
for the current daemon (collectors are stopped) and forgets the remembered
docker session, giving you a clean slate.

## Reading the telemetry

### Metric strips

Three strips — **CPU %**, **MEM %**, and **NET** (bytes/sec) — plot one
series per selected container, max-merged per pixel so short spikes stay
visible when zoomed out. The **〜 lines / ▤ histogram** switch in the toolbar
changes the rendering style everywhere (bars are translucent so overlapping
series stay readable). Hover a strip for a tooltip listing each visible
series' value at that instant, sorted descending.

Series from loaded `.cttc-metric` files draw **grayed and dashed** (hatched in
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

Gray is reserved for *not selected*/*hidden* — every **selected** (plotted)
container always gets its own distinct, fully-saturated color, no matter
how many are open at once. The first 8 use the theme's curated palette;
the 9th and beyond get procedurally generated colors that are always
unique and never fall back to gray.

Right-click a legend entry for actions:

- on a *selected* entry — **Unselect** (park it under *others*) or **Hide
  entirely**;
- on an *others* entry — **Track (logs + telemetry)**, which starts plotting
  it *and* begins following its logs from the same docker host, or **Hide
  entirely**;
- the `hidden (N)` chip lists hidden containers to **Restore**.

The `others (N)` chip itself expands/collapses the grayed list. All states
persist across launches.

**Legend and log panels are linked**: clicking a *selected* container off in
the legend hides its log panel too, in the exact same position on screen;
clicking it back on brings the panel right back where it was. A log panel's
own **✕** does the same thing in reverse — it hides the panel and dims its
legend entry, but **does not stop collection**, so the data keeps arriving
in the background and reappears the instant you turn it back on. This is
different from *hiding* a container from the legend's right-click menu,
which really does stop it being tracked.

When `.cttc-metric` files are loaded, the legend also shows one **switch per file**
(labelled with the file name) that shows/hides all of that file's data at
once.

**Reordering**: drag a legend entry to a new spot to reorder it — its
matching log panel moves to match, in the exact same relative position.
Dragging a log panel's header reorders the same way in reverse, moving its
legend entry to match: one shared order, two views onto it. The header is
the drag handle (so selecting log text or scrolling doesn't start a
reorder by accident), but the whole panel — header and body — moves
together as the drag ghost, so it's clear the *entire panel* is what's
being repositioned. Drag either one **out past the edge of the window** to
detach it into its own pop-out window instead of reordering it (see
[Pop-out windows](#pop-out-windows)).

### Density lanes

Below the strips, each log source gets a lane of tick marks — one per log
entry, darker where entries are denser. Lanes share the strips' time axis
and support the same click / drag / double-click gestures.

### Host telemetry

When host telemetry is collected, a separate **Host telemetry — `<name>`**
strip group appears at the bottom of the chart block, named for the docker
daemon system it's actually reporting on (`this machine`, or the remote
host's name for an `ssh://` daemon) — with its own CPU/MEM/NET strips and
its own timeline navigator. While the first reading is on its way you'll see
a brief ⏳ loading indicator. The ▾/▸ button collapses the group; ⧉ pops it
out into its own window. Its visibility choice persists.

## Navigating time

### Live-following and the "now" line

By default, the view **follows the present**: it's centered a few seconds
behind real time (so the very latest points aren't drawn flush against the
chart's edge) and keeps sliding forward automatically. A **dotted line**
sweeps across the charts marking the actual current instant, distinct from
the solid cursor line.

Any deliberate pan or zoom (drag, wheel, the timeline navigator, a
double-click recenter) stops the live-follow — you're now looking at a
fixed window on purpose. Click **"now"** on the timeline navigator (see
below) to jump back to the present and resume following it; while live, the
label reads highlighted, and a ◀ marker appears on it while paused so it's
obvious at a glance whether you're watching live data or looking at the
past.

The now-line's **color and dash style** (dotted, dashed, or solid) are
configurable in **Preferences → Appearance → "Now" line**, live-previewed
as you adjust them.

![The Appearance dialog's "Now" line section: a color swatch and a
Dotted/Dashed/Solid switch](docs/images/dlg-appearance.png)

### The cursor and the frequency window

Click any chart or lane to place the **cursor** at that time: every log
panel scrolls to its entry nearest the cursor, and entries within the
**frequency** window (± N seconds, set in the toolbar) are highlighted.
Clicking a log row moves the cursor to that row's time instead.

### Zooming and panning

- **Drag** across a chart or lane to zoom into the selection (blue band).
- **Mouse wheel / trackpad scroll** over a chart or lane zooms in/out,
  anchored on the point under the cursor (ctrl/cmd+wheel is left alone for
  the OS's own page-zoom gesture). Hover a chart for a tooltip spelling out
  all three gestures.
- **Double-click** to re-center the view on that time, keeping the span.
- **Right-click** a chart for `🔍+ Zoom in here`, `🔍− Zoom out here`,
  `↺ Reset zoom` (fits the whole data range and places the cursor on now —
  a one-off "fit everything" action, unlike live-follow which keeps
  tracking), `📸 Take snapshot`, and `✂ Capture metrics`.

### The timeline navigator

The scrollbar-like track under the strips shows the current view as a thumb
within the whole available time range:

- **drag the thumb** to pan;
- **click the track** to jump there, keeping the span;
- **click "now"** (center of the track) to jump the view to the present and
  resume live-following it (see
  [Live-following and the "now" line](#live-following-and-the-now-line)).

### The status bar

The toolbar's right-hand side shows both **the current view range** (its
start and span, e.g. `view: 2026-07-27 15:30:26 UTC + 10m`) and **the
cursor's exact time**, so you always know both what window you're looking
at and where the cursor sits within it — not just one or the other.

## Working with logs

Each log source gets a panel below the charts (virtual-scrolled — files with
millions of lines stay smooth). Rows with `ERROR`/`FATAL`/`CRIT` get a red
edge, `WARN` an amber one. The header shows the entry count and any applied
transforms; ✕ hides the panel (see
[The container legend](#the-container-legend) — collection keeps running).

- **⬆ / ⬇ order** — newest-first (default) or oldest-first; applies to new
  panels too and persists.
- **🔍 search** — case-insensitive substring search with next/previous,
  wrapping around the whole log.
- **Selection** — ctrl/cmd-click rows to select them, shift-click to select
  a range. Right-click the selection for the timeline menu (snapshot,
  capture metrics, zoom in/out, reset zoom) **anchored on the selected
  entries' time span** — e.g. a snapshot centered on exactly those entries.
- **⧉ pop out** — move this log to its own window, reopening in the same
  position when popped back in.

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

## Capturing and sharing metrics (.cttc-metric)

To save a time range for later analysis or to share it:

1. **Shift+drag** or **Ctrl/Cmd+drag** across the charts (or right-click →
   **✂ Capture metrics**, then drag) — the selection shows as an orange band.
2. In the **Save metrics** dialog choose whether to include host telemetry
   (if it isn't being collected yet, ticking the box starts it for future
   captures) and, optionally, an **Encrypt for** key.
3. Pick a destination — you get a single **`.cttc-metric`** file containing the
   logs *and* metrics of every open source, sliced to the selected range.

A `.cttc-metric` file is a zip: a manifest, one JSONL file per log source, and the
per-service metric series (host flag and swarm info preserved). If encrypted,
the zip is wrapped in AES-256-GCM under a one-time key that only the chosen
recipient's RSA private key can unwrap.

Load a `.cttc-metric` back with **Load Metrics…** — see
[Loading metrics files](#loading-metrics-files) for how sampled data is
displayed.

## Automating with events

**Create Event…** (sidebar → Metrics) watches CPU/MEM/NET thresholds or a
log regular expression on chosen systems, and automatically **takes a
snapshot** or **starts a recording** the moment the condition is met — it
keeps watching until you disable or delete it.

- **Hosted on** — *the presently connected gateway* keeps watching even
  after this window closes (the gateway is a long-running server — see
  [Connecting to a Gateway](#connecting-to-a-gateway)); *local to this app*
  stops watching as soon as the window closes.
- **Conditions** — one or more of *metric threshold* (a metric name, an
  operator, and a value) or *log regular expression*; with more than one
  condition, choose whether **any** or **all** must be met to trigger.
- **Action** — *take a snapshot* (with a ± window in minutes) or *start a
  recording* (for a given duration); tick **keep longer than the default
  retention window** to override how long the result is kept.

**Edit Events…** lists every event — local and gateway alike — to update,
enable/disable, or erase.

## Encryption keys

**Settings…** (sidebar → Preferences) → **Keys** manages the keys used to
encrypt/decrypt `.cttc-metric` files. They are plain PEM files in
`~/.cttc/keys/` (private keys are created owner-only, mode 600 — the same
trust model as `~/.ssh`).

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
*Encrypt for → their name*, and send them the `.cttc-metric`. Only they can open it.

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
main window on close (back at the same position it was hidden from); series
pop-outs are extra views, so nothing moves.

## Transforms

Transforms are user-written Python modules applied to every log record at
ingest. Drop a `.py` file into `app/server/transforms/` and it appears as a
checkbox in the **Set Docker Daemon…** dialog. Modules are reloaded every time
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
| mouse wheel / trackpad scroll over chart / lane | zoom in/out anchored on the cursor |
| shift+drag (or right-click → ✂ Capture metrics, then drag) | export the range as `.cttc-metric` (orange band) |
| double-click chart / lane | re-center on that point in time |
| right-click chart / lane | zoom in / zoom out / reset zoom / snapshot / capture metrics |
| drag timeline-nav thumb | pan the view |
| click timeline-nav track | jump there, keeping the span |
| click "now" on the timeline-nav | jump to the present and resume live-following |
| 〜 lines / ▤ histogram switch | change chart rendering style |
| drag divider above log panels | resize charts vs. logs |
| drag the sidebar splitter | resize the sidebar |
| frequency | size of the ± highlight window around the cursor |
| legend entry click | dim/undim a selected series, or hide/show its log panel |
| legend entry right-click | track / unselect / hide a container, or open it in its own window |
| drag a legend entry / log panel header | reorder it (and its counterpart, kept in sync) |
| drag a legend entry / log panel header past the window's edge | detach it into its own pop-out window |
| `others (N)` chip | expand/collapse not-selected containers |
| `hidden (N)` chip | restore hidden containers |
| sample-file switch in the legend | show/hide everything from that `.cttc-metric` file |
| ▾/▸ on Host telemetry | collapse/expand the host strip group |
| ⬆/⬇ in a log panel | newest-first / oldest-first ordering |
| 🔍 in a log panel | search that log |
| ✕ on a log panel | hide the panel (collection keeps running) |
| ⧉ / ⤴ Pop back | pop a panel out / back in |
| click a group heading in the Docker Daemon checklist | select/deselect every item in that group |

## What is remembered between launches

Chart style, strip height, host-panel visibility, container tracking states,
log ordering, panel positions, the *others* list state, per-host SSH keys,
your docker collections (restored automatically at startup; cleared by
Remove Docker Daemon), the sidebar's dock position/collapsed state/size, and
the "now" line's color and style.

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

## Getting help

This manual is installed **next to the CTTC executable** so it's available
without an internet connection. Two ways to reach it from inside the app:

- **sidebar → About CTTC**;
- any **`?`** hint button in the toolbar (e.g. next to *frequency*)
  jumps straight to the relevant section.

## Troubleshooting

- **CTTC is stuck in a broken state and nothing else here helps** —
  **Settings… → Danger → Hard Reset** closes every open source and erases
  every saved CTTC preference on this machine (track states, panel
  positions, sidebar layout, theme, docker/ssh-key associations,
  everything), then reloads the app to boot exactly like a brand-new
  install. This cannot be undone — it does not touch your `.cttc-metric`
  files, gateways, or encryption keys, only CTTC's own cached UI state.
- **"could not start server via uv"** — install
  [uv](https://docs.astral.sh/uv/); it provisions the server's Python
  environment on first run.
- **"docker CLI not found on PATH"** — install the docker CLI, or use the
  app on files / `.cttc-metric` metrics only.
- **The app opens as a plain terminal process / nothing appears** (VS Code
  terminals) — the extension host exports `ELECTRON_RUN_AS_NODE`, which
  turns Electron into plain Node. Unset it (`task start` already does).
- **Timestamps look shifted** — files with naive local timestamps need the
  server started with `--naive-tz local`.
- **An encrypted `.cttc-metric` won't open** — you need the *private* key of the
  keypair it was encrypted for; a name from `~/.cttc/keys/` or a pasted PEM
  both work at the prompt. If that private key was deleted, the file cannot
  be recovered.
- **Host telemetry for a remote host shows an error** — host sampling
  supports the local daemon and `ssh://` hosts (Linux `/proc` on the remote
  side); `tcp://` daemons are not supported for host vitals.
- **A remote gateway won't reconnect** — CTTC falls back to an SSH tunnel
  automatically; if that also fails, check that the SSH key/host in **Edit
  Gateway** is still correct and that the remote Docker daemon is running.
