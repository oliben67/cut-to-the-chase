"""compat.py's source-id scheme, daemon registration, and source
lifecycle translation.
"""

from datetime import UTC, datetime, timedelta

import pytest
from fakeredis import FakeAsyncRedis

from log_sump.common.daemon_registry import list_registered_daemons, register_daemon
from log_sump.common.redis_keys import stream_key
from log_sump.common.schema import Kind, LogRecord, MetricRecord, RecordAdapter

from .. import compat


def test_hostkey_none_is_local() -> None:
    assert compat.hostkey(None) == "local"
    assert compat.hostkey("10.0.0.5") == "10.0.0.5"


def test_source_id_builders() -> None:
    assert compat.stats_source_id(None) == "docker://local/stats"
    assert compat.host_source_id("10.0.0.5") == "docker://10.0.0.5/host"
    assert compat.log_source_id(None, "container", "web") == "docker://local/container/web"


def test_parse_source_id_stats_and_host() -> None:
    parsed = compat.parse_source_id("docker://local/stats")
    assert parsed == compat.ParsedSourceId(hostkey="local", subtype="stats", name=None)
    parsed = compat.parse_source_id("docker://10.0.0.5/host")
    assert parsed == compat.ParsedSourceId(hostkey="10.0.0.5", subtype="host", name=None)


def test_parse_source_id_container_and_service() -> None:
    parsed = compat.parse_source_id("docker://local/container/web")
    assert parsed == compat.ParsedSourceId(hostkey="local", subtype="container", name="web")
    parsed = compat.parse_source_id("docker://10.0.0.5/service/api")
    assert parsed == compat.ParsedSourceId(hostkey="10.0.0.5", subtype="service", name="api")


def test_parse_source_id_rejects_non_docker_scheme() -> None:
    with pytest.raises(ValueError, match="not a docker://"):
        compat.parse_source_id("file:///tmp/foo")


def test_parse_source_id_rejects_malformed() -> None:
    with pytest.raises(ValueError, match="malformed"):
        compat.parse_source_id("docker://local/nonsense/too/many/parts")


async def test_register_or_get_daemon_local() -> None:
    redis = FakeAsyncRedis()
    daemon = await compat.register_or_get_daemon(redis, None)
    assert daemon.id == "local"
    assert daemon.transport == "local"
    assert daemon.watched_containers == []


async def test_register_or_get_daemon_ssh_with_user_and_port() -> None:
    redis = FakeAsyncRedis()
    daemon = await compat.register_or_get_daemon(redis, "deploy@10.0.0.5:2222")
    assert daemon.id == "deploy@10.0.0.5:2222"
    assert daemon.transport == "ssh"
    assert daemon.user == "deploy"
    assert daemon.host == "10.0.0.5"
    assert daemon.ssh_options == ["-p", "2222"]


async def test_register_or_get_daemon_ssh_scheme_prefix_stripped() -> None:
    redis = FakeAsyncRedis()
    daemon = await compat.register_or_get_daemon(redis, "ssh://10.0.0.5")
    assert daemon.host == "10.0.0.5"
    assert daemon.user == "root"


async def test_register_or_get_daemon_is_idempotent() -> None:
    redis = FakeAsyncRedis()
    first = await compat.register_or_get_daemon(redis, "10.0.0.5")
    await register_daemon(redis, first.model_copy(update={"watched_containers": ["web"]}))

    second = await compat.register_or_get_daemon(redis, "10.0.0.5")

    assert second.watched_containers == ["web"]  # existing registration wasn't clobbered


async def test_forget_daemon_removes_it() -> None:
    redis = FakeAsyncRedis()
    await compat.register_or_get_daemon(redis, None)

    removed = await compat.forget_daemon(redis, None)

    assert removed is True
    assert await list_registered_daemons(redis) == []


async def test_collect_opens_stats_host_and_log_sources() -> None:
    redis = FakeAsyncRedis()
    daemon, opened = await compat.collect(
        redis, host=None, stats=True, host_stats=True, logs=[{"name": "web", "type": "container"}]
    )
    assert daemon.watched_containers == ["web"]
    assert compat.host_source_id(None) in opened
    assert compat.log_source_id(None, "container", "web") in opened
    # "stats" isn't opened yet on this very first call -- nothing was
    # watched before this request landed, matching collect()'s own "only
    # report stats as opened once there's something to sample" rule.


async def test_collect_reports_stats_open_once_something_is_watched() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(
        redis, host=None, stats=True, host_stats=False, logs=[{"name": "web", "type": "container"}]
    )

    _daemon, opened = await compat.collect(redis, host=None, stats=True, host_stats=False, logs=[])

    assert compat.stats_source_id(None) in opened


async def test_collect_unions_new_container_names_into_existing_selection() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(
        redis, host=None, stats=False, host_stats=False, logs=[{"name": "web", "type": "container"}]
    )

    daemon, _opened = await compat.collect(
        redis, host=None, stats=False, host_stats=False, logs=[{"name": "db", "type": "container"}]
    )

    assert daemon.watched_containers == ["db", "web"]


