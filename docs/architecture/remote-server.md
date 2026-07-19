# Running the CTTC server remotely (no local Docker required)

**Status:** phases 1-3 (SSH-tunnel transport + server container; collector
de-duplication; file transfer) implemented on
`feature/remote-server-ssh-tunnel`. Phases 4-5 below are still design only.
See [Using phase 1](#using-phase-1) for how to actually run it.

## Product context this design has to preserve

CTTC's entire value proposition is **correlating log entries with metrics**
— letting someone see that this CPU/MEM/NET spike lines up with that error
burst, and infer which app/container actually caused an incident. Every
decision below is judged against one question: *does this keep every
metric and every log entry the user is looking at on one honest, shared
timeline, with nothing missing and nothing duplicated?* That's the real
reason "one collector per host, never two" and "close the duplication race"
matter in [Single collector, multiple viewers](#single-collector-multiple-viewers)
— two overlapping collectors for the same container wouldn't just be
untidy, they'd hand the user two slightly-different CPU curves for one
container and no way to know which is real, which is exactly the kind of
ambiguity that breaks the "infer causal impact" use case this tool exists
for.

## Problem

Today, CTTC is one Electron process that spawns a local Python server as a
child process and talks to it on `127.0.0.1`. That server shells out to the
`docker` CLI to list/poll containers and follow logs. This means **every
machine running the Electron app needs Docker CLI (and `uv`/Python)
installed locally.**

Some client machines can't have Docker installed — licensing restrictions,
locked-down corporate images, etc. — but there's usually still a host
*somewhere* in reach that does have a Docker daemon (a build server, a
shared dev box, a bastion). The ask: run the server as a container on that
Docker-enabled host, and have Electron on the license-restricted machine
connect to it over the network instead of spawning it locally — **with as
little change as possible to the current UI and interaction flow.**

## Current architecture (for reference)

- [main.js](../../app/main.js) `startServer()` spawns
  `uv run --project server server.py --port 0 [files...]`, reads one JSON
  line (`{"port": N}`) off stdout, then `win.loadFile(index.html, {search:
  "port=" + N})`.
- [renderer/app.js](../../app/renderer/app.js)`:6` derives
  `API = http://127.0.0.1:${port}` from that query param — every fetch and
  the `/events` SSE connection go through this one constant.
- [renderer/index.html](../../app/renderer/index.html)`:5-6` hardcodes a CSP
  `connect-src http://127.0.0.1:* http://localhost:*` — the renderer is
  *only allowed* to talk to loopback.
- [server.py](../../app/server/server.py) binds
  `ThreadingHTTPServer(("127.0.0.1", port), ...)` (`:1422`) and sends
  `Access-Control-Allow-Origin: *` — there is **no authentication at all**.
  This is deliberate and safe *only* because the server is unreachable from
  anywhere but the same machine.
- `docker_cmd()` (`:531`) builds `[docker, -H, host?]`; every collector
  (`DockerStatsSource`, `DockerLogSource`, `HostStatsSource`, `docker_ps`)
  shells out to that binary via `subprocess`. `HostStatsSource` also has an
  ssh-based `/proc` sampler for when the *target* is a different host than
  the one `server.py` runs on.
- On quit, `main.js` POSTs `/shutdown` and kills the child process — it
  assumes it's the sole owner of that server instance.

Every one of those facts matters for what changes and what doesn't.

## Decisions

Two of the open questions below have been answered, and both sharpen the
design:

1. **One collector per monitored system, shared by every viewer.** Not
   one container per client. See
   [Single collector, multiple viewers](#single-collector-multiple-viewers).
2. **File transfer needs real upload/download endpoints**, designed as a
   separable module from day one so it can be split into its own
   container later if it needs to scale independently. See
   [File transfer](#file-transfer-upload--download--implemented). This also surfaced a
   real security gap in the *existing* encryption-key design that needs
   fixing as part of this work — see
   [Encryption keys need to move client-side](#encryption-keys-need-to-move-client-side).

## Two candidate architectures

### A. SSH tunnel to a remote server container (recommended default)

Electron still connects to `127.0.0.1:<port>` exactly as it does today —
but that port is now a local end of an SSH port-forward
(`ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>`) into the Docker-enabled
host, where the server container's port is *not* exposed to the network at
all (bound to the container's loopback or a firewalled internal port).
`main.js` manages the `ssh` child process the same way it manages the `uv`
child process today.

**Why this is the low-change option:** the server's `127.0.0.1`-only bind,
the CSP `connect-src`, the zero-auth model, and every line of
`renderer/app.js` stay **exactly as they are**. The trust boundary the code
already assumes ("only my own loopback can reach this") continues to hold —
it's just that loopback now has an encrypted tunnel behind it instead of a
local process. `docker` CLI calls inside the container talk to a
Unix-socket-mounted daemon, so `docker_cmd(host=None)` — the existing
default, no-ssh-host path — is what actually runs; none of the collector
code changes either.

Trade-offs: requires SSH access (a keypair, network reachability to port
22 or whatever's configured) from the client machine to the Docker host.
If the client environment blocks outbound SSH too, this doesn't work — see
option B.

### B. Direct network connection with a token + TLS

Electron connects straight to `https://docker-host:8765` (or plain
`http://` on a trusted private network). This needs real changes, because
the server stops being a same-machine, zero-trust process:

1. **Auth.** Add a shared-secret bearer token: `--token` / `CTTC_TOKEN` on
   the server, `Authorization: Bearer <token>` on every renderer request.
   The `/events` SSE endpoint can't set headers from `EventSource`, so it
   needs a `?token=` query-string fallback.
2. **Bind-address safety catch.** Add a `--bind` flag (default stays
   `127.0.0.1`); refuse to bind non-loopback unless a token is configured,
   so this can't be exposed unauthenticated by a config mistake.
3. **CSP.** `connect-src` in `index.html` needs to allow the remote origin.
   Since `loadFile` bakes a static CSP meta tag, the cleanest fix is
   generating that origin into the page at load time (or moving the CSP to
   a response header set via `session.webRequest.onHeadersReceived`, which
   can be computed per-launch from config).
4. **TLS.** The server itself has no TLS; terminate it in front (Caddy,
   Traefik, nginx, or a cloud load balancer) rather than adding a
   certificate story to `server.py`.
5. **CORS** can stay `*` since the token is the actual gate, but it's worth
   tightening once a real deployment story exists.

Trade-off: several new, security-sensitive lines of code, and an
operational TLS/token story. Upside: works in environments that block SSH
but allow HTTPS egress.

**Recommendation:** ship A first (small, self-contained, no new attack
surface). Keep B documented as the fallback for SSH-hostile networks and
implement it only if a real deployment needs it.

## Containerizing the server

Either architecture needs the server running as a long-lived container on
the Docker-enabled host, independent of any Electron process. Implemented
as [server/Dockerfile](../../app/server/Dockerfile) and
[server/docker-compose.yml](../../app/server/docker-compose.yml) — a
distilled version:

```dockerfile
FROM python:3.12-slim
# docker CLI only (static binary, arch-matched via $TARGETARCH) + openssh-client
RUN ... curl -fsSL https://download.docker.com/linux/static/stable/${arch}/docker-*.tgz | tar -xz ...
RUN pip install --no-cache-dir uv
WORKDIR /srv/cttc-server
COPY pyproject.toml ./
RUN uv sync --no-dev   # uv treats "dev" as included by default; exclude it explicitly
COPY server.py transforms ./
EXPOSE 8765
ENTRYPOINT ["uv", "run", "--no-sync", "server.py", "--port", "8765"]
```

```yaml
# docker-compose.yml (on the Docker-enabled host)
services:
  cttc-server:
    build: .
    pid: host          # psutil sees the real host, not the container's cgroup
    network_mode: host  # NET counters match the host's interfaces, not veth0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - cttc-keys:/root/.cttc   # persist generated encryption keys
    restart: unless-stopped
volumes:
  cttc-keys:
```

Things worth calling out because they're easy to get wrong silently:

- **Static `docker` binary, not `docker-ce-cli` via apt** — Debian slim has
  no clean `docker-ce-cli`-only package without adding Docker's apt repo;
  downloading the static binary from `download.docker.com` and discarding
  `curl` afterward keeps the image lean and avoids pulling in package
  manager machinery for a full engine install this container never needs
  (it only ever talks to the *mounted* socket, never runs its own dockerd).
- **`uv sync --no-dev` is required, not optional** — verified by actually
  building the image: plain `uv sync` pulled in `pytest`/`pytest-cov`/
  `coverage` because uv treats a group literally named `dev` as included
  by default. Without `--no-dev` the "production" image silently ships
  test tooling.
- **`server.py` needed zero changes for this** — it still hardcodes a
  `127.0.0.1` bind. With `network_mode: host`, that loopback *is* the
  host's loopback, so the host's ssh tunnel reaches it exactly as if this
  were a same-machine embedded server. No `--bind 0.0.0.0` flag was added
  (there's deliberately nowhere for one to go).
- **Host telemetry accuracy.** `HostStatsSource._sample_local()` uses
  `psutil`, which by default reports the *container's* view (its cgroup
  limits, its network namespace), not the physical host's — exactly the gap
  `pid: host` + `network_mode: host` closes (the same technique
  node-exporter/cAdvisor-style agents use). Without both, host telemetry
  will silently report container-scoped numbers that look plausible but are
  wrong.
- **`.dockerignore` matters here more than usual** — without one, `.venv/`,
  `tests/`, `.pytest_cache/`, and `uv.lock` (all present in a normal dev
  checkout of `server/`) get sent to the docker daemon as build context
  even though nothing COPYs them in. Added
  [server/.dockerignore](../../app/server/.dockerignore); confirmed it
  drops the transferred context from megabytes to a few hundred bytes.

### Using phase 1

On the Docker-enabled host:

```sh
cd app/server
docker compose up -d --build
```

On the client machine, `~/.cttc/connection.json`:

```json
{
  "mode": "ssh-tunnel",
  "ssh_target": "deploy@docker-host.internal",
  "ssh_key": "~/.ssh/cttc_deploy",
  "remote_port": 8765
}
```

Then `npm start` as usual — nothing else changes. (Env vars `CTTC_MODE`,
`CTTC_SSH_TARGET`, `CTTC_SSH_KEY`, `CTTC_REMOTE_PORT` override the file, for
scripted deployment; see
[lib/connection-config.js](../../app/lib/connection-config.js).)

**Verified, not just built:** the whole pipeline was validated for real, not
only unit-tested — a standalone `server.py` instance was started, Electron
was launched in `ssh-tunnel` mode pointed at it through
[test/fixtures/fake-ssh.js](../../app/test/fixtures/fake-ssh.js) (a real
subprocess proxying real sockets, not a mock), and the renderer loaded real
telemetry and log data over that tunnel with a UI pixel-identical to
embedded mode. Separately, the container image itself was built and run
against a real Docker daemon: `docker ps` from inside the container
correctly matched the host's actual container list through the mounted
socket, the `/docker/ps` and `/sources` HTTP endpoints responded correctly
from within the container's network namespace, and host-telemetry sampling
produced real readings with `pid: host` + `network_mode: host` in place.

That first pass had one gap, specific to the *test* environment rather than
the design: on Docker Desktop for Mac, `network_mode: host` joins the
container to the LinuxKit VM's network namespace, not literally macOS's, so
external reachability from outside the VM couldn't be exercised there.

**That gap is now closed.** The full path was validated against a real,
separate Linux Docker host reached over the network (not Docker Desktop):
`server/` was `rsync`'d over, `docker compose up -d --build` run for real,
and Electron on a different machine connected to it purely by ssh'ing in —
no fake-ssh fixture this time, the actual `ssh` binary. Every layer was
real: an actual `docker exec ... docker ps` inside the deployed container
matched that host's real containers (itself plus two unrelated ones already
running there), and the app displayed real telemetry (including host CPU/
MEM/**NET numbers that reflected genuine network activity on that
physical machine**, the exact thing Docker Desktop's VM networking
couldn't prove) and 71 real log entries from a container on that host, all
over a real SSH tunnel across a real LAN.

This is also where a real bug turned up: `files.py` (added in phase 3) was
never added to the Dockerfile's `COPY` list, so the built image ran fine
locally (nothing in the build graph needed it) but crash-looped on start
with `ModuleNotFoundError` the moment `server.py`'s `import files` executed
— invisible to `docker build` succeeding, only visible once something
actually tried to *run* the container. Fixed by adding `files.py` to the
`COPY` line; re-verified with the same real-host deployment. Worth noting
as a general lesson for this Dockerfile going forward: a successful `docker
build` doesn't prove the image runs, only that the copied files were
syntactically fine to package — a fresh `docker compose up` (or at minimum
checking `docker logs` after one) is the actual test, and it's worth
re-running after any new local module lands, not just after the first one.

## The container's host doesn't have to be the monitored host — validated

Nothing above requires the machine running the CTTC server *container* to be
the same machine whose Docker daemon it's watching. That decoupling already
existed in the code before this remote-server work started —
`docker_cmd(host)` builds `[docker, -H, host]`, and `host` can be
`ssh://user@another-machine` just as easily as `None` (the local socket) —
but it had never actually been exercised with the CTTC server itself running
in a container, so it was worth proving rather than assuming.

Validated for real, across two genuinely separate physical machines: a CTTC
container built and run on one host (**no Docker socket mounted into it at
all** — just a single SSH private key), asked via `/docker/collect` to
monitor `ssh://user@a-completely-different-host`. Every layer of data came
back correctly from the *other* machine: `docker ps`-equivalent listing,
`docker stats` telemetry (6 samples), host telemetry over the existing
`HostStatsSource._sample_ssh()` path (2 samples — this is the *ssh-to-a-
different-host* sampler, not the `psutil`/`pid: host` one, and it's the one
that actually ran here), and real log entries (71) — all while the
container itself had zero local Docker awareness.

Practical implication for `docker-compose.yml`: the `/var/run/docker.sock`
mount there is only for the common case (container host *is* the Docker
host, the default in this repo's compose file). It's not required for this
topology — a deployment where the CTTC container runs somewhere lightweight
and only reaches out over `ssh://` to the real Docker host(s) needs no
socket mount at all, just an SSH private key made available to it (e.g. a
volume mount) and that key's path passed as `ssh_key` in `/docker/collect`
requests. Worth a follow-up compose variant if this topology turns out to be
common in practice, rather than everyone hand-rolling their own `docker run`
for it.

## Single collector, multiple viewers

The decision: for a given monitored system (a Docker host), there is **one**
gathering process — one server container polling that host's `docker
stats`, following its logs, sampling its vitals — and every Electron client
interested in that host connects to that same instance. No per-client
containers, no per-client collectors.

The good news: **most of what this needs already exists**, because
`server.py`'s `State` was never designed as single-user — it just happened
to only ever have one client because nothing else could reach it.

- **Per-viewer state already lives client-side, not server-side.**
  `state.track` (selected/hidden containers), `state.view` (zoom/pan),
  `state.cursorT`, chart style, strip height — all of it is
  `localStorage` in the *renderer*, not anything `server.py` tracks. Two
  people looking at the same server can independently zoom, select
  different containers, and scrub to different times without stepping on
  each other. Nothing to build here.
- **The shared, de-duplicated part is exactly what `State.sources` already
  is** — one `DockerStatsSource`/`DockerLogSource`/`HostStatsSource` per
  collected target, visible identically to every client via `/sources` and
  `/series`. A second client's *"Add sources"* dialog already calls
  `/docker/ps` + checks `openPaths()` against the live `/sources` list and
  marks already-open containers *"already added"* ([app.js
  `updateDockerDupes`/`listContainers`](../../app/renderer/app.js)) — so
  today, two simultaneous clients pointed at the same server already won't
  double-collect the same container, *as long as each has fetched
  `/sources` before submitting*.
- **The one real gap: a race.** If two clients open the dialog and hit
  *Add* within the same instant — before either has re-fetched
  `/sources` — `collect_docker()` currently has no server-side check and
  will happily start two `DockerStatsSource`/`DockerLogSource` pairs
  polling the same container. Low-probability, but "not duplicated as much
  as possible" means closing it rather than leaving it to client-side
  timing. Fix is small and self-contained: before creating a new
  `DockerStatsSource`/`HostStatsSource`/`DockerLogSource` in
  `State.collect_docker()`, check `self.sources` for an existing source
  whose `.path` matches the target being requested
  (`docker://{host}/stats`, `docker://{host}/host`,
  `docker://{host}/{type}/{name}`) and return its id instead of creating a
  duplicate. This is a pure server-side addition — no protocol change, no
  client change, and it also protects the single-client case (e.g. a
  double-click on *Add*, or `lastDockerSessions` restore racing a manual
  re-add after a crash).
- **Cross-host scope stays one-window-per-host.** If someone needs to watch
  two different Docker hosts at once, that's two Electron windows (or two
  `connection.json`s), each tunneled to its own server container — not a
  host-switcher inside one window. Keeps the "minimal UI change" goal
  intact; multi-host-in-one-window is a materially bigger feature
  (cross-server legend/merging) that nothing here requires.
- **Transport latency can't skew correlation.** Every timestamp on the
  shared timeline is stamped at *ingest*, server-side — a log line's own
  embedded timestamp, or `now_iso()` when a `docker stats` snapshot returns
  (see `DockerStatsSource._loop`) — never when a client happens to receive
  it. An SSH tunnel (or any network hop) adds *display* latency between the
  collector and a viewer, but every viewer still sees the same ingest
  timestamps on the same events, so two people looking at the same host
  through different tunnels still get one consistent, correlatable
  timeline, not two skewed ones.

## File transfer (upload / download) — implemented

Shipped as designed below, with a few concrete decisions made along the
way:

- `POST /files/upload` takes the raw file bytes as the request body (not
  multipart) plus three headers: `X-CTTC-Filename` (required),
  `X-CTTC-Private-Key` (optional, **base64-encoded** — a raw header can't
  safely carry a multi-line PEM's newlines), `X-CTTC-Transforms`
  (optional, comma-separated). Response shape matches `/open`'s
  `{opened, errors}` exactly, `errors[].encrypted` included, so the
  renderer's existing "locked file, prompt for a key and retry" logic
  needed no new branches, just a different fetch underneath it.
- `GET /files/download?from&to&public_key&include_host` returns the zip
  (or encrypted blob) as the response body, plus a
  `X-CTTC-Source-Count` header (cross-origin `fetch()` can't read
  response headers unless the server explicitly
  `Access-Control-Expose-Headers`s them — easy to miss, would have shown
  up as `undefined` in the status line silently) so the client can still
  say "saved: N sources" without the server needing to return JSON.
- `State.export_sample()`'s zip-building was split into
  `State.build_sample_bytes() -> (data, meta)`, with `export_sample()`
  reduced to "build, then write to a path" — a pure refactor, the
  existing path-based `/sample/export` endpoint (still used by
  `--static`/CLI flows) is untouched and its tests passed unmodified.
- An uploaded source's `.path` is set to a synthetic `upload://<filename>`
  after opening (the scratch temp file is deleted immediately after — both
  `open_file`/`load_sample` fully consume their input into memory, and a
  non-live source's `.path` is never read again afterward). This is a
  display-only change with one real consequence: the renderer's
  already-open check for "Load metrics" compares against
  `upload://<basename>` now, not the picked local path.
- On the client, **`window.cttc.saveFile` (path-only, no write) was
  removed**, not left dead — `saveBinary(name, bytes)` replaced its one
  caller. `readFile(path)` was added alongside it so the renderer (which
  has no fs access) can hand local bytes to `/files/upload` itself; per
  the existing "main.js is thin glue" pattern, `main.js` still never talks
  to the CTTC server API — it only reads/writes local files and shows
  native dialogs, same division of responsibility as everywhere else in
  the app.
- A real, non-obvious test-infrastructure finding:
  `contextBridge.exposeInMainWorld`-exposed objects (`window.cttc.*`) are
  **not configurable** — `delete window.cttc.readFile` throws in strict
  mode. An E2E test attempting to simulate a degraded environment that way
  had to be dropped rather than worked around; the equivalent
  `saveBinaryFile` fallback (plain-browser `Blob` download when
  `window.cttc` is entirely absent) has the same untestable-in-Electron
  property and was left unverified at the E2E layer for the same reason —
  both are simple enough by inspection that this was judged an acceptable
  gap rather than worth restructuring production code around.

Two flows in the current UI assume the Electron client and `server.py`
share a filesystem — true today (same machine), false once the server
runs on a different host:

- **📂 Load metrics** — `pickFiles()` returns a path *on the client*;
  `/open` and `load_sample()` read that path *on the server*. Works only by
  coincidence of both being the same machine.
- **✂ Capture metrics (Save)** — `/sample/export` already builds the whole
  zip in memory (`io.BytesIO()` in
  [`export_sample`](../../app/server/server.py)) before ever touching
  disk — encouraging, since it means the "write to `path`" step is already
  the *only* thing that's server-filesystem-specific, not the zip-building
  itself.

One flow **already gets this right** and is the pattern to copy: **Save
snapshot as TXT/JSON**. The snapshot's data is assembled from ordinary JSON
API calls (`/point`, `/logs`) in the renderer, then handed to
`window.cttc.saveJson`/`saveText`, which round-trip through
`ipcMain.handle("save-json"/"save-text")` in `main.js` and write the bytes
**on the client** via a native save dialog. No server filesystem access at
all. See [main.js `saveSnapshotAs`](../../app/main.js).

Proposed change: give sample export/import the same shape.

- **Download (export).** `/sample/export` gains a mode that returns the
  zip (or encrypted blob) **as the HTTP response body**
  (`Content-Type: application/octet-stream`,
  `Content-Disposition: attachment; filename=...`) instead of / in addition
  to writing to a server-side `path`. The renderer fetches those bytes,
  passes them to a new `window.cttc.saveBinary(name, bytes)` IPC call
  (same shape as `saveJson`/`saveText`, just `Buffer`-based instead of
  UTF-8 text), and Electron's native save dialog writes them on the client
  — identical user-visible flow to today, just no shared filesystem
  required.
- **Upload (load / add local files).** A new endpoint, e.g.
  `POST /files/upload` — client streams the picked file's bytes up
  (`multipart/form-data` or raw body + a `name` header), server writes
  them to a scratch path and runs the *existing* `load_sample()` /
  `open_file()` logic against that path unchanged. From the client's
  perspective: pick a file → it opens, exactly like today; the bytes just
  take a detour through the network instead of already being local.
- **Keep it a separable module.** Per the ask, structure this as its own
  route prefix and its own file (`server/files.py` or similar) with a
  narrow interface into `State` (hand it bytes, get back opened source ids
  / a zip blob), rather than folding upload/download logic into the
  existing endpoint handlers. That's what makes "spin it off into its own
  container later" a refactor instead of a rewrite — the day file traffic
  needs to scale independently of the telemetry/log collectors (large
  `.cttc` files, many concurrent uploads), it lifts out behind the same
  route prefix on a different port/container without the collector code
  ever noticing.
- **Uploaded sources stay first-class, not a side view.** Once opened, a
  file uploaded this way must become an ordinary entry in `state.sources` —
  same legend, same shared cursor, same timeline as anything the collector
  gathered. Correlating a log someone uploaded (say, a log pulled from a
  system CTTC doesn't have live access to) against telemetry the collector
  *is* gathering live is a real, intended use of the tool, not an edge
  case — nothing about this design should special-case "uploaded" sources
  into a separate, non-correlatable view.

## Encryption keys need to move client-side

Designing the upload/download story surfaced a real problem in the
**existing** (already-shipped) sample-encryption feature, not something new
this proposal introduces — but it only becomes *live* once a server can
have more than one user.

Today, `~/.cttc/keys/` and the whole 🔑 Keys dialog assume "the machine
running `server.py`" and "the one person using CTTC" are the same entity —
reasonable when true. `resolve_private_key()` reads a private key straight
off that machine's disk with no notion of *which client* is asking. Once
one server is shared by multiple viewers, that assumption breaks in a way
that defeats the point of encryption:

- Every connected client can call `/cttc/keys/generate|import|delete` and
  see the same keyring — including **other people's private keys**.
- `/open` with `private_key: "alice"` on a shared server means *anyone*
  who can reach the API can decrypt anything encrypted for Alice, not just
  Alice. The "encrypt for a specific recipient" feature stops meaning
  anything.

Fix: **private keys, and the operations that need them, move to the
client.** Concretely:

- **Encryption (needs only the public key) can stay server-side as-is.**
  `resolve_public_key()` already accepts a raw PEM string, not just a
  stored name — `/sample/export`'s `public_key` field already supports a
  client supplying the PEM directly with no server-side key storage
  involved at all. No change required here.
- **Decryption moves to the client.** Instead of `/open` taking a
  `private_key` name/PEM and decrypting server-side, the *download* path
  above hands the (still-encrypted) bytes to Electron, and decryption
  happens locally — Node's built-in `crypto` module covers the exact
  primitives `server.py` uses (`crypto.privateDecrypt` with OAEP padding
  for the wrapped AES key, `crypto.createDecipheriv("aes-256-gcm", ...)`
  for the payload), so this is a port, not a redesign.
- **`~/.cttc/keys/` becomes a client-side concern.** The 🔑 Keys dialog's
  generate/import/list/delete operations move to run against the local
  Electron install (a small main-process module backed by Node `crypto`
  + local files) instead of `/cttc/keys/*` on the server. The server's
  key-management endpoints either go away entirely or stay only for the
  local/embedded (single-user, same-machine) deployment mode, gated off
  when running in shared/remote mode.

This is scoped as **required for the shared-server model to be honest about
its security properties**, not a nice-to-have — shipping shared-server mode
with server-side private keys would be a regression from what the feature
currently promises (documented in
[MANUAL.md](../../MANUAL.md#encryption-keys): *"the private key never
leaves this machine"* — true today, false under naive shared-server reuse).

## What changes in Electron for the SSH-tunnel path

`main.js` gains a second `startServer`-shaped function alongside the
existing one, selected by config (see below), not by any new UI:

```js
async function startTunnel({ sshTarget, sshKey, remotePort }) {
  const localPort = await getFreeLocalPort(); // bind :0, read it, close it
  const args = ["-N", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
                ...(sshKey ? ["-i", sshKey, "-o", "IdentitiesOnly=yes"] : []),
                sshTarget];
  sshProc = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
  await waitForPortOpen("127.0.0.1", localPort, { timeoutMs: 15000 });
  serverPort = localPort;
}
```

- `app.whenReady()` picks `startServer(fileArgs)` (today's behavior) or
  `startTunnel(cfg)` based on config presence — everything downstream
  (`createWindow`, popout windows, `/events`) is unaware which one ran.
- **`/shutdown` on quit must not fire in tunnel/remote mode** — that server
  is shared infrastructure, not this process's child. `stopServer()` needs
  a mode check; in tunnel mode it should just kill the local `ssh` process
  and leave the remote container running.
- Startup failure UX reuses the existing `dialog.showErrorBox` path (today:
  *"could not start server via uv"*); the tunnel path's equivalent failure
  ("could not reach `docker-host` via ssh") slots into the same dialog with
  a different message — no new dialog needed.

## Configuration surface (keeps the default flow untouched)

Nothing in the UI changes. Mode selection is a **deployment-time** concern,
read once at startup, e.g.:

```jsonc
// ~/.cttc/connection.json  (absent = today's embedded/local behavior)
{
  "mode": "ssh-tunnel",
  "ssh_target": "deploy@docker-host.internal",
  "ssh_key": "~/.ssh/cttc_deploy",
  "remote_port": 8765
}
```

or the equivalent as environment variables (`CTTC_MODE`, `CTTC_SSH_TARGET`,
…) for scripted/MDM-pushed deployment. This mirrors how the app already
treats `CTTC_TEST`/`CTTC_SCREENSHOT`/`CTTC_EVAL` as environment-driven,
invisible-by-default switches (see [main.js](../../app/main.js)).

**Windows note, found while building a Windows client test bundle:**
`connection.json` needs to be plain, BOM-less UTF-8. Windows PowerShell's
`Set-Content -Encoding UTF8` (the obvious way to write this file from a
setup script) prepends a byte-order-mark, and `JSON.parse()` treats a
leading BOM as invalid syntax — `loadConnectionConfig()` failed with
"invalid JSON in connection config" on a file that looked completely
correct opened in a text editor. Two fixes landed together:
`readConfigFile()` now strips a leading BOM defensively (so *any* tool that
writes this file, not just one setup script, can't reintroduce this), and
the reference PowerShell setup script writes the file via
`[System.IO.File]::WriteAllText(..., (New-Object System.Text.UTF8Encoding
$false))` instead of `Set-Content` to avoid emitting one in the first
place.

## Open questions still needing a decision

Shared-vs-per-client and file semantics are settled (see
[Decisions](#decisions)). What's left is narrower and mostly matters only
for path B:

1. **Token distribution (path B only).** Who generates/rotates the shared
   token, and how does it reach each client's `connection.json` — manually,
   via MDM, via a short-lived provisioning step?
2. **TLS termination ownership (path B only).** Is there already a reverse
   proxy / ingress in these environments, or does this project need to ship
   one (a Caddy sidecar in the compose file is the least-effort default)?
3. **Client-side key storage location.** Moving key management to Electron
   (see [Encryption keys need to move client-side](#encryption-keys-need-to-move-client-side))
   needs a concrete home for `~/.cttc/keys/`-equivalent files on the client
   — reuse the same path convention (simplest, and lets someone move from
   embedded to remote mode without losing their keys), or use Electron's
   `app.getPath("userData")`? Leaning toward keeping `~/.cttc/keys/`
   either way, for that continuity, but flagging it rather than assuming.

## Suggested phasing

1. **SSH-tunnel transport.** `main.js` gains the tunnel manager and a
   config loader; `server.py`/`index.html`/`renderer/app.js` untouched.
   Ship the Dockerfile/compose file for the remote host (`pid: host`,
   `network_mode: host`, docker socket mount).
2. **Collector de-duplication — done.** `State._open_or_reuse()` in
   `server.py`: a target already open (matched by its exact
   `docker://{host}/{stats|host|type/name}` path) is returned as-is,
   check-then-insert under one continuous lock hold rather than the
   previous two-separate-acquisitions version, which really could start
   two collectors for the same target under real concurrent load. Proven,
   not just written: a 16-thread test hitting the identical target through
   a `threading.Barrier` reliably produces exactly one collector — and,
   run against the pre-fix code as a check that the test itself has teeth,
   reliably fails there (8/8 runs), confirming it wasn't passing
   vacuously. 100% line coverage maintained (157 server tests total).
3. **File transfer module — done.** `server/files.py` (`download_sample`,
   `upload_and_open`) plus `GET /files/download` / `POST /files/upload`
   on `server.py`; `main.js` gained `saveBinary`/`readFile` and dropped
   the now-unused `saveFile`; `exportSample()` and the Load-metrics
   handler in `app.js` rewired to fetch/POST bytes instead of exchanging
   server-side paths. 100% coverage maintained on `server.py` and the new
   `files.py` (182 server tests); renderer E2E covers the real
   fetch-based upload/download round trip (53 tests). Full details and a
   couple of real findings from building it (the
   `Access-Control-Expose-Headers` gotcha, `contextBridge` object
   immutability) in
   [File transfer (upload / download) — implemented](#file-transfer-upload--download--implemented).
4. **Client-side key management.** Port key generate/import/list/delete
   and sample decryption to Electron/Node `crypto`; retire (or gate behind
   embedded-mode-only) the server's `/cttc/keys/*` endpoints and `/open`'s
   `private_key` parameter once the client can decrypt locally.
5. **Path B (token + TLS + CSP)** only if a real deployment blocks SSH
   egress — still deferred, still strictly more code/attack-surface than
   phases 1–4 need.

Phases 1–3 are independent of each other and can land in any order; phase 4
depends on phase 3 (decryption needs the downloaded bytes to decrypt).

## Future direction: a VS Code extension client (not this phase)

Flagged for a later exploration, not started: packaging the CTTC *client*
as a VS Code extension instead of (or alongside) the Electron app — viewing
correlated telemetry/logs inside the editor.

One thing worth banking now while it's fresh: phase 1's decision to keep
`lib/connection-config.js` and `lib/ssh-tunnel.js` as plain Node modules
with zero `electron` dependency (see
[What changes in Electron for the SSH-tunnel path](#what-changes-in-electron-for-the-ssh-tunnel-path))
means they already run unmodified in *any* Node host process — a VS Code
extension's extension host is exactly that. The remote-server transport
this phase built isn't Electron-specific despite living in `app/main.js`
today; a future VS Code extension would reuse both modules as-is rather
than reimplementing tunnel management. Whether the *rest* of the client
(the canvas-based renderer, IPC-shaped interactions) ports as cleanly is
the real question for that future exploration — not answered here.
