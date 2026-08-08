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
import time
import uuid
from pathlib import Path

import pytest

import orjson
import redis_log
from conftest import unique_redis_tcp_port


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


async def test_start_binds_loopback_only_tcp_port(monkeypatch, tmp_path):
    """Confirms the actual redis-server invocation asks for a loopback-only
    bind -- --bind/--protected-mode are the real controls here, not just
    which port number is picked."""
    captured = {}
    real_exec = asyncio.create_subprocess_exec

    async def spy_exec(*args, **kwargs):
        captured["args"] = args
        return await real_exec(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spy_exec)
    rl = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=61235, data_dir=tmp_path / "redis-data")
    await rl.start()
    try:
        args = captured["args"]
        assert "--bind" in args and args[args.index("--bind") + 1] == "127.0.0.1"
        assert "--protected-mode" in args and args[args.index("--protected-mode") + 1] == "no"
        assert "--port" in args and args[args.index("--port") + 1] == "61235"
    finally:
        await rl.stop()


async def test_start_uses_an_eviction_policy_that_can_actually_evict(monkeypatch, tmp_path):
    # br-REDIS-012: `volatile-*` policies only consider keys with a
    # key-level EXPIRE, which none of these ever have (TTLs here are all
    # per-field HEXPIRE) -- so the policy must be an `allkeys-*` one, or
    # Redis silently refuses every write once it hits maxmemory instead of
    # evicting anything.
    captured = {}
    real_exec = asyncio.create_subprocess_exec

    async def spy_exec(*args, **kwargs):
        captured["args"] = args
        return await real_exec(*args, **kwargs)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spy_exec)
    rl = redis_log.RedisLog(
        socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=tmp_path / "redis-data"
    )
    await rl.start()
    try:
        args = captured["args"]
        assert "--maxmemory-policy" in args
        policy = args[args.index("--maxmemory-policy") + 1]
        assert policy.startswith("allkeys-"), f"{policy!r} can't evict a key with no key-level TTL"
    finally:
        await rl.stop()


async def test_tcp_port_is_actually_reachable_and_usable(redis_log_instance):
    """Not just "redis-server accepted the flag" -- a real client, connected
    over TCP rather than the unix socket every other test here uses, can
    actually read data written through the normal record()/_flush_loop
    path."""
    import redis.asyncio as aioredis

    rl = redis_log_instance
    rl.record("tcp-check", 1000.0, {"text": "hello over tcp"})
    await asyncio.sleep(0.2)  # let the flush loop drain, same as _settle() below

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


async def test_stop_clears_enabled(tmp_path):
    # br-REDIS-008: `enabled` staying True after stop() let any late
    # record() keep enqueuing against a pump/server that were already gone.
    rl = redis_log.RedisLog(
        socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=tmp_path / "redis-data"
    )
    await rl.start()
    await rl.stop()
    assert rl.enabled is False


async def test_stop_flushes_whatever_was_still_buffered(tmp_path):
    # br-REDIS-008: stop() used to cancel the pump and kill redis-server
    # immediately, permanently losing whatever was still queued/buffered.
    # A long flush_interval_seconds here means the record below is
    # guaranteed to still be sitting unflushed in _buffer when stop() runs.
    # Monkeypatch around terminate()/wait() so redis-server survives past
    # stop() returning, letting us confirm the buffered write actually
    # landed.
    rl = redis_log.RedisLog(
        socket_path=_short_socket_path(),
        tcp_port=unique_redis_tcp_port(),
        flush_interval_seconds=60.0,
        data_dir=tmp_path / "redis-data",
    )
    await rl.start()
    proc = rl._proc
    real_terminate, real_wait = proc.terminate, proc.wait
    proc.terminate = lambda: None
    proc.wait = _noop_async

    rl._enqueue("queued-at-shutdown", 1000.0, {"text": "should not be lost"})
    await rl.stop()  # no sleep first -- the write is still only buffered, not yet flushed

    assert rl.enabled is False
    assert rl._buffer == []
    raw = await rl._client.hget("cttc:log:queued-at-shutdown", "1000.0")
    assert raw is not None
    assert orjson.loads(raw)["text"] == "should not be lost"

    await rl._client.aclose()
    real_terminate()
    await real_wait()


