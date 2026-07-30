"""Durable, TTL-bounded side store for logs/telemetry, backed by a Redis
instance bundled into the gateway's own container image (see Dockerfile).

This is a write-through *addition* to the existing RAM-resident storage
(Source.rows/series, see docs/architecture/remote-server.md) -- the live
read path (/series, /logs, rolling buffers, event conditions, recording-
session exports) is untouched and keeps reading straight out of RAM. Redis
exists purely so history survives a gateway restart and to bound how long
that history is kept (default 3 days, live-configurable via /logs/ttl),
which unbounded RAM has never done.

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

`redis-server` is only bundled inside the containerized gateway image (see
Dockerfile) -- this server.py module is also run bare/embedded on a user's
own machine with no Docker image involved (see main.js), where no
redis-server binary exists. start() detects that via shutil.which and
returns a disabled handle whose record()/set_ttl() are no-ops, so every
call site here can call unconditionally with no branching.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from pathlib import Path

import orjson

logger = logging.getLogger("cttc")

DEFAULT_TTL_SECONDS = 3 * 24 * 3600.0  # 3 days
SOCKET_PATH = "/run/cttc-redis.sock"
LUA_PATH = Path(__file__).parent / "logs.lua"


class RedisLog:
    """One instance lives on State (see server.py's State.__init__). Every
    method is a no-op when Redis isn't available (see start()'s disabled
    handle), so callers never need to check `if redis_log.enabled`
    themselves."""

    enabled = False

    def __init__(self):
        self._client = None
        self._proc: asyncio.subprocess.Process | None = None
        self._queue: asyncio.Queue | None = None
        self._pump_task: asyncio.Task | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self.ttl_seconds = DEFAULT_TTL_SECONDS

    # ── lifecycle ────────────────────────────────────────────────────────

    async def start(self) -> None:
        if shutil.which("redis-server") is None:
            logger.info("redis_log: no redis-server binary found -- durable log/telemetry store disabled (expected outside the containerized gateway image)")
            return
        try:
            import redis.asyncio as aioredis  # local import: optional dependency, only needed here
        except ImportError:
            logger.warning("redis_log: redis-server is present but the `redis` python package isn't installed -- durable store disabled")
            return

        self._proc = await asyncio.create_subprocess_exec(
            "redis-server",
            "--unixsocket", SOCKET_PATH,
            "--port", "0",  # no TCP listener at all -- unix socket only
            "--save", "",  # ephemeral by design: TTL bounds it, a redeploy losing it is fine
            "--maxmemory", "256mb",
            "--maxmemory-policy", "volatile-ttl",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        for _ in range(50):  # wait up to ~5s for the socket to appear
            if Path(SOCKET_PATH).exists():
                break
            await asyncio.sleep(0.1)
        else:
            logger.warning("redis_log: redis-server did not create %s in time -- durable store disabled", SOCKET_PATH)
            return

        client = aioredis.Redis(unix_socket_path=SOCKET_PATH, decode_responses=False)
        try:
            await client.ping()
            await client.function_load(LUA_PATH.read_text(), replace=True)
        except Exception as e:
            logger.warning("redis_log: could not initialize redis client/functions: %s: %s", type(e).__name__, e)
            return

        self._client = client
        self._queue = asyncio.Queue(maxsize=10_000)
        self._loop = asyncio.get_running_loop()
        self._pump_task = asyncio.ensure_future(self._pump())
        self.enabled = True
        logger.info("redis_log: durable store enabled (ttl=%.0fs)", self.ttl_seconds)

    async def stop(self) -> None:
        if self._pump_task is not None:
            self._pump_task.cancel()
        if self._proc is not None:
            self._proc.terminate()
            await self._proc.wait()

    # ── writing ──────────────────────────────────────────────────────────

    def record(self, entity_id: str, ts: float, payload: dict) -> None:
        """Best-effort, non-blocking: called from hot ingestion paths
        (StatsSource.ingest_row, LogSource.ingest_chunk) that must never
        stall waiting on Redis. Queues the write; _pump() does the actual
        I/O. Silently drops on a full queue (Redis falling behind) or when
        disabled -- this store is a durability nice-to-have, never a
        dependency for the live path.

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
            logger.debug("redis_log: queue full, dropping a sample for %s", entity_id)

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
                logger.debug("redis_log: write failed for %s@%s: %s", entity_id, ts, e)

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

    async def read_range(self, entity_id: str, t0: float, t1: float) -> list[dict]:
        """History for `entity_id` in [t0, t1] -- only ever needed for a
        range that's aged out of RAM (a gateway restart, or a client asking
        further back than in-process history goes); the live path never
        calls this. Returns [] when disabled or nothing matches."""
        if not self.enabled:
            return []
        raw = await self._client.fcall(
            "getRange", 0, f"cttc:log:{entity_id}", f"cttc:idx:{entity_id}", t0, t1
        )
        return [orjson.loads(v) for v in raw if v is not None]

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
