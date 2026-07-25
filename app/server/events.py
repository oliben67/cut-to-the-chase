"""Gateway-hosted events: watch metrics/logs on chosen sources and, when
one or more conditions are met, take a snapshot or start a recording --
no polling by the client required.

An event can carry more than one condition (e.g. "cpu > 80" and a log
regex both watching the same systems); `match` picks whether *any* one of
them firing is enough (the default) or *all* of them must be true at once.
A metric condition (cpu/mem/net + one of >, <, >=, <=, = + a threshold) is
checked against the *latest* sample of every monitored source's series; a
log condition (a regex) is checked against every log line appended to a
monitored source since the event was created or last checked. Either way,
checking is O(monitored sources) per condition per tick() call from
server.py's background loop -- no separate polling/subscription machinery.

The snapshot action needs "the records on hand" the moment a condition
fires, including a bit of *before* the trigger -- exactly what
rolling_buffer.py already provides, so create() starts one (kept alive for
the event's whole life, covering only its monitored systems) and a trigger
just calls its non-destructive snapshot(). A recording action instead
starts an ordinary forward-looking recording_session.py session from the
trigger moment. Either way the result is handed to
RecordingSessionManager.store_precomputed()/start(), so it gets the same
TTL/safe-flag handling and the same /session/* download endpoints as any
other snapshot or recording -- an event doesn't need its own storage or
retention logic.

An event keeps watching for as long as it's enabled -- disable()/cancel()
are the only things that stop it, there's no one-shot "fires once and
waits for reset()" state. To avoid re-firing (and re-snapshotting/
re-recording) on every single tick for as long as a condition happens to
stay true, firing is edge-triggered: `_armed` tracks whether the condition
was *not* met on the previous check, and only a not-met -> met transition
fires. Once met, `_armed` goes False and stays False until the condition
is seen not-met again, at which point the event is ready to fire once
more. reset() exists as a manual override of that latch (force-ready
again without waiting for the condition to actually clear).
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from cttc_format import METRIC_EXT

if TYPE_CHECKING:
    from recording_session import RecordingSessionManager
    from rolling_buffer import RollingBufferManager
    from server import State

_METRIC_INDEX = {"cpu": 1, "mem": 2, "net": 4}  # index into a series row: (ts, cpu, mem, mem_bytes, net)
_OPS = {
    ">": lambda v, t: v > t,
    "<": lambda v, t: v < t,
    ">=": lambda v, t: v >= t,
    "<=": lambda v, t: v <= t,
    "=": lambda v, t: v == t,
}


class UnknownEvent(KeyError):
    """Raised for an unknown event id."""


class InvalidEvent(ValueError):
    """Raised for a malformed condition/action at create()/update() time."""


@dataclass
class MetricCondition:
    metric: Literal["cpu", "mem", "net"]
    op: Literal[">", "<", ">=", "<=", "="]
    threshold: float


@dataclass
class LogCondition:
    pattern: str  # regex, matched against each new log line's text


@dataclass
class Action:
    kind: Literal["snapshot", "recording"]
    minutes: float | None = None  # snapshot: the rolling buffer's window length
    duration_minutes: float | None = None  # recording: how long to record for
    safe: bool = False
    max_keep_seconds: float | None = None


@dataclass
class Event:
    id: str
    name: str
    source_ids: set[str]  # empty -> every currently-open source, evaluated live
    conditions: list[MetricCondition | LogCondition]
    match: Literal["any", "all"]
    action: Action
    enabled: bool = True
    status: str = "armed"  # armed (watching, ready to fire) <-> triggered (latched until condition clears)
    buffer_id: str | None = None  # snapshot actions only: the backing rolling buffer
    triggered_at: float | None = None
    artifact_id: str | None = None  # the most recent trigger's session_id
    trigger_detail: str | None = None  # human-readable "why" it last fired
    trigger_count: int = 0
    _armed: bool = True  # edge-trigger latch -- see module docstring
    # per condition index -> {source_id: rows already scanned}; only log
    # conditions use this, kept per-condition so two log conditions on the
    # same source never share (and so corrupt) each other's cursor
    _log_cursors: dict[int, dict[str, int]] = field(default_factory=dict)


def _validate(
    conditions: list[MetricCondition | LogCondition], match: str, action: Action
) -> None:
    if not conditions:
        raise InvalidEvent("an event needs at least one condition")
    if match not in ("any", "all"):
        raise InvalidEvent(f"match must be 'any' or 'all', got {match!r}")
    for condition in conditions:
        if isinstance(condition, MetricCondition):
            if condition.metric not in _METRIC_INDEX:
                raise InvalidEvent(f"unknown metric: {condition.metric}")
            if condition.op not in _OPS:
                raise InvalidEvent(f"unknown operator: {condition.op}")
        elif isinstance(condition, LogCondition):
            try:
                re.compile(condition.pattern)
            except re.error as e:
                raise InvalidEvent(f"invalid regex: {condition.pattern}") from e
        else:
            raise InvalidEvent(f"unknown condition type: {condition!r}")
    if action.kind == "snapshot":
        if not action.minutes:
            raise InvalidEvent("a snapshot action needs `minutes`")
    elif action.kind == "recording":
        if not action.duration_minutes:
            raise InvalidEvent("a recording action needs `duration_minutes`")
    else:
        raise InvalidEvent(f"unknown action kind: {action.kind}")


class EventManager:
    def __init__(
        self,
        state: State,
        rolling_buffers: RollingBufferManager,
        recording_sessions: RecordingSessionManager,
    ):
        self._state = state
        self._rolling_buffers = rolling_buffers
        self._recording_sessions = recording_sessions
        self._events: dict[str, Event] = {}
        self._next_id = 1

    def create(
        self,
        name: str,
        source_ids: set[str],
        conditions: list[MetricCondition | LogCondition],
        action: Action,
        match: Literal["any", "all"] = "any",
    ) -> str:
        _validate(conditions, match, action)
        eid = f"evt{self._next_id}"
        self._next_id += 1
        buffer_id = None
        if action.kind == "snapshot":
            buffer_id = self._rolling_buffers.start(action.minutes, source_ids=source_ids or None)
        self._events[eid] = Event(
            id=eid,
            name=name,
            source_ids=set(source_ids),
            conditions=list(conditions),
            match=match,
            action=action,
            buffer_id=buffer_id,
            _log_cursors=self._seed_log_cursors(source_ids, conditions),
        )
        return eid

    def update(
        self,
        event_id: str,
        name: str | None = None,
        source_ids: set[str] | None = None,
        conditions: list[MetricCondition | LogCondition] | None = None,
        action: Action | None = None,
        match: Literal["any", "all"] | None = None,
    ) -> None:
        """Change an existing event in place (same id, same trigger
        history) -- e.g. the Edit Event dialog. Any argument left as None
        keeps that field unchanged. Changing `action` to/from a snapshot,
        or changing `source_ids` while it's a snapshot action, restarts its
        backing rolling buffer (the old one is stopped -- its in-flight
        window is discarded, since the set of monitored systems or the
        window length itself changed)."""
        ev = self._require(event_id)
        new_conditions = conditions if conditions is not None else ev.conditions
        new_match = match if match is not None else ev.match
        new_action = action if action is not None else ev.action
        _validate(new_conditions, new_match, new_action)

        new_source_ids = set(source_ids) if source_ids is not None else ev.source_ids
        was_snapshot = ev.action.kind == "snapshot"
        will_be_snapshot = new_action.kind == "snapshot"
        needs_restart = will_be_snapshot and (action is not None or source_ids is not None or not was_snapshot)
        if needs_restart or (was_snapshot and not will_be_snapshot):
            if ev.buffer_id is not None:
                from rolling_buffer import UnknownBuffer

                try:
                    self._rolling_buffers.stop(ev.buffer_id)
                except UnknownBuffer:
                    pass
                ev.buffer_id = None
            if will_be_snapshot:
                ev.buffer_id = self._rolling_buffers.start(
                    new_action.minutes, source_ids=new_source_ids or None
                )

        if name is not None:
            ev.name = name
        if source_ids is not None:
            ev.source_ids = new_source_ids
        if conditions is not None:
            ev.conditions = list(new_conditions)
            ev._log_cursors = self._seed_log_cursors(new_source_ids, new_conditions)
        ev.match = new_match
        ev.action = new_action

    def _seed_log_cursors(
        self, source_ids: set[str], conditions: list[MetricCondition | LogCondition]
    ) -> dict[int, dict[str, int]]:
        """A log condition only watches for lines appended *after* it starts
        being watched -- seed each currently-known monitored source's cursor
        at its present length so pre-existing backlog never counts as a
        fresh match (a source opened/selected later starts, unavoidably,
        from 0)."""
        watched = set(source_ids) if source_ids else set(self._state.sources.keys())
        return {
            i: {
                sid: len(rows)
                for sid in watched
                if (rows := getattr(self._state.sources.get(sid), "rows", None)) is not None
            }
            for i, cond in enumerate(conditions)
            if isinstance(cond, LogCondition)
        }

    def cancel(self, event_id: str) -> None:
        ev = self._require(event_id)
        if ev.buffer_id is not None:
            from rolling_buffer import UnknownBuffer

            try:
                self._rolling_buffers.stop(ev.buffer_id)
            except UnknownBuffer:
                pass
        del self._events[event_id]

    def enable(self, event_id: str) -> None:
        self._require(event_id).enabled = True

    def disable(self, event_id: str) -> None:
        self._require(event_id).enabled = False

    def reset(self, event_id: str) -> None:
        """Force the edge-trigger latch back to "ready" without waiting for
        the condition to actually clear first."""
        ev = self._require(event_id)
        ev._armed = True
        ev.status = "armed"

    def status_of(self, event_id: str) -> dict:
        ev = self._require(event_id)
        return {
            "event_id": ev.id,
            "name": ev.name,
            "source_ids": sorted(ev.source_ids),
            "conditions": [self._condition_json(c) for c in ev.conditions],
            "match": ev.match,
            "action": {
                "kind": ev.action.kind,
                "minutes": ev.action.minutes,
                "duration_minutes": ev.action.duration_minutes,
                "safe": ev.action.safe,
                "max_keep_seconds": ev.action.max_keep_seconds,
            },
            "enabled": ev.enabled,
            "status": ev.status,
            "triggered_at": ev.triggered_at,
            "artifact_id": ev.artifact_id,
            "trigger_detail": ev.trigger_detail,
            "trigger_count": ev.trigger_count,
        }

    @staticmethod
    def _condition_json(cond: MetricCondition | LogCondition) -> dict:
        if isinstance(cond, MetricCondition):
            return {"type": "metric", "metric": cond.metric, "op": cond.op, "threshold": cond.threshold}
        return {"type": "log", "pattern": cond.pattern}

    def list_ids(self) -> list[str]:
        return list(self._events.keys())

    def tick(self, now: float | None = None) -> None:
        now = now if now is not None else time.time() * 1000.0
        for ev in list(self._events.values()):
            if not ev.enabled:
                continue
            detail = self._check(ev)
            if detail is not None:
                if ev._armed:
                    self._fire(ev, detail, now)
                ev.status = "triggered"
            else:
                ev._armed = True
                ev.status = "armed"

    def _monitored_ids(self, ev: Event) -> set[str]:
        return ev.source_ids if ev.source_ids else set(self._state.sources.keys())

    def _check(self, ev: Event) -> str | None:
        # every condition is always evaluated (never short-circuited), so a
        # log condition's read cursor keeps advancing each tick regardless
        # of `match` or of the edge-trigger latch's own state
        details = [self._check_one(ev, i, cond) for i, cond in enumerate(ev.conditions)]
        hits = [d for d in details if d is not None]
        if ev.match == "any":
            return hits[0] if hits else None
        if len(hits) == len(ev.conditions):
            return "; ".join(hits)
        return None

    def _check_one(self, ev: Event, index: int, cond: MetricCondition | LogCondition) -> str | None:
        if isinstance(cond, MetricCondition):
            return self._check_metric(ev, cond)
        return self._check_log(ev, index, cond)

    def _check_metric(self, ev: Event, cond: MetricCondition) -> str | None:
        idx = _METRIC_INDEX[cond.metric]
        cmp = _OPS[cond.op]
        for sid in self._monitored_ids(ev):
            series = getattr(self._state.sources.get(sid), "series", None)
            if not series:
                continue
            for svc, rows in series.items():
                if not rows:
                    continue
                val = rows[-1][idx]
                if val is not None and cmp(val, cond.threshold):
                    return f"{sid}/{svc}: {cond.metric}={val} {cond.op} {cond.threshold}"
        return None

    def _check_log(self, ev: Event, index: int, cond: LogCondition) -> str | None:
        pattern = re.compile(cond.pattern)
        cursors = ev._log_cursors.setdefault(index, {})
        hit = None
        for sid in self._monitored_ids(ev):
            rows = getattr(self._state.sources.get(sid), "rows", None)
            if rows is None:
                continue
            start = cursors.get(sid, 0)
            new_rows = rows[start:]
            cursors[sid] = len(rows)
            if hit is None:
                for _ts, _seq, _uid, text in new_rows:
                    if pattern.search(text):
                        hit = f"{sid}: matched {text!r}"
                        break
        return hit

    def _fire(self, ev: Event, detail: str, now: float) -> None:
        ev._armed = False
        ev.triggered_at = now
        ev.trigger_detail = detail
        ev.trigger_count += 1
        if ev.action.kind == "snapshot":
            data, _meta = self._rolling_buffers.snapshot(ev.buffer_id)
            ev.artifact_id = self._recording_sessions.store_precomputed(
                data,
                ext=METRIC_EXT,
                safe=ev.action.safe,
                max_keep_seconds=ev.action.max_keep_seconds,
            )
        else:
            ev.artifact_id = self._recording_sessions.start(
                duration_minutes=ev.action.duration_minutes,
                safe=ev.action.safe,
                max_keep_seconds=ev.action.max_keep_seconds,
            )

    def _require(self, event_id: str) -> Event:
        ev = self._events.get(event_id)
        if ev is None:
            raise UnknownEvent(event_id)
        return ev
