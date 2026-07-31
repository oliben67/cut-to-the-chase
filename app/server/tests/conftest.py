import itertools
import os
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import redis_log as redis_log_module  # noqa: E402

# Every RedisLog binds a TCP monitor port now (see redis_log.py's
# DEFAULT_TCP_PORT) -- tests that need more than one concurrently-live
# RedisLog in the same process (see test_server.py's TestSampleRoundTrip/
# TestMultiSegmentSample, which spin up extra ones to prove two entities
# can't cross-contaminate) would otherwise all collide on that one fixed
# default port. Seeded by pid so two test *processes* (e.g. -n auto) don't
# collide with each other either, not just within one process.
_next_test_redis_port = itertools.count(56380 + (os.getpid() % 5000))


def unique_redis_tcp_port() -> int:
    return next(_next_test_redis_port)


def pytest_collection_modifyitems(config, items):
    """redis-server is a hard dependency now (Redis is the sole source of
    truth for logs/telemetry reads -- see redis_log.py's module docstring):
    there's no RAM fallback left to test against, so fail loudly and early
    rather than letting every test that touches a Source/State fail one by
    one with a confusing AttributeError."""
    if shutil.which("redis-server") is None:
        pytest.exit(
            "redis-server not found on PATH -- it's a hard dependency for the gateway "
            "test suite now (Redis is the sole source of truth for logs/telemetry reads, "
            "see redis_log.py); install it and make sure `redis-server` is on PATH.",
            returncode=1,
        )


@pytest.fixture
async def redis_log_instance():
    """A real, running RedisLog backed by a real redis-server subprocess --
    same launch pattern as RedisLog.start() itself (unix socket + loopback
    TCP monitor port, `--save ""`). Every test that needs a Redis-backed
    State/LogSource/StatsSource/EventManager/RecordingSessionManager takes
    this instead of faking anything -- there's no disabled/no-op path left
    to fall back to. A unique tcp_port per instance (not the real
    DEFAULT_TCP_PORT) since a test can construct more than one of these
    concurrently -- see unique_redis_tcp_port's docstring above."""
    rl = redis_log_module.RedisLog(tcp_port=unique_redis_tcp_port())
    await rl.start()
    assert rl.enabled
    yield rl
    await rl.stop()
