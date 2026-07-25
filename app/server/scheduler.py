"""Time-based triggering for recording sessions.

recording_session.py owns *what* a session is and how it's collected;
this module owns *when* one starts. A Schedule is either:

  - one-shot: fires exactly once at `start_at` (epoch ms), or
  - recurring: fires every time `cron` (a standard 5-field cron
    expression, evaluated via croniter) matches, indefinitely.

Each firing calls straight into RecordingSessionManager.start(), so a
schedule doesn't hold any recording data itself -- it just accumulates the
session_ids it has triggered, letting a client that only has the
schedule_id (from the original POST /scheduler call) discover and then
poll/download each occurrence through the ordinary session endpoints.

tick() is polled by server.py's background loop, same as
RecordingSessionManager.tick().
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from croniter import croniter

if TYPE_CHECKING:
    from recording_session import RecordingSessionManager


class UnknownSchedule(KeyError):
    """Raised for an unknown schedule id."""


class InvalidSchedule(ValueError):
    """Raised for a schedule request that's neither one-shot nor recurring
    (or both), or that carries a malformed cron expression."""


@dataclass
class Schedule:
    id: str
    duration_minutes: float
    safe: bool = False
    max_keep_seconds: float | None = None
    start_at: float | None = None  # one-shot: epoch ms
    cron: str | None = None  # recurring: cron expression
    next_fire: float | None = None  # recurring: next epoch ms to trigger at
    done: bool = False  # one-shot only: true once fired
    session_ids: list[str] = field(default_factory=list)


class Scheduler:
    def __init__(self, sessions: RecordingSessionManager):
        self._sessions = sessions
        self._schedules: dict[str, Schedule] = {}
        self._next_id = 1

    def create(
        self,
        duration_minutes: float,
        start_at: float | None = None,
        cron: str | None = None,
        safe: bool = False,
        max_keep_seconds: float | None = None,
    ) -> str:
        """Register a schedule and return its id. Give exactly one of
        `start_at` (one-shot, epoch ms) or `cron` (recurring)."""
        if bool(start_at) == bool(cron):
            raise InvalidSchedule("give exactly one of start_at or cron")
        next_fire = None
        if cron is not None:
            try:
                next_fire = croniter(cron, time.time()).get_next(float) * 1000.0
            except (ValueError, KeyError) as e:
                raise InvalidSchedule(f"invalid cron expression: {cron}") from e
        sid = f"sch{self._next_id}"
        self._next_id += 1
        self._schedules[sid] = Schedule(
            id=sid,
            duration_minutes=duration_minutes,
            safe=safe,
            max_keep_seconds=max_keep_seconds,
            start_at=start_at,
            cron=cron,
            next_fire=next_fire,
        )
        return sid

    def cancel(self, schedule_id: str) -> None:
        if schedule_id not in self._schedules:
            raise UnknownSchedule(schedule_id)
        del self._schedules[schedule_id]

    def status_of(self, schedule_id: str) -> dict:
        sch = self._require(schedule_id)
        return {
            "schedule_id": sch.id,
            "start_at": sch.start_at,
            "cron": sch.cron,
            "done": sch.done,
            "session_ids": list(sch.session_ids),
        }

    def tick(self, now: float | None = None) -> None:
        now = now if now is not None else time.time() * 1000.0
        for sch in list(self._schedules.values()):
            if sch.cron is not None:
                while sch.next_fire is not None and now >= sch.next_fire:
                    self._fire(sch)
                    sch.next_fire = (
                        croniter(sch.cron, sch.next_fire / 1000.0).get_next(float) * 1000.0
                    )
            elif not sch.done and sch.start_at is not None and now >= sch.start_at:
                self._fire(sch)
                sch.done = True

    def _fire(self, sch: Schedule) -> None:
        sid = self._sessions.start(
            duration_minutes=sch.duration_minutes,
            safe=sch.safe,
            max_keep_seconds=sch.max_keep_seconds,
        )
        sch.session_ids.append(sid)

    def _require(self, schedule_id: str) -> Schedule:
        sch = self._schedules.get(schedule_id)
        if sch is None:
            raise UnknownSchedule(schedule_id)
        return sch
