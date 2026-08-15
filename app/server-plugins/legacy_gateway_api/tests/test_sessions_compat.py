"""sessions_compat.py's cross-daemon recording-session translation."""

import asyncio
from datetime import UTC, datetime
from typing import Literal

import pytest
from fakeredis import FakeAsyncRedis

from log_sump.common.redis_keys import stream_key
from log_sump.common.sample_archive import read_archive
from log_sump.common.schema import SYSTEM_SCOPE_ID, Kind, LogRecord, MetricRecord, RecordAdapter

from .. import compat, log_index, sessions_compat


async def _start(redis: FakeAsyncRedis) -> str:
    return await sessions_compat.start(
        redis, duration_minutes=None, safe=False, max_keep_seconds=None
    )


@pytest.fixture(autouse=True)
def _reset_module_state():
    log_index._INDEX.clear()
    log_index._LOCKS.clear()
    sessions_compat._SESSIONS.clear()
    sessions_compat._next_id = 1
    sessions_compat._default_ttl_seconds = sessions_compat.DEFAULT_TTL_SECONDS
    yield
    log_index._INDEX.clear()
    log_index._LOCKS.clear()
    sessions_compat._SESSIONS.clear()
    sessions_compat._next_id = 1
    sessions_compat._default_ttl_seconds = sessions_compat.DEFAULT_TTL_SECONDS


def _seed_log(redis: FakeAsyncRedis, docker_host: str, container_name: str, ts_ms: int, text: str):
    record = LogRecord(
        docker_host=docker_host,
        container_name=container_name,
        container_id=f"{container_name}-id",
        ts=datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC),
        seq=1,
        stream="stdout",
        level="info",
        message=text,
        raw=text,
    )
    return redis.xadd(
        stream_key(docker_host, Kind.LOG),
        {"data": RecordAdapter.dump_json(record)},
        id=f"{ts_ms}-0",
    )


def _seed_metric(
    redis: FakeAsyncRedis,
    docker_host: str,
    container_name: str,
    ts_ms: int,
    *,
    cpu: float | None = 1.0,
    scope: Literal["container", "system"] = "container",
):
    record = MetricRecord(
        docker_host=docker_host,
        container_name=container_name,
        container_id=f"{container_name}-id",
        ts=datetime.fromtimestamp(ts_ms / 1000.0, tz=UTC),
        seq=1,
        metric_scope=scope,
        cpu_pct=cpu,
        source="docker stats",
    )
    return redis.xadd(
        stream_key(docker_host, Kind.METRIC),
        {"data": RecordAdapter.dump_json(record)},
        id=f"{ts_ms}-0",
    )


async def test_status_of_unknown_session_raises() -> None:
    redis = FakeAsyncRedis()
    with pytest.raises(sessions_compat.UnknownSession):
        await sessions_compat.status_of(redis, "leg-rec999")


async def test_start_reports_running_and_not_ready() -> None:
    redis = FakeAsyncRedis()
    sid = await _start(redis)

    status = await sessions_compat.status_of(redis, sid)

    assert status == {"session_id": sid, "status": "running", "ready": False, "safe": False}


async def test_download_before_completion_raises() -> None:
    redis = FakeAsyncRedis()
    sid = await _start(redis)

    with pytest.raises(sessions_compat.UnknownSession):
        sessions_compat.download(sid)


async def test_stop_produces_a_downloadable_archive_scoped_to_open_sources() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(
        redis, host=None, stats=False, host_stats=False, logs=[{"name": "web"}]
    )
    sid = await _start(redis)
    start_ts = sessions_compat._SESSIONS[sid].start_ts_ms

    await _seed_log(redis, "local", "web", int(start_ts) + 10, "hello from session")
    await asyncio.sleep(0.05)

    await sessions_compat.stop(redis, sid)

    status = await sessions_compat.status_of(redis, sid)
    assert status["status"] == "completed"
    assert status["ready"] is True

    data, ext = sessions_compat.download(sid)
    assert ext == ".cttc-record"
    sources = read_archive(data)
    assert len(sources) == 1
    assert sources[0].kind == "log"
    assert sources[0].log_rows[0].text == "hello from session"


async def test_stop_excludes_a_container_that_was_never_opened() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(
        redis, host=None, stats=False, host_stats=False, logs=[{"name": "web"}]
    )
    sid = await _start(redis)
    start_ts = sessions_compat._SESSIONS[sid].start_ts_ms

    await _seed_log(redis, "local", "web", int(start_ts) + 10, "watched")
    await _seed_log(redis, "local", "unwatched", int(start_ts) + 11, "not watched")
    await asyncio.sleep(0.05)

    await sessions_compat.stop(redis, sid)
    data, _ext = sessions_compat.download(sid)

    sources = read_archive(data)
    assert [s.name for s in sources] == ["web"]


