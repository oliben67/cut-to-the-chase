# Running the CTTC server remotely (no local Docker required)

**Status:** exploration / design proposal — not implemented.

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
the Docker-enabled host, independent of any Electron process. Sketch:

```dockerfile
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      docker-ce-cli openssh-client && rm -rf /var/lib/apt/lists/*
RUN pip install uv
COPY app/server /srv/cttc-server
WORKDIR /srv/cttc-server
RUN uv sync --frozen
EXPOSE 8765
ENTRYPOINT ["uv", "run", "server.py", "--port", "8765"]
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

Two things worth calling out because they're easy to get wrong silently:

- **`docker-ce-cli` only, not the full engine** — the container needs the
  CLI binary and the mounted socket, never its own nested daemon.
- **Host telemetry accuracy.** `HostStatsSource._sample_local()` uses
  `psutil`, which by default reports the *container's* view (its cgroup
  limits, its network namespace), not the physical host's — exactly the gap
  `pid: host` + `network_mode: host` closes (the same technique
  node-exporter/cAdvisor-style agents use). Without both, host telemetry
  will silently report container-scoped numbers that look plausible but are
  wrong. Worth a loud comment in the compose file, and probably a startup
  self-check in `HostStatsSource` that warns if `/proc/1/comm` doesn't look
  like host `init` (a `pid: host` giveaway) when host-telemetry is
  requested.

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

## Open questions that need a decision before implementing

These are judgment calls about the deployment model, not implementation
details — flagging them rather than picking silently:

1. **Shared vs. per-client server.** `State` in `server.py` is one global
   object — if two client machines point at the same container, they see
   *each other's* open sources, tracked/hidden state, everything. Is that
   the intent (a shared team dashboard), or does each client need its own
   container (spun up on demand — needs an orchestration story: who starts
   a container per connecting user, how is idle cleanup handled)?
2. **File-based sources.** `/open` and "load .cttc metrics" currently read
   a path on whichever machine runs `server.py`. In remote mode, a path
   picked in the client's file dialog won't exist on the remote host. Is
   this out of scope for v1 (Docker-collection-only clients don't need
   local file loading), or does it need upload/download endpoints added to
   `server.py` (a real feature, not a config change)?
3. **Token distribution (path B only).** Who generates/rotates the shared
   token, and how does it reach each client's `connection.json` — manually,
   via MDM, via a short-lived provisioning step?
4. **TLS termination ownership (path B only).** Is there already a reverse
   proxy / ingress in these environments, or does this project need to ship
   one (a Caddy sidecar in the compose file is the least-effort default)?

## Suggested phasing

1. Ship the SSH-tunnel path only. Zero changes to `server.py`,
   `index.html`, or `renderer/app.js`; `main.js` gains the tunnel manager
   and a config loader; ship the Dockerfile/compose file for the remote
   host. This alone unblocks the stated problem (no Docker CLI on the
   client) for any environment where SSH egress is allowed.
2. Only build path B (token + TLS + CSP changes) if a real deployment shows
   up that blocks SSH — it's strictly more code and more attack surface for
   a case that may never materialize.
3. Decide questions 1–2 above before phase 1 lands, since they affect
   whether "remote mode" is a single flag or needs a small provisioning
   API.
