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

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from redis.asyncio import Redis

from log_sump.common.config import DaemonConfig
from log_sump.common.daemon_registry import (
    list_registered_daemons,
    register_daemon,
    unregister_daemon,
)
from log_sump.common.redis_keys import stream_key
from log_sump.common.schema import SYSTEM_SCOPE_ID, Kind, MetricRecord
from log_sump.server.queries import fetch_kind_page

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
                        "total": 0,
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
