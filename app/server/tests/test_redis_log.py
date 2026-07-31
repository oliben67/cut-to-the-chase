"""Tests for redis_log.py.

Redis is a hard dependency now (the sole source of truth for logs/telemetry
reads -- see redis_log.py's module docstring), so every test here exercises
a real redis-server subprocess (see conftest.py's redis_log_instance
fixture, which launches it the same way RedisLog.start() itself does).
There is no disabled/no-op path left to test."""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

import redis_log


def _short_socket_path() -> str:
    """A unix socket path under /tmp directly, not pytest's tmp_path --
    tmp_path nests several directories deep (.../pytest-of-x/pytest-NN/
    test_name0/...), which routinely exceeds the ~104-byte unix socket path
    limit (macOS/BSD; Linux's is a little more forgiving) and makes
    redis-server fail to bind silently (stderr is DEVNULL) -- indistinguishable
    from a genuinely slow/broken start() unless you know to look for it."""
    return str(Path(tempfile.gettempdir()) / f"cttc-test-{os.getpid()}-{uuid.uuid4().hex[:8]}.sock")


async def test_start_enables_the_store(redis_log_instance):
    assert redis_log_instance.enabled is True


def test_tcp_port_defaults_to_the_module_constant():
    rl = redis_log.RedisLog()  # not started -- just checking the attribute
    assert rl._tcp_port == redis_log.DEFAULT_TCP_PORT == 56379


def test_tcp_port_override_is_respected():
    rl = redis_log.RedisLog(tcp_port=61234)
    assert rl._tcp_port == 61234


async def test_start_binds_loopback_only_tcp_port(monkeypatch):
    """Confirms the actual redis-server invocation asks for a loopback-only
    bind -- --bind/--protected-mode are the real controls here, not just
    which port number is picked."""
    captured = {}
    real_exec = asyncio.create_subprocess_exec

    async def spy_exec(*args, **kwargs):
        captured["args"] = args
        return await real_exec(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spy_exec)
    rl = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=61235)
    await rl.start()
    try:
        args = captured["args"]
        assert "--bind" in args and args[args.index("--bind") + 1] == "127.0.0.1"
        assert "--protected-mode" in args and args[args.index("--protected-mode") + 1] == "no"
        assert "--port" in args and args[args.index("--port") + 1] == "61235"
    finally:
        await rl.stop()


async def test_tcp_port_is_actually_reachable_and_usable(redis_log_instance):
    """Not just "redis-server accepted the flag" -- a real client, connected
    over TCP rather than the unix socket every other test here uses, can
    actually read data written through the normal record()/_pump path."""
    import redis.asyncio as aioredis

    rl = redis_log_instance
    rl.record("tcp-check", 1000.0, {"text": "hello over tcp"})
    await asyncio.sleep(0.2)  # let the pump drain, same as _settle() below

    tcp_client = aioredis.Redis(host="127.0.0.1", port=rl._tcp_port, decode_responses=True)
    try:
        assert await tcp_client.ping() is True
        raw = await tcp_client.hget("cttc:log:tcp-check", "1000.0")
        assert raw and "hello over tcp" in raw
    finally:
        await tcp_client.aclose()


async def test_start_raises_when_redis_server_missing(monkeypatch):
    import shutil as shutil_module

    monkeypatch.setattr(shutil_module, "which", lambda _name: None)
    rl = redis_log.RedisLog()
    with pytest.raises(RuntimeError, match="redis-server"):
        await rl.start()
    assert rl.enabled is False


async def test_stop_without_start_does_not_raise():
    rl = redis_log.RedisLog()
    await rl.stop()


async def test_start_raises_when_redis_package_missing(monkeypatch, tmp_path):
    # `import redis.asyncio` inside start() -- a module set to None in
    # sys.modules makes the import machinery raise ImportError, same as it
    # not being installed at all.
    monkeypatch.setitem(sys.modules, "redis.asyncio", None)
    rl = redis_log.RedisLog(socket_path=_short_socket_path())
    with pytest.raises(redis_log.RedisUnavailable, match="python package"):
        await rl.start()
    assert rl.enabled is False