async def test_stop_includes_host_scope_only_when_it_was_open() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=False, host_stats=True, logs=[])
    sid = await _start(redis)
    start_ts = sessions_compat._SESSIONS[sid].start_ts_ms

    await _seed_metric(redis, "local", SYSTEM_SCOPE_ID, int(start_ts) + 10, scope="system")
    await asyncio.sleep(0.05)

    await sessions_compat.stop(redis, sid)
    data, _ext = sessions_compat.download(sid)

    sources = read_archive(data)
    assert len(sources) == 1
    assert sources[0].kind == "stats"
    assert SYSTEM_SCOPE_ID in sources[0].stats_series


async def test_store_precomputed_scoped_to_stats_source_still_includes_watched_names() -> None:
    """A "stats" source's own `services` list already names every
    currently-watched container on its daemon -- an explicit source_ids
    scope naming *only* that stats source id (not also the matching log
    source id) must still see those names for *stats*, without depending
    on the log source id being listed too. Regression test for a real
    bug caught by events_compat.py's own snapshot-action test:
    `_scopes_from_sources` populated `watched` only from log-kind source
    dicts, leaving a stats-only-scoped snapshot with an empty stats
    series.

    Also seeds a *log* line for the same container (not just a metric):
    an earlier version of this test only seeded metrics, so it couldn't
    catch a related bug in the same fix -- conflating "include this
    container's stats" with "include its logs too" would have silently
    passed here, since `write_archive` only adds a log source when there
    are rows to add, and a metric-only seed never produces any. Caught
    for real only once verified against a real container with both log
    and metric traffic actually flowing.
    """
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=True, host_stats=False, logs=[{"name": "web"}])
    start_ts = sessions_compat._now_ms()
    await _seed_metric(redis, "local", "web", int(start_ts) + 10)
    await _seed_log(redis, "local", "web", int(start_ts) + 20, "hello")

    sid = await sessions_compat.store_precomputed(
        redis,
        source_ids={compat.stats_source_id(None)},  # only the stats id, not the log id
        t0_ms=start_ts,
        t1_ms=start_ts + 1000,
        safe=False,
        max_keep_seconds=None,
    )

    data, ext = sessions_compat.download(sid)
    assert ext == ".cttc-metric"
    sources = read_archive(data)
    assert [s.kind for s in sources] == ["stats"]  # not "log" -- that id was never in scope
    assert "web" in sources[0].stats_series


async def test_store_precomputed_scoped_to_log_source_excludes_stats() -> None:
    """The mirror image of the test above: selecting only the *log*
    source id must not pull in that container's stats either.
    """
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=True, host_stats=False, logs=[{"name": "web"}])
    start_ts = sessions_compat._now_ms()
    await _seed_metric(redis, "local", "web", int(start_ts) + 10)
    await _seed_log(redis, "local", "web", int(start_ts) + 20, "hello")

    sid = await sessions_compat.store_precomputed(
        redis,
        source_ids={compat.log_source_id(None, "container", "web")},  # only the log id
        t0_ms=start_ts,
        t1_ms=start_ts + 1000,
        safe=False,
        max_keep_seconds=None,
    )

    data, _ext = sessions_compat.download(sid)
    sources = read_archive(data)
    assert [s.kind for s in sources] == ["log"]  # not "stats" -- that id was never in scope
    assert sources[0].log_rows[0].text == "hello"


async def test_stop_is_idempotent() -> None:
    redis = FakeAsyncRedis()
    sid = await _start(redis)

    await sessions_compat.stop(redis, sid)
    first, _ext = sessions_compat.download(sid)
    await sessions_compat.stop(redis, sid)  # no-op, already completed
    second, _ext = sessions_compat.download(sid)

    assert first == second


async def test_tick_finishes_session_once_duration_elapses() -> None:
    redis = FakeAsyncRedis()
    sid = await sessions_compat.start(
        redis, duration_minutes=0.0005, safe=False, max_keep_seconds=None
    )  # 30ms

    status = await sessions_compat.status_of(redis, sid)
    assert status["status"] == "running"

    await asyncio.sleep(0.05)

    status = await sessions_compat.status_of(redis, sid)
    assert status["status"] == "completed"


async def test_mark_safe_uses_its_own_ttl_instead_of_default() -> None:
    redis = FakeAsyncRedis()
    sessions_compat.set_default_ttl(100.0)
    sid = await _start(redis)
    sessions_compat.mark_safe(sid, 99999.0)

    await sessions_compat.stop(redis, sid)
    sess = sessions_compat._SESSIONS[sid]

    assert sess.safe is True
    assert sess.max_keep_seconds == 99999.0


async def test_sweep_drops_expired_completed_session() -> None:
    redis = FakeAsyncRedis()
    sessions_compat.set_default_ttl(0.01)  # 10ms
    sid = await _start(redis)
    await sessions_compat.stop(redis, sid)
    assert sid in sessions_compat._SESSIONS

    await asyncio.sleep(0.05)
    await sessions_compat._sweep(redis)  # normally triggered by the next start()/status_of()

    assert sid not in sessions_compat._SESSIONS
    with pytest.raises(sessions_compat.UnknownSession):
        await sessions_compat.status_of(redis, sid)


async def test_set_default_ttl_updates_module_state() -> None:
    sessions_compat.set_default_ttl(42.0)
    assert sessions_compat._default_ttl_seconds == 42.0
