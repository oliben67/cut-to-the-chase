"""Tests for recording_session.py."""

from __future__ import annotations

import json
import time
import zipfile
from datetime import UTC, datetime

import pytest

import recording_session
import server


def ms(y, mo, d, h=0, mi=0, s=0, us=0, tz=UTC):
    return datetime(y, mo, d, h, mi, s, us, tz).timestamp() * 1000.0


@pytest.fixture
async def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    # redis_flush_interval_seconds=0.05 (sRate), not the 1.0s default -- see
    # _flush() below.
    st = server.State(tdir, redis_flush_interval_seconds=0.05, redis_data_dir=str(tdir / "redis-data"))
    await st.redis_log.start()
    yield st
    await st.redis_log.stop()


async def _flush():
    # record() buffers in memory and is flushed to Redis every
    # flush_interval_seconds (sRate, 0.05s for this fixture's State); give
    # it a beat past that before reads that expect it.
    import asyncio

    await asyncio.sleep(0.15)


@pytest.fixture
def log_file(tmp_path):
    f = tmp_path / "svc.log"
    f.write_text("2026-01-02T03:00:00Z one\n2026-01-02T03:00:30Z two\n2026-01-02T03:01:00Z three\n")
    return f


def _members(data: bytes) -> dict:
    import io

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {n: zf.read(n) for n in zf.namelist()}


class TestRecordingSessionTickResilience:
    async def test_one_failing_finish_does_not_raise_or_block_sweep(
        self, state, log_file, monkeypatch
    ):
        # br-ORCH-004: an exception finishing one session must not kill the
        # tick (and, transitively, all future orchestration ticks) -- the
        # TTL sweep in the same tick must still run.
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        bad_id = state.recording_sessions.start(duration_minutes=1)

        orig_finish = recording_session.RecordingSessionManager._finish

        async def flaky_finish(self, sess, end_ts):
            if sess.id == bad_id:
                raise RuntimeError("boom")
            return await orig_finish(self, sess, end_ts)

        monkeypatch.setattr(recording_session.RecordingSessionManager, "_finish", flaky_finish)
        sweep_calls = []
        orig_sweep = recording_session.RecordingSessionManager._sweep
        monkeypatch.setattr(
            recording_session.RecordingSessionManager,
            "_sweep",
            lambda self, now: (sweep_calls.append(now), orig_sweep(self, now))[-1],
        )

        await state.recording_sessions.tick(
            now=ms(2026, 1, 2, 3, 1, 30)
        )  # must not raise

        assert state.recording_sessions.status_of(bad_id)["status"] == "running"
        assert len(sweep_calls) == 1


class TestRecordingSessionReclaim:
    async def test_orphaned_archive_is_reclaimed_and_next_id_avoids_collision(
        self, state, log_file, tmp_path
    ):
        # br-RECS-013: a gateway restart must not (a) leak a previously
        # completed archive forever, or (b) let a fresh session's id
        # collide with -- and silently overwrite -- one of them.
        sessions_dir = tmp_path / "sess"
        mgr1 = recording_session.RecordingSessionManager(state, sessions_dir)
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        sid = mgr1.start()
        await mgr1.stop(sid)
        assert mgr1.status_of(sid)["ready"] is True
        old_bytes = mgr1.download(sid)
        old_path = mgr1._sessions[sid].path
        assert old_path.exists()

        # simulate a restart: a brand-new manager pointed at the same dir,
        # with no memory of mgr1's in-flight state
        mgr2 = recording_session.RecordingSessionManager(state, sessions_dir)

        # (a) reclaimed -- still reachable via its original id
        assert mgr2.status_of(sid) == {
            "session_id": sid,
            "status": "completed",
            "ready": True,
            "safe": False,
        }
        assert mgr2.download(sid) == old_bytes

        # (b) _next_id was advanced past it, so a fresh session can't collide
        new_sid = mgr2.start()
        assert new_sid != sid
        await mgr2.stop(new_sid)
        assert old_path.exists(), "the old archive must survive a same-process restart + new session"
        assert mgr2.download(sid) == old_bytes, "old archive content must be untouched"

    async def test_reclaimed_orphan_is_swept_once_its_normal_ttl_elapses(self, state, tmp_path):
        sessions_dir = tmp_path / "sess2"
        mgr1 = recording_session.RecordingSessionManager(state, sessions_dir)
        sid = mgr1.start()
        await mgr1.stop(sid)
        path = mgr1._sessions[sid].path
        assert path.exists()

        mgr2 = recording_session.RecordingSessionManager(state, sessions_dir)
        assert sid in mgr2._sessions  # reclaimed

        future = time.time() * 1000.0 + mgr2.default_ttl_seconds * 1000.0 + 1000.0
        mgr2._sweep(future)
        assert not path.exists(), "a reclaimed orphan must be swept once its normal TTL has elapsed"
        assert sid not in mgr2._sessions

    async def test_a_safe_orphan_is_not_reclaimed_with_its_own_max_keep_seconds(
        self, state, tmp_path
    ):
        # A restart can't know the original safe/max_keep_seconds a session
        # was marked with -- reclaimed orphans always fall back to the
        # ordinary default_ttl_seconds sweep, never a longer safe window.
        # Confirms the fallback doesn't accidentally look "safe" by default.
        sessions_dir = tmp_path / "sess3"
        mgr1 = recording_session.RecordingSessionManager(state, sessions_dir)
        sid = mgr1.start()
        await mgr1.stop(sid)
        mgr1.mark_safe(sid, max_keep_seconds=999_999)

        mgr2 = recording_session.RecordingSessionManager(state, sessions_dir)
        assert mgr2.status_of(sid)["safe"] is False

    async def test_unrelated_or_malformed_filenames_are_left_alone(self, state, tmp_path):
        sessions_dir = tmp_path / "sess4"
        sessions_dir.mkdir(parents=True)
        (sessions_dir / ".DS_Store").write_bytes(b"")
        (sessions_dir / "recABC.cttc-record").write_bytes(b"not a real id")
        (sessions_dir / "notarec3.cttc-record").write_bytes(b"wrong prefix")

        mgr = recording_session.RecordingSessionManager(state, sessions_dir)
        assert mgr._sessions == {}
        assert mgr._next_id == 1  # nothing recognized -- no reason to advance it
        # and nothing was touched/deleted
        assert (sessions_dir / ".DS_Store").exists()
        assert (sessions_dir / "recABC.cttc-record").exists()
        assert (sessions_dir / "notarec3.cttc-record").exists()

    async def test_fresh_install_with_no_sessions_dir_yet_starts_clean(self, state, tmp_path):
        sessions_dir = tmp_path / "never-created"
        mgr = recording_session.RecordingSessionManager(state, sessions_dir)
        assert mgr._sessions == {}
        assert mgr._next_id == 1
        assert sessions_dir.is_dir()  # still created up front, as before


