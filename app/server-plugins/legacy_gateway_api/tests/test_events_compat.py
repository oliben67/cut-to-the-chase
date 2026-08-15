"""events_compat.py's condition-watch-and-fire translation."""

from datetime import UTC, datetime

import pytest
from fakeredis import FakeAsyncRedis

from log_sump.common.redis_keys import stream_key
from log_sump.common.sample_archive import read_archive
from log_sump.common.schema import Kind, LogRecord, MetricRecord, RecordAdapter

from .. import compat, events_compat, log_index, sessions_compat


@pytest.fixture(autouse=True)
def _reset_module_state():
    log_index._INDEX.clear()
    log_index._LOCKS.clear()
    sessions_compat._SESSIONS.clear()
    sessions_compat._next_id = 1
    events_compat._EVENTS.clear()
    events_compat._next_id = 1
    yield
    log_index._INDEX.clear()
    log_index._LOCKS.clear()
    sessions_compat._SESSIONS.clear()
    sessions_compat._next_id = 1
    events_compat._EVENTS.clear()
    events_compat._next_id = 1


def _metric_cond(metric="cpu", op=">", threshold=80.0):
    return events_compat.parse_condition(
        {"type": "metric", "metric": metric, "op": op, "threshold": threshold}
    )


def _log_cond(pattern="ERROR"):
    return events_compat.parse_condition({"type": "log", "pattern": pattern})


def _action(kind="snapshot", **kwargs):
    body = {"kind": kind}
    if kind == "snapshot":
        body["minutes"] = kwargs.get("minutes", 5)
    else:
        body["duration_minutes"] = kwargs.get("duration_minutes", 5)
    body.update({k: v for k, v in kwargs.items() if k not in ("minutes", "duration_minutes")})
    return events_compat.parse_action(body)


async def _now_metric(
    redis: FakeAsyncRedis, docker_host: str, container_name: str, *, cpu: float | None = 1.0
):
    now = datetime.now(UTC)
    record = MetricRecord(
        docker_host=docker_host,
        container_name=container_name,
        container_id=f"{container_name}-id",
        ts=now,
        seq=1,
        metric_scope="container",
        cpu_pct=cpu,
        source="docker stats",
    )
    await redis.xadd(
        stream_key(docker_host, Kind.METRIC),
        {"data": RecordAdapter.dump_json(record)},
        id=f"{int(now.timestamp() * 1000)}-0",
    )


async def _seed_log(
    redis: FakeAsyncRedis, docker_host: str, container_name: str, ts_ms: int, text: str
):
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
    await redis.xadd(
        stream_key(docker_host, Kind.LOG),
        {"data": RecordAdapter.dump_json(record)},
        id=f"{ts_ms}-0",
    )


def test_parse_condition_rejects_unknown_type() -> None:
    with pytest.raises(events_compat.InvalidEvent):
        events_compat.parse_condition({"type": "bogus"})


def test_parse_action_rejects_unknown_kind() -> None:
    with pytest.raises(events_compat.InvalidEvent):
        events_compat.parse_action({"kind": "bogus"})


async def test_create_requires_at_least_one_condition() -> None:
    redis = FakeAsyncRedis()
    with pytest.raises(events_compat.InvalidEvent, match="at least one condition"):
        await events_compat.create(
            redis, name="e", source_ids=set(), conditions=[], action=_action(), match="any"
        )


async def test_create_rejects_bad_regex() -> None:
    redis = FakeAsyncRedis()
    with pytest.raises(events_compat.InvalidEvent):
        await events_compat.create(
            redis,
            name="e",
            source_ids=set(),
            conditions=[_log_cond("(unclosed")],
            action=_action(),
            match="any",
        )


async def test_create_rejects_snapshot_without_minutes() -> None:
    redis = FakeAsyncRedis()
    action = events_compat.parse_action({"kind": "snapshot"})
    with pytest.raises(events_compat.InvalidEvent, match="needs `minutes`"):
        await events_compat.create(
            redis,
            name="e",
            source_ids=set(),
            conditions=[_metric_cond()],
            action=action,
            match="any",
        )


async def test_status_of_unknown_event_raises() -> None:
    redis = FakeAsyncRedis()
    with pytest.raises(events_compat.UnknownEvent):
        await events_compat.status_of(redis, "leg-evt999")


async def test_create_and_status_of_roundtrip() -> None:
    redis = FakeAsyncRedis()
    eid = await events_compat.create(
        redis,
        name="my event",
        source_ids=set(),
        conditions=[_metric_cond()],
        action=_action(),
        match="any",
    )

    status = await events_compat.status_of(redis, eid)

    assert status["event_id"] == eid
    assert status["name"] == "my event"
    assert status["enabled"] is True
    assert status["status"] == "armed"
    assert status["trigger_count"] == 0


