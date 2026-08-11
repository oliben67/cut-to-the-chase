"""Durable store for logs/telemetry, backed by a Redis instance the gateway
starts itself (see Dockerfile for the containerized image, main.js for the
bare/embedded dev path).

Redis is the *sole* source of truth for logs/telemetry reads (/series,
/logs, /range, /ticks, /point, /index_at, /logs/find, rolling buffers,
event conditions, recording-session exports -- see server.py's
LogSource/StatsSource): Source objects keep no unbounded RAM history of
their own, only small bounded bookkeeping (LogSource._last_row,
StatsSource._services). Redis also bounds how long history is kept
(sTTL, default 3 days -- read once at startup, see reconcile_ttl below;
no longer runtime-mutable), which unbounded RAM never did.

Persisted to disk (RDB + AOF, see start()) so a graceful shutdown or a
crash both survive a restart -- graceful shutdown flushes a full RDB
snapshot, AOF (`appendfsync everysec`) bounds a crash's loss window to
~1s, matching sRate's own default cadence. Every record's TTL (a
per-*field* HEXPIRE, not a key-level EXPIRE -- see the schema below)
round-trips through both correctly: restored fields keep their original
remaining TTL, and anything already past it at load time is dropped by
Redis itself, not resurrected. See DEFAULT_DATA_DIR/data_dir below for
where the persisted files live in each deployment mode.

Live records are buffered in memory and flushed to Redis in one batched
pipeline every `flush_interval_seconds` (sRate, default 1s, runtime-
adjustable via set_flush_interval -- see server.py's POST /logs/rate) --
decoupled from any individual source's own sampling interval
(DockerStatsSource/HostStatsSource/LogSource keep polling/streaming on
their own cadence; this only governs how often *this module* talks to
Redis). See record()/_flush_loop().

Schema: one hash + one sorted-set index per entity (container name, or
`host@<hostname>` for host telemetry -- matching the label scheme already
used for Source.path in server.py -- always prefixed with a "log:"/"stats:"
kind discriminator, see server.py's _entity_id/br-DEDUP-006, so the same
container's log entries and stats samples never land in the same entity
even when their bare names are identical):
    cttc:log:<entity_id>   hash  field=timestamp(ms, str)  value=orjson record
    cttc:idx:<entity_id>   zset  member=same field          score=timestamp
    cttc:entities          set   every entity_id ever recorded (for
                                  reconcile_ttl's walk, and for the
                                  daemon-registry style bootstrap when
                                  re-serving old history)
    cttc:daemons           hash  host -> the exact /docker/collect request
                                  body that opened it (used to reconnect
                                  remote hosts on the gateway's own restart)
    config:sTTL             str  the sTTL (seconds) reconcile_ttl last
                                  applied -- compared against the newly
                                  configured value on every startup so an
                                  unchanged sTTL stays a no-op.

`redis-server` must be on PATH in every deployment mode this module runs
in -- the containerized gateway image bundles it (see Dockerfile), and the
bare/embedded `uv run server.py` path (see main.js) now requires it on the
host's PATH too, the same way `uv`/`docker` already are. start() raises
if the binary is missing, the `redis` python package isn't installed, the
socket never appears, or the client can't ping/load functions -- there is
no RAM fallback to degrade to."""

from __future__ import annotations

import asyncio
import logging
import shutil
import tempfile
import time
from pathlib import Path

import orjson

logger = logging.getLogger("cttc")


class RedisUnavailable(RuntimeError):
    """Raised by start() when redis-server can't be launched or reached --
    a distinct type (rather than a bare RuntimeError) so this specific,
    expected-to-happen-sometimes failure mode (binary missing, package
    missing, socket never came up, client couldn't ping/load functions) can
    be told apart from an unrelated RuntimeError elsewhere in startup, both
    in logs and by any caller that wants to handle it specifically."""


DEFAULT_TTL_SECONDS = 3 * 24 * 3600.0  # 3 days (sTTL)

DEFAULT_FLUSH_INTERVAL_SECONDS = 1.0
# sRate: how often the whole in-memory record buffer is flushed to Redis in
# one batched pipeline -- decoupled from any individual source's own
# sampling interval (see module docstring). 1s keeps the common case
# (Docker "Frequency" ~5s) imperceptibly close to the old near-immediate
# visibility, while still batching bursts (many containers reporting near-
# simultaneously, a fast log tail) into fewer, larger pipelines than the
# old one-pipeline-per-record.
MIN_FLUSH_INTERVAL_SECONDS = 0.01
# set_flush_interval's floor -- flush_interval_seconds feeds straight into
# asyncio.sleep(), which treats <=0 as "don't sleep at all"; this guards
# against a fat-fingered 0/negative value turning the flush loop into a
# tight spin hammering Redis.
MAX_BUFFERED_RECORDS = 50_000
# br-REDIS-019: with per-record writes gone, _enqueue() no longer has any
# natural backpressure signal from a bounded asyncio.Queue -- this is the
# in-memory buffer's own drop-and-warn ceiling (5x the old queue's 10_000,
# since a slow flush interval now legitimately accumulates more between
# flushes than the old per-record queue ever needed to hold at once).