async def _noop_async(*_args, **_kwargs):
    return None


async def test_start_raises_when_redis_package_missing(monkeypatch, tmp_path):
    # `import redis.asyncio` inside start() -- a module set to None in
    # sys.modules makes the import machinery raise ImportError, same as it
    # not being installed at all.
    monkeypatch.setitem(sys.modules, "redis.asyncio", None)
    rl = redis_log.RedisLog(socket_path=_short_socket_path())
    with pytest.raises(redis_log.RedisUnavailable, match="python package"):
        await rl.start()
    assert rl.enabled is False


async def test_start_raises_when_socket_never_appears(tmp_path):
    # redis-server can't create a unix socket inside a directory that
    # doesn't exist -- it exits almost immediately, and start()'s polling
    # loop now checks process state each iteration (not just the socket
    # path), so this fast-fails via that check rather than the plain
    # "waited the full 5s, still nothing" timeout path (which is now only
    # reachable if the process stays alive but the socket genuinely never
    # appears -- not exercised here, since this scenario always exits).
    rl = redis_log.RedisLog(
        socket_path=_short_socket_path() + ".no-such-dir/test.sock", data_dir=tmp_path / "redis-data"
    )
    with pytest.raises(redis_log.RedisUnavailable, match="exited"):
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
    rl = redis_log.RedisLog(socket_path=_short_socket_path(), data_dir=tmp_path / "redis-data")
    with pytest.raises(redis_log.RedisUnavailable, match="could not initialize"):
        await rl.start()
    assert rl.enabled is False
    await rl.stop()  # redis-server itself did come up -- clean it up


async def test_disabled_instance_helpers_are_all_safe_noops():
    """A RedisLog that was never start()ed (or whose start() failed) has no
    _client at all -- every one of these must still be callable without
    raising, matching how they behave for the (now-legacy) disabled path."""
    rl = redis_log.RedisLog()
    rl.set_flush_interval(5.0)
    assert rl.flush_interval_seconds == 5.0
    await rl.reconcile_ttl()  # enabled is False -- must return immediately, no _client touched
    await rl.remember_daemon("ssh://host", {"host": "ssh://host"})
    assert await rl.known_daemons() == []
    await rl.forget_daemon("ssh://host")  # must not raise with no _client either
    rl.record("c", 1.0, {"text": "dropped, no _client to enqueue against"})  # must not raise
    await rl.bulk_record([("c", 1.0, {"text": "dropped, no _client to write against"})])


async def test_record_buffers_and_does_not_land_before_the_flush_interval_elapses(tmp_path):
    # A long flush_interval_seconds so the write is still definitely
    # sitting in the buffer, unflushed, right after record() returns.
    rl = redis_log.RedisLog(
        socket_path=_short_socket_path(),
        tcp_port=unique_redis_tcp_port(),
        flush_interval_seconds=10.0,
        data_dir=tmp_path / "redis-data",
    )
    await rl.start()
    try:
        rl.record("sr1", 1000.0, {"text": "not yet"})
        await asyncio.sleep(0.05)  # let call_soon_threadsafe's _enqueue actually run
        assert len(rl._buffer) == 1
        assert await rl._client.hget("cttc:log:sr1", "1000.0") is None  # not flushed yet
    finally:
        await rl.stop()


async def test_record_lands_once_the_flush_interval_elapses(redis_log_instance):
    rl = redis_log_instance  # flush_interval_seconds=0.05, see conftest.py
    rl.record("sr2", 1000.0, {"text": "eventually"})
    await _settle()
    assert rl._buffer == []
    raw = await rl._client.hget("cttc:log:sr2", "1000.0")
    assert raw is not None and orjson.loads(raw)["text"] == "eventually"