async def test_start_raises_when_socket_never_appears():
    # redis-server can't create a unix socket inside a directory that
    # doesn't exist -- it exits almost immediately, but start()'s polling
    # loop doesn't check process state, only the socket path, so this
    # exercises the real "waited the full 5s, still nothing" timeout.
    rl = redis_log.RedisLog(socket_path=_short_socket_path() + ".no-such-dir/test.sock")
    with pytest.raises(redis_log.RedisUnavailable, match="did not create"):
        await rl.start()
    assert rl.enabled is False


async def test_start_raises_when_function_load_fails(monkeypatch, tmp_path):
    # redis-server itself comes up fine (ping() would succeed) -- point
    # LUA_PATH at a file that doesn't exist so function_load's read_text()
    # raises, exercising start()'s post-ping initialization failure path
    # without needing to break a real redis-server. Needs a *short* socket
    # path (see _short_socket_path's docstring) since this one has to
    # actually succeed in binding.
    monkeypatch.setattr(redis_log, "LUA_PATH", tmp_path / "does-not-exist.lua")
    rl = redis_log.RedisLog(socket_path=_short_socket_path())
    with pytest.raises(redis_log.RedisUnavailable, match="could not initialize"):
        await rl.start()
    assert rl.enabled is False
    await rl.stop()  # redis-server itself did come up -- clean it up


async def test_disabled_instance_helpers_are_all_safe_noops():
    """A RedisLog that was never start()ed (or whose start() failed) has no
    _client at all -- every one of these must still be callable without
    raising, matching how they behave for the (now-legacy) disabled path."""
    rl = redis_log.RedisLog()
    await rl.set_ttl(99.0)
    assert rl.ttl_seconds == 99.0
    await rl.remember_daemon("ssh://host", {"host": "ssh://host"})
    assert await rl.known_daemons() == []
    rl.record("c", 1.0, {"text": "dropped, no _client to enqueue against"})  # must not raise


async def test_range_by_score_with_payload_empty_range_returns_empty_list(redis_log_instance):
    rl = redis_log_instance
    rl.record("c13", 1000.0, {"text": "outside"})
    await _settle()
    assert await rl.range_by_score_with_payload("c13", 5000.0, 6000.0) == []


async def _settle():
    # record() enqueues via call_soon_threadsafe and is pumped
    # asynchronously; give the pump a beat.
    await asyncio.sleep(0.2)


async def test_total_and_slice_by_rank(redis_log_instance):
    rl = redis_log_instance
    rl.record("c1", 1000.0, {"text": "one"})
    rl.record("c1", 2000.0, {"text": "two"})
    rl.record("c1", 3000.0, {"text": "three"})
    await _settle()

    assert await rl.total("c1") == 3
    page = await rl.slice_by_rank("c1", 0, 2)
    assert [p["text"] for _ts, p in page] == ["one", "two"]
    page2 = await rl.slice_by_rank("c1", 1, 10)
    assert [p["text"] for _ts, p in page2] == ["two", "three"]
    assert await rl.slice_by_rank("c1", 0, 0) == []


async def test_total_and_slice_for_unknown_entity(redis_log_instance):
    rl = redis_log_instance
    assert await rl.total("nope") == 0
    assert await rl.slice_by_rank("nope", 0, 10) == []


