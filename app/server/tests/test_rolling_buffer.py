"""Tests for the rolling metrics/log buffer (rolling_buffer.py)."""

from __future__ import annotations

import asyncio
import json
import zipfile
from datetime import UTC, datetime

import pytest

import rolling_buffer
import server


def ms(y, mo, d, h=0, mi=0, s=0, us=0, tz=UTC):
    return datetime(y, mo, d, h, mi, s, us, tz).timestamp() * 1000.0


def stats_entry(name, ts):
    return {"Name": name, "CPUPerc": "1%", "Container": name, "read": ts}


@pytest.fixture
async def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    st = server.State(tdir)
    await st.redis_log.start()
    yield st
    await st.redis_log.stop()


async def _flush():
    # record() enqueues via call_soon_threadsafe and is pumped
    # asynchronously; give the pump a beat before reads that expect it.
    await asyncio.sleep(0.15)


@pytest.fixture
def log_file(tmp_path):
    f = tmp_path / "svc.log"
    f.write_text("2026-01-02T03:00:00Z one\n2026-01-02T03:00:30Z two\n2026-01-02T03:01:00Z three\n")
    return f


def _members(data: bytes) -> dict:
    import io as _io

    with zipfile.ZipFile(_io.BytesIO(data)) as zf:
        return {n: zf.read(n) for n in zf.namelist()}


class TestRollingBuffer:
    async def test_start_returns_unique_ids(self, state):
        b1 = state.rolling_buffers.start(5)
        b2 = state.rolling_buffers.start(5)
        assert b1 != b2

    async def test_stop_unknown_buffer_raises(self, state):
        with pytest.raises(rolling_buffer.UnknownBuffer):
            await state.rolling_buffers.stop("nope")

    async def test_pause_unknown_buffer_raises(self, state):
        with pytest.raises(rolling_buffer.UnknownBuffer):
            state.rolling_buffers.pause("nope")

    async def test_stop_removes_buffer(self, state, log_file, monkeypatch):
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 1, 0) / 1000.0)
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        buffer_id = state.rolling_buffers.start(5)
        await state.rolling_buffers.stop(buffer_id)
        with pytest.raises(rolling_buffer.UnknownBuffer):
            await state.rolling_buffers.stop(buffer_id)

    async def test_stop_captures_only_snapshotted_sources(
        self, state, log_file, tmp_path, monkeypatch
    ):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0)
        buffer_id = state.rolling_buffers.start(5)
        # opened after the buffer started -- must not appear in its output
        late = tmp_path / "late.log"
        late.write_text("2026-01-02T03:00:00Z late\n")
        state.open_file(str(late), "log", None, live=False, transforms=[])
        await _flush()

        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 1, 0) / 1000.0)
        _data, meta = await state.rolling_buffers.stop(buffer_id)
        assert len(meta) == 1
        assert meta[0]["name"] == "svc"

    async def test_stop_windows_to_last_n_minutes(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0)
        buffer_id = state.rolling_buffers.start(0.5)  # 30s window
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 1, 0) / 1000.0)
        data, meta = await state.rolling_buffers.stop(buffer_id)
        members = _members(data)
        rows = members[meta[0]["file"]].decode().splitlines()
        texts = [json.loads(r)["text"] for r in rows]
        # window is [end - 30s, end] = [03:00:30, 03:01:00] -- "one" (03:00:00) excluded
        assert texts == ["two", "three"]

    async def test_pause_freezes_window_end(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0)
        buffer_id = state.rolling_buffers.start(10)
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 30) / 1000.0)
        state.rolling_buffers.pause(buffer_id)
        # time keeps moving after pause, but stop() must use the paused_at
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 4, 0, 0) / 1000.0)
        data, meta = await state.rolling_buffers.stop(buffer_id)
        members = _members(data)
        rows = members[meta[0]["file"]].decode().splitlines()
        texts = [json.loads(r)["text"] for r in rows]
        assert texts == ["one", "two"]  # up to 03:00:30, not the later "three"

    async def test_pause_twice_keeps_first_pause_time(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0)
        buffer_id = state.rolling_buffers.start(10)
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 30) / 1000.0)
        state.rolling_buffers.pause(buffer_id)
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 5, 0) / 1000.0)
        state.rolling_buffers.pause(buffer_id)  # no-op, first pause wins
        data, meta = await state.rolling_buffers.stop(buffer_id)
        members = _members(data)
        rows = members[meta[0]["file"]].decode().splitlines()
        assert len(rows) == 2  # "one" and "two", not "three"


class TestRollingBufferRetention:
    """br-RBUF-005: ad-hoc buffers (POST /buffer/start) used to have no
    retention/cap of any kind, leaking forever without an explicit stop()."""

    def test_tick_reclaims_an_ad_hoc_buffer_past_max_age(self, state, monkeypatch):
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0)
        buffer_id = state.rolling_buffers.start(5)
        future = ms(2026, 1, 2, 3, 0, 0) + rolling_buffer.MAX_AGE_SECONDS * 1000.0 + 1000.0
        reclaimed = state.rolling_buffers.tick(now=future)
        assert reclaimed == [buffer_id]
        assert buffer_id not in state.rolling_buffers._buffers

    def test_tick_does_not_reclaim_before_max_age(self, state, monkeypatch):
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0)
        buffer_id = state.rolling_buffers.start(5)
        almost = ms(2026, 1, 2, 3, 0, 0) + rolling_buffer.MAX_AGE_SECONDS * 1000.0 - 1000.0
        assert state.rolling_buffers.tick(now=almost) == []
        assert buffer_id in state.rolling_buffers._buffers

    def test_tick_never_reclaims_an_event_owned_buffer_no_matter_how_old(self, state, monkeypatch):
        monkeypatch.setattr(rolling_buffer.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0)
        buffer_id = state.rolling_buffers.start(5, owned_by_event=True)
        far_future = ms(2026, 1, 2, 3, 0, 0) + rolling_buffer.MAX_AGE_SECONDS * 1000.0 * 100
        assert state.rolling_buffers.tick(now=far_future) == []
        assert buffer_id in state.rolling_buffers._buffers

    def test_start_raises_once_max_open_ad_hoc_buffers_are_reached(self, state):
        for _ in range(rolling_buffer.MAX_OPEN):
            state.rolling_buffers.start(5)
        with pytest.raises(rolling_buffer.TooManyBuffers):
            state.rolling_buffers.start(5)

    def test_event_owned_buffers_do_not_count_toward_the_ad_hoc_cap(self, state):
        for _ in range(rolling_buffer.MAX_OPEN):
            state.rolling_buffers.start(5, owned_by_event=True)
        # every slot "used" above was event-owned -- an ad-hoc one must
        # still be free to start
        buffer_id = state.rolling_buffers.start(5)
        assert buffer_id in state.rolling_buffers._buffers

    def test_stopping_an_ad_hoc_buffer_frees_a_cap_slot(self, state):
        first = state.rolling_buffers.start(5)
        for _ in range(rolling_buffer.MAX_OPEN - 1):
            state.rolling_buffers.start(5)
        with pytest.raises(rolling_buffer.TooManyBuffers):
            state.rolling_buffers.start(5)
        state.rolling_buffers._buffers.pop(first)  # simulate a completed stop()
        state.rolling_buffers.start(5)  # no longer raises