# TCP monitor port -- bound to 127.0.0.1 only (see start()), so an external
# tool (redis-cli, RedisInsight) can inspect the store on the same machine
# the gateway runs on, in both deployment modes. Loopback-only and
# unauthenticated is a deliberate choice: no new exposure over what's
# already trusted (matches the HTTP API's own --host 127.0.0.1 default),
# since the containerized gateway's network_mode: host means a non-loopback
# bind here would land directly on the real host's network interfaces.
DEFAULT_TCP_PORT = 56379
# redis-py silently defaults an unset max_connections to 100. describe()/
# range()'s nested gather (every open source x every service x first_last's
# two zrange calls) can burst well past that under concurrent /sources or
# /range polling, so size explicit headroom here instead of relying on the
# library default -- this is a local unix socket, connections are cheap.
MAX_CLIENT_CONNECTIONS = 256
# /run always exists (and is writable by root) inside the containerized
# gateway image; the bare/embedded dev path (main.js, or this test suite)
# runs as a regular user on whatever host OS is at hand, where /run may not
# exist at all (macOS has no /run) -- fall back to the OS temp dir there.
SOCKET_PATH = (
    "/run/cttc-redis.sock"
    if Path("/run").is_dir()
    else str(Path(tempfile.gettempdir()) / "cttc-redis.sock")
)
LUA_PATH = Path(__file__).parent / "logs.lua"

# Where RDB/AOF persistence files live -- sibling to server.py, the same
# Path(__file__).parent trick --sessions-dir already uses (server.py), so
# this resolves correctly with zero extra config in both bare mode (a real
# path in the dev checkout) and the containerized image (WORKDIR/COPY
# --from=builder preserve the same relative layout, so this becomes
# /srv/cttc-gateway/redis-data there -- see docker-compose's volumes:,
# which bind-mounts exactly that path to a host directory). Deliberately
# not nested inside sessions/ -- different concern (binary Redis files vs.
# user-facing .cttc-record exports), different audience.
DEFAULT_DATA_DIR = Path(__file__).parent / "redis-data"


