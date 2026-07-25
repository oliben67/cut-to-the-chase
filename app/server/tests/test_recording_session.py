"""Tests for recording_session.py."""

from __future__ import annotations

import json
import zipfile
from datetime import UTC, datetime

import pytest

import recording_session
import server


def ms(y, mo, d, h=0, mi=0, s=0, us=0, tz=UTC):
    return datetime(y, mo, d, h, mi, s, us, tz).timestamp() * 1000.0


@pytest.fixture
def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    return server.State(tdir)


@pytest.fixture
def log_file(tmp_path):
    f = tmp_path / "svc.log"
    f.write_text(
        "2026-01-02T03:00:00Z one\n2026-01-02T03:00:30Z two\n2026-01-02T03:01:00Z three\n"
    )
    return f


def _members(data: bytes) -> dict:
    import io

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        return {n: zf.read(n) for n in zf.namelist()}


class TestRecordingSession:
    def test_start_returns_unique_ids(self, state):
        s1 = state.recording_sessions.start()
        s2 = state.recording_sessions.start()
        assert s1 != s2

    def test_status_of_unknown_raises(self, state):
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.status_of("nope")

    def test_stop_unknown_raises(self, state):
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.stop("nope")

    def test_download_before_completion_raises(self, state):
        sid = state.recording_sessions.start()
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.download(sid)

    def test_status_running_then_completed(self, state, log_file):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        sid = state.recording_sessions.start()
        assert state.recording_sessions.status_of(sid)["status"] == "running"
        state.recording_sessions.stop(sid)
        st = state.recording_sessions.status_of(sid)
        assert st["status"] == "completed" and st["ready"] is True

    def test_stop_writes_cttc_record_file_to_disk(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start()
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 1, 0) / 1000.0
        )
        state.recording_sessions.stop(sid)
        path = state.recording_sessions._dir / f"{sid}.cttc-record"
        assert path.exists()
        data = state.recording_sessions.download(sid)
        assert data == path.read_bytes()
        assert "manifest.json" in _members(data)

    def test_stop_captures_only_snapshotted_sources(
        self, state, log_file, tmp_path, monkeypatch
    ):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start()
        late = tmp_path / "late.log"
        late.write_text("2026-01-02T03:00:00Z late\n")
        state.open_file(str(late), "log", None, live=False, transforms=[])
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 1, 0) / 1000.0
        )
        state.recording_sessions.stop(sid)
        data = state.recording_sessions.download(sid)
        man = json.loads(_members(data)["manifest.json"])
        assert len(man["segments"][0]["sources"]) == 1
        assert man["segments"][0]["sources"][0]["name"] == "svc"

    def test_stop_is_idempotent(self, state, log_file):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        sid = state.recording_sessions.start()
        state.recording_sessions.stop(sid)
        first = state.recording_sessions.download(sid)
        state.recording_sessions.stop(sid)  # no-op: already completed
        assert state.recording_sessions.download(sid) == first

    def test_tick_finishes_session_once_duration_elapses(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start(duration_minutes=0.5)  # 30s
        state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 0, 20))
        assert state.recording_sessions.status_of(sid)["status"] == "running"
        state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 0, 31))
        assert state.recording_sessions.status_of(sid)["status"] == "completed"

    def test_sweep_erases_after_default_ttl(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start()
        state.recording_sessions.set_default_ttl(60)  # 1 minute
        state.recording_sessions.stop(sid)
        path = state.recording_sessions._dir / f"{sid}.cttc-record"
        assert path.exists()

        state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 0, 30))
        assert path.exists()
        state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 1, 31))
        assert not path.exists()
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.status_of(sid)

    def test_safe_flag_overrides_default_ttl(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start(safe=True, max_keep_seconds=3600)
        state.recording_sessions.set_default_ttl(60)  # would erase in 1 minute otherwise
        state.recording_sessions.stop(sid)

        state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 1, 31))  # past default ttl
        assert state.recording_sessions.status_of(sid)["status"] == "completed"
        assert state.recording_sessions.status_of(sid)["safe"] is True

    def test_mark_safe_on_already_completed_session(self, state, log_file, monkeypatch):
        state.open_file(str(log_file), "log", None, live=False, transforms=[])
        monkeypatch.setattr(
            recording_session.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        sid = state.recording_sessions.start()
        state.recording_sessions.set_default_ttl(60)
        state.recording_sessions.stop(sid)
        state.recording_sessions.mark_safe(sid, 3600)

        state.recording_sessions.tick(now=ms(2026, 1, 2, 3, 1, 31))
        assert state.recording_sessions.status_of(sid)["status"] == "completed"

    def test_mark_safe_unknown_raises(self, state):
        with pytest.raises(recording_session.UnknownSession):
            state.recording_sessions.mark_safe("nope", 3600)