async def test_enable_disable_and_disabled_event_is_never_checked() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=True, host_stats=False, logs=[{"name": "web"}])
    eid = await events_compat.create(
        redis,
        name="e",
        source_ids={compat.stats_source_id(None)},
        conditions=[_metric_cond(threshold=1.0)],
        action=_action(),
        match="any",
    )
    events_compat.disable(eid)
    await _now_metric(redis, "local", "web", cpu=99.0)

    status = await events_compat.status_of(redis, eid)
    assert status["status"] == "armed"  # never checked while disabled

    events_compat.enable(eid)
    status = await events_compat.status_of(redis, eid)
    assert status["status"] == "triggered"


async def test_cancel_removes_the_event() -> None:
    redis = FakeAsyncRedis()
    eid = await events_compat.create(
        redis,
        name="e",
        source_ids=set(),
        conditions=[_metric_cond()],
        action=_action(),
        match="any",
    )
    events_compat.cancel(eid)
    with pytest.raises(events_compat.UnknownEvent):
        await events_compat.status_of(redis, eid)


async def test_metric_condition_fires_and_edge_triggers() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=True, host_stats=False, logs=[{"name": "web"}])
    eid = await events_compat.create(
        redis,
        name="e",
        source_ids={compat.stats_source_id(None)},
        conditions=[_metric_cond(threshold=80.0)],
        action=_action(),
        match="any",
    )

    await _now_metric(redis, "local", "web", cpu=90.0)
    status = await events_compat.status_of(redis, eid)
    assert status["status"] == "triggered"
    assert status["trigger_count"] == 1

    # still above threshold -- edge-triggered, must not re-fire
    status = await events_compat.status_of(redis, eid)
    assert status["trigger_count"] == 1


async def test_reset_forces_rearm() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=True, host_stats=False, logs=[{"name": "web"}])
    eid = await events_compat.create(
        redis,
        name="e",
        source_ids={compat.stats_source_id(None)},
        conditions=[_metric_cond(threshold=80.0)],
        action=_action(),
        match="any",
    )
    await _now_metric(redis, "local", "web", cpu=90.0)
    await events_compat.status_of(redis, eid)

    events_compat.reset(eid)
    status = await events_compat.status_of(redis, eid)
    # condition is still true, so re-checking after reset fires again
    assert status["trigger_count"] == 2


async def test_log_condition_ignores_pre_existing_backlog_but_fires_on_new_lines() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=False, host_stats=False, logs=[{"name": "web"}])
    await _seed_log(redis, "local", "web", 1000, "boot ok")

    eid = await events_compat.create(
        redis,
        name="e",
        source_ids={compat.log_source_id(None, "container", "web")},
        conditions=[_log_cond("ERROR")],
        action=_action(),
        match="any",
    )
    status = await events_compat.status_of(redis, eid)
    assert status["status"] == "armed"  # backlog predates the event, doesn't count

    await _seed_log(redis, "local", "web", 2000, "ERROR: disk full")
    status = await events_compat.status_of(redis, eid)
    assert status["status"] == "triggered"
    assert "disk full" in status["trigger_detail"]


async def test_update_changes_conditions_and_reseeds_cursors() -> None:
    redis = FakeAsyncRedis()
    eid = await events_compat.create(
        redis,
        name="e",
        source_ids=set(),
        conditions=[_metric_cond()],
        action=_action(),
        match="any",
    )

    await events_compat.update(
        redis,
        eid,
        name="renamed",
        source_ids=None,
        conditions=[_log_cond("WARN")],
        action=None,
        match=None,
    )

    status = await events_compat.status_of(redis, eid)
    assert status["name"] == "renamed"
    assert status["conditions"] == [{"type": "log", "pattern": "WARN"}]


async def test_update_unknown_event_raises() -> None:
    redis = FakeAsyncRedis()
    with pytest.raises(events_compat.UnknownEvent):
        await events_compat.update(
            redis,
            "leg-evt999",
            name=None,
            source_ids=None,
            conditions=None,
            action=None,
            match=None,
        )


async def test_snapshot_action_fires_a_downloadable_metric_archive() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=True, host_stats=False, logs=[{"name": "web"}])
    eid = await events_compat.create(
        redis,
        name="e",
        source_ids={compat.stats_source_id(None)},
        conditions=[_metric_cond(threshold=80.0)],
        action=_action("snapshot", minutes=5),
        match="any",
    )

    await _now_metric(redis, "local", "web", cpu=90.0)
    status = await events_compat.status_of(redis, eid)

    assert status["artifact_id"] is not None
    data, ext = sessions_compat.download(status["artifact_id"])
    assert ext == ".cttc-metric"
    sources = read_archive(data)
    assert sources[0].kind == "stats"


async def test_recording_action_starts_a_session() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(redis, host=None, stats=True, host_stats=False, logs=[{"name": "web"}])
    eid = await events_compat.create(
        redis,
        name="e",
        source_ids={compat.stats_source_id(None)},
        conditions=[_metric_cond(threshold=80.0)],
        action=_action("recording", duration_minutes=10),
        match="any",
    )

    await _now_metric(redis, "local", "web", cpu=90.0)
    status = await events_compat.status_of(redis, eid)

    assert status["artifact_id"] in sessions_compat._SESSIONS
    assert sessions_compat._SESSIONS[status["artifact_id"]].status == "running"