async def test_rank_at_score_nearest(redis_log_instance):
    rl = redis_log_instance
    rl.record("c2", 1000.0, {"text": "a"})
    rl.record("c2", 5000.0, {"text": "b"})
    await _settle()

    assert await rl.rank_at_score("c2", 500.0) == 0  # before everything -> first
    assert await rl.rank_at_score("c2", 1000.0) == 0  # exact match
    assert await rl.rank_at_score("c2", 2900.0) == 0  # nearer to a
    assert await rl.rank_at_score("c2", 3100.0) == 1  # nearer to b
    assert await rl.rank_at_score("c2", 999999.0) == 1  # past everything -> last
    assert await rl.rank_at_score("empty-entity", 0.0) is None


async def test_nearest_and_latest(redis_log_instance):
    rl = redis_log_instance
    rl.record("svc1", 1000.0, {"cpu": 10.0})
    rl.record("svc1", 5000.0, {"cpu": 90.0})
    await _settle()

    ts, payload = await rl.nearest("svc1", 2900.0)
    assert ts == 1000.0 and payload["cpu"] == 10.0
    ts, payload = await rl.nearest("svc1", 3100.0)
    assert ts == 5000.0 and payload["cpu"] == 90.0
    assert await rl.nearest("empty-entity", 0.0) is None

    ts, payload = await rl.latest("svc1")
    assert ts == 5000.0 and payload["cpu"] == 90.0
    assert await rl.latest("empty-entity") is None


async def test_first_last(redis_log_instance):
    rl = redis_log_instance
    assert await rl.first_last("empty-entity") is None
    rl.record("c3", 1000.0, {"text": "a"})
    rl.record("c3", 9000.0, {"text": "b"})
    await _settle()
    assert await rl.first_last("c3") == (1000.0, 9000.0)


async def test_range_by_score(redis_log_instance):
    rl = redis_log_instance
    rl.record("c4", 1000.0, {"text": "a"})
    rl.record("c4", 2000.0, {"text": "b"})
    rl.record("c4", 5000.0, {"text": "out of range"})
    await _settle()

    assert await rl.range_by_score("c4", 0, 3000) == [1000.0, 2000.0]

    rows = await rl.range_by_score_with_payload("c4", 0, 3000)
    assert [p["text"] for _ts, p in rows] == ["a", "b"]


async def test_find_text_forward_and_backward_with_wraparound(redis_log_instance):
    rl = redis_log_instance
    texts = ["alpha error one", "beta", "gamma error two", "delta"]
    for i, t in enumerate(texts):
        rl.record("c5", float(1000 * (i + 1)), {"text": t})
    await _settle()

    assert await rl.find_text("c5", "error", 0, forward=True) == 0
    assert await rl.find_text("c5", "error", 1, forward=True) == 2  # forward from middle
    assert await rl.find_text("c5", "error", 1, forward=False) == 0  # backward from middle
    assert await rl.find_text("c5", "ERROR one", 1, forward=True) == 0  # wraps past the end
    assert await rl.find_text("c5", "two", 0, forward=False) == 2  # wraps backward
    assert await rl.find_text("c5", "nothing-here", 0, forward=True) is None
    assert await rl.find_text("c5", "   ", 0, forward=True) is None  # blank query
    assert await rl.find_text("nope", "x", 0, forward=True) is None  # empty entity


async def test_find_text_batches_across_pages(redis_log_instance):
    """Regression check for the paginated scan itself, not just its
    boundary conditions -- push past the default 500-record batch size."""
    rl = redis_log_instance
    n = 1200
    for i in range(n):
        rl.record("c6", float(i), {"text": "needle" if i == 999 else "hay"})
    for _ in range(50):  # up to ~5s for the pump to drain 1200 queued writes
        if await rl.total("c6") == n:
            break
        await asyncio.sleep(0.1)
    assert await rl.total("c6") == n

    assert await rl.find_text("c6", "needle", 0, forward=True) == 999
    assert await rl.find_text("c6", "needle", n - 1, forward=False) == 999


async def test_set_ttl_reapplies_to_existing_entries(redis_log_instance):
    rl = redis_log_instance
    rl.record("c7", 1000.0, {"text": "one"})
    await _settle()
    await rl.set_ttl(60.0)
    ttl = await rl._client.httl("cttc:log:c7", "1000.0")
    assert ttl and ttl[0] <= 60