async def test_set_flush_interval_takes_effect_on_the_next_cycle_without_dropping_buffered_data(tmp_path):
    rl = redis_log.RedisLog(
        socket_path=_short_socket_path(),
        tcp_port=unique_redis_tcp_port(),
        flush_interval_seconds=10.0,
        data_dir=tmp_path / "redis-data",
    )
    await rl.start()
    try:
        rl.record("sr3", 1000.0, {"text": "buffered under the long interval"})
        await asyncio.sleep(0.05)
        assert len(rl._buffer) == 1  # confirmed still sitting there, unflushed

        rl.set_flush_interval(0.05)  # shrink it mid-cycle
        await asyncio.sleep(0.2)  # well past the new, shorter interval

        assert rl._buffer == []  # landed -- nothing was dropped by the change
        raw = await rl._client.hget("cttc:log:sr3", "1000.0")
        assert raw is not None
    finally:
        await rl.stop()


async def test_flush_writes_are_chunked_like_bulk_record(redis_log_instance):
    # _write_rows (shared by _flush and bulk_record) chunks in batches of
    # 500 -- push past that through the live record() path, not just
    # bulk_record, to prove _flush's own call into it is wired the same way.
    rl = redis_log_instance
    n = 650
    for i in range(n):
        rl.record("sr4", float(i), {"text": f"row {i}"})
    for _ in range(50):  # up to ~5s for the flush loop to drain them
        if await rl.total("sr4") == n:
            break
        await asyncio.sleep(0.1)
    assert await rl.total("sr4") == n


async def test_range_by_score_with_payload_empty_range_returns_empty_list(redis_log_instance):
    rl = redis_log_instance
    rl.record("c13", 1000.0, {"text": "outside"})
    await _settle()
    assert await rl.range_by_score_with_payload("c13", 5000.0, 6000.0) == []


async def _settle():
    # record() buffers in memory and is flushed to Redis every
    # flush_interval_seconds (sRate, 0.05s for redis_log_instance -- see
    # conftest.py); give it a beat past that.
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
    for _ in range(50):  # up to ~5s for the flush loop to drain 1200 buffered records
        if await rl.total("c6") == n:
            break
        await asyncio.sleep(0.1)
    assert await rl.total("c6") == n

    assert await rl.find_text("c6", "needle", 0, forward=True) == 999
    assert await rl.find_text("c6", "needle", n - 1, forward=False) == 999


@pytest.mark.parametrize("bad", [0.0, -1.0, -3600.0, 0.005])
async def test_set_flush_interval_rejects_too_small_a_value(redis_log_instance, bad):
    rl = redis_log_instance
    good = rl.flush_interval_seconds
    with pytest.raises(ValueError):
        rl.set_flush_interval(bad)
    assert rl.flush_interval_seconds == good  # rejected outright, unchanged


async def test_set_flush_interval_accepts_exactly_the_minimum(redis_log_instance):
    rl = redis_log_instance
    rl.set_flush_interval(redis_log.MIN_FLUSH_INTERVAL_SECONDS)
    assert rl.flush_interval_seconds == redis_log.MIN_FLUSH_INTERVAL_SECONDS


async def test_reconcile_ttl_is_a_noop_when_config_sttl_matches(redis_log_instance):
    rl = redis_log_instance
    rl.record("c7", 1000.0, {"text": "one"})
    await _settle()
    await rl._client.set("config:sTTL", str(rl.ttl_seconds))
    ttl_before = (await rl._client.httl("cttc:log:c7", "1000.0"))[0]
    await rl.reconcile_ttl()
    ttl_after = (await rl._client.httl("cttc:log:c7", "1000.0"))[0]
    assert ttl_after == ttl_before  # untouched -- config:sTTL already matched


async def test_reconcile_ttl_re_expires_records_that_still_have_time_left(redis_log_instance):
    rl = redis_log_instance
    now_ms = time.time() * 1000.0
    rl.record("c7b", now_ms, {"text": "recent"})
    await _settle()
    await rl._client.set("config:sTTL", str(rl.ttl_seconds - 10))  # force a mismatch
    rl.ttl_seconds = 3600.0  # new, larger sTTL
    await rl.reconcile_ttl()
    ttl = await rl._client.httl("cttc:log:c7b", str(now_ms))
    assert ttl and 3500 < ttl[0] <= 3600  # re-expired to ~the new sTTL, not deleted
    assert await rl._client.zscore("cttc:idx:c7b", str(now_ms)) is not None


