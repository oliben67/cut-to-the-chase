"""Tests for redis_log.py.

Most of this only exercises the disabled path (no redis-server binary) --
that's the actual environment these tests run in, and it's also the real
behavior for the bare/embedded deployment (see main.js), which never has
redis-server available and must be a complete no-op. The enabled path is
covered by a real-Redis integration test, skipped unless redis-server is
actually on PATH (matching the containerized gateway image).
"""

from __future__ import annotations

import shutil

import pytest

import redis_log


class TestDisabled:
    """redis-server isn't on PATH in most dev/CI environments, and never is
    for the bare/embedded server.py deployment -- every public method must
    be a safe no-op in that case, since callers never check `.enabled`
    themselves."""

    @pytest.fixture
    async def rl(self, monkeypatch):
        monkeypatch.setattr(shutil, "which", lambda _name: None)
        rl = redis_log.RedisLog()
        await rl.start()
        return rl

    async def test_start_leaves_disabled(self, rl):
        assert rl.enabled is False

    async def test_record_is_a_silent_noop(self, rl):
        rl.record("my-container", 1234.0, {"text": "hi"})  # must not raise

    async def test_set_ttl_still_updates_default(self, rl):
        await rl.set_ttl(60.0)
        assert rl.ttl_seconds == 60.0

    async def test_read_range_returns_empty(self, rl):
        assert await rl.read_range("my-container", 0, 1_000_000) == []

    async def test_remember_and_known_daemons_are_noops(self, rl):
        await rl.remember_daemon("ssh://user@host", {"host": "ssh://user@host"})
        assert await rl.known_daemons() == []

    async def test_stop_without_start_does_not_raise(self):
        rl = redis_log.RedisLog()
        await rl.stop()


@pytest.mark.skipif(shutil.which("redis-server") is None, reason="requires a real redis-server binary (7.4+)")
class TestEnabled:
    """Only runs where redis-server is actually available (the containerized
    gateway image's own environment, or a dev machine with it installed) --
    exercises the real write -> range-query path end to end."""

    @pytest.fixture
    async def rl(self):
        rl = redis_log.RedisLog()
        await rl.start()
        assert rl.enabled, "expected redis-server on PATH to actually enable the store"
        yield rl
        await rl.stop()

    async def test_record_then_read_range_roundtrip(self, rl):
        rl.record("my-container", 1000.0, {"text": "one"})
        rl.record("my-container", 2000.0, {"text": "two"})
        rl.record("my-container", 5000.0, {"text": "out of range"})
        # record() enqueues via call_soon_threadsafe; give the pump a beat
        import asyncio

        await asyncio.sleep(0.2)
        got = await rl.read_range("my-container", 0, 3000)
        assert got == [{"text": "one"}, {"text": "two"}]

    async def test_set_ttl_reapplies_to_existing_entries(self, rl):
        rl.record("my-container", 1000.0, {"text": "one"})
        import asyncio

        await asyncio.sleep(0.2)
        await rl.set_ttl(60.0)
        ttl = await rl._client.httl("cttc:log:my-container", "1000.0")
        assert ttl and ttl[0] <= 60
