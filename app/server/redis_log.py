"""Durable store for logs/telemetry, backed by a Redis instance the gateway
starts itself (see Dockerfile for the containerized image, main.js for the
bare/embedded dev path).

Redis is the *sole* source of truth for logs/telemetry reads (/series,
/logs, /range, /ticks, /point, /index_at, /logs/find, rolling buffers,
event conditions, recording-session exports -- see server.py's
LogSource/StatsSource): Source objects keep no unbounded RAM history of
their own, only small bounded bookkeeping (LogSource._last_row,
StatsSource._services). Redis also bounds how long history is kept
(default 3 days, live-configurable via /logs/ttl), which unbounded RAM
never did.

Schema: one hash + one sorted-set index per entity (container name, or
`host@<hostname>` for host telemetry -- matching the label scheme already
used for Source.path in server.py):
    cttc:log:<entity_id>   hash  field=timestamp(ms, str)  value=orjson record
    cttc:idx:<entity_id>   zset  member=same field          score=timestamp
    cttc:entities          set   every entity_id ever recorded (for set_ttl's
                                  walk, and for the daemon-registry style
                                  bootstrap when re-serving old history)
    cttc:daemons           hash  host -> the exact /docker/collect request
                                  body that opened it (used to reconnect
                                  remote hosts on the gateway's own restart)

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


DEFAULT_TTL_SECONDS = 3 * 24 * 3600.0  # 3 days
# TCP monitor port -- bound to 127.0.0.1 only (see start()), so an external
# tool (redis-cli, RedisInsight) can inspect the store on the same machine
# the gateway runs on, in both deployment modes. Loopback-only and
# unauthenticated is a deliberate choice: no new exposure over what's
# already trusted (matches the HTTP API's own --host 127.0.0.1 default),
# since the containerized gateway's network_mode: host means a non-loopback
# bind here would land directly on the real host's network interfaces.
DEFAULT_TCP_PORT = 56379
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


class RedisLog:
    """One instance lives on State (see server.py's State.__init__). Redis
    is a hard dependency now (sole source of truth for reads) -- start()
    raises rather than degrading, so once it returns every method here is
    safe to call unconditionally."""

    enabled = False

    def __init__(self, socket_path: str | None = None, tcp_port: int | None = None):
        """`socket_path` defaults to the module-level SOCKET_PATH (every
        real deployment mode's one true instance) -- overridable purely so
        tests that need two genuinely independent Redis instances in the
        same process (e.g. simulating two separate gateway restarts, or
        two Source objects that happen to share an entity name) can each
        spawn their own, rather than colliding on the one fixed path.
        `tcp_port` similarly defaults to DEFAULT_TCP_PORT -- None here means
        "use the default", not "disabled": the TCP monitor listener is
        always on, only its port number is configurable (see server.py's
        --redis-port)."""
        self._client = None
        self._proc: asyncio.subprocess.Process | None = None
        self._queue: asyncio.Queue | None = None
        self._pump_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.ttl_seconds = DEFAULT_TTL_SECONDS
        self._socket_path = socket_path or SOCKET_PATH
        self._tcp_port = tcp_port or DEFAULT_TCP_PORT

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
            "--save",
            "",  # ephemeral by design: TTL bounds it, a redeploy losing it is fine
            "--maxmemory",
            "256mb",
            "--maxmemory-policy",
            "volatile-ttl",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        for _ in range(50):  # wait up to ~5s for the socket to appear
            if Path(self._socket_path).exists():
                break
            await asyncio.sleep(0.1)
        else:
            raise RedisUnavailable(
                f"redis_log: redis-server did not create {self._socket_path} in time"
            )

        client = aioredis.Redis(unix_socket_path=self._socket_path, decode_responses=False)
        try:
            await client.ping()
            await client.function_load(LUA_PATH.read_text(), replace=True)
        except Exception as e:
            raise RedisUnavailable(
                f"redis_log: could not initialize redis client/functions: {type(e).__name__}: {e}"
            ) from e

        self._client = client
        self._queue = asyncio.Queue(maxsize=10_000)
        self._loop = asyncio.get_running_loop()
        self._pump_task = asyncio.ensure_future(self._pump())
        self.enabled = True
        logger.info(
            "redis_log: durable store enabled (ttl=%.0fs, tcp monitor port=%d, loopback-only)",
            self.ttl_seconds,
            self._tcp_port,
        )

    async def stop(self) -> None:
        if self._pump_task is not None:
            self._pump_task.cancel()
        if self._proc is not None:
            self._proc.terminate()
            await self._proc.wait()

    # ── writing ──────────────────────────────────────────────────────────

    def record(self, entity_id: str, ts: float, payload: dict) -> None:
        """Non-blocking: called from hot ingestion paths (StatsSource.
        ingest_row, LogSource.ingest_chunk) that must never stall waiting on
        Redis. Queues the write; _pump() does the actual I/O. Redis is the
        sole store now (see this module's docstring) -- a write that never
        makes it in is a real, permanent loss of that sample, not just a
        missed durability copy, so both failure points below (a full queue,
        a failed pipeline in _pump) log at `warning`, loud enough to show up
        without debug logging enabled.

        Uses call_soon_threadsafe rather than put_nowait directly: some
        callers (DockerStatsSource/HostStatsSource) run their sampling via
        asyncio.to_thread, i.e. off the event loop, where asyncio.Queue's
        put_nowait isn't safe to call directly."""
        if not self.enabled:
            return
        self._loop.call_soon_threadsafe(self._enqueue, entity_id, ts, payload)

    def _enqueue(self, entity_id: str, ts: float, payload: dict) -> None:
        try:
            self._queue.put_nowait((entity_id, ts, payload))
        except asyncio.QueueFull:
            logger.warning(
                "redis_log: write queue full (Redis falling behind) -- dropping a sample for %s",
                entity_id,
            )

    async def _pump(self) -> None:
        while True:
            entity_id, ts, payload = await self._queue.get()
            field = str(ts)
            try:
                pipe = self._client.pipeline(transaction=False)
                pipe.hset(f"cttc:log:{entity_id}", field, orjson.dumps(payload))
                pipe.zadd(f"cttc:idx:{entity_id}", {field: ts})
                pipe.hexpire(f"cttc:log:{entity_id}", int(self.ttl_seconds), field)
                pipe.sadd("cttc:entities", entity_id)
                await pipe.execute()
            except Exception as e:
                # Broad on purpose: this loop must keep pumping later
                # samples even after one bad write (a malformed payload, a
                # transient Redis hiccup) -- but since Redis is the sole
                # store, a write that doesn't land here is permanently
                # gone, so this must never be quieter than `warning`.
                logger.warning(
                    "redis_log: write failed, sample for %s@%s lost: %s: %s",
                    entity_id,
                    ts,
                    type(e).__name__,
                    e,
                )

    # ── TTL ──────────────────────────────────────────────────────────────

    async def set_ttl(self, seconds: float) -> None:
        """Changes the default for future writes, and re-applies HEXPIRE to
        every already-stored field across every known entity -- "even live:
        changes to this configuration would trigger a new ttl for future
        and existing entries" per the original ask. Uses HSCAN, not
        HKEYS/KEYS, so this doesn't block Redis on a large hash."""
        self.ttl_seconds = seconds
        if not self.enabled:
            return
        entities = await self._client.smembers("cttc:entities")
        for raw in entities:
            entity_id = raw.decode() if isinstance(raw, bytes) else raw
            hash_key = f"cttc:log:{entity_id}"
            cursor = 0
            while True:
                cursor, batch = await self._client.hscan(hash_key, cursor)
                if batch:
                    fields = list(batch.keys())
                    await self._client.hexpire(hash_key, int(seconds), *fields)
                if cursor == 0:
                    break

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
        for (_field, score), raw in zip(fields_scores, values):
            if raw is None:
                continue
            out.append((score, orjson.loads(raw)))
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
        sample")."""
        idx_key = f"cttc:idx:{entity_id}"
        after, before = await asyncio.gather(
            self._client.zrangebyscore(idx_key, t, "+inf", start=0, num=1, withscores=True),
            self._client.zrevrangebyscore(idx_key, t, "-inf", start=0, num=1, withscores=True),
        )
        candidates = list(after) + list(before)
        if not candidates:
            return None
        field, score = min(candidates, key=lambda fs: abs(fs[1] - t))
        raw = await self._client.hget(f"cttc:log:{entity_id}", field)
        if raw is None:
            return None
        return score, orjson.loads(raw)

    async def latest(self, entity_id: str) -> tuple[float, dict] | None:
        """The single most-recent record for `entity_id`, payload included
        -- used by EventManager._check_metric's threshold check (the old
        RAM version read series[...][-1])."""
        idx_key = f"cttc:idx:{entity_id}"
        last = await self._client.zrange(idx_key, -1, -1, withscores=True)
        if not last:
            return None
        field, score = last[0]
        raw = await self._client.hget(f"cttc:log:{entity_id}", field)
        if raw is None:
            return None
        return score, orjson.loads(raw)

    async def first_last(self, entity_id: str) -> tuple[float, float] | None:
        """(first_ts, last_ts) for `entity_id`, or None if it has no
        records at all."""
        idx_key = f"cttc:idx:{entity_id}"
        first, last = await asyncio.gather(
            self._client.zrange(idx_key, 0, 0, withscores=True),
            self._client.zrange(idx_key, -1, -1, withscores=True),
        )
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
        for (_, score), raw in zip(fields_scores, values):
            if raw is None:
                continue
            out.append((score, orjson.loads(raw)))
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