async def test_reconcile_ttl_deletes_records_that_have_already_outlived_the_new_ttl(
    redis_log_instance,
):
    rl = redis_log_instance
    old_ms = (time.time() - 3600) * 1000.0  # created an hour ago
    rl.record("c7c", old_ms, {"text": "stale"})
    await _settle()
    await rl._client.set("config:sTTL", str(rl.ttl_seconds))
    rl.ttl_seconds = 60.0  # new sTTL far shorter than this record's actual age
    await rl.reconcile_ttl()
    assert await rl._client.hget("cttc:log:c7c", str(old_ms)) is None  # HDEL'd
    assert await rl._client.zscore("cttc:idx:c7c", str(old_ms)) is None  # ZREM'd too, paired


async def test_reconcile_ttl_updates_config_sttl_after_a_successful_pass(redis_log_instance):
    rl = redis_log_instance
    rl.record("c7d", 1000.0, {"text": "one"})
    await _settle()
    await rl._client.set("config:sTTL", str(rl.ttl_seconds - 10))
    await rl.reconcile_ttl()
    assert float(await rl._client.get("config:sTTL")) == rl.ttl_seconds


async def test_reconcile_ttl_paginates_across_multiple_hscan_batches(redis_log_instance):
    # reconcileTTL's HSCAN uses COUNT 200 -- push more than that into one
    # entity so a single reconcile_ttl() call has to walk multiple cursor
    # batches, not just one.
    rl = redis_log_instance
    now_ms = time.time() * 1000.0
    for i in range(450):
        rl.record("c7e", now_ms + i, {"text": f"row {i}"})
    await _settle()
    await rl._client.set("config:sTTL", str(rl.ttl_seconds - 10))
    rl.ttl_seconds = 3600.0
    await rl.reconcile_ttl()
    assert await rl.total("c7e") == 450  # every field still there, none dropped mid-scan
    ttl = await rl._client.httl("cttc:log:c7e", str(now_ms))
    assert ttl and ttl[0] > 0


async def test_reconcile_ttl_handles_multiple_entities(redis_log_instance):
    rl = redis_log_instance
    now_ms = time.time() * 1000.0
    rl.record("c7f", now_ms, {"text": "one"})
    rl.record("c7g", now_ms, {"text": "two"})
    await _settle()
    await rl._client.set("config:sTTL", str(rl.ttl_seconds - 10))
    rl.ttl_seconds = 3600.0
    await rl.reconcile_ttl()
    ttl_f = await rl._client.httl("cttc:log:c7f", str(now_ms))
    ttl_g = await rl._client.httl("cttc:log:c7g", str(now_ms))
    assert ttl_f and ttl_f[0] > 0
    assert ttl_g and ttl_g[0] > 0


async def test_remember_and_known_daemons(redis_log_instance):
    rl = redis_log_instance
    await rl.remember_daemon("ssh://user@host", {"host": "ssh://user@host"})
    known = await rl.known_daemons()
    assert {"host": "ssh://user@host"} in known


async def test_forget_daemon_removes_it_from_known_daemons(redis_log_instance):
    # br-REDIS-017: the counterpart remember_daemon lacked entirely --
    # without it, a daemon removed in the UI was silently re-collected
    # forever on the gateway's own next restart.
    rl = redis_log_instance
    await rl.remember_daemon("ssh://user@host", {"host": "ssh://user@host"})
    await rl.remember_daemon("ssh://other@host2", {"host": "ssh://other@host2"})
    await rl.forget_daemon("ssh://user@host")
    known = await rl.known_daemons()
    assert {"host": "ssh://user@host"} not in known
    assert {"host": "ssh://other@host2"} in known  # sibling entry untouched


