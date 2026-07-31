"""Recording sessions: on-demand or scheduler-triggered captures that
accumulate server-side and are collected by the client afterward.

Like rolling_buffer.py, a session doesn't duplicate any data -- Redis
already retains bounded history for every source (see redis_log.py), so
start() just snapshots {source_ids, start_ts} and the actual [start, end]
window is sliced lazily out of Redis once the session ends, via
State.build_sample_bytes(). Unlike the rolling buffer (which hands the
slice straight back to the caller of stop()), a session's result is a
.cttc-record file written to `sessions_dir` and left there for the client
to collect at its own pace -- start() returns a session_id immediately,
and the client polls status_of(session_id) until status is "completed",
then download(session_id).

A session ends either by an explicit stop() call (on-demand, client-paced
recordings) or once its planned duration_minutes elapses (checked by
tick(), called periodically from server.py's background loop, and by
scheduler.py after every scheduled session it fires with a duration).

Retention: completed sessions are erased default_ttl_seconds after they
finish (24h unless changed via set_default_ttl -- see POST /session/ttl),
except sessions marked `safe`, which are kept for their own
max_keep_seconds instead. Mark a session safe when its expected total
recording span is longer than the gateway's default TTL -- otherwise the
gateway could erase it before the client has even finished recording it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from cttc_format import METRIC_EXT, RECORD_EXT

if TYPE_CHECKING:
    from server import State

DEFAULT_TTL_SECONDS = 24 * 3600.0


class UnknownSession(KeyError):
    """Raised for an unknown, or not-yet-completed-where-completion-was-
    required, recording-session id."""


@dataclass
class RecordingSession:
    id: str
    source_ids: set[str]
    start_ts: float
    duration_minutes: float | None  # None -> ends only via an explicit stop()
    safe: bool = False
    max_keep_seconds: float | None = None
    status: str = "running"  # running -> completed
    end_ts: float | None = None
    path: Path | None = None
    stored_ts: float | None = None


class RecordingSessionManager:
    def __init__(self, state: State, sessions_dir: Path):
        self._state = state
        self._dir = sessions_dir
        self._dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, RecordingSession] = {}
        self._next_id = 1
        self.default_ttl_seconds = DEFAULT_TTL_SECONDS

    def set_default_ttl(self, seconds: float) -> None:
        self.default_ttl_seconds = seconds

    def start(
        self,
        duration_minutes: float | None = None,
        safe: bool = False,
        max_keep_seconds: float | None = None,
    ) -> str:
        """Snapshot every currently-open source and begin a new session,
        returning its id. `duration_minutes` of None means the session only
        ends via an explicit stop() call (the on-demand case); scheduler.py
        always passes a duration."""
        sid = f"rec{self._next_id}"
        self._next_id += 1
        self._sessions[sid] = RecordingSession(
            id=sid,
            source_ids=set(self._state.sources.keys()),
            start_ts=time.time() * 1000.0,
            duration_minutes=duration_minutes,
            safe=safe,
            max_keep_seconds=max_keep_seconds,
        )
        return sid

    def store_precomputed(
        self,
        data: bytes,
        ext: str = METRIC_EXT,
        safe: bool = False,
        max_keep_seconds: float | None = None,
    ) -> str:
        """Register already-built archive bytes as a completed "session" --
        for events.py, whose triggered snapshots come from a rolling
        buffer's own build_sample_bytes() slice rather than from a session
        that ran on this manager's own clock. Gets the same id space,
        download()/status_of() access, and TTL sweep as an ordinary
        session for free; `source_ids`/`start_ts`/`duration_minutes` are
        meaningless here so are left at their empty/now defaults."""
        sid = f"rec{self._next_id}"
        self._next_id += 1
        now = time.time() * 1000.0
        path = self._dir / f"{sid}{ext}"
        path.write_bytes(data)
        self._sessions[sid] = RecordingSession(
            id=sid,
            source_ids=set(),
            start_ts=now,
            duration_minutes=None,
            safe=safe,
            max_keep_seconds=max_keep_seconds,
            status="completed",
            end_ts=now,
            path=path,
            stored_ts=now,
        )
        return sid

    def mark_safe(self, session_id: str, max_keep_seconds: float) -> None:
        """Flag a running or already-completed session as exempt from the
        default TTL sweep, kept instead for up to `max_keep_seconds` from
        completion -- for a recording the client knows is (or was) longer
        than the gateway's default retention window."""
        sess = self._require(session_id)
        sess.safe = True
        sess.max_keep_seconds = max_keep_seconds

    async def stop(self, session_id: str) -> None:
        """End a running session now. A no-op if it's already completed."""
        sess = self._require(session_id)
        if sess.status == "running":
            await self._finish(sess, time.time() * 1000.0)

    async def tick(self, now: float | None = None) -> None:
        """Finish any running session whose planned duration has elapsed,
        then sweep expired completed sessions off disk. Called periodically
        from server.py's background loop."""
        now = now if now is not None else time.time() * 1000.0
        for sess in list(self._sessions.values()):
            if (
                sess.status == "running"
                and sess.duration_minutes is not None
                and now - sess.start_ts >= sess.duration_minutes * 60_000.0
            ):
                await self._finish(sess, sess.start_ts + sess.duration_minutes * 60_000.0)
        self._sweep(now)

    def status_of(self, session_id: str) -> dict:
        sess = self._require(session_id)
        return {
            "session_id": sess.id,
            "status": sess.status,
            "ready": sess.status == "completed",
            "safe": sess.safe,
        }

    def download(self, session_id: str) -> bytes:
        sess = self._require(session_id)
        if sess.status != "completed" or sess.path is None:
            raise UnknownSession(session_id)
        return sess.path.read_bytes()

    async def _finish(self, sess: RecordingSession, end_ts: float) -> None:
        data, _ = await self._state.build_sample_bytes(
            sess.start_ts, end_ts, source_ids=sess.source_ids
        )
        path = self._dir / f"{sess.id}{RECORD_EXT}"
        path.write_bytes(data)
        sess.end_ts = end_ts
        sess.path = path
        sess.stored_ts = time.time() * 1000.0
        sess.status = "completed"

    def _sweep(self, now: float) -> list[str]:
        expired = []
        for sid, sess in self._sessions.items():
            if sess.status != "completed" or sess.stored_ts is None:
                continue
            ttl = (
                sess.max_keep_seconds
                if sess.safe and sess.max_keep_seconds is not None
                else self.default_ttl_seconds
            )
            if now - sess.stored_ts > ttl * 1000.0:
                expired.append(sid)
        for sid in expired:
            sess = self._sessions.pop(sid)
            if sess.path is not None and sess.path.exists():
                sess.path.unlink()
        return expired

    def _require(self, session_id: str) -> RecordingSession:
        sess = self._sessions.get(session_id)
        if sess is None:
            raise UnknownSession(session_id)
        return sess