async def test_close_source_removes_one_container_from_watched_list() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(
        redis,
        host=None,
        stats=False,
        host_stats=False,
        logs=[{"name": "web", "type": "container"}, {"name": "db", "type": "container"}],
    )

    await compat.close_source(redis, compat.log_source_id(None, "container", "web"))

    registered = {d.id: d for d in await list_registered_daemons(redis)}
    assert registered["local"].watched_containers == ["db"]


async def test_close_source_on_stats_or_host_is_a_no_op() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(
        redis, host=None, stats=True, host_stats=True, logs=[{"name": "web", "type": "container"}]
    )

    await compat.close_source(redis, compat.stats_source_id(None))
    await compat.close_source(redis, compat.host_source_id(None))

    registered = {d.id: d for d in await list_registered_daemons(redis)}
    assert registered["local"].watched_containers == ["web"]


async def test_close_source_on_unregistered_daemon_is_a_no_op() -> None:
    redis = FakeAsyncRedis()
    sid = compat.log_source_id("nope", "container", "web")
    await compat.close_source(redis, sid)  # must not raise


def _seed_metric(redis: FakeAsyncRedis, docker_host: str, container_name: str, ts: datetime):
    record = MetricRecord(
        docker_host=docker_host,
        container_name=container_name,
        container_id=f"{container_name}-id",
        ts=ts,
        seq=1,
        metric_scope="container",
        source="docker stats",
    )
    return redis.xadd(
        stream_key(docker_host, Kind.METRIC),
        {"data": RecordAdapter.dump_json(record)},
        id=f"{int(ts.timestamp() * 1000)}-0",
    )


async def test_preview_containers_registers_an_unknown_host_and_reads_back_metrics() -> None:
    redis = FakeAsyncRedis()
    now = datetime.now(UTC)
    await _seed_metric(redis, "local", "web", now)
    await _seed_metric(redis, "local", "db", now + timedelta(milliseconds=1))

    result = await compat.preview_containers(redis, None)

    assert {c["name"] for c in result["containers"]} == {"web", "db"}
    registered = {d.id: d for d in await list_registered_daemons(redis)}
    assert registered["local"].watched_containers is None  # widened for discovery


async def test_preview_containers_excludes_system_scope() -> None:
    redis = FakeAsyncRedis()
    now = datetime.now(UTC)
    await _seed_metric(redis, "local", "__system__", now)

    result = await compat.preview_containers(redis, None)

    assert result["containers"] == []


async def test_preview_containers_leaves_an_existing_selection_untouched() -> None:
    redis = FakeAsyncRedis()
    daemon = await compat.register_or_get_daemon(redis, None)
    await register_daemon(redis, daemon.model_copy(update={"watched_containers": ["web"]}))

    await compat.preview_containers(redis, None)

    registered = {d.id: d for d in await list_registered_daemons(redis)}
    assert registered["local"].watched_containers == ["web"]  # not widened


async def test_list_sources_empty_when_nothing_registered() -> None:
    redis = FakeAsyncRedis()
    assert await compat.list_sources(redis) == []


async def test_list_sources_includes_host_source_for_every_registered_daemon() -> None:
    redis = FakeAsyncRedis()
    await compat.register_or_get_daemon(redis, None)

    sources = await compat.list_sources(redis)

    assert [s["id"] for s in sources] == [compat.host_source_id(None)]
    assert sources[0]["is_host"] is True


async def test_list_sources_includes_stats_and_log_sources_once_watching_something() -> None:
    redis = FakeAsyncRedis()
    await compat.collect(
        redis, host=None, stats=True, host_stats=True, logs=[{"name": "web", "type": "container"}]
    )

    sources = await compat.list_sources(redis)

    web_log_id = compat.log_source_id(None, "container", "web")
    ids = {s["id"] for s in sources}
    assert compat.stats_source_id(None) in ids
    assert compat.host_source_id(None) in ids
    assert web_log_id in ids
    log_source = next(s for s in sources if s["id"] == web_log_id)
    assert log_source["kind"] == "log"
    assert log_source["name"] == "web"


async def test_time_range_none_when_nothing_registered() -> None:
    redis = FakeAsyncRedis()
    assert await compat.time_range(redis) == (None, None)


async def test_time_range_spans_registered_daemons_streams() -> None:
    redis = FakeAsyncRedis()
    await compat.register_or_get_daemon(redis, None)
    now = datetime(2026, 8, 14, 12, 0, 0, tzinfo=UTC)
    record = LogRecord(
        docker_host="local",
        container_name="web",
        container_id="c1",
        ts=now,
        seq=1,
        stream="stdout",
        level="info",
        message="hi",
        raw="hi",
    )
    await redis.xadd(
        stream_key("local", Kind.LOG),
        {"data": RecordAdapter.dump_json(record)},
        id=f"{int(now.timestamp() * 1000)}-0",
    )

    lo, hi = await compat.time_range(redis)

    assert lo == hi == int(now.timestamp() * 1000)