async def test_forget_daemon_on_an_unknown_host_is_a_safe_noop(redis_log_instance):
    rl = redis_log_instance
    await rl.remember_daemon("ssh://user@host", {"host": "ssh://user@host"})
    await rl.forget_daemon("ssh://never@known")
    known = await rl.known_daemons()
    assert {"host": "ssh://user@host"} in known


async def test_buffer_full_drops_and_logs_a_warning(redis_log_instance, caplog, monkeypatch):
    rl = redis_log_instance
    monkeypatch.setattr(redis_log, "MAX_BUFFERED_RECORDS", 1)
    rl._enqueue("c8", 1000.0, {"text": "fills the buffer"})
    with caplog.at_level(logging.WARNING):
        rl._enqueue("c8", 2000.0, {"text": "dropped"})  # buffer full -> logged, not raised
    assert "buffer full" in caplog.text
    assert len(rl._buffer) == 1  # the second record never got appended


async def test_bulk_record_survives_more_rows_than_the_live_buffer_capacity(
    redis_log_instance, caplog, monkeypatch
):
    """br-REDIS-018: a bulk import (State.load_sample loading a whole
    recording) must not lose data just because the archive holds more rows
    than record()'s live-ingestion buffer can hold at once -- bulk_record()
    bypasses that bounded buffer entirely (writes directly, awaited, never
    touching _enqueue's MAX_BUFFERED_RECORDS check at all), so every row
    here has to land, where the same volume through record()/_enqueue
    would start dropping once the buffer filled up. Patches the cap down
    (rather than using the real 50_000 default) so this stays fast while
    still proving the same point."""
    rl = redis_log_instance
    monkeypatch.setattr(redis_log, "MAX_BUFFERED_RECORDS", 10)
    rows = [("bulk-c", float(i), {"text": f"row {i}"}) for i in range(500)]
    with caplog.at_level(logging.WARNING):
        await rl.bulk_record(rows)
    assert "buffer full" not in caplog.text
    assert "lost" not in caplog.text
    assert await rl.total("bulk-c") == 500


async def test_bulk_record_continues_after_a_failed_batch(redis_log_instance, caplog, monkeypatch):
    """One bad batch (a malformed payload, a transient Redis hiccup) must
    not stop later batches from landing -- same broad-except-and-keep-going
    contract as _write()'s per-sample failure handling."""
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
    # 500 rows exactly fills bulk_record's first chunk (chunk_size=500) --
    # the next 5 start a genuinely separate pipeline().execute() call, so
    # this actually exercises "first batch fails, second batch still lands"
    # rather than both landing (or failing) in the same one pipeline call.
    rows = [("bulk-a", float(i), {"text": "lost"}) for i in range(500)] + [
        ("bulk-b", float(i), {"text": "ok"}) for i in range(5)
    ]
    with caplog.at_level(logging.WARNING):
        await rl.bulk_record(rows)
    assert "write failed" in caplog.text
    assert await rl.total("bulk-a") == 0  # first batch's write failed
    assert await rl.total("bulk-b") == 5  # later batch still landed


async def test_bulk_record_with_no_rows_is_a_noop(redis_log_instance):
    rl = redis_log_instance
    await rl.bulk_record([])  # must not raise, nothing to write


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


async def test_latest_falls_back_past_a_stale_newest_entry_and_prunes_it(redis_log_instance):
    # br-REDIS-011: a field's hash payload can expire while its zset member
    # lingers -- latest() used to return None just because the *newest* one
    # had expired, silently disabling every metric event condition on the
    # entity, even though an older, still-live sample exists.
    rl = redis_log_instance
    rl.record("c14", 1000.0, {"text": "still alive"})
    rl.record("c14", 2000.0, {"text": "expired"})
    await _settle()
    await rl._client.hdel("cttc:log:c14", "2000.0")  # simulate the newest one expiring

    assert await rl._client.zcard("cttc:idx:c14") == 2  # phantom member still indexed
    ts, payload = await rl.latest("c14")
    assert (ts, payload["text"]) == (1000.0, "still alive")
    assert await rl._client.zcard("cttc:idx:c14") == 1  # br-REDIS-011: pruned on discovery


