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
  - [Loading and switching data files](#loading-and-switching-data-files)
  - [Opening files from the command line](#opening-files-from-the-command-line)
  - [Removing or disconnecting the Docker Host](#removing-or-disconnecting-the-docker-host)
- [Reading the telemetry](#reading-the-telemetry)
  - [Metric strips](#metric-strips)
  - [The container legend](#the-container-legend)
  - [Density lanes](#density-lanes)
  - [Host telemetry](#host-telemetry)
- [Navigating time](#navigating-time)
  - [Live-following and the "now" line](#live-following-and-the-now-line)
  - [Live tracking](#live-tracking)
  - [The cursor and the highlight window](#the-cursor-and-the-highlight-window)
  - [Zooming and panning](#zooming-and-panning)
  - [The timeline navigator](#the-timeline-navigator)
  - [The status bar](#the-status-bar)
- [Working with logs](#working-with-logs)
- [Snapshots](#snapshots)
- [Recording](#recording)
- [Capturing and sharing metrics (.cttc-metric)](#capturing-and-sharing-metrics-cttc-metric)
- [Exporting metrics as text or JSON](#exporting-metrics-as-text-or-json)
- [Automating with events](#automating-with-events)
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
- **Docker Host** — the *target* whose containers/services you want
  telemetry and logs from. It can be the same machine as the gateway, or a
  different one reached over `ssh://`. Don't confuse the two: you can be
  connected to a gateway running on your laptop while it collects from a
  Docker host on a completely different server, or vice versa.
- **Source** — anything that feeds the timeline: a followed container log,
  a `docker stats` collector, a host-telemetry collector, or an opened file.
- **Cursor** — the currently selected point in time. Click anywhere on a
  chart or density lane at time *t* and **every log panel jumps to its
  entries at *t***, highlighting the ± highlight window around it.
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

With no sources open, **New Docker Host…** (sidebar → Docker Host) attaches
to a Docker host; or use **Load Data…** (sidebar → Analysis) to open a saved
`.cttc-metric` or `.cttc-record` file instead.

If you collected from Docker before, the app **restores those collections on
launch** automatically.

Hover any control for a short built-in hint. The manual is one click away
from the sidebar's **About CTTC** panel and the toolbar's `?` buttons — see
[Getting help](#getting-help).

## The sidebar

The sidebar (visible on the left in the screenshot under
[The main window](#the-main-window)) groups every action into four
collapsible sections, plus a flat **Preferences** entry:

- **Gateway** — New Gateway…, Edit Gateway, Uninstall Gateway… (see
  [Connecting to a Gateway](#connecting-to-a-gateway)).
- **Docker Host** — New Docker Host…, Edit Docker Host, Disconnect Docker
  Host, Remove Docker Host… (see [Adding sources](#adding-sources)).
- **Events Capture** — Create Event…, Edit Events… (see
  [Automating with events](#automating-with-events)).
- **Analysis** — Load Data…, Opened Data… (see
  [Loading and switching data files](#loading-and-switching-data-files)).
- **Preferences** — one entry opens the combined Settings/Appearance dialog
  (see [Live-following and the "now" line](#live-following-and-the-now-line)
  for the now-line's color/style controls, and
  [The cursor and the highlight window](#the-cursor-and-the-highlight-window)
  for the Time window field); it opens on the Appearance pane, switch to
  Settings from the pane list on the left.

Click a section's header to expand/collapse it; click its chevron or title
again to collapse. Below the sections, **About CTTC** and **Quit** are
always visible.

The bar itself can be:

- **docked** to the left or right edge of the window, or **detached** into
  its own floating window — use the small dock-position buttons at its top.
- **collapsed** to a thin rail (the ◂/▸ button at the top-left of the bar)
  when you want the chart area at full width; every section hides, leaving
  just the rail to expand it again.
- **resized** by dragging the thin splitter between the bar and the main
  content — the width is remembered independently of which edge it's
  currently docked to.

## The main window

![The CTTC main window: the cursor sits on a c3_worker spike; both log
panels have jumped to that moment, highlighting the ± highlight window,
with ERROR and WARN rows edge-colored, and the dotted "now" line visible on
the charts](docs/images/app-overview.png)

From top to bottom:

1. **Toolbar** — recording transport (⏺/⏸/⏹/⏏, see
   [Recording](#recording)), the **frequency** control (labelled
   *Frequency* — how often, in seconds, telemetry/logs are actually polled
   from the Docker host; not to be confused with the ± highlight window
   around the selected time, which is a separate, independently
   configurable value — see
   [The cursor and the highlight window](#the-cursor-and-the-highlight-window)),
   the Live tracking toggle, the 〜/▤ chart-style switch, the current
   **view range**, and the cursor's UTC readout — see
   [The status bar](#the-status-bar). While a loaded metrics/recording file
   is the active view (see
   [Loading and switching data files](#loading-and-switching-data-files)),
   the toolbar switches into **analysis mode**: the recording transport and
   live-only controls hide, a **metric(s)** dropdown appears to switch
   between a multi-segment recording's segments, an **export** icon opens
   [Exporting metrics as text or JSON](#exporting-metrics-as-text-or-json),
   and a **Back to live tracking** button returns to live data.
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
   highlight window, and `c3_worker` shows why the spike happened —
   edge-colored `WARN job … slow` and `ERROR … OutOfMemoryError` rows. A log
   panel's own **✕** hides it (and its matching legend entry) without
   stopping collection — see [The container legend](#the-container-legend).
7. **Status bar** (bottom, not shown above — toggle in **Preferences →
   Appearance → Show status bar**, on by default) — recording/analysis-mode
   indicators, event notifications, the Gateway and Docker Host status
   pills, and a **History** button. See
   [The status bar](#the-status-bar) for what each of these does.

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

The gateway stores everything it collects in Redis — its sole data store, no
in-memory fallback. When Docker is available on this machine, **the first
time the app ever runs** you're asked to choose how the embedded gateway
should run: **as a container** (recommended — self-contained, bundles its
own Redis, matches how CTTC runs in production) or **natively** (runs
directly as a process on this machine; requires `redis-server` to already be
installed and on this machine's `PATH`, the same way the container-free
embedded server has always required `uv`). That choice is remembered — you
won't be asked again unless you delete `~/.cttc/connection.json`. If Docker
isn't available at all, the embedded server always runs natively and this
choice never comes up.

Redis itself is reachable directly (not just through the gateway's own API)
on `127.0.0.1:56379` by default (`redis-cli -p 56379`, RedisInsight, etc.),
in both modes — useful for inspecting what's actually stored. Loopback-only,
no password, same trust model as everything else this app runs locally.
Configurable via server.py's `--redis-port` flag if 56379 ever collides with
something else on your machine.

That data now **survives a restart** — a graceful shutdown snapshots it to
disk, and even an ungraceful crash loses at most a second or two of the most
recent writes. Retention defaults to 3 days (`--redis-ttl-seconds`); how
often new data is actually saved defaults to every second
(`--redis-flush-interval-seconds`, live-adjustable without a restart) and
where it's saved defaults to a folder next to the server
(`--redis-data-dir`) — in a container, that folder needs to be on a
host-mounted volume (already set up in the bundled `docker-compose.yml`) or
it's lost whenever the container itself is recreated, same as any other
container storage.

**New Gateway…** (sidebar → Gateway) walks through adding a remote one:
host, SSH key (a file already on this machine, or paste one directly), and
which gateway image to use (a registry reference, or a local tarball for
offline installs). **Skip — use this machine** bypasses all of this and
uses local Docker (or the embedded server if Docker isn't available), per
the choice above.
**Edit Gateway** re-opens that same form for an existing entry — **"This
machine"** (the embedded/local gateway) is never listed here, since it has
no connection settings to change and can't be uninstalled; it's always
available from the status bar's gateway status pill instead (see
[The status bar](#the-status-bar)), which switches between every gateway
you've connected to, including it.

**Uninstall** stops and removes the gateway's container **and its image**
(not just the container), streaming progress to the same activity log New
Gateway uses. If it reports an error, it also checks — and logs — whether
the container is actually still there, since `docker compose down` can
exit non-zero after partially succeeding.

Editing or uninstalling the gateway you're **currently connected to** while
a [recording](#recording) is running warns first — it will be abandoned,
unsaved, since the gateway it was capturing from won't be the one you end
up on.

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

![The New Docker Host dialog: docker host field and the Fetch Sources button
that lists containers/services to follow](docs/images/dlg-set-sources.png)

Only one Docker host can be watched at a time, so **New Docker Host…** is
only enabled while none is defined yet — once one's set, use **Edit Docker
Host** (or **Remove Docker Host…** first) instead of starting a second one.

**New Docker Host…** attaches to a Docker host. Leave the host field
empty for the local daemon (or the gateway's own host, if you're connected
to a remote gateway). CPU/MEM/NET telemetry — both per-container
(`docker stats`) and for the host machine itself — is always collected
once a daemon is set, on the poll interval set by the toolbar's/Settings'
**Frequency** field (default 5s, live-adjustable); there's no separate
opt-in for it. Only *selected* containers (see below) are actually
*plotted*; the rest wait in the legend's *others* group (see
[The container legend](#the-container-legend)).

Click **Fetch Sources** to list the running containers and swarm services
for the entered host, grouped under **"Swarm services"** and
**"Containers"** headings. **Nothing is ticked by default** — pick exactly
what you want followed and plotted; ticking an item both starts following
its logs (`docker logs -f -t`, or `docker service logs -f -t` for swarm
services) *and* marks it *selected* so its telemetry plots immediately. You
can always right-click a container later to track it (see
[The container legend](#the-container-legend)). **Click a group's own
heading** to select or deselect every checkbox in that group at once (a
partially-ticked group selects all first, rather than deselecting).

**Connect Docker Host**/**Update Docker Host** stays disabled until at
least one container or service is actually checked — with nothing
ticked there's nothing to collect.

An already-followed container or service looks exactly like any other
entry in the list — same color, still enabled — the only cue is a **✔**
mark next to it if it's currently ticked. Ticking/unticking toggles that
mark live. Ticked transforms (see [Transforms](#transforms)) apply to the
new log sources. **Connect Docker Host** syncs exactly to what's checked
here, and — on every successful **Connect**/**Update Docker Host** —
remembers exactly which containers/services were ticked in a small file
at `~/.cttc/[user]@[gateway]-containers.json` (one file per Docker host
you connect to), so this daemon's selection survives closing and
reopening the dialog, and even relaunching CTTC. That same submit also
updates every entry's legend/graph tracking state to match exactly
what's ticked — a newly-ticked container starts plotting immediately,
and one you just unticked stops being selected right away, rather than
staying stuck in the graph until separately unselected from the legend.

**Edit Docker Host** and **Remove Docker Host…** are only enabled once
a daemon is actually being watched — nothing to edit or remove otherwise.
Once one is set, **Edit Docker Host** re-opens this same form with the
host and SSH key pre-filled and locked, **Fetch Sources** relabelled
**Refresh Sources** (just re-probes for new containers/services rather than
starting over), and the bottom button relabelled **Update Docker Host**.
Opening it immediately runs that same live probe on its own — you don't
have to remember to click Refresh Sources yourself for the checklist to
reflect what's actually running right now. It also gains a **Load Docker
Host** dropdown, listing any previously used (currently disconnected)
Docker hosts — picking one pre-fills its SSH key and last-selected
containers and immediately re-probes it live, letting you reconnect to a
past host without retyping its connection details.

Opening **Edit Docker Host** reads that daemon's
`[user]@[gateway]-containers.json` file first, and the checklist is built
from it, not from whatever happens to be open in this session:

- anything listed in the file — ticked with a **✔**, indistinguishable
  otherwise from any other entry; unticking it removes the ✔, ticking it
  back re-adds it;
- anything *not* listed in the file — unticked, even if it's still being
  followed from an earlier session (e.g. previously unselected from the
  legend) — the file, not "is a log source open for it", is what decides
  the starting tick;
- **gone** (stopped/removed) *and* listed in the file — stays **listed,
  disabled, and marked 🚫**, with a "no longer available" note, instead of
  silently vanishing; its source is closed automatically, removing it from
  the graph — Update Docker Host isn't needed for that part;
- **gone** and *not* listed in the file — simply **omitted** from the
  checklist entirely, nothing to flag;
- **new** — appears unticked (nothing is preselected just for being found);
- anything you've since checked/unchecked yourself, still there and
  unchanged server-side, keeps exactly that — Refresh never discards an
  in-progress edit.

Clicking **Connect**/**Update Docker Host** rewrites
`[user]@[gateway]-containers.json` to match exactly what's ticked (and
not disabled) at that moment — this is the "on the way out" save that
Edit Docker Host reads back next time.

### Remote hosts over SSH

Enter `ssh://user@host` (optionally `:port`) as the **Daemon host ssh
connection string**. An **SSH
key** selector appears listing the private keys found in `~/.ssh` — pick one,
choose *default* to use your ssh config / agent, or *browse…* for a key file
elsewhere. The choice is remembered per host.

Container logs and stats, and host telemetry (read from the remote's
`/proc`), all go over that same SSH connection.

### Loading and switching data files

**Load Data…** (sidebar → Analysis) opens one or more `.cttc-metric` files
(see [Capturing and sharing metrics](#capturing-and-sharing-metrics-cttc-metric))
or `.cttc-record` files (see [Recording](#recording)) previously captured
with the app. They open as **static** sources: their series draw grayed and
dashed, their log panels carry a *sample* badge, and the legend gains one
switch per loaded file to show/hide everything from that file at once.
Loading any such file switches the whole app into **analysis mode** — see
[The main window](#the-main-window)'s toolbar item.

**Opened Data…** (sidebar → Analysis, or File menu) lists every
`.cttc-metric`/`.cttc-record` file currently open; click one to switch the
active view to it without re-picking or re-uploading it, or use its
**Remove** button to close a file from memory (without touching it on disk).

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

### Removing or disconnecting the Docker Host

**Disconnect Docker Host** (sidebar → Docker Host) closes every open source
for the current daemon and stops it auto-reconnecting on the next launch,
but **keeps** its saved connection, SSH key, and selected containers — it
still appears in **Remove Docker Host…** and in **Edit Docker Host**'s
*Load Docker Host* list, so reconnecting to it later doesn't mean
retyping everything.

**Remove Docker Host…** (sidebar → Docker Host) permanently forgets a saved
daemon: pick which one from the list, and its connection, SSH key, and
selected containers are deleted for good — unlike Disconnect, this cannot
be undone by reconnecting to it.

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

![The Appearance pane: Mode (Light/Dark/System), Log highlight color, the
"Now" line's color and Dotted/Dashed/Solid switch, Live tracking's color,
Recording capture's color and Sprocket holes toggle, and the Show status
bar toggle](docs/images/dlg-appearance.png)

### Live tracking

Enabled by default (toolbar and Settings both have a switch to turn it
off), **Live tracking** simulates a click on the graph at *now + N
seconds* on every refresh, but only while the view is actually following
live — panning away to look at history leaves it alone rather than
yanking your view back. *N* defaults to 0 (track exactly now) and is
never positive — the future has no data to show yet — so it only ever
looks at now or slightly behind it, e.g. `-5` to allow for a bit of
log-shipping delay. Set it in the toolbar's **Live tracking** field or
**Settings → Live tracking**.

Unlike a manual click, a Live-tracking-driven cursor renders as a soft
**green bar** on the charts (not the usual thin accent line), and log
entries within the highlight window around it are highlighted in the same
color instead of the ordinary highlight color — both a visual cue that
this position was picked automatically, not by you. That color is
configurable in **Preferences → Appearance → "Live tracking"**, right
after the "Now" line section, the same way as the now-line's own color.

### The cursor and the highlight window

Click any chart or lane to place the **cursor** at that time: every log
panel scrolls to its entry nearest the cursor, and entries within the
**highlight window** (± N seconds, set in **Preferences → Settings → Time
window** — not the toolbar's *Frequency* field, which controls the
Docker polling rate instead, see [The main window](#the-main-window)) are
highlighted. Clicking a log row moves the cursor to that row's time
instead. The highlighted log rows' color is configurable in **Preferences
→ Appearance → Log highlight color**.

### Zooming and panning

- **Drag** across a chart or lane to zoom into the selection (blue band).
- **Mouse wheel / trackpad scroll** over a chart or lane zooms in/out,
  anchored on the point under the cursor (ctrl/cmd+wheel is left alone for
  the OS's own page-zoom gesture). Hover a chart for a tooltip spelling out
  all three gestures.
- **Double-click** to re-center the view on that time, keeping the span.
  Like any pan/zoom, this pauses live-following; if it was on, **Live
  tracking** resumes on its own after a configurable delay
  (**Preferences → Settings → Live tracking → Double-click resume**,
  default 10s — set to 0 to stay paused until you click "now" yourself).
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

The **toolbar's** right-hand side shows both **the current view range**
(its start and span, e.g. `view: 2026-07-27 15:30:26 UTC + 10m`) and **the
cursor's exact time**, so you always know both what window you're looking
at and where the cursor sits within it — not just one or the other.

A separate, optional **status bar** runs along the bottom of the window
(**Preferences → Appearance → Show status bar**, on by default). Left to
right:

- a **live/analysis mode icon** and, while [recording](#recording), a
  blinking recording indicator;
- a **notification area** for transient messages (event fired, action
  confirmed, connection lost/restored…) — how long these stay visible is
  configurable in **Preferences → Settings → Status Bar**;
- the **Gateway status pill** — a colored dot for reachability; click it to
  switch between every gateway you've ever connected to, or right-click for
  **New Gateway…**, **Edit Gateway**, **Uninstall Gateway…**, and
  **Current Status** (connection type, host, and — for a remote/tunneled
  gateway — its SSH target and forwarded port);
- the **Docker Host status pill** — the same pattern, for the currently
  watched Docker host;
- a **History** button showing a running log of recent events (connects,
  errors, event triggers, etc.), with a **Clear** button of its own.

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

A snapshot always covers host telemetry (when collected) plus every
currently **selected** container — not unselected/hidden ones (see
[The container legend](#the-container-legend)). Options in the snapshot
dialog:

- **Include nearby log entries**;
- **panorama** — enlarge the snapshot around the chosen time: by *entries*
  (wider log context per source) or by *seconds* (adds full extra slices N
  seconds before and after, for side-by-side comparison).

View the result as a **Raw** table or as **JSON**, and save it with
**💾 Save as TXT…** / **💾 Save as JSON…**.

## Recording

The toolbar's transport (⏺ **Start**, ⏸ **Pause**, ⏹ **Stop**, ⏏ **Open
Recording…**) captures live telemetry and logs into a `.cttc-record` file
for later analysis — a tape-recorder-style span of live time, as opposed to
[a snapshot](#snapshots) (one instant) or
[capturing metrics](#capturing-and-sharing-metrics-cttc-metric) (a range you
select after the fact).

- **⏺ Start** begins recording immediately — there's no save-path prompt
  yet, so starting never interrupts you before you know how long you'll be
  recording.
- **⏸ Pause**/**⏺ Start again** can be repeated any number of times; each
  Record-to-Pause span becomes its own segment in the same recording, with
  genuine gaps (not interpolated) for the paused stretches in between.
- **⏹ Stop** finalizes the recording, then asks where to save it. If you
  cancel that save prompt (or it fails), the recording stays in a
  *stopped, not yet saved* state — click **⏹ Stop** again to retry the save
  without losing or re-capturing anything.
- **⏏ Open Recording…** opens one or more previously saved `.cttc-record`
  files — the same way as [Load Data…](#loading-and-switching-data-files).

If CTTC closes or crashes while a recording is in progress (not a clean
Pause/Stop), the next launch offers a choice instead of silently leaving it
paused:

- **Resume from the interruption point** continues the same segment from
  where it was interrupted — whatever telemetry was actually captured in
  the meantime is picked up the next time you Pause or Stop; anything
  genuinely missing (never collected, or past the retention window) stays
  an honest gap.
- **Resume from now** starts a fresh segment at the moment the app
  restarted, leaving the interruption itself as a gap.
- **Decide later** leaves the recording paused, exactly as before — Resume
  and Stop stay available from the toolbar.

While recording, a band marks the captured time range(s) on every chart
strip and log density lane. Its **color** is configurable in
**Preferences → Appearance → "Recording capture"**, live-previewed as you
adjust it; the same section's **sprocket holes** toggle adds a film-strip
motif on top of it (strips only, not density lanes): rounded-rect
perforations bookending each CPU/MEM/NET strip group — along the top of its
first (CPU) strip and the bottom of its last (NET) strip, not repeated on
every strip in between — plus faint **frame-division lines**, one every
third perforation, running the full height of every strip in the group
(including MEM, which has no perforations of its own) so they read as one
continuous line down the whole group rather than just bookending it.

Loading or recording data switches the app into **analysis mode** (see
[The main window](#the-main-window)): the live-only toolbar controls hide,
and a **Back to live tracking** button returns you to live data — your
place in analysis mode is remembered so returning to it later picks up
right where you left off.

Editing or removing the **active** Gateway or Docker Host while a recording
is in progress, paused, or stopped-but-unsaved warns first and, if you
confirm, discards it — the data it was capturing no longer corresponds to a
stable source once that Gateway/Docker Host changes out from under it.

## Capturing and sharing metrics (.cttc-metric)

To save a time range for later analysis or to share it:

1. **Shift+drag** or **Ctrl/Cmd+drag** across the charts (or right-click →
   **✂ Capture metrics**, then drag) — the selection shows as an orange band.
2. In the **Save metrics** dialog choose whether to include host telemetry
   (if it isn't being collected yet, ticking the box starts it for future
   captures).
3. Pick a destination — you get a single **`.cttc-metric`** file containing the
   logs *and* metrics of every open source, sliced to the selected range.

A `.cttc-metric` file is a zip: a manifest, one JSONL file per log source, and the
per-service metric series (host flag and swarm info preserved).

Load a `.cttc-metric` back with **Load Data…** — see
[Loading and switching data files](#loading-and-switching-data-files) for
how sampled data is displayed.

## Exporting metrics as text or JSON

While a loaded metrics/recording file is the active view (see
[The main window](#the-main-window)'s toolbar item), **Export Metrics…**
(File menu, or the toolbar's export icon next to the metric(s) dropdown)
exports that **entire file's** stats and/or logs as a flat text or JSON
file — covering its whole time range, not just the current zoom/pan window.
This is a different feature from [capturing metrics](#capturing-and-sharing-metrics-cttc-metric)
above, which slices a *live* time range into a new `.cttc-metric` file;
Export Metrics instead flattens an *already-captured* file into a
plain-text/JSON report for reading or sharing outside CTTC.

1. Choose what to include: **Stats** (CPU/MEM/NET telemetry) and/or
   **Logs**.
2. Choose the format: **Text** or **JSON**; for stats, also choose
   **Summary** (per-container min/avg/max over the whole file) or
   **Full time series** (every recorded sample).
3. **💾 Export…** saves the result.

## Automating with events

**Create Event…** (sidebar → Events Capture) watches CPU/MEM/NET thresholds
or a log regular expression on chosen systems, and automatically **takes a
snapshot** or **starts a recording** (see [Recording](#recording)) the
moment the condition is met — it keeps watching until you disable or
delete it.

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
checkbox in the **New Docker Host…**/**Edit Docker Host** dialog. Modules are reloaded every time
sources are opened — edit and re-add, no restart needed.

```python
def transform(record):   # {"ts": epoch_ms, "text": str, "fields": dict, "source": str}
    ...
    return record        # or a list of records (fan-out), or None to drop the line
```

Shipped examples: `parse_level` (tags `fields["level"]`),
`drop_healthchecks` (drops noisy probe lines), `json_message` (renders JSON
log lines as `LEVEL logger: message`). **`json_message` and `parse_level`
are ticked by default** — turning raw JSON lines and bare level tagging
into something readable is the common case, not an opt-in; everything
else (like `drop_healthchecks`) stays opt-in. A Refresh preserves
whatever you've actually ticked/unticked yourself, rather than resetting
back to those defaults. A crashing transform never kills ingestion — the
error is recorded on the affected record instead.

## Interactions reference

| Action | Effect |
|---|---|
| click chart / lane | set cursor at t; all panels jump to t and highlight the ± highlight window |
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
| toolbar Frequency field | how often telemetry/logs are polled from the Docker host |
| Settings → Time window | size of the ± highlight window around the cursor |
| ⏺/⏸/⏹/⏏ recording transport | start/pause/stop/open a `.cttc-record` recording |
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
| click a group heading in the Docker Host checklist | select/deselect every item in that group |
| click the Gateway/Docker Host status pill (status bar) | switch between gateways / hosts |
| right-click the Gateway/Docker Host status pill (status bar) | New/Edit/Uninstall/Remove, or Current Status |

## What is remembered between launches

Chart style, strip height, host-panel visibility, container tracking states,
log ordering, panel positions, the *others* list state, per-host SSH keys,
your docker collections (restored automatically at startup; cleared by
Remove Docker Host…, but kept — just not auto-reconnected — by Disconnect
Docker Host, see
[Removing or disconnecting the Docker Host](#removing-or-disconnecting-the-docker-host)),
the sidebar's dock position/collapsed state/size, the "now" line's color and
style, the highlight-window color, the recording capture-range band's color
and its sprocket-holes toggle, whether the status bar is shown, the
toolbar Frequency (poll interval), the highlight window size, Live tracking's
on/off state and offset, the double-click live-tracking resume delay, and
how long status-bar notifications stay visible.

## Scripting the server

The app is backed by a local HTTP server (bound to `127.0.0.1` only; the
port is printed on startup). All timestamps are epoch milliseconds.

```
GET  /health · /sources · /transforms · /ssh/keys · /range
     /series?from&to&px · /logs?source&start&count · /point?t
     /stats_export · /index_at?source&t · /ticks?source&from&to&px
     /logs/find?source&q&start&dir · /files/download · /events (SSE)
     /logs/rate · /mlog · /events/list · /events/{id}
     /scheduler/{id} · /session/{id}/status · /session/{id}/download
POST /open · /close · /docker/ps · /docker/collect · /docker/forget
     /sample/export · /sample/record · /files/upload · /logs/rate
     /buffer/start · /buffer/{id}/pause · /buffer/{id}/stop
     /session/start · /session/{id}/stop · /session/{id}/safe
     /session/ttl · /scheduler/create · /scheduler/{id}/cancel
     /events/create · /events/{id}/enable · /events/{id}/disable
     /events/{id}/reset · /events/{id}/update · /events/{id}/cancel
     /shutdown
```

Highlights:

- `/series` entries carry `host` (host-telemetry flag), `sid` (source id)
  and `ttype` (`container` | `service`).
- `/logs/rate` (`GET`, or `POST` with `{"seconds": n}`) reads/sets how often
  the durable store is actually flushed to disk — see [Connecting to a
  Gateway](#connecting-to-a-gateway). A `POST` broadcasts the change over
  `/events` so every connected client picks it up immediately.
- `/docker/collect` accepts `host`, `stats`, `host_stats`,
  `logs: [{name, type}]`, `transforms`, `interval`, `ssh_key`.
- `/sample/export` takes `{path, from, to, include_host}` and produces a
  `.cttc-metric` file — see
  [Capturing and sharing metrics](#capturing-and-sharing-metrics-cttc-metric).
- `/sample/record` is the byte-oriented endpoint behind
  [Recording](#recording) — each segment flush POSTs the existing
  `.cttc-record` bytes plus an `{from, to}` range and gets back the merged
  archive.
- `/events/create` and its siblings (`/events/list`, `/events/{id}`,
  `/events/{id}/enable|disable|reset|update|cancel`) are what
  [Automating with events](#automating-with-events) uses under the hood —
  scriptable directly if you'd rather not use the dialog.
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
  **Preferences → Settings → Danger → Hard Reset** closes every open source
  and erases every saved CTTC preference on this machine (track states,
  panel positions, sidebar layout, theme, docker/ssh-key associations,
  everything), then reloads the app to boot exactly like a brand-new
  install. This cannot be undone — it does not touch your `.cttc-metric`/
  `.cttc-record` files or gateways, only CTTC's own cached UI state.
- **Reporting a problem and need diagnostic logs** — enable **Preferences
  → Settings → Collect CTTC Own Logs**, pick a folder, and CTTC writes its
  own timestamped `.cttc-log` files there; the same panel's **Ship logs**
  button packages them up to attach to a report.
- **"could not start server via uv"** — install
  [uv](https://docs.astral.sh/uv/); it provisions the server's Python
  environment on first run.
- **"redis-server is required to run CTTC's embedded server..."** — the
  embedded gateway needs `redis-server` on PATH too, the same way it needs
  `uv` (Redis is the sole store for logs/telemetry now, not just a cache —
  see [Scripting the server](#scripting-the-server)). Install Redis (e.g.
  `brew install redis` on macOS, `apt install redis-server` on
  Debian/Ubuntu) and relaunch. Not needed for the local-Docker-container or
  remote-gateway modes, which already bundle it.
- **The gateway refuses to start, citing a corrupt or unreadable
  persistence file** — its saved data (in the folder from
  `--redis-data-dir`, see [Connecting to a Gateway](#connecting-to-a-gateway))
  didn't survive whatever stopped it last time cleanly enough to reload.
  This fails loudly on purpose rather than silently starting empty. Moving
  or deleting that folder's contents starts a fresh, empty store on the
  next launch — everything in it is otherwise unrecoverable.
- **"docker CLI not found on PATH"** — install the docker CLI, or use the
  app on files / `.cttc-metric` metrics only.
- **The app opens as a plain terminal process / nothing appears** (VS Code
  terminals) — the extension host exports `ELECTRON_RUN_AS_NODE`, which
  turns Electron into plain Node. Unset it (`task start` already does).
- **Timestamps look shifted** — files with naive local timestamps need the
  server started with `--naive-tz local`.
- **Host telemetry for a remote host shows an error** — host sampling
  supports the local daemon and `ssh://` hosts (Linux `/proc` on the remote
  side); `tcp://` daemons are not supported for host vitals.
- **A remote gateway won't reconnect** — CTTC falls back to an SSH tunnel
  automatically; if that also fails, check that the SSH key/host in **Edit
  Gateway** is still correct and that the remote Docker host is running.
