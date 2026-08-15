"""log_index.py's in-memory per-container-name rank index."""

from datetime import UTC, datetime

import pytest
from fakeredis import FakeAsyncRedis

from log_sump.common.redis_keys import stream_key
from log_sump.common.schema import Kind, LogRecord, RecordAdapter

from .. import log_index

DOCKER_HOST = "local"


@pytest.fixture(autouse=True)
def _reset_module_cache():
    """log_index's own index/locks are module-level (one log-server
    process, per its own docstring) -- reset between tests so one test's
    cached rows can't leak into the next.
    """
    log_index._INDEX.clear()
    log_index._LOCKS.clear()
    yield
    log_index._INDEX.clear()
    log_index._LOCKS.clear()


async def _seed_log(
    redis: FakeAsyncRedis, docker_host: str, container_name: str, ts_ms: int, text: str
) -> None:
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


async def test_total_is_zero_for_an_unseen_container() -> None:
    redis = FakeAsyncRedis()
    assert await log_index.total(redis, DOCKER_HOST, "web") == 0


async def test_total_and_slice_only_count_matching_container_name() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "hello")
    await _seed_log(redis, DOCKER_HOST, "db", 1001, "unrelated")
    await _seed_log(redis, DOCKER_HOST, "web", 1002, "world")

    assert await log_index.total(redis, DOCKER_HOST, "web") == 2
    rows = await log_index.log_slice(redis, DOCKER_HOST, "web", 0, 10)
    assert [r["text"] for r in rows] == ["hello", "world"]
    assert [r["ts"] for r in rows] == [1000, 1002]
    assert [r["i"] for r in rows] == [0, 1]


async def test_log_slice_respects_start_and_count() -> None:
    redis = FakeAsyncRedis()
    for i in range(5):
        await _seed_log(redis, DOCKER_HOST, "web", 1000 + i, f"line{i}")

    rows = await log_index.log_slice(redis, DOCKER_HOST, "web", 2, 2)

    assert [r["text"] for r in rows] == ["line2", "line3"]
    assert [r["i"] for r in rows] == [2, 3]


async def test_catch_up_picks_up_entries_written_after_the_first_scan() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "first")
    assert await log_index.total(redis, DOCKER_HOST, "web") == 1

    await _seed_log(redis, DOCKER_HOST, "web", 1001, "second")

    assert await log_index.total(redis, DOCKER_HOST, "web") == 2
    rows = await log_index.log_slice(redis, DOCKER_HOST, "web", 0, 10)
    assert [r["text"] for r in rows] == ["first", "second"]


async def test_forget_drops_the_cached_index() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "first")
    await log_index.total(redis, DOCKER_HOST, "web")
    assert (DOCKER_HOST, "web") in log_index._INDEX

    log_index.forget(DOCKER_HOST, "web")

    assert (DOCKER_HOST, "web") not in log_index._INDEX
    assert (DOCKER_HOST, "web") not in log_index._LOCKS


async def test_index_at_empty_log_returns_minus_one() -> None:
    redis = FakeAsyncRedis()
    assert await log_index.index_at(redis, DOCKER_HOST, "web", 1000) == -1


async def test_index_at_before_first_entry_returns_zero() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "a")
    await _seed_log(redis, DOCKER_HOST, "web", 2000, "b")

    assert await log_index.index_at(redis, DOCKER_HOST, "web", 0) == 0


async def test_index_at_after_last_entry_returns_last_rank() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "a")
    await _seed_log(redis, DOCKER_HOST, "web", 2000, "b")

    assert await log_index.index_at(redis, DOCKER_HOST, "web", 9999) == 1


async def test_index_at_picks_the_nearer_neighbor() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "a")
    await _seed_log(redis, DOCKER_HOST, "web", 2000, "b")

    assert await log_index.index_at(redis, DOCKER_HOST, "web", 1200) == 0  # closer to 1000
    assert await log_index.index_at(redis, DOCKER_HOST, "web", 1800) == 1  # closer to 2000


async def test_index_at_ties_prefer_the_later_entry() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "a")
    await _seed_log(redis, DOCKER_HOST, "web", 2000, "b")

    assert await log_index.index_at(redis, DOCKER_HOST, "web", 1500) == 1


async def test_ticks_buckets_matching_entries_only() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "a")
    await _seed_log(redis, DOCKER_HOST, "db", 1250, "unrelated")
    await _seed_log(redis, DOCKER_HOST, "web", 1500, "b")

    counts = await log_index.ticks(redis, DOCKER_HOST, "web", 1000, 2000, 2)

    assert counts == [1, 1]


async def test_find_text_forward_from_start() -> None:
    redis = FakeAsyncRedis()
    for i, text in enumerate(["alpha", "beta", "gamma", "beta again"]):
        await _seed_log(redis, DOCKER_HOST, "web", 1000 + i, text)

    hit = await log_index.find_text(redis, DOCKER_HOST, "web", "beta", 0, True)

    assert hit == 1


async def test_find_text_forward_wraps_around() -> None:
    redis = FakeAsyncRedis()
    for i, text in enumerate(["beta", "alpha", "gamma"]):
        await _seed_log(redis, DOCKER_HOST, "web", 1000 + i, text)

    hit = await log_index.find_text(redis, DOCKER_HOST, "web", "beta", 1, True)

    assert hit == 0  # wrapped past the end back to rank 0


async def test_find_text_backward_wraps_around() -> None:
    redis = FakeAsyncRedis()
    for i, text in enumerate(["alpha", "beta", "gamma"]):
        await _seed_log(redis, DOCKER_HOST, "web", 1000 + i, text)

    hit = await log_index.find_text(redis, DOCKER_HOST, "web", "gamma", 0, False)

    assert hit == 2  # wrapped backward past rank 0 to the end


async def test_find_text_no_match_returns_none() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "alpha")

    assert await log_index.find_text(redis, DOCKER_HOST, "web", "nope", 0, True) is None


async def test_find_text_empty_query_returns_none() -> None:
    redis = FakeAsyncRedis()
    await _seed_log(redis, DOCKER_HOST, "web", 1000, "alpha")

    assert await log_index.find_text(redis, DOCKER_HOST, "web", "  ", 0, True) is None