async def test_nearest_falls_back_past_a_stale_candidate_and_prunes_it(redis_log_instance):
    rl = redis_log_instance
    rl.record("c15", 1000.0, {"text": "still alive"})
    rl.record("c15", 2000.0, {"text": "expired"})
    await _settle()
    await rl._client.hdel("cttc:log:c15", "2000.0")

    ts, payload = await rl.nearest("c15", 2000.0)  # nearest to the now-gone field itself
    assert (ts, payload["text"]) == (1000.0, "still alive")
    assert await rl._client.zcard("cttc:idx:c15") == 1


async def test_slice_by_rank_prunes_a_stale_index_entry_it_discovers(redis_log_instance):
    rl = redis_log_instance
    rl.record("c16", 1000.0, {"text": "a"})
    rl.record("c16", 2000.0, {"text": "b"})
    await _settle()
    await rl._client.hdel("cttc:log:c16", "1000.0")

    await rl.slice_by_rank("c16", 0, 10)
    assert await rl._client.zcard("cttc:idx:c16") == 1  # br-REDIS-011: stale member pruned


async def test_range_by_score_with_payload_prunes_a_stale_index_entry_it_discovers(
    redis_log_instance,
):
    rl = redis_log_instance
    rl.record("c17", 1000.0, {"text": "a"})
    rl.record("c17", 2000.0, {"text": "b"})
    await _settle()
    await rl._client.hdel("cttc:log:c17", "1000.0")

    await rl.range_by_score_with_payload("c17", 0, 3000)
    assert await rl._client.zcard("cttc:idx:c17") == 1


async def test_find_text_skips_a_field_evicted_mid_scan(redis_log_instance):
    rl = redis_log_instance
    rl.record("c12", 1000.0, {"text": "needle"})
    rl.record("c12", 2000.0, {"text": "hay"})
    await _settle()
    await rl._client.hdel("cttc:log:c12", "1000.0")  # the needle itself gone

    assert await rl.find_text("c12", "needle", 0, forward=True) is None
    assert await rl.find_text("c12", "hay", 0, forward=True) == 1


# ── persistence: restore on restart, TTL survival, crash tolerance, ──────
# ── missing/corrupt file handling ─────────────────────────────────────────


async def test_ttl_survives_a_graceful_restart_including_an_already_expired_field(tmp_path):
    """The user's explicit hard requirement: per-hash-field TTL (HEXPIRE/
    HTTL, Redis 7.4+, NOT the classic per-key EXPIRE) must survive a real
    save + restart round trip, empirically -- not assumed from documentation."""
    data_dir = tmp_path / "redis-data"
    rl1 = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    await rl1.start()
    now_ms = time.time() * 1000.0
    rl1.record("ttl-check", now_ms, {"text": "long-lived"})  # gets ttl_seconds's default HEXPIRE
    await _settle()
    # A field that will already be expired by the time we restart:
    await rl1._client.hset("cttc:log:ttl-check", "already-expired-field", orjson.dumps({"text": "gone"}))
    await rl1._client.hexpire("cttc:log:ttl-check", 1, "already-expired-field")
    hexpire_at = time.monotonic()
    await asyncio.sleep(1.5)  # let the 1s field genuinely expire before we ever save/restart
    await rl1.stop()  # graceful: SIGTERM, RDB save-on-shutdown per --save "3600 1"

    rl2 = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    await rl2.start()
    try:
        remaining = await rl2._client.httl("cttc:log:ttl-check", str(now_ms))
        elapsed = time.monotonic() - hexpire_at
        expected = rl2.ttl_seconds - elapsed
        assert remaining[0] == pytest.approx(expected, abs=5)  # a few seconds' tolerance for real restart time
        assert await rl2._client.hget("cttc:log:ttl-check", "already-expired-field") is None
    finally:
        await rl2.stop()


