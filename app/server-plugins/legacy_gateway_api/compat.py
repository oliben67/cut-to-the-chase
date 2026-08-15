"""Translation logic for the legacy gateway API plugin -- see this
package's `__init__.py`/`routes.py` for what this is and why it exists as
a log-sump plugin rather than living inside log-sump itself.

Every function here translates the legacy wire shape to/from log-sump's
native daemon/stream model, calling the exact same daemon registry and
query functions any other log-sump client would use. No new source of
truth, no access to anything log-sump doesn't already expose through its
own public modules.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, NamedTuple

from pydantic import ValidationError
from redis.asyncio import Redis

from log_sump.common.config import DaemonConfig
from log_sump.common.daemon_registry import (
    list_registered_daemons,
    register_daemon,
    unregister_daemon,
)
from log_sump.common.redis_keys import stream_key
from log_sump.common.schema import SYSTEM_SCOPE_ID, Kind, MetricRecord, RecordAdapter
from log_sump.server.queries import bucketed, fetch_kind_page, point_at

from . import log_index

#: Redis Stream IDs are `<ms>-<seq>`; this is the max seq for a given ms,
#: so `<ms>-MAX_SEQ` is an inclusive upper bound covering every entry
#: stamped within that millisecond -- same trick log-sump's own queries.py
#: uses, reproduced locally rather than imported (that one's private).
_MAX_SEQ = (2**64) - 1

# ── source-id scheme ─────────────────────────────────────────────────────
#
# docker://<hostkey>/stats, docker://<hostkey>/host,
# docker://<hostkey>/<container|service>/<name> -- the legacy gateway's own
# addressing scheme, reproduced exactly so its existing client keeps
# working unmodified. hostkey is the daemon id too (see
# register_or_get_daemon) -- an opened source's id is entirely derived,
# never separately persisted.


def hostkey(host: str | None) -> str:
    return host or "local"


def stats_source_id(host: str | None) -> str:
    return f"docker://{hostkey(host)}/stats"


def host_source_id(host: str | None) -> str:
    return f"docker://{hostkey(host)}/host"


def log_source_id(host: str | None, ttype: str, name: str) -> str:
    return f"docker://{hostkey(host)}/{ttype}/{name}"


@dataclass(frozen=True)
class ParsedSourceId:
    hostkey: str
    subtype: Literal["stats", "host", "container", "service"]
    name: str | None  # None for "stats"/"host"


def parse_source_id(sid: str) -> ParsedSourceId:
    if not sid.startswith("docker://"):
        raise ValueError(f"not a docker:// source id: {sid!r}")
    parts = sid[len("docker://") :].split("/")
    if len(parts) == 2 and parts[1] == "stats":
        return ParsedSourceId(hostkey=parts[0], subtype="stats", name=None)
    if len(parts) == 2 and parts[1] == "host":
        return ParsedSourceId(hostkey=parts[0], subtype="host", name=None)
    if len(parts) == 3 and parts[1] == "container":
        return ParsedSourceId(hostkey=parts[0], subtype="container", name=parts[2])
    if len(parts) == 3 and parts[1] == "service":
        return ParsedSourceId(hostkey=parts[0], subtype="service", name=parts[2])
    raise ValueError(f"malformed docker:// source id: {sid!r}")


# ── host string -> DaemonConfig ──────────────────────────────────────────


def _parse_ssh_host(host: str) -> tuple[str, str, int | None]:
    """`[user@]host[:port]` -> (user, host, port). `host` has already had
    any `ssh://` prefix stripped by the caller.
    """
    user = "root"
    rest = host
    if "@" in rest:
        user, rest = rest.rsplit("@", 1)
    port: int | None = None
    if ":" in rest:
        rest, port_s = rest.rsplit(":", 1)
        if port_s.isdigit():
            port = int(port_s)
    return user, rest, port


async def register_or_get_daemon(redis: Redis, host: str | None) -> DaemonConfig:
    """Ensures a daemon exists for `host` (null-means-local), returning its
    current config. `host` is used verbatim as the daemon id, so a caller
    that already has a legacy-style host string never needs a separate id
    lookup.
    """
    daemon_id = hostkey(host)
    existing = {d.id: d for d in await list_registered_daemons(redis)}
    if daemon_id in existing:
        return existing[daemon_id]
    if host is None:
        daemon = DaemonConfig(id=daemon_id, host="local", transport="local", watched_containers=[])
    else:
        raw = host[len("ssh://") :] if host.startswith("ssh://") else host
        user, real_host, port = _parse_ssh_host(raw)
        ssh_options = ["-p", str(port)] if port is not None else []
        daemon = DaemonConfig(
            id=daemon_id,
            host=real_host,
            user=user,
            transport="ssh",
            ssh_options=ssh_options,
            watched_containers=[],
        )
    await register_daemon(redis, daemon)
    return daemon


async def forget_daemon(redis: Redis, host: str | None) -> bool:
    return await unregister_daemon(redis, hostkey(host))


# ── docker/ps preview ────────────────────────────────────────────────────


async def preview_containers(redis: Redis, host: str | None) -> dict[str, Any]:
    """What's currently running on `host`, for a "pick containers to
    watch" picker to offer *before* the caller commits to watching
    anything. log-sump's listener only ever discovers containers
    in-process -- there's no live "ask the daemon what's running right
    now" primitive to call instead.

    Compromise: if `host` isn't registered yet, register it with
    `watched_containers=None` (watch everything) just long enough for a
    discovery cycle to land actual per-container metric records, then read
    those back. An already-registered daemon's existing selection is left
    untouched -- this only widens an unregistered daemon's *brand new*
    registration, and only until the caller narrows it via `collect()`'s
    own watched_containers update.
    """
    existing = {d.id: d for d in await list_registered_daemons(redis)}
    daemon = existing.get(hostkey(host))
    if daemon is None:
        daemon = await register_or_get_daemon(redis, host)
        await register_daemon(redis, daemon.model_copy(update={"watched_containers": None}))

    now = datetime.now(UTC)
    entries, _next_cursor = await fetch_kind_page(
        redis,
        hostkey(host),
        Kind.METRIC,
        start=now - timedelta(minutes=5),
        end=now,
        cursor=None,
        limit=1000,
    )
    seen: dict[str, dict[str, str]] = {}
    for _entry_id, record in entries:
        if not isinstance(record, MetricRecord):
            continue
        if record.metric_scope != "container" or record.container_name == SYSTEM_SCOPE_ID:
            continue
        seen[record.container_name] = {
            "id": record.container_id[:12],
            "name": record.container_name,
            "image": "",  # not carried by MetricRecord -- unused by the picker
        }
    containers = sorted(seen.values(), key=lambda c: c["name"])
    return {"containers": containers, "services": [], "log": []}


# ── collect / close ───────────────────────────────────────────────────────


async def collect(
    redis: Redis, *, host: str | None, stats: bool, host_stats: bool, logs: list[dict[str, str]]
) -> tuple[DaemonConfig, list[str]]:
    """Opens (or extends) whatever the caller asked for and returns
    `(daemon, opened_source_ids)`.

    `stats`/`host_stats` need no bookkeeping of their own to "open" --
    log-sump always samples per-container stats for every watched
    container and host-level stats for every registered daemon regardless,
    so those two flags only ever affect *this function's own `opened`
    list*, for the caller's benefit -- they don't gate anything
    server-side. `transforms`/`interval` (the legacy API's own per-request
    knobs) have no per-daemon equivalent in log-sump today (transforms are
    a single global list; sampling intervals are global settings, not
    per-request) -- silently accepted and ignored, a known, deliberately
    deferred gap.
    """
    daemon = await register_or_get_daemon(redis, host)
    opened: list[str] = []
    if stats and daemon.watched_containers != []:
        opened.append(stats_source_id(host))
    if host_stats:
        opened.append(host_source_id(host))

    requested_names = {item["name"] for item in logs}
    current = set(daemon.watched_containers or [])
    updated_names = sorted(current | requested_names)
    if daemon.watched_containers is None or updated_names != sorted(current):
        daemon = daemon.model_copy(update={"watched_containers": updated_names})
        await register_daemon(redis, daemon)
    for item in logs:
        opened.append(log_source_id(host, item.get("type", "container"), item["name"]))
    return daemon, opened


async def close_source(redis: Redis, sid: str) -> None:
    """For a log source, drops just that one container/service name from
    its daemon's `watched_containers` (log-sump's own daemon-registry
    watch loop picks the change up and stops that one listener). For
    "stats"/"host", there's nothing to individually turn off (see
    `collect`'s own docstring) -- a no-op.
    """
    parsed = parse_source_id(sid)
    if parsed.subtype not in ("container", "service") or parsed.name is None:
        return
    existing = {d.id: d for d in await list_registered_daemons(redis)}
    daemon = existing.get(parsed.hostkey)
    if daemon is None or daemon.watched_containers is None:
        return
    remaining = [n for n in daemon.watched_containers if n != parsed.name]
    if remaining != daemon.watched_containers:
        await register_daemon(redis, daemon.model_copy(update={"watched_containers": remaining}))
    log_index.forget(parsed.hostkey, parsed.name)


# ── sources / range ────────────────────────────────────────────────────────


async def _stream_bounds(
    redis: Redis, docker_host: str, kind: Kind
) -> tuple[int | None, int | None]:
    """(min_ts_ms, max_ts_ms) approximated across the *whole* per-daemon,
    per-kind stream, not scoped to one container -- log-sump's Streams are
    shared by every container on a daemon, so a precise per-container range
    would mean scanning the whole stream rather than one
    `XRANGE`/`XREVRANGE COUNT 1` each. A known, deliberately coarse
    approximation: a single busy daemon's many sources all report the same
    daemon-wide bounds rather than their own exact one.
    """
    key = stream_key(docker_host, kind)
    first = await redis.xrange(key, count=1)
    last = await redis.xrevrange(key, count=1)
    if not first or not last:
        return None, None
    first_id, last_id = first[0][0], last[0][0]
    if first_id is None or last_id is None:
        return None, None
    return _entry_id_ms(first_id), _entry_id_ms(last_id)


def _entry_id_ms(entry_id: bytes | str) -> int:
    text = entry_id.decode() if isinstance(entry_id, bytes) else entry_id
    return int(text.split("-", 1)[0])


async def list_sources(redis: Redis) -> list[dict[str, Any]]:
    daemons = await list_registered_daemons(redis)
    out: list[dict[str, Any]] = []
    for daemon in daemons:
        host = None if daemon.id == "local" else daemon.id
        watched = daemon.watched_containers or []
        metric_min_ts, metric_max_ts = await _stream_bounds(redis, daemon.id, Kind.METRIC)

        if watched:
            out.append(
                {
                    "id": stats_source_id(host),
                    "name": f"stats@{daemon.host}",
                    "kind": "stats",
                    "path": stats_source_id(host),
                    "live": True,
                    "skipped": 0,
                    "min_ts": metric_min_ts,
                    "max_ts": metric_max_ts,
                    "error": None,
                    "total": 0,
                    "host": host,
                    "services": sorted(watched),
                    "is_host": False,
                }
            )

        out.append(
            {
                "id": host_source_id(host),
                "name": f"host@{daemon.host}",
                "kind": "stats",
                "path": host_source_id(host),
                "live": True,
                "skipped": 0,
                "min_ts": metric_min_ts,
                "max_ts": metric_max_ts,
                "error": None,
                "total": 0,
                "host": host,
                "services": [SYSTEM_SCOPE_ID],
                "is_host": True,
            }
        )

        if watched:
            log_min_ts, log_max_ts = await _stream_bounds(redis, daemon.id, Kind.LOG)
            for name in sorted(watched):
                out.append(
                    {
                        "id": log_source_id(host, "container", name),
                        "name": name,
                        "kind": "log",
                        "path": log_source_id(host, "container", name),
                        "live": True,
                        "skipped": 0,
                        "min_ts": log_min_ts,
                        "max_ts": log_max_ts,
                        "error": None,
                        "total": await log_index.total(redis, daemon.id, name),
                        "host": host,
                        "transforms": [],
                    }
                )
    return out


async def time_range(redis: Redis) -> tuple[int | None, int | None]:
    daemons = await list_registered_daemons(redis)
    lo = hi = None
    for daemon in daemons:
        for kind in (Kind.LOG, Kind.METRIC):
            min_ts, max_ts = await _stream_bounds(redis, daemon.id, kind)
            if min_ts is not None:
                lo = min_ts if lo is None else min(lo, min_ts)
            if max_ts is not None:
                hi = max_ts if hi is None else max(hi, max_ts)
    return lo, hi


# ── chart/log-panel queries ─────────────────────────────────────────────────
#
# /point, /series, /stats_export, /logs, /index_at, /ticks, /logs/find --
# deliberately not delegated to log_sump.server.routers.series (Phase 1):
# that router is daemon-scoped and per-`X-API-Key`, addressed by
# `docker_host`+`container_id`; this legacy client has no notion of either
# (no per-daemon key, and its source ids name a *container name*, stable
# across that container's restarts, not the container id `docker ps`
# reassigns on every one -- see log_index.py's own docstring). /point and
# /series still reach into `queries.point_at`/`bucketed` directly (both
# already group by container *name* internally), just reshaped and merged
# across every registered daemon's currently-open sources at once, the way
# the old gateway's own global sources dict did.


def _is_open_group(group: str, watched: set[str]) -> bool:
    return group == SYSTEM_SCOPE_ID or group in watched


async def point_all(redis: Redis, t: datetime) -> dict[str, dict[str, Any]]:
    """Per display group, the nearest metric sample to `t`, merged across
    every registered daemon's currently-open stats sources -- backs
    `/point` (compares an arbitrary instant, e.g. a loaded sample, against
    another, e.g. live "now").

    No net rate here, unlike `series_all`/`stats_export_all` below:
    `queries.point_at` hands back one raw sample, and a rate needs a
    *second*, prior sample to diff against -- unlike a windowed query,
    which already computes rates while scanning a whole range anyway. A
    known, deliberately accepted gap (the old gateway's own snapshot
    dialog is this field's only consumer).
    """
    daemons = await list_registered_daemons(redis)
    out: dict[str, dict[str, Any]] = {}
    for daemon in daemons:
        host = None if daemon.id == "local" else daemon.id
        watched = set(daemon.watched_containers or [])
        nearest = await point_at(redis, daemon.id, Kind.METRIC, t)
        for group, (_entry_id, record, _is_service) in nearest.items():
            if not isinstance(record, MetricRecord) or not _is_open_group(group, watched):
                continue
            is_host_group = group == SYSTEM_SCOPE_ID
            out[group] = {
                "ts": record.ts.timestamp() * 1000.0,
                "cpu": record.cpu_pct,
                "mem": record.mem_pct,
                "mem_bytes": record.mem_used_bytes,
                "net": None,
                "host": is_host_group,
                "sid": host_source_id(host) if is_host_group else stats_source_id(host),
            }
    return out


async def series_all(redis: Redis, t0: datetime, t1: datetime, px: int) -> list[dict[str, Any]]:
    """Per display group, per pixel bucket: max cpu/mem, max net rate --
    backs `/series` (chart rendering). Merged across every registered
    daemon's currently-open stats sources, same gating as `point_all`.
    """
    daemons = await list_registered_daemons(redis)
    out: list[dict[str, Any]] = []
    for daemon in daemons:
        host = None if daemon.id == "local" else daemon.id
        watched = set(daemon.watched_containers or [])
        for c in await bucketed(redis, daemon.id, t0, t1, px):
            if not _is_open_group(c["name"], watched):
                continue
            is_host_group = c["name"] == SYSTEM_SCOPE_ID
            out.append(
                {
                    "name": c["name"],
                    "cpu": c["cpu"],
                    "mem": c["mem"],
                    "net": c["net"],
                    "host": is_host_group,
                    "sid": host_source_id(host) if is_host_group else stats_source_id(host),
                    "ttype": c["ttype"],
                }
            )
    return out


def _metric_group(container_name: str) -> tuple[str, bool]:
    group = container_name.split(".", 1)[0]
    return (group, True) if group != container_name else (container_name, False)


def _decode_metric_entry(fields: dict | None) -> MetricRecord | None:
    if not fields:
        return None
    data = fields.get(b"data")
    if data is None:
        return None
    try:
        record = RecordAdapter.validate_json(data)
    except ValidationError:
        return None
    return record if isinstance(record, MetricRecord) else None


class _MetricRow(NamedTuple):
    ts_ms: int
    cpu: float | None
    mem: float | None
    mem_bytes: float | None
    net: float | None


async def stats_export_all(
    redis: Redis, t0_ms: int, t1_ms: int, granularity: str
) -> list[dict[str, Any]]:
    """Per display group: every raw sample in `[t0_ms, t1_ms]` ("full") or
    a min/avg/max summary over them ("summary") -- backs `/stats_export`
    ("Export metrics"). Unlike `series_all`'s per-pixel max (chart
    rendering), this reads exact stored samples, so it scans the window
    directly rather than going through `queries.bucketed`.
    """
    daemons = await list_registered_daemons(redis)
    out: list[dict[str, Any]] = []
    for daemon in daemons:
        host = None if daemon.id == "local" else daemon.id
        watched = set(daemon.watched_containers or [])
        stream = stream_key(daemon.id, Kind.METRIC)
        raw = await redis.xrange(stream, min=f"{t0_ms}-0", max=f"{t1_ms}-{_MAX_SEQ}")

        by_container: dict[str, list[tuple[int, MetricRecord]]] = {}
        for entry_id, fields in raw or []:
            if entry_id is None:
                continue
            record = _decode_metric_entry(fields)
            if record is None:
                continue
            ts_ms = _entry_id_ms(entry_id)
            by_container.setdefault(record.container_id, []).append((ts_ms, record))

        # Two-pass, same shape as queries.bucketed: rate first, per
        # container id (a different container's counters are unrelated),
        # then merge same-group containers together.
        by_group: dict[str, list[_MetricRow]] = {}
        for samples in by_container.values():
            samples.sort(key=lambda pair: pair[0])
            group, _is_service = _metric_group(samples[0][1].container_name)
            rows = by_group.setdefault(group, [])
            prev_total: tuple[int, int] | None = None
            for ts_ms, record in samples:
                total = None
                if record.net_rx_bytes is not None and record.net_tx_bytes is not None:
                    total = record.net_rx_bytes + record.net_tx_bytes
                rate = None
                if total is not None and prev_total is not None and ts_ms > prev_total[0]:
                    delta = total - prev_total[1]
                    if delta >= 0:  # negative == counter reset (restart); skip it
                        rate = delta / ((ts_ms - prev_total[0]) / 1000.0)
                if total is not None:
                    prev_total = (ts_ms, total)
                mem_bytes = record.mem_used_bytes
                mem_bytes = float(mem_bytes) if mem_bytes is not None else None
                rows.append(_MetricRow(ts_ms, record.cpu_pct, record.mem_pct, mem_bytes, rate))

        for group in sorted(by_group):
            if not _is_open_group(group, watched):
                continue
            rows = sorted(by_group[group], key=lambda row: row[0])
            is_host_group = group == SYSTEM_SCOPE_ID
            sid = host_source_id(host) if is_host_group else stats_source_id(host)
            if granularity == "full":
                out.append(
                    {
                        "name": group,
                        "host": is_host_group,
                        "sid": sid,
                        "samples": [
                            {
                                "ts": r.ts_ms,
                                "cpu": r.cpu,
                                "mem": r.mem,
                                "mem_bytes": r.mem_bytes,
                                "net": r.net,
                            }
                            for r in rows
                        ],
                    }
                )
                continue

            def agg(
                rows: list[_MetricRow], key: Callable[[_MetricRow], float | None]
            ) -> dict[str, float] | None:
                vals: list[float] = []
                for row in rows:
                    v = key(row)
                    if v is not None:
                        vals.append(v)
                if not vals:
                    return None
                return {"min": min(vals), "avg": sum(vals) / len(vals), "max": max(vals)}

            out.append(
                {
                    "name": group,
                    "host": is_host_group,
                    "sid": sid,
                    "count": len(rows),
                    "cpu": agg(rows, lambda r: r.cpu),
                    "mem": agg(rows, lambda r: r.mem),
                    "mem_bytes": agg(rows, lambda r: r.mem_bytes),
                    "net": agg(rows, lambda r: r.net),
                }
            )
    return out


# ── log-panel queries (rank-addressed, see log_index.py) ────────────────────


def _log_target(sid: str) -> tuple[str, str]:
    """A log source id -> `(docker_host, container_name)` -- shared by
    every function below so a malformed or non-log source id (e.g. a
    stats/host source's own id) fails the same way in one place.
    """
    parsed = parse_source_id(sid)
    if parsed.subtype not in ("container", "service") or parsed.name is None:
        raise ValueError(f"not a log source id: {sid!r}")
    return parsed.hostkey, parsed.name


async def logs_total(redis: Redis, sid: str) -> int:
    docker_host, name = _log_target(sid)
    return await log_index.total(redis, docker_host, name)


async def logs_page(
    redis: Redis, sid: str, start: int, count: int
) -> tuple[int, list[dict[str, Any]]]:
    docker_host, name = _log_target(sid)
    # Sequential, not gathered: log_slice's own catch-up scan already
    # leaves the index fully up to date, so this second call is a cache
    # hit with no further Redis round trips -- gathering them would just
    # race two catch-up scans against the same key for no benefit.
    rows = await log_index.log_slice(redis, docker_host, name, start, count)
    total = await log_index.total(redis, docker_host, name)
    return total, rows


async def logs_index_at(redis: Redis, sid: str, t_ms: int) -> int:
    docker_host, name = _log_target(sid)
    return await log_index.index_at(redis, docker_host, name, t_ms)


async def logs_ticks(redis: Redis, sid: str, t0_ms: int, t1_ms: int, px: int) -> list[int]:
    docker_host, name = _log_target(sid)
    return await log_index.ticks(redis, docker_host, name, t0_ms, t1_ms, px)


async def logs_find(redis: Redis, sid: str, query: str, start: int, forward: bool) -> int | None:
    docker_host, name = _log_target(sid)
    return await log_index.find_text(redis, docker_host, name, query, start, forward)