class TestRecordingSession:
    async def test_start_returns_unique_ids(self, state):
        s1 = state.recording_sessions.start()
        s2 = state.recording_sessions.start()
        assert s1 != s2

    async def test_status_of_unknown_raises(self, state):
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.status_of("nope")

    async def test_stop_unknown_raises(self, state):
        with pytest.raises(recording_session.UnknownSession):
            await state.recording_sessions.stop("nope")

    async def test_download_before_completion_raises(self, state):
        sid = state.recording_sessions.start()
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.download(sid)

    async def test_status_running_then_completed(self, state, log_file):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        sid = state.recording_sessions.start()
        assert state.recording_sessions.status_of(sid)["status"] == "running"
        await state.recording_sessions.stop(sid)
        st = state.recording_sessions.status_of(sid)
        assert st["status"] == "completed" and st["ready"] is True

    async def test_stop_writes_cttc_record_file_to_disk(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 1, 0) / 1000.0
        )
        await state.recording_sessions.stop(sid)
        path = state.recording_sessions._dir / f"{sid}.cttc-record"
        assert path.exists()
        data = state.recording_sessions.download(sid)
        assert data == path.read_bytes()
        assert "manifest.json" in _members(data)

    async def test_stop_captures_only_snapshotted_sources(
        self, state, log_file, tmp_path, monkeypatch
    ):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start()
        late = tmp_path / "late.log"
        late.write_text("2026-01-02T03:00:00Z late\n")
        state.open_file(str(late), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 1, 0) / 1000.0
        )
        await state.recording_sessions.stop(sid)
        data = state.recording_sessions.download(sid)
        man = json.loads(_members(data)["manifest.json"])
        assert len(man["segments"][0]["sources"]) == 1
        assert man["segments"][0]["sources"][0]["name"] == "svc"

    async def test_stop_is_idempotent(self, state, log_file):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        sid = state.recording_sessions.start()
        await state.recording_sessions.stop(sid)
        first = state.recording_sessions.download(sid)
        await state.recording_sessions.stop(sid)  # no-op: already completed
        assert state.recording_sessions.download(sid) == first

    async def test_tick_finishes_session_once_duration_elapses(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start(duration_minutes=0.5)  # 30s
        await state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 0, 20))
        assert state.recording_sessions.status_of(sid)["status"] == "running"
        await state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 0, 31))
        assert state.recording_sessions.status_of(sid)["status"] == "completed"

    async def test_sweep_erases_after_default_ttl(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start()
        state.recording_sessions.set_default_ttl(60)  # 1 minute
        await state.recording_sessions.stop(sid)
        path = state.recording_sessions._dir / f"{sid}.cttc-record"
        assert path.exists()

        await state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 0, 30))
        assert path.exists()
        await state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 1, 31))
        assert not path.exists()
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.status_of(sid)

    async def test_safe_flag_overrides_default_ttl(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start(safe=True, max_keep_seconds=3600)
        state.recording_sessions.set_default_ttl(60)  # would erase in 1 minute otherwise
        await state.recording_sessions.stop(sid)

        await state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 1, 31))  # past default ttl
        assert state.recording_sessions.status_of(sid)["status"] == "completed"
        assert state.recording_sessions.status_of(sid)["safe"] is True

    async def test_mark_safe_on_already_completed_session(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        await _flush()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start()
        state.recording_sessions.set_default_ttl(60)
        await state.recording_sessions.stop(sid)
        state.recording_sessions.mark_safe(sid, 3600)

        await state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 1, 31))
        assert state.recording_sessions.status_of(sid)["status"] == "completed"

    async def test_mark_safe_unknown_raises(self, state):
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.mark_safe("nope", 3600)