async def test_ttl_survives_a_raw_sigterm_sent_directly_to_the_subprocess(tmp_path):
    """Same as above but bypassing RedisLog.stop() entirely -- a raw SIGTERM
    to the redis-server child (not this app's own shutdown path), to isolate
    "does Redis's own save-on-SIGTERM work" from "does our stop() wrapper
    work" (the latter is already covered elsewhere)."""
    data_dir = tmp_path / "redis-data"
    rl1 = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    await rl1.start()
    await rl1._client.hset("cttc:log:raw-sigterm", "f", orjson.dumps({"text": "x"}))
    await rl1._client.hexpire("cttc:log:raw-sigterm", 100, "f")
    proc = rl1._proc
    proc.terminate()  # raw SIGTERM, not rl1.stop()
    await proc.wait()

    rl2 = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    await rl2.start()
    try:
        assert await rl2._client.hget("cttc:log:raw-sigterm", "f") is not None
        ttl = (await rl2._client.httl("cttc:log:raw-sigterm", "f"))[0]
        assert 0 < ttl <= 100
    finally:
        await rl2.stop()


async def test_crash_bounded_loss_window_kill9_then_deterministic_torn_write(tmp_path):
    """Demonstrates the ~1s bounded-loss claim empirically rather than just
    asserting it. A plain kill -9 of the child process alone is NOT a
    reliable way to reproduce loss with appendfsync everysec on a real OS
    (the write() syscall already landed in the OS page cache even without an
    fsync -- only a genuine machine power-loss loses that), so this test
    kill -9's the process to prove "no clean shutdown occurred, restart still
    recovers" AND deterministically truncates the AOF incr file's tail
    afterward to simulate what a real torn write during a crash would leave
    behind, proving data before the tear survives and data in the torn tail
    is correctly, safely dropped (not corrupting the restart)."""
    data_dir = tmp_path / "redis-data"
    rl1 = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    await rl1.start()
    await rl1._client.hset("cttc:log:survivor", "f", orjson.dumps({"text": "written well before the crash"}))
    await rl1._client.hexpire("cttc:log:survivor", 100, "f")
    await asyncio.sleep(1.2)  # comfortably past one appendfsync everysec cycle
    proc = rl1._proc
    proc.kill()  # SIGKILL -- no graceful shutdown, no RDB save-on-exit at all
    await proc.wait()

    incr_path = data_dir / "appendonlydir" / "appendonly.aof.1.incr.aof"
    raw = incr_path.read_bytes()
    incr_path.write_bytes(raw[:-5])  # simulate a torn trailing write

    rl2 = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    await rl2.start()  # must NOT raise -- aof-load-truncated tolerates this
    try:
        assert await rl2._client.hget("cttc:log:survivor", "f") is not None
    finally:
        await rl2.stop()


async def test_start_logs_clearly_when_no_persistence_file_exists(tmp_path, caplog):
    data_dir = tmp_path / "redis-data"  # deliberately fresh, nothing here yet
    rl = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    with caplog.at_level(logging.INFO, logger="cttc"):
        await rl.start()
    try:
        assert any("no existing persisted data" in r.message for r in caplog.records)
    finally:
        await rl.stop()


async def test_start_logs_clearly_when_persisted_data_is_found(tmp_path, caplog):
    data_dir = tmp_path / "redis-data"
    rl1 = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    await rl1.start()
    await rl1.stop()  # writes a real dump.rdb via --save "3600 1"'s save-on-shutdown

    rl2 = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    with caplog.at_level(logging.INFO, logger="cttc"):
        await rl2.start()
    try:
        assert any("found existing persisted data" in r.message for r in caplog.records)
    finally:
        await rl2.stop()


async def test_start_raises_with_a_clear_error_on_a_corrupt_persistence_file(tmp_path):
    data_dir = tmp_path / "redis-data"
    aof_dir = data_dir / "appendonlydir"
    aof_dir.mkdir(parents=True)
    (aof_dir / "appendonly.aof.manifest").write_bytes(b"not a real manifest, garbage bytes\xff\xff")
    rl = redis_log.RedisLog(socket_path=_short_socket_path(), tcp_port=unique_redis_tcp_port(), data_dir=data_dir)
    with pytest.raises(redis_log.RedisUnavailable, match="exited"):
        await rl.start()
    assert rl.enabled is False
