"""Per-container-name rank index for one daemon's shared log stream --
backs `/logs`, `/index_at`, `/logs/find`, and `/sources`' `total` field,
all of which address a log source by an integer rank (page offset, cursor
position, search-result index) the way cttc's pre-log-sump gateway's own
Redis zset (`redis_log.py`'s `cttc:idx:<entity>`) did. log-sump's own
Streams have no such rank concept -- a Stream ID sorts by time, not by an
addressable position -- so this rebuilds one in this plugin process's own
memory, entirely from what's already in the daemon's `:log` stream (no new
Redis structure, nothing that outlives this process).

Keyed by `(docker_host, container_name)`, not `container_id`: cttc's old
entity model kept one continuous history per *name* across container
restarts (a new container id, same name, appends to the same zset) --
matching that means filtering log-sump's per-daemon stream by
`record.container_name`, not `record.container_id`.

Rebuilt incrementally: the first request for a given `(docker_host, name)`
scans that stream from the beginning (bounded by however much history is
actually in Redis -- retention_days, not a row count, so this can be a lot
for a long-lived, chatty container); every later request only scans
what's arrived since the last scan. A log-server restart drops this index
entirely -- the next request just rebuilds it from Streams, the same as
any other cache with Redis as its real source of truth.
"""

from __future__ import annotations

import asyncio
import bisect

from pydantic import ValidationError
from redis.asyncio import Redis

from log_sump.common.redis_keys import stream_key
from log_sump.common.schema import Kind, LogRecord, RecordAdapter

#: XRANGE page size for both the initial full scan and later catch-up
#: scans -- matches log-sump's own `find_text`'s bounded-batch style.
_SCAN_PAGE = 500

_Entry = tuple[str, int, str]  # (stream id, ts_ms, text)

#: One entry list per (docker_host, container_name), oldest-first. A plain
#: module-level dict is safe here: log-server is always exactly one
#: process (spec's four-process constraint), so there's only ever one
#: event loop's worth of state to keep consistent.
_INDEX: dict[tuple[str, str], list[_Entry]] = {}
#: Serializes concurrent catch-up scans for the same key -- without this,
#: two requests racing on the same not-yet-cached container could each
#: append the same batch of newly-seen entries.
_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}


def _decode_log_entry(fields: dict | None) -> LogRecord | None:
    if not fields:
        return None
    data = fields.get(b"data")
    if data is None:
        return None
    try:
        record = RecordAdapter.validate_json(data)
    except ValidationError:
        return None
    return record if isinstance(record, LogRecord) else None


def _decode_id(entry_id: bytes | str) -> str:
    return entry_id.decode() if isinstance(entry_id, bytes) else entry_id


def _id_ms(entry_id: str) -> int:
    return int(entry_id.split("-", 1)[0])


async def _catch_up(redis: Redis, docker_host: str, name: str) -> list[_Entry]:
    key = (docker_host, name)
    lock = _LOCKS.setdefault(key, asyncio.Lock())
    async with lock:
        entries = _INDEX.setdefault(key, [])
        stream = stream_key(docker_host, Kind.LOG)
        lo = f"({entries[-1][0]}" if entries else "-"
        while True:
            page = await redis.xrange(stream, min=lo, max="+", count=_SCAN_PAGE)
            if not page:
                break
            for entry_id, fields in page:
                if entry_id is None:
                    continue
                record = _decode_log_entry(fields)
                if record is not None and record.container_name == name:
                    id_str = _decode_id(entry_id)
                    entries.append((id_str, _id_ms(id_str), record.message))
            last_id = page[-1][0]
            if last_id is None:
                break
            lo = f"({_decode_id(last_id)}"
            if len(page) < _SCAN_PAGE:
                break
        return entries


def forget(docker_host: str, name: str) -> None:
    """Drops one source's cached index -- called when a source is closed
    (`compat.close_source`), so a re-opened source with the same name
    rebuilds clean rather than silently resuming a stale in-memory list.
    """
    key = (docker_host, name)
    _INDEX.pop(key, None)
    _LOCKS.pop(key, None)


async def total(redis: Redis, docker_host: str, name: str) -> int:
    return len(await _catch_up(redis, docker_host, name))


async def log_slice(
    redis: Redis, docker_host: str, name: str, start: int, count: int
) -> list[dict]:
    entries = await _catch_up(redis, docker_host, name)
    start = max(0, start)
    count = max(0, count)
    out = []
    for i, (_id, ts_ms, text) in enumerate(entries[start : start + count]):
        out.append({"i": start + i, "ts": ts_ms, "uid": None, "text": text})
    return out


async def index_at(redis: Redis, docker_host: str, name: str, t_ms: int) -> int:
    """Rank of whichever entry is nearest `t_ms` -- ties go to the entry
    *after* `t_ms`, matching the old gateway's own `rank_at_score` (its
    `min()` over `[after_candidate, before_candidate]` picks the first
    on a tie, and `after` is listed first there). `-1` on an empty log,
    matching that same code's documented empty-log behavior.
    """
    entries = await _catch_up(redis, docker_host, name)
    if not entries:
        return -1
    ts_list = [ts for _id, ts, _text in entries]
    pos = bisect.bisect_left(ts_list, t_ms)
    if pos == 0:
        return 0
    if pos == len(ts_list):
        return len(ts_list) - 1
    before_dt = abs(ts_list[pos - 1] - t_ms)
    after_dt = abs(ts_list[pos] - t_ms)
    return pos if after_dt <= before_dt else pos - 1


async def ticks(
    redis: Redis, docker_host: str, name: str, t0_ms: int, t1_ms: int, px: int
) -> list[int]:
    entries = await _catch_up(redis, docker_host, name)
    px = max(1, px)
    dt_ms = max(1.0, (t1_ms - t0_ms) / px)
    counts = [0] * px
    for _id, ts_ms, _text in entries:
        if t0_ms <= ts_ms <= t1_ms:
            bucket = int((ts_ms - t0_ms) / dt_ms)
            if 0 <= bucket < px:
                counts[bucket] += 1
    return counts


async def find_text(
    redis: Redis, docker_host: str, name: str, query: str, start: int, forward: bool
) -> int | None:
    """Case-insensitive substring search with wraparound -- same two-
    segment scan order as the old gateway's own `find_text` (see that
    function's docstring in `app/server/redis_log.py`): forward scans
    `[start, end]` then `[0, start)`; backward scans `[start, 0]` then
    `(start, end]`, both directions inclusive of `start` itself (the
    caller is what offsets `start` by ±1 from its current cursor).
    """
    q = query.strip().lower()
    if not q:
        return None
    entries = await _catch_up(redis, docker_host, name)
    n = len(entries)
    if n == 0:
        return None
    start = max(0, min(start, n - 1))

    def matches(i: int) -> bool:
        return q in entries[i][2].lower()

    if forward:
        for i in range(start, n):
            if matches(i):
                return i
        for i in range(0, start):
            if matches(i):
                return i
    else:
        for i in range(start, -1, -1):
            if matches(i):
                return i
        for i in range(n - 1, start, -1):
            if matches(i):
                return i
    return None
