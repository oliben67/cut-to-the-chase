"""Recording-session translation for the legacy gateway API plugin --
reproduces `app/server/recording_session.py`'s on-demand-capture wire
protocol (`POST /session/start`, `/{id}/stop`, `/{id}/safe`, `GET
/{id}/status`, `/{id}/download`, `POST /session/ttl`) on top of
log-sump's daemon/stream model.

Not built on log-sump's own `sessions.py`/`SessionManager` at all, even
though that exists and looks like the obvious fit (same migration-plan
Phase 4 lineage): that manager is deliberately scoped to one
`docker_host` per session, matching log-sump's own generic multi-tenant
model, while the legacy gateway's session snapshots *every currently
open source across every daemon at once* into one combined archive
(`recording_session.py`'s own `RecordingSessionManager.start()`:
`source_ids=set(self._state.sources.keys())`, no daemon distinction at
all). Reproducing that faithfully means owning the bookkeeping here
instead -- this module's `CompatSession` records which daemons/names
were open *at start*, and `_finish` gathers each daemon's own slice
separately (`queries.export_window` for stats, `log_index.rows_between`
per watched log source) before merging them into one archive via
log-sump's own `sample_archive.write_archive` (a genuinely generic
function -- nothing about it is single-daemon-specific, only
`export_window`'s own per-call scope is).

Also, deliberately, entirely in-process rather than in Redis (matching
`log_index.py`'s own reasoning): a session here is bookkeeping over data
that already lives durably in log-sump's Streams, not data of its own --
losing an in-flight or completed-but-not-yet-downloaded session on a
log-server restart is a real but accepted gap (matches this plugin's own
`log_index.py` cache precedent), not a regression from the old gateway
(which held the exact same state in RAM too, `RecordingSessionManager.
_sessions`).

No background tick task exists to run per migration-plan Phase 4 (the
plugin mechanism exposes only a router, no lifespan hook) -- a session's
own "duration elapsed" close and the completed-session TTL sweep both
happen lazily, opportunistically, on any request that touches a session
at all (`start`/`status_of`). This means a session's actual completion
can lag its planned end by however long it is before the next
`status_of` poll -- acceptable given the client (events.py's own
polling loop) already polls status on its own cadence and has no
expectation of exact-to-the-millisecond completion.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

from redis.asyncio import Redis

from log_sump.common.sample_archive import write_archive
from log_sump.common.schema import SYSTEM_SCOPE_ID
from log_sump.server.queries import export_window

from . import compat, log_index

DEFAULT_TTL_SECONDS = 24 * 3600.0


class UnknownSession(KeyError):
    pass


@dataclass(frozen=True)
class _Scope:
    watched: frozenset[str]
    include_host: bool


@dataclass
class CompatSession:
    id: str
    scopes: dict[str, _Scope]
    start_ts_ms: float
    duration_minutes: float | None
    safe: bool = False
    max_keep_seconds: float | None = None
    status: Literal["running", "completed"] = "running"
    end_ts_ms: float | None = None
    data: bytes | None = None
    stored_ts_ms: float | None = None


_SESSIONS: dict[str, CompatSession] = {}
_next_id = 1
_default_ttl_seconds = DEFAULT_TTL_SECONDS


def _now_ms() -> float:
    return time.time() * 1000.0


def _from_ms(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000.0, tz=UTC)


async def _scopes_from_open_sources(redis: Redis) -> dict[str, _Scope]:
    """Every currently-open source, grouped by daemon -- the same
    "what's open right now" view `/sources` itself reports, snapshotted
    at session-start time exactly like the old gateway's own
    `set(self._state.sources.keys())`.
    """
    sources = await compat.list_sources(redis)
    watched: dict[str, set[str]] = {}
    include_host: dict[str, bool] = {}
    for s in sources:
        hostkey = compat.hostkey(s["host"])
        if s["kind"] == "log":
            watched.setdefault(hostkey, set()).add(s["name"])
        elif s["kind"] == "stats" and s.get("is_host"):
            include_host[hostkey] = True
        elif s["kind"] == "stats":
            watched.setdefault(hostkey, set())
    hostkeys = set(watched) | set(include_host)
    return {
        hostkey: _Scope(
            watched=frozenset(watched.get(hostkey, ())),
            include_host=include_host.get(hostkey, False),
        )
        for hostkey in hostkeys
    }


async def start(
    redis: Redis,
    *,
    duration_minutes: float | None,
    safe: bool,
    max_keep_seconds: float | None,
) -> str:
    global _next_id
    await _sweep(redis)
    sid = f"leg-rec{_next_id}"
    _next_id += 1
    _SESSIONS[sid] = CompatSession(
        id=sid,
        scopes=await _scopes_from_open_sources(redis),
        start_ts_ms=_now_ms(),
        duration_minutes=duration_minutes,
    )
    return sid


def _require(session_id: str) -> CompatSession:
    sess = _SESSIONS.get(session_id)
    if sess is None:
        raise UnknownSession(session_id)
    return sess


async def _finish(redis: Redis, sess: CompatSession, end_ts_ms: float) -> None:
    all_log_sources: list[tuple[str, list[tuple[float, str]]]] = []
    all_stats_series: dict[str, list] = {}
    all_swarm: set[str] = set()
    t0, t1 = _from_ms(sess.start_ts_ms), _from_ms(end_ts_ms)
    for hostkey, scope in sess.scopes.items():
        for name in sorted(scope.watched):
            rows = await log_index.rows_between(
                redis, hostkey, name, int(sess.start_ts_ms), int(end_ts_ms)
            )
            if rows:
                all_log_sources.append((name, rows))
        export = await export_window(redis, hostkey, t0, t1)
        for group, series in export["stats_series"].items():
            is_host_group = group == SYSTEM_SCOPE_ID
            if is_host_group:
                if scope.include_host:
                    all_stats_series[group] = series
            elif group in scope.watched:
                all_stats_series[group] = series
        all_swarm.update(export["swarm_services"])
    sess.data = write_archive(
        sess.start_ts_ms, end_ts_ms, all_log_sources, all_stats_series, sorted(all_swarm)
    )
    sess.end_ts_ms = end_ts_ms
    sess.stored_ts_ms = _now_ms()
    sess.status = "completed"


async def _tick_one(redis: Redis, sess: CompatSession) -> None:
    if (
        sess.status == "running"
        and sess.duration_minutes is not None
        and _now_ms() - sess.start_ts_ms >= sess.duration_minutes * 60_000.0
    ):
        await _finish(redis, sess, sess.start_ts_ms + sess.duration_minutes * 60_000.0)


async def _sweep(redis: Redis) -> None:
    """Opportunistic duration-elapsed finish + expired-completed-session
    reclaim -- see this module's own docstring for why this runs inline
    on every session-touching request instead of a background task.
    """
    now = _now_ms()
    for sess in list(_SESSIONS.values()):
        await _tick_one(redis, sess)
    expired = []
    for sid, sess in _SESSIONS.items():
        if sess.status != "completed" or sess.stored_ts_ms is None:
            continue
        ttl_seconds = (
            sess.max_keep_seconds
            if sess.safe and sess.max_keep_seconds is not None
            else _default_ttl_seconds
        )
        if now - sess.stored_ts_ms > ttl_seconds * 1000.0:
            expired.append(sid)
    for sid in expired:
        del _SESSIONS[sid]


async def stop(redis: Redis, session_id: str) -> None:
    sess = _require(session_id)
    if sess.status == "running":
        await _finish(redis, sess, _now_ms())


def mark_safe(session_id: str, max_keep_seconds: float) -> None:
    sess = _require(session_id)
    sess.safe = True
    sess.max_keep_seconds = max_keep_seconds


async def status_of(redis: Redis, session_id: str) -> dict:
    await _tick_one(redis, _require(session_id))
    sess = _require(session_id)
    return {
        "session_id": sess.id,
        "status": sess.status,
        "ready": sess.status == "completed",
        "safe": sess.safe,
    }


def download(session_id: str) -> bytes:
    sess = _require(session_id)
    if sess.status != "completed" or sess.data is None:
        raise UnknownSession(session_id)
    return sess.data


def set_default_ttl(seconds: float) -> None:
    global _default_ttl_seconds
    _default_ttl_seconds = seconds