class RedisLog:
    """One instance lives on State (see server.py's State.__init__). Redis
    is a hard dependency now (sole source of truth for reads) -- start()
    raises rather than degrading, so once it returns every method here is
    safe to call unconditionally."""

    enabled = False

    def __init__(
        self,
        socket_path: str | None = None,
        tcp_port: int | None = None,
        ttl_seconds: float | None = None,
        flush_interval_seconds: float | None = None,
        data_dir: str | Path | None = None,
    ):
        """`socket_path` defaults to the module-level SOCKET_PATH (every
        real deployment mode's one true instance) -- overridable purely so
        tests that need two genuinely independent Redis instances in the
        same process (e.g. simulating two separate gateway restarts, or
        two Source objects that happen to share an entity name) can each
        spawn their own, rather than colliding on the one fixed path.
        `tcp_port` similarly defaults to DEFAULT_TCP_PORT -- None here means
        "use the default", not "disabled": the TCP monitor listener is
        always on, only its port number is configurable (see server.py's
        --redis-port).

        `ttl_seconds` (sTTL) is read once here, at construction, and never
        mutated afterward -- retention is a startup-only setting now (see
        reconcile_ttl); there is no runtime TTL mutator. `flush_interval_
        seconds` (sRate) seeds the initial buffer-flush cadence but *is*
        runtime-adjustable afterward (see set_flush_interval).

        `data_dir` defaults to the module-level DEFAULT_DATA_DIR -- override
        it (as every test here does, pointed at a tmp_path) so tests never
        write real persistence files into the repo's own working tree, and
        so two RedisLog instances sharing one process never collide on the
        one real default path."""
        self._client = None
        # Bounds concurrent in-flight fan-out reads (see first_last) app-wide,
        # across every overlapping /sources and /range request -- keeps peak
        # pool usage predictable regardless of how many sources/services get
        # gathered over at once, well under MAX_CLIENT_CONNECTIONS.
        self._fanout_limit = asyncio.Semaphore(64)
        self._proc: asyncio.subprocess.Process | None = None
        self._buffer: list[tuple[str, float, dict]] = []
        self._flush_task: asyncio.Task | None = None
        self._interval_changed: asyncio.Event | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.ttl_seconds = ttl_seconds if ttl_seconds is not None else DEFAULT_TTL_SECONDS
        self.flush_interval_seconds = (
            flush_interval_seconds if flush_interval_seconds is not None else DEFAULT_FLUSH_INTERVAL_SECONDS
        )
        self._socket_path = socket_path or SOCKET_PATH
        self._tcp_port = tcp_port or DEFAULT_TCP_PORT
        self._data_dir = Path(data_dir) if data_dir is not None else DEFAULT_DATA_DIR

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        if shutil.which("redis-server") is None:
            raise RedisUnavailable(
                "redis_log: no redis-server binary found on PATH -- redis-server is a hard "
                "requirement in every deployment mode (containerized gateway image or bare/"
                "embedded dev path), same as uv/docker"
            )
        try:
            import redis.asyncio as aioredis  # local import: optional dependency, only needed here
        except ImportError as e:
            raise RedisUnavailable(
                "redis_log: redis-server is present but the `redis` python package isn't installed"
            ) from e

        self._data_dir.mkdir(parents=True, exist_ok=True)  # redis-server won't create a missing --dir itself
        manifest_path = self._data_dir / "appendonlydir" / "appendonly.aof.manifest"
        rdb_path = self._data_dir / "dump.rdb"
        if manifest_path.exists() or rdb_path.exists():
            logger.info("redis_log: found existing persisted data at %s -- restoring on load", self._data_dir)
        else:
            logger.info(
                "redis_log: no existing persisted data found at %s -- starting with an empty store",
                self._data_dir,
            )
        log_path = self._data_dir / "redis-server.log"
        # Redis appends to --logfile across restarts rather than truncating
        # it -- read from this pre-spawn size, not "whole file", so a
        # startup failure below never misattributes a stale prior run's log
        # output to *this* attempt.
        pre_spawn_log_size = log_path.stat().st_size if log_path.exists() else 0

        self._proc = await asyncio.create_subprocess_exec(
            "redis-server",
            "--unixsocket",
            self._socket_path,
            "--port",
            str(self._tcp_port),  # TCP monitor listener -- see DEFAULT_TCP_PORT's docstring
            "--bind",
            "127.0.0.1",  # the actual control: loopback-only, no matter what network mode wraps us
            "--protected-mode",
            "no",  # redundant with --bind above, just avoids protected-mode surprises
            "--dir",
            str(self._data_dir),
            "--dbfilename",
            "dump.rdb",
            "--save",
            # A non-empty save config is what makes a graceful SIGTERM
            # actually write an RDB snapshot before exiting at all --
            # confirmed empirically, `--save ""` (the old, deliberately
            # ephemeral default) skips that entirely regardless of AOF.
            # One conservative save point rather than Redis's stock
            # multi-point defaults (`300 100`/`60 10000` etc.): AOF
            # everysec below is the real bounded-loss mechanism for a
            # crash, so frequent periodic BGSAVE forks under this
            # workload's continuous per-second write volume would cost
            # more (a fork() + full-dataset write every minute) than they'd
            # add -- this one point still gives a periodically-fresh RDB as
            # a secondary safety net, and (combined with AOF) guarantees
            # the shutdown-time save requirement above.
            "3600",
            "1",
            "--appendonly",
            "yes",
            # everysec: matches sRate's own default cadence (1s) -- bounds
            # a crash's loss window to ~1s of writes, the number the user
            # asked for explicitly. Do NOT read this as "RDB alone captures
            # the crash instant" -- it doesn't; AOF is what does that.
            "--appendfsync",
            "everysec",
            "--appenddirname",
            "appendonlydir",
            "--appendfilename",
            "appendonly.aof",
            "--logfile",
            str(log_path),
            "--maxmemory",
            "256mb",
            "--maxmemory-policy",
            # br-REDIS-012: `volatile-*` policies only ever consider keys
            # that have a *key-level* EXPIRE -- but every record's TTL here
            # is a per-*field* HEXPIRE on the shared `cttc:log:<entity>`
            # hash (see _write_rows()), so none of `cttc:log:*`/`cttc:idx:*`/
            # `cttc:entities`/`cttc:daemons` ever qualify. `volatile-ttl`
            # therefore finds nothing evictable and Redis falls back to
            # rejecting writes outright once the 256MB cap is hit, which
            # _write_rows()'s warning-and-drop path turns into every
            # subsequent sample being silently, permanently lost. `allkeys-
            # lru` can actually evict (whichever key -- any entity's full
            # history -- was least recently touched), trading "lose one
            # entity's oldest history under sustained memory pressure" for
            # "every gateway silently stops recording anything at all".
            # Now that persistence is on, that eviction is durable across a
            # restart too (it's just a DEL, appended to the AOF like any
            # other write) -- not merely lost for this process's uptime, as
            # it was when --save "" made the whole store ephemeral. The
            # 256MB cap is still the real backstop either way; this doesn't
            # change that, it's just no longer a free pass that resets on
            # every restart.
            "allkeys-lru",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        def _log_tail() -> str:
            if not log_path.exists():
                return ""
            with log_path.open("rb") as f:
                f.seek(pre_spawn_log_size)
                return f.read().decode(errors="replace").strip()

        for _ in range(50):  # wait up to ~5s for the socket to appear
            if Path(self._socket_path).exists():
                break
            if self._proc.returncode is not None:
                raise RedisUnavailable(
                    f"redis_log: redis-server exited (code {self._proc.returncode}) before creating "
                    f"{self._socket_path} -- likely a corrupt or unreadable persistence file at "
                    f"{self._data_dir}: {_log_tail() or '(no log output captured)'}"
                )
            await asyncio.sleep(0.1)
        else:
            raise RedisUnavailable(
                f"redis_log: redis-server did not create {self._socket_path} in time"
            )

        client = aioredis.Redis(
            unix_socket_path=self._socket_path,
            decode_responses=False,
            max_connections=MAX_CLIENT_CONNECTIONS,
        )
        try:
            await client.ping()
            await client.function_load(LUA_PATH.read_text(), replace=True)
        except Exception as e:
            # The unix socket file can exist for a brief window before a
            # corrupt persistence file's fatal error actually kills the
            # process (confirmed empirically: redis-server logs "Server
            # initialized" -- which is when the socket gets bound -- before
            # it gets to validating AOF/RDB content) -- so a connection
            # failure here can *also* mean "the process died right after
            # creating the socket", not just a generic client-side error.
            # Surface the same rich diagnostic (with the log tail) in that
            # case rather than a bare ConnectionError with no context. A
            # brief bounded wait here in case the child has died but
            # asyncio's SIGCHLD reaping hasn't caught up to set returncode
            # yet -- still bounded, never hangs this on a genuinely-alive
            # process (that just failed to answer a ping for some other,
            # unrelated reason).
            if self._proc.returncode is None:
                try:
                    await asyncio.wait_for(self._proc.wait(), timeout=0.5)
                except asyncio.TimeoutError:
                    pass
            if self._proc.returncode is not None:
                raise RedisUnavailable(
                    f"redis_log: redis-server exited (code {self._proc.returncode}) right after creating "
                    f"{self._socket_path} -- likely a corrupt or unreadable persistence file at "
                    f"{self._data_dir}: {_log_tail() or '(no log output captured)'}"
                ) from e
            raise RedisUnavailable(
                f"redis_log: could not initialize redis client/functions: {type(e).__name__}: {e}"
            ) from e

        self._client = client
        self._buffer = []
        self._loop = asyncio.get_running_loop()
        self._interval_changed = asyncio.Event()
        self._flush_task = asyncio.ensure_future(self._flush_loop())
        self.enabled = True
        logger.info(
            "redis_log: durable store enabled (ttl=%.0fs, flush interval=%.1fs, tcp monitor port=%d, "
            "loopback-only, data dir=%s)",
            self.ttl_seconds,
            self.flush_interval_seconds,
            self._tcp_port,
            self._data_dir,
        )

    async def stop(self) -> None:
        """Stops accepting new writes immediately, cancels the flush loop,
        then flushes whatever was still buffered directly (rather than
        counting on the now-cancelled loop to finish it) before tearing
        down redis-server (br-REDIS-008): otherwise every orderly shutdown
        silently lost up to MAX_BUFFERED_RECORDS buffered samples, and
        `enabled` staying `True` meant a late record() kept buffering
        against a flush loop/server that were about to die (or already
        had), never to be read.

        terminate() (SIGTERM) is what actually triggers redis-server's own
        RDB-save-before-exit (see start()'s --save config) -- but that save
        takes real time under real data volumes, and the *caller's* own
        shutdown budget varies by deployment mode (main.js's bare-mode
        killGraceMs, or a container's stop_grace_period) and isn't always
        generous enough on its own. This wraps the wait in its own internal
        deadline so a slow/stuck save can never hang shutdown indefinitely,
        with a specific, diagnosable log line naming the actual failure mode
        rather than a caller's generic timeout doing it blind."""
        self.enabled = False
        if self._flush_task is not None:
            self._flush_task.cancel()
            try:
                await self._flush_task
            except asyncio.CancelledError:
                pass
        await self._flush()
        if self._proc is not None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                logger.warning(
                    "redis_log: redis-server did not exit within 15s of SIGTERM -- an RDB save may "
                    "not have completed; killing it (SIGKILL) rather than hanging shutdown "
                    "indefinitely. Any data since the last completed AOF fsync may be lost."
                )
                self._proc.kill()
                await self._proc.wait()

    # ── writing ──────────────────────────────────────────────────────────

    def record(self, entity_id: str, ts: float, payload: dict) -> None:
        """Non-blocking: called from hot ingestion paths (StatsSource.
        ingest_row, LogSource.ingest_chunk) that must never stall waiting on
        Redis. Appends to the in-memory buffer; _flush_loop() does the
        actual I/O every flush_interval_seconds (sRate). Redis is the sole
        store now (see this module's docstring) -- a record that never
        makes it in is a real, permanent loss of that sample, not just a
        missed durability copy, so both failure points below (a full
        buffer, a failed pipeline in _write_rows) log at `warning`, loud
        enough to show up without debug logging enabled.

        Uses call_soon_threadsafe rather than appending directly: some
        callers (DockerStatsSource/HostStatsSource) run their sampling via
        asyncio.to_thread, i.e. off the event loop, where a plain list
        append isn't safe to call directly (it could race _flush()'s
        buffer swap, which also runs on the event loop thread)."""
        if not self.enabled:
            return
        self._loop.call_soon_threadsafe(self._enqueue, entity_id, ts, payload)

    def _enqueue(self, entity_id: str, ts: float, payload: dict) -> None:
        # br-REDIS-019: runs on the event loop thread (via
        # call_soon_threadsafe), same thread _flush()'s buffer-swap runs
        # on, so this can never race a concurrent flush mid-swap -- no lock
        # needed.
        if len(self._buffer) >= MAX_BUFFERED_RECORDS:
            logger.warning(
                "redis_log: in-memory flush buffer full (%d records, flush interval=%.1fs) -- "
                "dropping a sample for %s",
                MAX_BUFFERED_RECORDS,
                self.flush_interval_seconds,
                entity_id,
            )
            return
        self._buffer.append((entity_id, ts, payload))

    async def _flush_loop(self) -> None:
        """Runs for RedisLog's whole lifetime once start() launches it.
        Waits on _interval_changed rather than a plain asyncio.sleep(): a
        bare `await asyncio.sleep(self.flush_interval_seconds)` captures
        its duration once, at the moment it's *called* -- a
        set_flush_interval() midway through an already-in-progress long
        sleep would otherwise have no effect until that stale sleep
        finally finishes on its own, however much later that is (e.g.
        shrinking sRate from 60s to 1s for more responsive event
        conditions would still leave you waiting up to 60s for the first
        post-change flush). Racing the wait against a set()-able Event
        instead means a change wakes this immediately: it flushes whatever
        old records had for it right then, then goes back to sleeping
        for the *new* interval from here on -- always "next cycle", never
        "next cycle after this one finally, coincidentally elapses". A
        change never touches self._buffer either way, so it can never drop
        or interrupt whatever's already buffered."""
        while True:
            self._interval_changed.clear()
            try:
                await asyncio.wait_for(self._interval_changed.wait(), timeout=self.flush_interval_seconds)
            except asyncio.TimeoutError:
                pass
            await self._flush()

    async def _flush(self) -> None:
        """Atomically swaps out whatever's currently buffered -- no
        `await` between the read and the reassignment, so a concurrently-
        running _enqueue (same event loop thread) can never see a
        half-swapped buffer or lose a record in the gap -- and writes it
        to Redis in chunked pipelines (see _write_rows)."""
        if not self._buffer:
            return
        pending, self._buffer = self._buffer, []
        await self._write_rows(pending)

    async def bulk_record(self, rows: list[tuple[str, float, dict]]) -> None:
        """For batch imports (State.load_sample loading a whole .cttc-record/
        .cttc-metric archive) rather than the hot ingestion paths record()
        serves: writes everything directly in chunked pipelines, awaited
        here, instead of going through the buffered live-ingestion path.

        record()'s buffer (MAX_BUFFERED_RECORDS, see start()) is sized for
        the drip of real-time samples accumulating between flushes -- a
        bulk load can hand it tens of thousands of rows in one synchronous
        burst (every row of every source in the archive), overflowing it
        and silently, permanently dropping the excess (br-REDIS-018).
        Blocking here for the duration of an explicit, user-initiated
        "Open" is correct, unlike record()'s callers, which must never
        stall."""
        if not self.enabled or not rows:
            return
        await self._write_rows(rows)

    async def _write_rows(self, rows: list[tuple[str, float, dict]]) -> None:
        """Writes `rows` to Redis in chunked pipelines -- shared by
        bulk_record (one-shot batch import, awaited directly) and _flush
        (the periodic buffered-write path, i.e. sRate)."""
        chunk_size = 500
        for i in range(0, len(rows), chunk_size):
            chunk = rows[i : i + chunk_size]
            pipe = self._client.pipeline(transaction=False)
            entities = set()
            for entity_id, ts, payload in chunk:
                field = str(ts)
                pipe.hset(f"cttc:log:{entity_id}", field, orjson.dumps(payload))
                pipe.zadd(f"cttc:idx:{entity_id}", {field: ts})
                pipe.hexpire(f"cttc:log:{entity_id}", int(self.ttl_seconds), field)
                entities.add(entity_id)
            for entity_id in entities:
                pipe.sadd("cttc:entities", entity_id)
            try:
                await pipe.execute()
            except Exception as e:
                # Broad on purpose: this must keep writing later batches
                # even after one bad batch (a malformed payload, a
                # transient Redis hiccup) -- but since Redis is the sole
                # store, a batch that doesn't land here is permanently
                # gone, so this must never be quieter than `warning`.
                logger.warning(
                    "redis_log: write failed, %d samples lost: %s: %s",
                    len(chunk),
                    type(e).__name__,
                    e,
                )

    # ── sRate ────────────────────────────────────────────────────────────

    def set_flush_interval(self, seconds: float) -> None:
        """Runtime-adjustable without a restart (sRate, see server.py's
        POST /logs/rate). Unlike the old set_ttl, this touches no Redis at
        all -- it's a plain attribute -- so it's synchronous, not async,
        and never blocks. Setting _interval_changed wakes _flush_loop
        immediately even if it's mid-sleep on a now-stale (long) interval,
        rather than leaving the change to only take effect once that old
        sleep happens to finish on its own (see _flush_loop's own
        docstring) -- but never drops or interrupts whatever's currently
        buffered, since waking early just runs an ordinary _flush() a
        little sooner than it otherwise would have."""
        if seconds < MIN_FLUSH_INTERVAL_SECONDS:
            raise ValueError(
                f"flush interval must be at least {MIN_FLUSH_INTERVAL_SECONDS}s, got {seconds!r} -- "
                "anything smaller risks a tight loop hammering Redis every cycle"
            )
        self.flush_interval_seconds = seconds
        if self._interval_changed is not None:
            self._interval_changed.set()

    # ── sTTL ─────────────────────────────────────────────────────────────

    async def reconcile_ttl(self) -> None:
        """Startup-only retention reconciliation (br-REDIS-020). sTTL is
        read-only after construction now, so the only time it can ever
        change is between one gateway startup and the next. Compares this
        startup's self.ttl_seconds against whatever was durably recorded
        last time (`config:sTTL`) -- a no-op if unchanged. If changed,
        walks every entity in cttc:entities via logs.lua's reconcileTTL
        Redis Function, called once per HSCAN cursor step per entity (same
        shape as the old set_ttl()'s own HSCAN loop) rather than one giant
        atomic EVAL, so a large history never blocks Redis for longer than
        one small batch.

        Age-based, not a blanket reset (unlike the old set_ttl): each
        field's name IS its creation timestamp (ms, see this module's
        schema docstring) -- reconcileTTL uses that to compute each
        record's *remaining* lifetime under the new sTTL, re-expiring it to
        exactly that (not simply stamping the full new sTTL onto every
        field, which would incorrectly extend already-old data), or
        deleting it outright if the new, shorter retention means it's
        already past its retention window."""
        if not self.enabled:
            return
        new_ttl = self.ttl_seconds
        stored = await self._client.get("config:sTTL")
        if stored is not None and float(stored) == new_ttl:
            logger.info("redis_log: sTTL unchanged (%.0fs) -- skipping retention reconciliation", new_ttl)
            return
        logger.info(
            "redis_log: sTTL %s -> %.0fs -- reconciling retention across every known entity",
            (stored.decode() if isinstance(stored, bytes) else stored) if stored is not None else "(none stored)",
            new_ttl,
        )
        now_ms = time.time() * 1000.0
        entities_raw = await self._client.smembers("cttc:entities")
        total_kept = total_deleted = total_entities = 0
        for raw in entities_raw:
            entity_id = raw.decode() if isinstance(raw, bytes) else raw
            hash_key = f"cttc:log:{entity_id}"
            zset_key = f"cttc:idx:{entity_id}"
            cursor = "0"
            while True:
                next_cursor, kept, deleted = await self._client.fcall(
                    "reconcileTTL", 0, hash_key, zset_key, cursor, str(int(new_ttl)), str(int(now_ms))
                )
                total_kept += kept
                total_deleted += deleted
                cursor = next_cursor.decode() if isinstance(next_cursor, bytes) else str(next_cursor)
                if cursor == "0":
                    break
            total_entities += 1
        await self._client.set("config:sTTL", str(new_ttl))
        logger.info(
            "redis_log: retention reconciliation complete across %d entities -- %d fields re-expired, "
            "%d fields deleted (already past the new %.0fs retention)",
            total_entities,
            total_kept,
            total_deleted,
            new_ttl,
        )

    # ── reading ──────────────────────────────────────────────────────────
    #
    # These back every live read path now (LogSource/StatsSource in
    # server.py) -- Source objects keep no RAM copy of their own to fall
    # back to, so every one of these is a real round trip to Redis over the
    # unix socket. Kept as thin, schema-only wrappers (no log/stats-specific
    # semantics) so server.py's methods stay the readable/authoritative
    # place for e.g. bucketing math.

    async def total(self, entity_id: str) -> int:
        """ZCARD -- total record count for `entity_id`."""
        return await self._client.zcard(f"cttc:idx:{entity_id}")

    async def slice_by_rank(
        self, entity_id: str, start: int, count: int
    ) -> list[tuple[float, dict]]:
        """Positional page: the `count` records starting at rank `start`
        (0-based, insertion/score order), as [(ts, payload), ...]."""
        start = max(0, start)
        count = max(0, count)
        if count == 0:
            return []
        idx_key = f"cttc:idx:{entity_id}"
        fields_scores = await self._client.zrange(
            idx_key, start, start + count - 1, withscores=True
        )
        if not fields_scores:
            return []
        fields = [f for f, _ in fields_scores]
        values = await self._client.hmget(f"cttc:log:{entity_id}", fields)
        out = []
        stale = []
        for (field, score), raw in zip(fields_scores, values):
            if raw is None:
                stale.append(field)  # br-REDIS-011: field expired, index member didn't
                continue
            out.append((score, orjson.loads(raw)))
        if stale:
            await self._client.zrem(idx_key, *stale)
        return out

    async def rank_at_score(self, entity_id: str, t: float) -> int | None:
        """Nearest-record lookup by time: the rank (0-based index) of
        whichever record is closest to `t`, straddling both directions with
        a 1-item LIMIT each so this stays O(1) regardless of history size.
        Used by both LogSource.index_at and StatsSource.point_at's index
        variant. None only when the whole zset is empty."""
        idx_key = f"cttc:idx:{entity_id}"
        after, before = await asyncio.gather(
            self._client.zrangebyscore(idx_key, t, "+inf", start=0, num=1, withscores=True),
            self._client.zrevrangebyscore(idx_key, t, "-inf", start=0, num=1, withscores=True),
        )
        candidates = list(after) + list(before)
        if not candidates:
            return None
        field, _ = min(candidates, key=lambda fs: abs(fs[1] - t))
        return await self._client.zrank(idx_key, field)

    async def nearest(self, entity_id: str, t: float) -> tuple[float, dict] | None:
        """Nearest-record lookup by time, payload included -- used for
        StatsSource.point_at (no index concept there, just "the closest
        sample"). Retries past a stale index entry (br-REDIS-011: the
        field's hash payload can expire while the zset member lingers) by
        pruning it and re-querying, rather than returning None even though
        a genuinely live nearby sample exists."""
        idx_key = f"cttc:idx:{entity_id}"
        hash_key = f"cttc:log:{entity_id}"
        while True:
            after, before = await asyncio.gather(
                self._client.zrangebyscore(idx_key, t, "+inf", start=0, num=1, withscores=True),
                self._client.zrevrangebyscore(idx_key, t, "-inf", start=0, num=1, withscores=True),
            )
            candidates = list(after) + list(before)
            if not candidates:
                return None
            field, score = min(candidates, key=lambda fs: abs(fs[1] - t))
            raw = await self._client.hget(hash_key, field)
            if raw is not None:
                return score, orjson.loads(raw)
            await self._client.zrem(idx_key, field)  # br-REDIS-011: prune, then retry

    async def latest(self, entity_id: str) -> tuple[float, dict] | None:
        """The single most-recent record for `entity_id`, payload included
        -- used by EventManager._check_metric's threshold check (the old
        RAM version read series[...][-1]). Walks past stale index entries
        (br-REDIS-011: their hash field expired but the zset member didn't)
        instead of returning None just because the newest one has expired."""
        idx_key = f"cttc:idx:{entity_id}"
        hash_key = f"cttc:log:{entity_id}"
        while True:
            last = await self._client.zrange(idx_key, -1, -1, withscores=True)
            if not last:
                return None
            field, score = last[0]
            raw = await self._client.hget(hash_key, field)
            if raw is not None:
                return score, orjson.loads(raw)
            await self._client.zrem(idx_key, field)  # br-REDIS-011: prune, then retry

    async def first_last(self, entity_id: str) -> tuple[float, float] | None:
        """(first_ts, last_ts) for `entity_id`, or None if it has no
        records at all."""
        idx_key = f"cttc:idx:{entity_id}"
        async with self._fanout_limit:
            # Pipelined (one connection checkout, one round trip) rather than
            # gather()'d over two separate commands (two checkouts) -- this
            # is the innermost call in describe()/range()'s nested fan-out
            # over every source x every service, so halving its pool
            # pressure matters.
            async with self._client.pipeline(transaction=False) as pipe:
                pipe.zrange(idx_key, 0, 0, withscores=True)
                pipe.zrange(idx_key, -1, -1, withscores=True)
                first, last = await pipe.execute()
        if not first or not last:
            return None
        return first[0][1], last[0][1]

    async def range_by_score(self, entity_id: str, t0: float, t1: float) -> list[float]:
        """Timestamps only (no payload fetch) for every record scored in
        [t0, t1] -- backs LogSource.ticks's density-bucketing, which never
        needs the record text itself."""
        idx_key = f"cttc:idx:{entity_id}"
        fields_scores = await self._client.zrangebyscore(idx_key, t0, t1, withscores=True)
        return [score for _field, score in fields_scores]

    async def range_by_score_with_payload(
        self, entity_id: str, t0: float, t1: float
    ) -> list[tuple[float, dict]]:
        """[(ts, payload), ...] for every record scored in [t0, t1] --
        backs StatsSource.bucketed, which needs cpu/mem/net out of the
        payload."""
        idx_key = f"cttc:idx:{entity_id}"
        fields_scores = await self._client.zrangebyscore(idx_key, t0, t1, withscores=True)
        if not fields_scores:
            return []
        fields = [f for f, _ in fields_scores]
        values = await self._client.hmget(f"cttc:log:{entity_id}", fields)
        out = []
        stale = []
        for (field, score), raw in zip(fields_scores, values):
            if raw is None:
                stale.append(field)  # br-REDIS-011: field expired, index member didn't
                continue
            out.append((score, orjson.loads(raw)))
        if stale:
            await self._client.zrem(idx_key, *stale)
        return out

    async def find_text(
        self, entity_id: str, query: str, start: int, forward: bool, batch: int = 500
    ) -> int | None:
        """Case-insensitive substring search over a `text` payload field,
        wrapping around the whole log -- reproduces the old RAM linear/
        wraparound scan (LogSource.find), just round-tripped in batches of
        `batch` records instead of one Python list. Same worst-case
        complexity as the RAM version, bounded round trips instead of a
        single in-process scan."""
        q = query.strip().lower()
        if not q:
            return None
        n = await self.total(entity_id)
        if n == 0:
            return None
        start = max(0, min(start, n - 1))
        idx_key = f"cttc:idx:{entity_id}"
        hash_key = f"cttc:log:{entity_id}"

        async def scan_segment(lo: int, hi: int, reverse: bool) -> int | None:
            """Walk the contiguous rank range [lo, hi] (inclusive), `batch`
            ranks at a time -- ascending order unless `reverse`. ZRANGE has
            no native descending-by-rank form, so a backward search fetches
            each batch ascending and reverses it in Python before matching,
            which still visits records in the right overall order."""
            if lo > hi:
                return None
            ranks = list(range(hi, lo - 1, -1)) if reverse else list(range(lo, hi + 1))
            for wstart in range(0, len(ranks), batch):
                chunk = ranks[wstart : wstart + batch]
                wlo, whi = min(chunk), max(chunk)
                fields = await self._client.zrange(idx_key, wlo, whi, withscores=False)
                if not fields:
                    continue
                values = await self._client.hmget(hash_key, fields)
                pairs = list(zip(range(wlo, whi + 1), values))
                if reverse:
                    pairs.reverse()
                for i, raw in pairs:
                    if raw is None:
                        continue
                    payload = orjson.loads(raw)
                    if q in str(payload.get("text", "")).lower():
                        return i
            return None

        # Two contiguous rank segments cover the whole wraparound scan, same
        # as the old RAM version's `order` list.
        if forward:
            segments = [(start, n - 1, False), (0, start - 1, False)]
        else:
            segments = [(0, start, True), (start + 1, n - 1, True)]

        for lo, hi, reverse in segments:
            hit = await scan_segment(lo, hi, reverse)
            if hit is not None:
                return hit
        return None

    # ── remote-daemon registry (for reconnecting on the gateway's own restart) ──

    async def remember_daemon(self, host: str, body: dict) -> None:
        if not self.enabled or not host:
            return
        await self._client.hset("cttc:daemons", host, orjson.dumps(body))

    async def known_daemons(self) -> list[dict]:
        if not self.enabled:
            return []
        raw = await self._client.hgetall("cttc:daemons")
        return [orjson.loads(v) for v in raw.values()]

    async def forget_daemon(self, host: str) -> None:
        """Removes a remembered remote daemon (br-REDIS-017) -- the
        counterpart remember_daemon lacked entirely. Without this,
        State.close_source only ever drops the in-memory source; the entry
        here survives, so a host removed in the UI kept being silently
        re-collected forever on the gateway's own next restart (see
        lifespan()'s known_daemons() replay), including with a since-deleted
        ssh_key path."""
        if not self.enabled or not host:
            return
        await self._client.hdel("cttc:daemons", host)

    # ── gateway ownership (br-OWNER-001, REQ-0069) ──────────────────────

    async def write_ownership(self, record: dict) -> bool:
        """Writes cttc:gateway:ownership only if it doesn't exist yet (SET
        NX) -- first claim wins, atomically, so a second client connecting
        to an already-owned gateway can never race a rewrite of the record
        (br-OWNER-001). No HEXPIRE/TTL, unlike cttc:log:*: ownership must
        survive indefinitely, not decay like telemetry. Returns whether
        this call actually wrote the record (False means one already
        existed and was left untouched)."""
        if not self.enabled:
            return False
        wrote = await self._client.set("cttc:gateway:ownership", orjson.dumps(record), nx=True)
        return bool(wrote)

    async def read_ownership(self) -> dict | None:
        if not self.enabled:
            return None
        raw = await self._client.get("cttc:gateway:ownership")
        return orjson.loads(raw) if raw is not None else None

    async def overwrite_ownership(self, record: dict) -> None:
        """Unconditional SET, unlike write_ownership's SET NX -- the one
        path allowed to *replace* an existing ownership record rather than
        only ever establish a first one. Callers (server.py's
        /gateway/ownership/rotate) are responsible for the actual
        authorization check (br-OWNER-003, via _require_owner_signature)
        before ever reaching this; this method itself trusts its caller
        completely, same as e.g. remember_daemon."""
        if not self.enabled:
            return
        await self._client.set("cttc:gateway:ownership", orjson.dumps(record))

    # ── admin-action nonces (br-OWNER-003, REQ-0069) ────────────────────

    async def remember_nonce(self, nonce: str, ttl_seconds: float) -> None:
        """Short-lived, single-use challenge for admin-action authorization
        (br-OWNER-003) -- SETEX so an unconsumed nonce expires on its own
        rather than accumulating forever. `nonce` is generated by the
        caller (server.py, matching how gateway_id is minted there too),
        not here -- this module only ever stores/reads, it doesn't
        synthesize identifiers (see remember_daemon)."""
        if not self.enabled or not nonce:
            return
        await self._client.set(f"cttc:gateway:nonce:{nonce}", b"1", ex=int(ttl_seconds))

    async def consume_nonce(self, nonce: str) -> bool:
        """Atomic exists+delete (GETDEL) rather than EXISTS then DEL: two
        concurrent admin requests racing to consume the exact same nonce
        must never both succeed, which a check-then-delete would allow
        under the right interleaving. Returns whether the nonce was found
        (and is now gone either way, once this returns)."""
        if not self.enabled or not nonce:
            return False
        deleted = await self._client.getdel(f"cttc:gateway:nonce:{nonce}")
        return deleted is not None

    # ── gateway peer-discovery list (br-MESH-001, REQ-0070) ─────────────

    async def load_gateway_list(self) -> dict:
        """cttc:gateway:list -- a single orjson blob keyed by each entry's
        own canonical `lower(host):port` string, not the cttc:log:*
        hash+zset pattern: the list is small and bounded (br-MESH-005), so
        one GET/SET beats per-field HEXPIRE bookkeeping this data has no
        use for (unlike telemetry, a gateway list entry never expires on
        its own -- it's superseded by a fresher sync instead). Read only
        from `lifespan()` (after `redis_log.start()` succeeds) and from
        `POST /gateways/sync` -- never eagerly replayed the way the
        broken `cttc:daemons` registry is (br-REDIS-016), so this can't
        inherit that startup-ordering bug."""
        if not self.enabled:
            return {}
        raw = await self._client.get("cttc:gateway:list")
        return orjson.loads(raw) if raw is not None else {}

    async def save_gateway_list(self, entries: dict) -> None:
        if not self.enabled:
            return
        await self._client.set("cttc:gateway:list", orjson.dumps(entries))
