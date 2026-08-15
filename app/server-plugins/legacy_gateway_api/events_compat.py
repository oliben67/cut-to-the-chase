"""Gateway-hosted event translation for the legacy gateway API plugin --
reproduces `app/server/events.py`'s condition-watch-and-fire wire
protocol (`POST /events/create`, `GET /events/list`, `GET /events/{id}`,
`POST /events/{id}/update`, `/enable`, `/disable`, `/reset`, `/cancel`)
on top of log-sump's daemon/stream model.

Distinct from cttc's *other*, purely client-side "UI-hosted" events
(`app/renderer/src/modules/events/engine.ts`) -- those never touch this
plugin at all, they poll `/logs`/`state.series` directly and fire via
the session/files-download primitives already covered by `sessions_
compat.py`. This module exists only for the *gateway*-hosted half: an
event registered here keeps watching even if every renderer window
closes, exactly like the old gateway's own `EventManager`.

Like `sessions_compat.py`, entirely in-process rather than in Redis (an
event's own watch state -- armed/triggered, log-read cursors, trigger
count -- isn't data of its own, and losing it on a log-server restart is
the same accepted gap the old gateway had with its own in-RAM
`EventManager._events`).

No rolling buffer, unlike the old gateway's own snapshot action (which
pre-starts one at event-creation time so a trigger can hand back
"already-buffered" history without missing anything). Not needed here:
log-sump's Streams already retain `retention_days` of history for
*every* source regardless of whether anything is "watching" it (the
same reasoning `sessions_compat.py`'s own docstring gives for skipping
log-sump's `SessionManager`), so a snapshot action just exports
`[trigger_time - minutes, trigger_time]` directly from Streams at fire
time, via `sessions_compat.store_precomputed` -- no separate pre-
accumulation subsystem to keep in sync with what's actually watched.

No background tick task either, same reasoning as `sessions_compat.py`:
condition-checking runs lazily, as a side effect of `status_of` -- the
renderer's own `pollGatewayEventTriggers` (in `engine.ts`) already polls
`GET /events/{id}` for every registered event every ~3s regardless, so
that poll cadence *is* this module's tick.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

from redis.asyncio import Redis

from log_sump.common.schema import SYSTEM_SCOPE_ID, Kind, MetricRecord
from log_sump.server.queries import point_at

from . import compat, log_index, sessions_compat

_OPS = {
    ">": lambda v, t: v > t,
    "<": lambda v, t: v < t,
    ">=": lambda v, t: v >= t,
    "<=": lambda v, t: v <= t,
    "=": lambda v, t: v == t,
}


class UnknownEvent(KeyError):
    pass


class InvalidEvent(ValueError):
    pass


@dataclass(frozen=True)
class MetricCondition:
    metric: Literal["cpu", "mem", "net"]
    op: Literal[">", "<", ">=", "<=", "="]
    threshold: float


@dataclass(frozen=True)
class LogCondition:
    pattern: str


@dataclass(frozen=True)
class Action:
    kind: Literal["snapshot", "recording"]
    minutes: float | None = None
    duration_minutes: float | None = None
    safe: bool = False
    max_keep_seconds: float | None = None


@dataclass
class CompatEvent:
    id: str
    name: str
    source_ids: set[str]
    conditions: list[MetricCondition | LogCondition]
    match: Literal["any", "all"]
    action: Action
    enabled: bool = True
    status: str = "armed"
    armed: bool = True
    triggered_at: float | None = None
    artifact_id: str | None = None
    trigger_detail: str | None = None
    trigger_count: int = 0
    log_cursors: dict[int, dict[str, int]] = field(default_factory=dict)


_EVENTS: dict[str, CompatEvent] = {}
_next_id = 1


def _now_ms() -> float:
    return time.time() * 1000.0


def parse_condition(body: dict) -> MetricCondition | LogCondition:
    ctype = body.get("type")
    if ctype == "metric":
        try:
            return MetricCondition(
                metric=body["metric"], op=body["op"], threshold=float(body["threshold"])
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidEvent(f"malformed metric condition: {exc}") from exc
    if ctype == "log":
        if "pattern" not in body:
            raise InvalidEvent("log condition needs a pattern")
        return LogCondition(pattern=body["pattern"])
    raise InvalidEvent(f"condition.type must be 'metric' or 'log', got {ctype!r}")


def parse_action(body: dict) -> Action:
    kind = body.get("kind")
    if kind not in ("snapshot", "recording"):
        raise InvalidEvent(f"action.kind must be 'snapshot' or 'recording', got {kind!r}")
    return Action(
        kind=kind,
        minutes=float(body["minutes"]) if body.get("minutes") is not None else None,
        duration_minutes=(
            float(body["duration_minutes"]) if body.get("duration_minutes") is not None else None
        ),
        safe=bool(body.get("safe", False)),
        max_keep_seconds=float(body["max_keep_seconds"]) if body.get("max_keep_seconds") else None,
    )


def _validate(
    conditions: list[MetricCondition | LogCondition], match: str, action: Action
) -> None:
    if not conditions:
        raise InvalidEvent("an event needs at least one condition")
    if match not in ("any", "all"):
        raise InvalidEvent(f"match must be 'any' or 'all', got {match!r}")
    for condition in conditions:
        if isinstance(condition, MetricCondition):
            if condition.op not in _OPS:
                raise InvalidEvent(f"unknown operator: {condition.op}")
        elif isinstance(condition, LogCondition):
            try:
                re.compile(condition.pattern)
            except re.error as exc:
                raise InvalidEvent(f"invalid regex: {condition.pattern}") from exc
    if action.kind == "snapshot" and not action.minutes:
        raise InvalidEvent("a snapshot action needs `minutes`")
    if action.kind == "recording" and not action.duration_minutes:
        raise InvalidEvent("a recording action needs `duration_minutes`")


async def _monitored_source_ids(redis: Redis, ev: CompatEvent) -> set[str]:
    if ev.source_ids:
        return ev.source_ids
    sources = await compat.list_sources(redis)
    return {s["id"] for s in sources}


async def _seed_log_cursors(
    redis: Redis, source_ids: set[str], conditions: list[MetricCondition | LogCondition]
) -> dict[int, dict[str, int]]:
    watched = source_ids or {s["id"] for s in await compat.list_sources(redis)}
    totals: dict[str, int] = {}
    for sid in watched:
        try:
            parsed = compat.parse_source_id(sid)
        except ValueError:
            continue
        if parsed.subtype in ("container", "service") and parsed.name is not None:
            totals[sid] = await log_index.total(redis, parsed.hostkey, parsed.name)
    return {i: dict(totals) for i, cond in enumerate(conditions) if isinstance(cond, LogCondition)}


async def create(
    redis: Redis,
    *,
    name: str,
    source_ids: set[str],
    conditions: list[MetricCondition | LogCondition],
    action: Action,
    match: Literal["any", "all"],
) -> str:
    global _next_id
    _validate(conditions, match, action)
    eid = f"leg-evt{_next_id}"
    _next_id += 1
    _EVENTS[eid] = CompatEvent(
        id=eid,
        name=name,
        source_ids=set(source_ids),
        conditions=list(conditions),
        match=match,
        action=action,
        log_cursors=await _seed_log_cursors(redis, source_ids, conditions),
    )
    return eid


def _require(event_id: str) -> CompatEvent:
    ev = _EVENTS.get(event_id)
    if ev is None:
        raise UnknownEvent(event_id)
    return ev


async def update(
    redis: Redis,
    event_id: str,
    *,
    name: str | None,
    source_ids: set[str] | None,
    conditions: list[MetricCondition | LogCondition] | None,
    action: Action | None,
    match: Literal["any", "all"] | None,
) -> None:
    ev = _require(event_id)
    new_conditions = conditions if conditions is not None else ev.conditions
    new_match = match if match is not None else ev.match
    new_action = action if action is not None else ev.action
    _validate(new_conditions, new_match, new_action)

    if name is not None:
        ev.name = name
    if source_ids is not None:
        ev.source_ids = set(source_ids)
    if conditions is not None:
        ev.conditions = list(new_conditions)
        ev.log_cursors = await _seed_log_cursors(redis, ev.source_ids, new_conditions)
    ev.match = new_match
    ev.action = new_action


def enable(event_id: str) -> None:
    _require(event_id).enabled = True


def disable(event_id: str) -> None:
    _require(event_id).enabled = False


def reset(event_id: str) -> None:
    ev = _require(event_id)
    ev.armed = True
    ev.status = "armed"


def cancel(event_id: str) -> None:
    ev = _require(event_id)
    del _EVENTS[ev.id]


def list_ids() -> list[str]:
    return list(_EVENTS.keys())


def _condition_json(cond: MetricCondition | LogCondition) -> dict:
    if isinstance(cond, MetricCondition):
        return {"type": "metric", "metric": cond.metric, "op": cond.op, "threshold": cond.threshold}
    return {"type": "log", "pattern": cond.pattern}


def _event_json(ev: CompatEvent) -> dict:
    return {
        "event_id": ev.id,
        "name": ev.name,
        "source_ids": sorted(ev.source_ids),
        "conditions": [_condition_json(c) for c in ev.conditions],
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


async def status_of(redis: Redis, event_id: str) -> dict:
    ev = _require(event_id)
    if ev.enabled:
        try:
            await _tick_one(redis, ev)
        except Exception:  # noqa: BLE001 -- a bad tick must not break status polling
            pass
    return _event_json(_require(event_id))


async def _check_metric(redis: Redis, ev: CompatEvent, cond: MetricCondition) -> str | None:
    if cond.metric == "net":
        return None  # queries.point_at has no rate, matching point_all's own accepted gap
    cmp = _OPS[cond.op]
    cache: dict[str, dict] = {}
    for sid in await _monitored_source_ids(redis, ev):
        try:
            parsed = compat.parse_source_id(sid)
        except ValueError:
            continue
        if parsed.subtype not in ("stats", "host"):
            continue
        nearest = cache.get(parsed.hostkey)
        if nearest is None:
            nearest = await point_at(redis, parsed.hostkey, Kind.METRIC, datetime.now(UTC))
            cache[parsed.hostkey] = nearest
        for group, (_entry_id, record, _is_service) in nearest.items():
            if not isinstance(record, MetricRecord):
                continue
            is_host_group = group == SYSTEM_SCOPE_ID
            if is_host_group != (parsed.subtype == "host"):
                continue
            val = record.cpu_pct if cond.metric == "cpu" else record.mem_pct
            if val is not None and cmp(val, cond.threshold):
                return f"{sid}/{group}: {cond.metric}={val} {cond.op} {cond.threshold}"
    return None


async def _check_log(
    redis: Redis, ev: CompatEvent, index: int, cond: LogCondition
) -> str | None:
    pattern = re.compile(cond.pattern)
    cursors = ev.log_cursors.setdefault(index, {})
    hit = None
    for sid in await _monitored_source_ids(redis, ev):
        try:
            parsed = compat.parse_source_id(sid)
        except ValueError:
            continue
        if parsed.subtype not in ("container", "service") or parsed.name is None:
            continue
        total = await log_index.total(redis, parsed.hostkey, parsed.name)
        start = cursors.get(sid, 0)
        if total > start:
            rows = await log_index.log_slice(
                redis, parsed.hostkey, parsed.name, start, total - start
            )
        else:
            rows = []
        cursors[sid] = total
        if hit is None:
            for row in rows:
                if pattern.search(row["text"]):
                    hit = f"{sid}: matched {row['text']!r}"
                    break
    return hit


async def _check(redis: Redis, ev: CompatEvent) -> str | None:
    details = []
    for i, cond in enumerate(ev.conditions):
        if isinstance(cond, MetricCondition):
            details.append(await _check_metric(redis, ev, cond))
        else:
            details.append(await _check_log(redis, ev, i, cond))
    hits = [d for d in details if d is not None]
    if ev.match == "any":
        return hits[0] if hits else None
    if len(hits) == len(ev.conditions):
        return "; ".join(hits)
    return None


async def _fire(redis: Redis, ev: CompatEvent, detail: str, now: float) -> None:
    ev.armed = False
    ev.triggered_at = now
    ev.trigger_detail = detail
    ev.trigger_count += 1
    if ev.action.kind == "snapshot":
        t0 = now - (ev.action.minutes or 0) * 60_000.0
        scope_ids = await _monitored_source_ids(redis, ev)
        ev.artifact_id = await sessions_compat.store_precomputed(
            redis,
            source_ids=scope_ids,
            t0_ms=t0,
            t1_ms=now,
            safe=ev.action.safe,
            max_keep_seconds=ev.action.max_keep_seconds,
        )
    else:
        ev.artifact_id = await sessions_compat.start(
            redis,
            duration_minutes=ev.action.duration_minutes,
            safe=ev.action.safe,
            max_keep_seconds=ev.action.max_keep_seconds,
        )


async def _tick_one(redis: Redis, ev: CompatEvent) -> None:
    detail = await _check(redis, ev)
    if detail is not None:
        if ev.armed:
            await _fire(redis, ev, detail, _now_ms())
        ev.status = "triggered"
    else:
        ev.armed = True
        ev.status = "armed"