async def test_remember_and_known_daemons(redis_log_instance):
    rl = redis_log_instance
    await rl.remember_daemon("ssh://user@host", {"host": "ssh://user@host"})
    known = await rl.known_daemons()
    assert {"host": "ssh://user@host"} in known


async def test_enqueue_logs_and_drops_when_the_write_queue_is_full(redis_log_instance, caplog):
    rl = redis_log_instance
    rl._queue = asyncio.Queue(maxsize=1)  # shrink it so one write fills it
    rl._enqueue("c8", 1000.0, {"text": "fills the queue"})
    with caplog.at_level(logging.WARNING):
        rl._enqueue("c8", 2000.0, {"text": "dropped"})  # queue full -> logged, not raised
    assert "queue full" in caplog.text


async def test_pump_logs_and_keeps_running_after_a_write_failure(
    redis_log_instance, caplog, monkeypatch
):
    """A single malformed/failed write must not take down the whole pump
    loop -- a later, good write still has to land."""
    rl = redis_log_instance
    real_pipeline = rl._client.pipeline
    calls = {"n": 0}

    def flaky_pipeline(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:

            class BoomPipeline:
                def hset(self, *a, **k):
                    return self

                def zadd(self, *a, **k):
                    return self

                def hexpire(self, *a, **k):
                    return self

                def sadd(self, *a, **k):
                    return self

                async def execute(self):
                    raise RuntimeError("simulated redis write failure")

            return BoomPipeline()
        return real_pipeline(*a, **k)

    monkeypatch.setattr(rl._client, "pipeline", flaky_pipeline)
    with caplog.at_level(logging.WARNING):
        rl.record("c9", 1000.0, {"text": "lost"})
        await _settle()
    assert "write failed" in caplog.text and "lost" not in caplog.text.split("write failed")[0]

    rl.record("c9", 2000.0, {"text": "ok"})
    await _settle()
    assert await rl.total("c9") == 1  # only the second write actually landed


async def test_slice_by_rank_skips_a_field_evicted_between_index_and_hash_read(
    redis_log_instance,
):
    """The index (zset) and the payload (hash) are two separate keys --
    HEXPIRE can evict a hash field a moment before a read gets to HMGET it,
    leaving a member in the index with no matching payload. Every read
    method has to tolerate that (skip it) rather than choke on None."""
    rl = redis_log_instance
    rl.record("c10", 1000.0, {"text": "a"})
    rl.record("c10", 2000.0, {"text": "b"})
    await _settle()
    await rl._client.hdel("cttc:log:c10", "1000.0")  # simulate the eviction race

    page = await rl.slice_by_rank("c10", 0, 10)
    assert [p["text"] for _ts, p in page] == ["b"]

    rows = await rl.range_by_score_with_payload("c10", 0, 3000)
    assert [p["text"] for _ts, p in rows] == ["b"]


async def test_latest_and_nearest_skip_a_field_evicted_after_the_index_lookup(
    redis_log_instance,
):
    rl = redis_log_instance
    rl.record("c11", 1000.0, {"text": "a"})
    await _settle()
    await rl._client.hdel("cttc:log:c11", "1000.0")

    assert await rl.latest("c11") is None
    assert await rl.nearest("c11", 1000.0) is None


async def test_find_text_skips_a_field_evicted_mid_scan(redis_log_instance):
    rl = redis_log_instance
    rl.record("c12", 1000.0, {"text": "needle"})
    rl.record("c12", 2000.0, {"text": "hay"})
    await _settle()
    await rl._client.hdel("cttc:log:c12", "1000.0")  # the needle itself gone

    assert await rl.find_text("c12", "needle", 0, forward=True) is None
    assert await rl.find_text("c12", "hay", 0, forward=True) == 1
