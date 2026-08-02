#!/usr/bin/env python3
"""CTTC timeline server (FastAPI / asyncio edition).

Ingests container telemetry (docker stats JSONL / JSON array) and service log
files (docker logs -t, JSONL, plain text), normalizes every record to
{uid, ts, text, fields}, optionally passes log records through user-written
transform modules, and serves time-bucketed series + indexed log rows over a
local HTTP API with SSE change notifications for live-tailed files.

Run:  uv run server.py [--port 0] [--transforms-dir transforms] [file ...]
Prints one JSON line {"port": N} on stdout once listening.

Docker connectivity uses the `docker` SDK (docker-py) for request/response
calls (listing containers/services, one-shot stats snapshots) -- structured
objects instead of hand-parsed CLI JSON lines. Long-lived streams (following
container/service logs, sampling a remote host's /proc over ssh) use asyncio
subprocesses instead: docker-py's log-follow is a blocking generator with no
clean way to abort it from another thread/coroutine, whereas an asyncio
subprocess can simply be terminated -- the right tool depends on the shape
of the operation, not a blanket rule.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import io
import logging
import os
import re
import shlex
import sys
import time
import zipfile
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timezone
from pathlib import Path
from typing import Literal

import docker
import orjson
import paramiko
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

import files  # local sibling module (server/files.py) -- upload/download endpoints
import redis_log
from cttc_format import RECORD_EXT, is_cttc_archive
from events import Action, EventManager, InvalidEvent, LogCondition, MetricCondition, UnknownEvent
from recording_session import RecordingSessionManager, UnknownSession
from redis_log import RedisLog
from rolling_buffer import RollingBufferManager, UnknownBuffer
from scheduler import InvalidSchedule, Scheduler, UnknownSchedule

logger = logging.getLogger("cttc")


def jloads(s):
    return orjson.loads(s)


def jdumps(obj) -> bytes:
    return orjson.dumps(obj)


JSON_IMPL = "orjson"


# ── timestamp / size parsing ─────────────────────────────────────────────────

ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})"
    r"(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?"
)

NAIVE_TZ = UTC  # overridden by --naive-tz local


def parse_ts(text: str) -> float | None:
    """ISO-ish timestamp -> epoch ms. Handles docker's 9-digit nanoseconds."""
    m = ISO_RE.match(text.strip())
    if not m:
        return None
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    frac = m.group(7)
    us = int(frac.ljust(6, "0")[:6]) if frac else 0
    off = m.group(8)
    if off is None:
        tz = NAIVE_TZ
    elif off in ("Z", "z"):
        tz = UTC
    else:
        sign = 1 if off[0] == "+" else -1
        hh, mm = int(off[1:3]), int(off[-2:])
        tz = timezone(
            sign
            * (
                datetime.min.resolution * 0
                or __import__("datetime").timedelta(hours=hh, minutes=mm)
            )
        )
    try:
        dt = datetime(y, mo, d, h, mi, s, us, tz)
    except ValueError:
        return None
    return dt.timestamp() * 1000.0


SIZE_RE = re.compile(r"([\d.]+)\s*([kKMGTP]?)(i?)B?")
SIZE_MULT = {"": 1, "k": 1e3, "m": 1e6, "g": 1e9, "t": 1e12, "p": 1e15}


def parse_size(text: str) -> float | None:
    """'512MiB' / '1.2kB' -> bytes."""
    m = SIZE_RE.match(text.strip())
    if not m:
        return None
    val = float(m.group(1))
    unit = m.group(2).lower()
    base = 1024 if m.group(3) else 1000
    if base == 1024:
        exp = {"": 0, "k": 1, "m": 2, "g": 3, "t": 4, "p": 5}[unit]
        return val * (1024**exp)
    return val * SIZE_MULT[unit]


def parse_pct(text: str) -> float | None:
    try:
        return float(text.rstrip("%"))
    except ValueError, AttributeError:
        return None


# ── transforms ───────────────────────────────────────────────────────────────


class TransformRegistry:
    """User modules in --transforms-dir. Each exposes transform(record) ->
    dict | list[dict] | None (None drops the record). Reloaded on every /open
    so edits apply without restarting the app."""

    def __init__(self, directory: Path):
        self.directory = directory

    def available(self) -> list[dict]:
        out = []
        if not self.directory.is_dir():
            return out
        for p in sorted(self.directory.glob("*.py")):
            if p.name.startswith("_"):
                continue
            doc = ""
            try:
                for line in p.read_text(errors="replace").splitlines():
                    line = line.strip()
                    if line.startswith(('"""', "'''", "#")):
                        doc = line.strip("\"'# ")
                        break
                    if line:
                        break
            except OSError as e:
                logger.debug("could not read transform doc from %s: %s", p, e)
            out.append({"name": p.stem, "doc": doc})
        return out

    def load(self, names: list[str]):
        fns = []
        for name in names:
            path = self.directory / f"{name}.py"
            if not path.is_file():
                raise ValueError(f"transform not found: {name}")
            spec = importlib.util.spec_from_file_location(f"cttc_transform_{name}", path)
            if spec is None or spec.loader is None:
                raise ValueError(f"transform not found: {name}")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            if not callable(getattr(mod, "transform", None)):
                raise ValueError(f"transform module {name} has no transform() function")
            fns.append((name, mod.transform))
        return fns


def apply_transforms(record: dict, fns) -> list[dict]:
    records = [record]
    for name, fn in fns:
        nxt = []
        for r in records:
            try:
                out = fn(r)
            except Exception as e:  # a broken user module must not kill ingest
                r.setdefault("fields", {})["_transform_error"] = f"{name}: {e}"
                nxt.append(r)
                continue
            if out is None:
                continue
            nxt.extend(out if isinstance(out, list) else [out])
        records = nxt
    return records


# ── sources ──────────────────────────────────────────────────────────────────


def make_uid(source: str, line_no: int, raw: str) -> str:
    return hashlib.sha1(f"{source}\x00{line_no}\x00{raw}".encode(errors="replace")).hexdigest()[:16]


def _entity_id(name: str, host: str | None) -> str:
    """The Redis entity id for one source's data (br-DEDUP-006): host-
    qualified for any remote docker target, so the same container/service
    name collected from two different hosts never collides into the same
    cttc:log:<id>/cttc:idx:<id> and silently interleaves their history --
    the scenario redis_log.py's own module docstring already claimed was
    handled, but never actually was for anything except host telemetry
    (HostStatsSource's `host@<hostname>` naming, which this mirrors). Bare
    for a local target (today's existing on-disk data, unambiguous since
    there's only one local machine) or anything with no host concept at
    all (static/demo file replay, imported .cttc samples) -- `name` itself
    is what every caller still uses for display/grouping (API responses,
    exported sample files); only the Redis key changes here.

    A `name` that already contains "@" is left untouched: HostStatsSource
    builds its own already-unique `host@<hostname>` name up front (used as
    both its display name *and* the single entity id it ever passes
    through StatsSource.ingest_row), so qualifying it again here would
    double up into `host@<hostname>@<hostname>`. "@" can't appear in a
    real docker container/service name, so this is an unambiguous signal,
    not a heuristic."""
    if not host or "@" in name:
        return name
    hostname = host.split("@")[-1]
    return f"{name}@{hostname}"


DOCKER_SVCLOG_PREFIX = re.compile(r"^(\S+\.\d+\.\S+@\S+|\S+)\s+\|\s?")
TS_FIELDS = ("timestamp", "ts", "time", "@timestamp", "datetime", "date")


class LogSource:
    kind: Literal["log"] = "log"

    def __init__(self, sid: str, name: str, path: Path | None, live: bool, transforms):
        self.id = sid
        self.name = name
        self.path = path
        self.live = live
        self.transforms = transforms
        self.seq = 0
        self.line_no = 0
        self.offset = 0
        self.skipped = 0
        self._pending_partial = b""
        # single most-recent row, kept only for ingest_chunk's continuation-
        # line-append heuristic below (Redis is the store now -- see
        # redis_log.py's module docstring)
        self._last_row: tuple[float, int, str, str] | None = None
        # set once by State.open_file/collect_docker right after
        # construction -- declared here (rather than left purely dynamic)
        # so static analysis knows every Source has it by the time any of
        # the read methods below run.
        self._state: State | None = None

    def stop(self):
        pass  # static/file-tailed sources have nothing to tear down

    def ingest_chunk(self, data: bytes):
        data = self._pending_partial + data
        lines = data.split(b"\n")
        self._pending_partial = lines.pop()  # incomplete trailing line, if any
        new = []
        redis_log = getattr(getattr(self, "_state", None), "redis_log", None)
        entity = _entity_id(self.name, getattr(self, "host", None))
        for bline in lines:
            self.line_no += 1
            raw = bline.decode("utf-8", errors="replace").rstrip("\r")
            if not raw.strip():
                continue
            rec = self._parse_line(raw)
            if rec is None:  # continuation line -> append to previous entry
                if new:
                    ts, seq, uid, text = new[-1]
                    new[-1] = (ts, seq, uid, text + "\n" + raw)
                    continue
                if self._last_row is not None:
                    ts, seq, uid, text = self._last_row
                    text = text + "\n" + raw
                    self._last_row = (ts, seq, uid, text)
                    if redis_log is not None:
                        # re-record under the SAME ts field -- HSET on an
                        # existing field overwrites naturally, no new
                        # redis_log method needed
                        redis_log.record(entity, ts, {"uid": uid, "text": text})
                    continue
                self.skipped += 1
                continue
            for out in apply_transforms(rec, self.transforms):
                ts = out.get("ts")
                if ts is None:
                    self.skipped += 1
                    continue
                uid = out.get("uid") or make_uid(self.name, self.line_no, raw)
                new.append((float(ts), self._next_seq(), uid, str(out.get("text", raw))))
        if new:
            self._last_row = new[-1]
            if redis_log is not None:
                for ts, _seq, uid, text in new:
                    redis_log.record(entity, ts, {"uid": uid, "text": text})
        return len(new)

    def _next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def _parse_line(self, raw: str) -> dict | None:
        """-> record dict, or None when the line has no timestamp of its own."""
        text = raw
        ts = None
        fields = {}
        # docker logs -t / docker service logs -t: leading RFC3339 timestamp
        sp = raw.split(" ", 1)
        ts = parse_ts(sp[0])
        if ts is not None:
            text = sp[1] if len(sp) > 1 else ""
            text = DOCKER_SVCLOG_PREFIX.sub("", text, count=1)
        body = text.lstrip()
        if body.startswith("{") and body.endswith("}"):
            try:
                fields = jloads(body)
            except Exception as e:
                logger.debug("log line looked like json but didn't parse: %s", e)
                fields = {}
            if isinstance(fields, dict) and ts is None:
                for f in TS_FIELDS:
                    v = fields.get(f)
                    if isinstance(v, str):
                        ts = parse_ts(v)
                    elif isinstance(v, (int, float)):
                        ts = float(v) * (1000.0 if v < 1e12 else 1.0)
                    if ts is not None:
                        break
        if ts is None:
            return None
        return {
            "ts": ts,
            "text": text,
            "fields": fields if isinstance(fields, dict) else {},
            "source": self.name,
        }

    @property
    def _redis(self) -> RedisLog:
        """`self._state` is only Optional to cover the brief window between
        construction and State.open_file/collect_docker attaching it
        (declared that way so static analysis catches an actually-missing
        assignment) -- every one of these read methods is only ever called
        once a source is registered on a State, so it's always set by then.
        Centralizes that invariant in one assert instead of repeating it
        (and the None-narrowing it gives the type checker) six times."""
        assert self._state is not None, (
            f"{self.name}: read before this source was attached to a State"
        )
        return self._state.redis_log

    @property
    def _entity(self) -> str:
        """The Redis entity id every read/write below actually keys on --
        `self.name` host-qualified when this source has one (see
        _entity_id/br-DEDUP-006). Distinct from `self.name` itself, which
        stays the bare display/grouping name everywhere else (API
        responses, exported sample files)."""
        return _entity_id(self.name, getattr(self, "host", None))

    # API helpers -- all Redis-backed now (see redis_log.py's module
    # docstring): Redis is the sole source of truth for reads, Source
    # objects keep no RAM copy of their own.
    async def total(self) -> int:
        return await self._redis.total(self._entity)

    async def slice(self, start: int, count: int):
        start = max(0, start)
        rows = await self._redis.slice_by_rank(self._entity, start, count)
        return [
            {"i": start + i, "ts": ts, "uid": payload.get("uid"), "text": payload.get("text", "")}
            for i, (ts, payload) in enumerate(rows)
        ]

    async def index_at(self, t: float) -> int:
        # -1 on an empty log, matching bisect_left's old behavior on []
        # (len(rows) - 1 == -1) -- preserved so callers don't need to
        # special-case "no rows yet" differently from before.
        rank = await self._redis.rank_at_score(self._entity, t)
        return -1 if rank is None else rank

    async def ticks(self, t0: float, t1: float, px: int):
        """Event-density strip: count of entries per pixel bucket."""
        px = max(1, px)
        dt = max(1.0, (t1 - t0) / px)
        counts = [0] * px
        timestamps = await self._redis.range_by_score(self._entity, t0, t1 + 1)
        for ts in timestamps:
            b = int((ts - t0) / dt)
            if 0 <= b < px:
                counts[b] += 1
        return counts

    async def range(self):
        return await self._redis.first_last(self._entity)

    async def find(self, query: str, start: int, forward: bool = True) -> int | None:
        """Case-insensitive substring search, wrapping around the whole log."""
        return await self._redis.find_text(self._entity, query, start, forward)


class StatsSource:
    """docker stats snapshots; grouped per service (Name before first dot),
    max-merged across container instances."""

    kind: Literal["stats"] = "stats"
    is_host = False  # host-level telemetry renders in its own strip group

    def __init__(self, sid: str, name: str, path: Path | None, live: bool):
        self.id = sid
        self.name = name
        self.path = path
        self.live = live
        self.offset = 0
        self.skipped = 0
        self.count = 0
        self._pending_partial = b""
        # service names seen by this Source instance -- Redis entities are
        # keyed by service name and there's no RAM series dict to enumerate
        # them from anymore (Redis is the store, see redis_log.py)
        self._services: set[str] = set()
        # services whose samples came from dotted instance names (swarm tasks)
        self._swarm: set[str] = set()
        # per container instance: last (ts, net_total) for rate calc
        self._net_prev: dict[str, tuple] = {}
        # set once by State.open_file/collect_docker right after
        # construction -- see LogSource.__init__'s matching field.
        self._state: State | None = None
        # only DockerStatsSource/HostStatsSource (below) actually poll and
        # set this to a real value; declared here so _update_poll_interval
        # can narrow on `isinstance(src, StatsSource)` instead of a bare
        # getattr with no static type behind it.
        self.interval: float | None = None

    def stop(self):
        pass  # static/file-tailed sources have nothing to tear down

    def ingest_chunk(self, data: bytes):
        """Replay path: parses `docker stats --format json` (or the
        jsonify-stats whole-array variant) text -- used for static/demo
        files opened via /open, not by the live docker-py collectors below
        (see DockerStatsSource, which appends pre-computed rows directly)."""
        data = self._pending_partial + data
        text = data.decode("utf-8", errors="replace")
        stripped = text.lstrip()
        if stripped.startswith("["):  # whole-file JSON array (jsonify-stats output)
            try:
                entries = jloads(stripped)
            except Exception as e:
                logger.debug("whole-array json didn't parse yet, treating as incomplete: %s", e)
                self._pending_partial = data
                return 0
            self._pending_partial = b""
            n = 0
            for e in entries:
                n += self._ingest_entry(e)
            return n
        lines = data.split(b"\n")
        self._pending_partial = lines.pop()
        n = 0
        for bline in lines:
            if not bline.strip():
                continue
            try:
                e = jloads(bline)
            except Exception as ex:
                logger.debug("skipping unparseable log line: %s", ex)
                self.skipped += 1
                continue
            n += self._ingest_entry(e)
        return n

    def _ingest_entry(self, e) -> int:
        if not isinstance(e, dict):
            self.skipped += 1
            return 0
        name = e.get("Name") or ""
        if not name or name == "--":
            self.skipped += 1
            return 0
        ts = None
        for f in TS_FIELDS:
            if isinstance(e.get(f), str):
                ts = parse_ts(e[f])
                if ts is not None:
                    break
        if ts is None:
            self.skipped += 1
            return 0
        cpu = parse_pct(e.get("CPUPerc", ""))
        mem = parse_pct(e.get("MemPerc", ""))
        mem_bytes = None
        if isinstance(e.get("MemUsage"), str):
            mem_bytes = parse_size(e["MemUsage"].split("/")[0])
        net_total = None
        netio = e.get("NetIO")
        if isinstance(netio, str) and "/" in netio:
            rx_s, tx_s = netio.split("/", 1)
            rx, tx = parse_size(rx_s), parse_size(tx_s)
            if rx is not None and tx is not None:
                net_total = rx + tx
        rate = self._net_rate(name, ts, net_total)
        self.ingest_row(name, ts, cpu, mem, mem_bytes, rate)
        return 1

    def ingest_row(
        self,
        name: str,
        ts: float,
        cpu: float | None,
        mem: float | None,
        mem_bytes: float | None,
        rate: float | None,
    ):
        """Shared low-level append, used by both the CLI-JSON replay path
        above and the live docker-py collectors (DockerStatsSource), which
        compute cpu/mem/rate from a completely different (raw API) shape but
        land in the same per-service Redis entity (max-merged across
        container instances at query time -- see bucketed())."""
        service = name.split(".")[0]
        if service != name:
            self._swarm.add(service)
        self._services.add(service)
        self.count += 1
        redis_log = getattr(getattr(self, "_state", None), "redis_log", None)
        if redis_log is not None:
            redis_log.record(
                self._entity_for(service), ts, {"cpu": cpu, "mem": mem, "mem_bytes": mem_bytes, "net": rate}
            )

    def _net_rate(self, container: str, ts: float, net_total: float | None) -> float | None:
        if net_total is None:
            return None
        prev = self._net_prev.get(container)
        self._net_prev[container] = (ts, net_total)
        if prev is None or ts <= prev[0]:
            return None
        d = net_total - prev[1]
        if d < 0:  # counter reset (container restart)
            return None
        return d / ((ts - prev[0]) / 1000.0)

    @property
    def _redis(self) -> RedisLog:
        """See LogSource._redis's matching docstring -- same invariant,
        same reasoning."""
        assert self._state is not None, (
            f"{self.name}: read before this source was attached to a State"
        )
        return self._state.redis_log

    def _entity_for(self, svc: str) -> str:
        """The Redis entity id one service's read/write actually keys on --
        `svc` host-qualified when this source has one (see
        _entity_id/br-DEDUP-006). `svc` itself (bare) stays what every
        caller uses for display/grouping (API responses, exported sample
        files) -- it's also the dict key both bucketed()/point_at() already
        return their per-service results under, so a caller reading two
        different sources' same-named service still tells them apart via
        each response entry's own "sid", exactly as it does today."""
        return _entity_id(svc, getattr(self, "host", None))

    def services(self):
        return sorted(self._services)

    async def range(self):
        """Redis-backed: first/last across every service, gathered
        concurrently rather than N serial round trips."""
        if not self._services:
            return None
        results = await asyncio.gather(
            *(self._redis.first_last(self._entity_for(svc)) for svc in self._services)
        )
        lo = hi = None
        for r in results:
            if r is None:
                continue
            lo = r[0] if lo is None else min(lo, r[0])
            hi = r[1] if hi is None else max(hi, r[1])
        return None if lo is None else (lo, hi)

    async def bucketed(self, t0: float, t1: float, px: int):
        """Per service, per pixel bucket: max cpu%, max mem%, max net B/s."""
        px = max(1, px)
        dt = max(1.0, (t1 - t0) / px)
        services = sorted(self._services)
        rows_per_service = await asyncio.gather(
            *(self._redis.range_by_score_with_payload(self._entity_for(svc), t0, t1 + 1) for svc in services)
        )
        out = []
        for svc, rows in zip(services, rows_per_service):
            cpu = [None] * px
            mem = [None] * px
            net = [None] * px
            for ts, payload in rows:
                b = int((ts - t0) / dt)
                if not (0 <= b < px):
                    continue
                c, m, r = payload.get("cpu"), payload.get("mem"), payload.get("net")
                if c is not None and (cpu[b] is None or c > cpu[b]):
                    cpu[b] = c
                if m is not None and (mem[b] is None or m > mem[b]):
                    mem[b] = m
                if r is not None and (net[b] is None or r > net[b]):
                    net[b] = r
            out.append(
                {
                    "name": svc,
                    "cpu": cpu,
                    "mem": mem,
                    "net": net,
                    "host": self.is_host,
                    "sid": self.id,
                    "ttype": "service" if svc in self._swarm else "container",
                }
            )
        return out

    async def point_at(self, t: float):
        """Per service, the single sample nearest time t — used to compare an
        arbitrary point (e.g. a loaded sample) against another point (e.g.
        live 'now') regardless of the current chart zoom window."""
        services = sorted(self._services)
        results = await asyncio.gather(*(self._redis.nearest(self._entity_for(svc), t) for svc in services))
        out = {}
        for svc, best in zip(services, results):
            if best is None:
                continue
            ts, payload = best
            out[svc] = {
                "ts": ts,
                "cpu": payload.get("cpu"),
                "mem": payload.get("mem"),
                "mem_bytes": payload.get("mem_bytes"),
                "net": payload.get("net"),
                "host": self.is_host,
            }
        return out


Source = LogSource | StatsSource  # everything State.sources can hold


# ── docker connectivity (docker-py + asyncio subprocess) ─────────────────────

_HOST_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")


def _validate_ssh_port(host: str) -> None:
    """br-CONN-005: _parse_ssh_target/ssh_host_and_port both split a trailing
    `:port` off an `ssh://[user@]host[:port]` target and hand it onward
    assuming it's already a valid number -- _parse_ssh_target's `int(port_s)`
    in particular raises a raw `ValueError` (Python's own "invalid literal
    for int()..." message) for anything else, and only once something is
    already mid ssh-connect (inside a background poll loop, where it ends up
    as an opaque `self.error` string, or wrapped into a 502 DockerPsError by
    docker_ps) instead of as a clean upfront error. Every caller reaches
    _parse_ssh_target/ssh_host_and_port via a host that already passed
    through normalize_docker_host (see its own docstring's br-CONN-002
    note), so validating the port here rejects a bad one immediately."""
    rest = host[len("ssh://") :]
    userhost = rest.rsplit("@", 1)[-1]
    if ":" not in userhost:
        return
    _, port_s = userhost.rsplit(":", 1)
    if not port_s.isdigit() or not (0 < int(port_s) < 65536):
        raise ValueError(f"invalid ssh port {port_s!r} in {host!r} -- must be 1-65535")


def normalize_docker_host(host: str | None) -> str | None:
    """ssh is the only remote transport CTTC supports, so a host string with
    no scheme (e.g. "user@other-server") is unambiguous shorthand for
    ssh://user@other-server. The client already normalizes this (see
    normalizeDockerHost in app.js); this is defense in depth for any other
    caller of the HTTP API.

    br-CONN-002: any *other* explicit scheme (`tcp://`, `http://`, ...) is
    rejected outright here instead of being passed through untouched.
    Every caller downstream (docker_ps, and every DockerStatsSource/
    DockerLogSource collect_docker() ever constructs) eventually reaches
    _parse_ssh_target/ssh_host_and_port, which strip a literal `"ssh://"`
    prefix unconditionally via `host[len("ssh://"):]` -- since every scheme
    prefix here happens to also be exactly 6 characters, that silently
    chopped off the wrong 6 and fed the remainder to ssh as a garbage
    host[:port] (e.g. `tcp://1.2.3.4:2375` -> ssh to host `1.2.3.4` port
    `2375`) instead of ever surfacing a clean "unsupported transport"
    error."""
    if not host:
        return None
    if _HOST_SCHEME_RE.match(host) and not host.startswith("ssh://"):
        scheme = host.split("://", 1)[0]
        raise ValueError(
            f"unsupported docker host transport {scheme!r} -- only ssh:// "
            "(or a bare user@host, treated as ssh://user@host) is supported"
        )
    host = host if _HOST_SCHEME_RE.match(host) else f"ssh://{host}"
    _validate_ssh_port(host)
    return host


def docker_client(host: str | None = None) -> docker.DockerClient:
    """Local daemon only -- a remote ssh:// source goes through
    _connect_ssh()/_exec_remote_docker() instead (see their docstrings for
    why): docker-py's own use_ssh_client transport (and the docker CLI's
    -H ssh://... equivalent) has no way to run the remote docker command as
    `sudo`, which many hosts require since the account CTTC connects as often
    isn't in that host's docker group. Kept as its own function (rather than
    inlining docker.from_env() at each call site) purely so tests can
    substitute a fake client the way they always have."""
    return docker.from_env(timeout=15)


def ssh_host_and_port(host: str) -> tuple[list[str], str]:
    """ssh://user@host[:port] -> (["-p", port] or [], "user@host")."""
    rest = host[len("ssh://") :]
    extra = []
    if ":" in rest.rsplit("@", 1)[-1]:
        rest, port = rest.rsplit(":", 1)
        extra = ["-p", port]
    return extra, rest


def _parse_ssh_target(host: str) -> tuple[str, str | None, int]:
    """ssh://[user@]hostname[:port] -> (hostname, username_or_None, port)."""
    rest = host[len("ssh://") :]
    user = None
    if "@" in rest:
        user, rest = rest.split("@", 1)
    port = 22
    if ":" in rest:
        rest, port_s = rest.rsplit(":", 1)
        port = int(port_s)
    return rest, user, port


def _connect_ssh(host: str, ssh_key: str | None) -> paramiko.SSHClient:
    """Opens a paramiko connection to an ssh:// Docker/telemetry host.
    AutoAddPolicy matches the same TOFU trust model the rest of the app uses
    (StrictHostKeyChecking=accept-new -- see Dockerfile); this container's
    filesystem is ephemeral, so there's no persistent known_hosts to violate
    across restarts either way. With no ssh_key given, falls back to
    paramiko's own default identity discovery (~/.ssh/id_rsa, id_ed25519,
    etc. + any running ssh-agent) -- ~/.ssh/id_rsa is populated at gateway
    deploy time for the *gateway's own* host (see docker-compose.yml's
    CTTC_ID_RSA mount / app/lib/server-provision.js), which is exactly what a
    source with no key of its own should try."""
    hostname, username, port = _parse_ssh_target(host)
    identity = ssh_key or "ssh-agent/default identity discovery"
    logger.info(
        "ssh: connecting to %s@%s:%d (key: %s)",
        username or "<default user>",
        hostname,
        port,
        identity,
    )
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs: dict = {
        "hostname": hostname,
        "port": port,
        "timeout": 10,
        "banner_timeout": 10,
        "auth_timeout": 10,
    }
    if username:
        kwargs["username"] = username
    if ssh_key:
        kwargs["key_filename"] = ssh_key
    t0 = time.monotonic()
    try:
        client.connect(**kwargs)
    except Exception as e:
        logger.warning(
            "ssh: connect to %s:%d failed after %.1fms: %s: %s",
            hostname,
            port,
            (time.monotonic() - t0) * 1000,
            type(e).__name__,
            e,
        )
        raise
    transport = client.get_transport()
    logger.info(
        "ssh: connected to %s:%d in %.1fms (server: %s, cipher: %s)",
        hostname,
        port,
        (time.monotonic() - t0) * 1000,
        transport.remote_version if transport else "?",
        transport.local_cipher if transport else "?",
    )
    return client


def _exec_remote_docker(
    client: paramiko.SSHClient, args: list[str], timeout: float
) -> tuple[str, str, int]:
    """Runs `sudo docker <args>` over an already-open ssh connection and
    returns (stdout, stderr, returncode). Always blocking (paramiko has no
    asyncio support) -- callers must run this via asyncio.to_thread. sudo is
    the whole reason this exists as a separate path from docker-py/the
    docker CLI's own -H ssh://... transport: reaching a *third* machine this
    way is exactly the case where the account CTTC connects as often isn't
    in that host's docker group, and -H ssh://... has no way to inject sudo
    before the remote `docker system dial-stdio` it runs -- so this shells
    out the equivalent of `ssh user@host sudo docker <args>` explicitly."""
    cmd = "sudo docker " + " ".join(shlex.quote(a) for a in args)
    t0 = time.monotonic()
    logger.debug("ssh: exec `%s` (timeout=%.1fs)", cmd, timeout)
    _stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace").strip()
    rc = stdout.channel.recv_exit_status()
    elapsed_ms = (time.monotonic() - t0) * 1000
    if rc == 0:
        logger.debug("ssh: `%s` -> exit 0 in %.1fms (%d bytes stdout)", cmd, elapsed_ms, len(out))
    else:
        logger.info("ssh: `%s` -> exit %d in %.1fms: %s", cmd, rc, elapsed_ms, err or "(no stderr)")
    return out, err, rc


_DOCKER_SIZE_UNITS = {
    "": 1,
    "b": 1,
    "kb": 1000,
    "mb": 1000**2,
    "gb": 1000**3,
    "tb": 1000**4,
    "kib": 1024,
    "mib": 1024**2,
    "gib": 1024**3,
    "tib": 1024**4,
}
_SIZE_RE = re.compile(r"^([\d.]+)\s*([a-zA-Z]*)$")


def _parse_docker_size(s: str) -> float:
    """ "12.3MiB" / "648B" / "1.9GB" -> bytes. The only place these human-
    formatted units come from is `docker stats`' own MemUsage/NetIO columns
    (binary KiB/MiB/GiB for memory, decimal kB/MB/GB for network -- matching
    Docker's own units.BytesSize/units.HumanSize) -- used for a remote
    ssh:// source's stats, where docker-py's structured raw stats API isn't
    reachable without the -H ssh://... transport this module deliberately
    avoids (see _exec_remote_docker)."""
    m = _SIZE_RE.match(s.strip())
    if not m:
        return 0.0
    val, unit = m.groups()
    return float(val) * _DOCKER_SIZE_UNITS.get(unit.lower(), 1)


def list_ssh_keys() -> list[str]:
    """Filenames (not full paths) of private keys under ~/.ssh (files whose
    header says so). Only the basename is returned -- the full path would
    disclose the gateway operator's home directory/username to any client
    that can reach this route (br-NET-005), and nothing needs it back:
    `ssh_key` request params are never resolved through this list (see
    docs/architecture/remote-connectivity-call-trace.md)."""
    keys = []
    d = Path.home() / ".ssh"
    if d.is_dir():
        for p in sorted(d.iterdir()):
            if not p.is_file() or p.suffix == ".pub":
                continue
            try:
                with open(p, "rb") as f:
                    head = f.read(80)
            except OSError as e:
                logger.debug("could not read %s while listing ssh keys: %s", p, e)
                continue
            if b"PRIVATE KEY" in head:
                keys.append(p.name)
    return keys


class DockerPsError(RuntimeError):
    """Like RuntimeError, but carries the activity log gathered so far -- so
    a failed docker/ps call still shows the client *what was attempted*
    (exact commands, exit codes, stderr) instead of just an error string."""

    def __init__(self, message: str, log: list):
        super().__init__(message)
        self.log = log


DOCKER_PS_TIMEOUT = 30  # seconds; a module constant so tests can shrink it


async def _run_docker_cli(desc: str, args: list[str], log: list, timeout: float) -> str:
    """Run a `docker ...` CLI invocation as a real asyncio subprocess (not
    docker-py's use_ssh_client transport): docker-py's SSH socket wraps a
    blocking `proc.stdout.read()` that ignores the timeout it's given (see
    docker/transport/sshconn.py's SSHSocket.recv) -- a hung ssh connection
    (bad host, network partition, unexpected prompt) then blocks forever in
    a worker thread that can never actually be cancelled. An asyncio
    subprocess can be genuinely killed on timeout instead of leaking."""
    t0 = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        log.append(
            {
                "cmd": desc,
                "returncode": 1,
                "ms": round((time.monotonic() - t0) * 1000),
                "stderr": f"timed out after {timeout:.0f}s (host unreachable, or hung waiting on an ssh prompt)",
            }
        )
        raise DockerPsError(f"{desc} timed out after {timeout:.0f}s", log)
    ms = round((time.monotonic() - t0) * 1000)
    err = stderr.decode(errors="replace").strip()
    log.append({"cmd": desc, "returncode": proc.returncode, "ms": ms, "stderr": err})
    if proc.returncode != 0:
        raise DockerPsError(err or f"{desc} failed", log)
    return stdout.decode(errors="replace")


async def _find_own_container() -> tuple[str, str] | None:
    """(id, name) of the gateway's own running container -- the one whose
    image basename is "cttc-gateway" (see docker-compose.yml), same
    filtering logic docker_ps() already uses to hide it from the
    monitorable-target list. None if this server isn't running
    containerized at all (the embedded/bare-process fallback -- see
    main.js), or docker itself isn't reachable."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "ps",
            "--format",
            "{{json .}}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=10.0)
    except TimeoutError, OSError:
        return None
    for line in out.decode(errors="replace").splitlines():
        if not line.strip():
            continue
        row = jloads(line)
        if row["Image"].split(":")[0].rsplit("/", 1)[-1] == "cttc-gateway":
            return row["ID"], row["Names"]
    return None


async def gather_own_container_logs(timeout: float = 15.0) -> tuple[str, bytes]:
    """(name, log bytes) for `docker logs` on the gateway's own container --
    "Ship Logs" (Settings > Collect CTTC Own Logs) bundles this alongside
    the client's own .cttc-log files. Falls back to an explanatory message
    (not an error) when there's no own container to find."""
    found = await _find_own_container()
    if found is None:
        return (
            "gateway",
            b"could not find this gateway's own container "
            b"(docker ps found nothing running the cttc-gateway image -- "
            b"this server may not be running containerized)\n",
        )
    container_id, name = found
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "logs",
            container_id,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except (TimeoutError, OSError) as e:
        out = f"could not gather gateway logs: {e}".encode()
    return name, out


async def docker_ps(host: str | None, ssh_key: str | None = None) -> dict:
    """List containers (and swarm services, when the daemon is a manager).
    Local daemon: plain `docker <args>` as an asyncio subprocess. A remote
    ssh:// host: `ssh user@host sudo docker <args>` over paramiko instead --
    see _exec_remote_docker's docstring for why sudo."""
    host = normalize_docker_host(host)
    where = host or "local"
    logger.info("docker_ps: host=%s", where)
    log: list = []
    t_left = DOCKER_PS_TIMEOUT
    client = None
    if host:
        try:
            client = await asyncio.to_thread(_connect_ssh, host, ssh_key)
        except Exception as e:
            raise DockerPsError(f"could not ssh to {host}: {e}", log)

    async def run(desc, args):
        nonlocal t_left
        t0 = time.monotonic()
        try:
            if client is None:
                return await _run_docker_cli(desc, ["docker", *args], log, max(0.01, t_left))
            out, err, rc = await asyncio.to_thread(
                _exec_remote_docker, client, args, max(0.01, t_left)
            )
            log.append(
                {
                    "cmd": desc,
                    "returncode": rc,
                    "ms": round((time.monotonic() - t0) * 1000),
                    "stderr": err,
                }
            )
            if rc != 0:
                raise DockerPsError(err or f"{desc} failed", log)
            return out
        finally:
            t_left -= time.monotonic() - t0

    try:
        try:
            await run(f"docker version @ {where}", ["version", "--format", "{{.Server.Version}}"])
        except DockerPsError as e:
            raise DockerPsError(
                f"docker is not installed (or not reachable) on {host or 'the local daemon'}: {e}",
                log,
            )

        ps_out = await run(f"docker ps @ {where}", ["ps", "--format", "{{json .}}"])
        ps_rows = [jloads(line) for line in ps_out.splitlines() if line.strip()]
        containers = [
            {"id": r["ID"][:12], "name": r["Names"], "image": r["Image"]}
            for r in ps_rows
            # Only ever hide this on the gateway's own daemon (host=None --
            # server.py's own /var/run/docker.sock, wherever it's actually
            # running: local, remote, or remote-tunnel all resolve here the
            # same way). This container (image "cttc-gateway[:tag]", see
            # docker-compose.yml) is infrastructure CTTC runs itself there,
            # not something to offer up as a monitorable target -- but a
            # remote ssh:// source is by definition a *different* machine
            # (that's the whole point of Set Sources), so a container that
            # merely happens to share that image name/tag there has nothing
            # to do with this gateway and must never be hidden.
            if host or r["Image"].split(":")[0].rsplit("/", 1)[-1] != "cttc-gateway"
        ]

        services = []
        try:
            svc_out = await run(
                f"docker service ls @ {where}", ["service", "ls", "--format", "{{json .}}"]
            )
            services = [
                {"id": (r := jloads(line))["ID"][:12], "name": r["Name"], "replicas": r["Replicas"]}
                for line in svc_out.splitlines()
                if line.strip()
            ]
        except DockerPsError:
            pass  # not a swarm manager -- same tolerance the old `docker service ls` had

        return {"containers": containers, "services": services, "log": log}
    finally:
        if client is not None:
            await asyncio.to_thread(client.close)


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _cpu_mem_net_from_raw(
    raw: dict,
) -> tuple[float | None, float | None, float | None, float | None]:
    """cpu%, mem%, mem_bytes, net_total_bytes from docker-py's raw per-
    container stats() dict (the same counters `docker stats` itself computes
    percentages from -- see Docker's own cli/command/container/stats_helpers.go)."""
    cpu_pct = None
    try:
        cpu_stats, precpu = raw["cpu_stats"], raw["precpu_stats"]
        cpu_delta = cpu_stats["cpu_usage"]["total_usage"] - precpu["cpu_usage"]["total_usage"]
        sys_delta = cpu_stats["system_cpu_usage"] - precpu["system_cpu_usage"]
        online = cpu_stats.get("online_cpus") or len(
            cpu_stats["cpu_usage"].get("percpu_usage") or [1]
        )
        if sys_delta > 0 and cpu_delta >= 0:
            cpu_pct = (cpu_delta / sys_delta) * online * 100.0
    except KeyError, TypeError, ZeroDivisionError:
        pass
    mem_pct = mem_bytes = None
    mem_stats = raw.get("memory_stats") or {}
    usage, limit = mem_stats.get("usage"), mem_stats.get("limit")
    if usage is not None and limit:
        inner = mem_stats.get("stats") or {}
        cache = inner.get("cache", inner.get("inactive_file", 0))
        mem_bytes = usage - cache
        mem_pct = mem_bytes / limit * 100.0
    net_total = None
    networks = raw.get("networks") or {}
    if networks:
        net_total = sum(v.get("rx_bytes", 0) + v.get("tx_bytes", 0) for v in networks.values())
    return cpu_pct, mem_pct, mem_bytes, net_total


class DockerStatsSource(StatsSource):
    """Polls per-container stats snapshots on an interval: docker-py for the
    local daemon, `sudo docker stats --no-stream` over paramiko for a remote
    ssh:// source (see _exec_remote_docker's docstring for why sudo)."""

    def __init__(
        self,
        sid: str,
        name: str,
        host: str | None,
        interval: float,
        state: State,
        ssh_key: str | None = None,
    ):
        super().__init__(sid, name, path=None, live=True)
        self.path = f"docker://{host or 'local'}/stats"
        self.host = host
        self.ssh_key = ssh_key
        # narrows the base class's Optional declarations for the rest of
        # this class's own methods -- DockerStatsSource always polls, so
        # both are unconditionally real from construction on.
        self.interval: float = interval
        self._state: State = state
        self.error: str | None = None
        self._ssh_client: paramiko.SSHClient | None = None
        self._task = asyncio.ensure_future(self._loop())

    def stop(self):
        self._task.cancel()
        self._close_ssh()

    def _close_ssh(self):
        if self._ssh_client is not None:
            try:
                self._ssh_client.close()
            except Exception as e:
                logger.debug("error closing ssh client for %s: %s", self.path, e)
            self._ssh_client = None

    def _sample_local(self):
        client = docker_client(None)
        containers = client.containers.list()
        ts_ms = time.time() * 1000.0
        n = 0
        for c in containers:
            try:
                raw = c.stats(stream=False)
            except Exception as e:
                # one container's stats() call failing (removed mid-poll,
                # a transient connection hiccup, ...) must not blank out
                # every other container's sample for this tick
                logger.debug("stats() failed for container %s: %s", c.name, e)
                continue
            cpu, mem, mem_bytes, net_total = _cpu_mem_net_from_raw(raw)
            rate = self._net_rate(c.name, ts_ms, net_total)
            self.ingest_row(c.name, ts_ms, cpu, mem, mem_bytes, rate)
            n += 1
        return n

    def _sample_remote(self):
        assert (
            self.host is not None
        )  # only ever called from _sample_once's own `if self.host` guard
        if self._ssh_client is None:
            self._ssh_client = _connect_ssh(self.host, self.ssh_key)
        out, err, rc = _exec_remote_docker(
            self._ssh_client, ["stats", "--no-stream", "--format", "{{json .}}"], timeout=15
        )
        if rc != 0:
            raise RuntimeError(err or "docker stats failed")
        ts_ms = time.time() * 1000.0
        n = 0
        for line in out.splitlines():
            if not line.strip():
                continue
            row = jloads(line)
            name = row.get("Name") or row.get("Container") or "?"
            cpu = float(row["CPUPerc"].rstrip("%")) if row.get("CPUPerc") else None
            mem_pct = float(row["MemPerc"].rstrip("%")) if row.get("MemPerc") else None
            mem_bytes = (
                _parse_docker_size(row["MemUsage"].split("/")[0]) if row.get("MemUsage") else None
            )
            net_total = (
                sum(_parse_docker_size(p) for p in row["NetIO"].split("/"))
                if row.get("NetIO")
                else None
            )
            rate = self._net_rate(name, ts_ms, net_total) if net_total is not None else None
            self.ingest_row(name, ts_ms, cpu, mem_pct, mem_bytes, rate)
            n += 1
        return n

    def _sample_once(self):
        return self._sample_remote() if self.host else self._sample_local()

    async def _loop(self):
        while True:
            t_start = time.time()
            try:
                n = await asyncio.to_thread(self._sample_once)
                self.error = None
                if n:
                    self._state.broadcast({"type": "update", "source": self.id})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.debug("stats poll failed for %s: %s", self.path, e)
                self.error = f"{type(e).__name__}: {e}"[:500]
                self._close_ssh()  # force a fresh connection next tick
            await asyncio.sleep(max(0.5, self.interval - (time.time() - t_start)))


class HostStatsSource(StatsSource):
    """Host-level CPU/MEM/NET for the docker host: psutil for the local
    machine, /proc read over an asyncio ssh subprocess for ssh:// hosts."""

    is_host = True

    def __init__(
        self,
        sid: str,
        name: str,
        host: str | None,
        interval: float,
        state: State,
        ssh_key: str | None = None,
    ):
        super().__init__(sid, name, path=None, live=True)
        self.path = f"docker://{host or 'local'}/host"
        self.host = host
        # narrows the base class's Optional declarations -- see
        # DockerStatsSource.__init__'s matching comment.
        self.interval: float = interval
        self._state: State = state
        self.error: str | None = None
        self._prev = None  # (ts, cpu_busy, cpu_total, net_total) for delta rates
        self._ssh_cmd = None
        if host:
            if host.startswith("ssh://"):
                extra, target = ssh_host_and_port(host)
                self._ssh_cmd = [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=10",
                    *extra,
                    *(["-i", ssh_key, "-o", "IdentitiesOnly=yes"] if ssh_key else []),
                    target,
                ]
            else:
                self.error = "host telemetry supports the local daemon or ssh:// hosts only"
        self._task = asyncio.ensure_future(self._loop())

    def stop(self):
        self._task.cancel()

    async def _loop(self):
        while True:
            t_start = time.time()
            if self.error is None or self._ssh_cmd is not None:
                try:
                    row = await (
                        self._sample_ssh()
                        if self._ssh_cmd
                        else asyncio.to_thread(self._sample_local)
                    )
                    self.error = None
                    if row is not None:
                        ts, cpu, mem, mem_bytes, rate = row
                        self.ingest_row(self.name, ts, cpu, mem, mem_bytes, rate)
                        self._state.broadcast({"type": "update", "source": self.id})
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.debug("host stats poll failed for %s: %s", self.path, e)
                    self.error = f"{type(e).__name__}: {e}"[:500]
            await asyncio.sleep(max(0.5, self.interval - (time.time() - t_start)))

    def _sample_local(self):
        try:
            import psutil
        except ImportError:
            raise RuntimeError("psutil not installed (re-run: uv sync refreshes the venv)")
        ts = time.time() * 1000.0
        cpu = psutil.cpu_percent(interval=None)  # since previous call
        vm = psutil.virtual_memory()
        io_c = psutil.net_io_counters()
        net_total = io_c.bytes_recv + io_c.bytes_sent
        rate = None
        first = self._prev is None
        if not first and ts > self._prev[0]:
            d = net_total - self._prev[3]
            if d >= 0:
                rate = d / ((ts - self._prev[0]) / 1000.0)
        self._prev = (ts, None, None, net_total)
        if first:  # cpu_percent's first call has no reference interval
            return None
        return (ts, cpu, vm.percent, vm.total - vm.available, rate)

    async def _sample_ssh(self):
        assert (
            self._ssh_cmd is not None
        )  # only ever called from _loop's own `if self._ssh_cmd` guard
        proc = await asyncio.create_subprocess_exec(
            *self._ssh_cmd,
            "cat",
            "/proc/stat",
            "/proc/meminfo",
            "/proc/net/dev",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=max(30, self.interval * 4)
            )
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError("ssh host sample timed out")
        if proc.returncode != 0:
            raise RuntimeError(
                stderr.decode(errors="replace").strip()[:200] or "ssh host sample failed"
            )
        ts = time.time() * 1000.0
        busy = total = None
        mem_total = mem_avail = None
        net_total = 0
        for line in stdout.decode(errors="replace").splitlines():
            if line.startswith("cpu ") and busy is None:
                parts = [float(x) for x in line.split()[1:]]
                total = sum(parts)
                busy = total - parts[3] - (parts[4] if len(parts) > 4 else 0)  # - idle - iowait
            elif line.startswith("MemTotal:"):
                mem_total = float(line.split()[1]) * 1024
            elif line.startswith("MemAvailable:"):
                mem_avail = float(line.split()[1]) * 1024
            elif ":" in line:
                name, _, rest = line.partition(":")
                name = name.strip()
                fields = rest.split()
                # skip loopback and container-side plumbing (veth/bridge traffic
                # already shows up on the physical interface)
                if (
                    len(fields) >= 9
                    and name
                    and name != "lo"
                    and not name.startswith(("veth", "br-", "docker"))
                ):
                    net_total += float(fields[0]) + float(fields[8])
        cpu = mem = mem_bytes = rate = None
        if mem_total and mem_avail is not None:
            mem = (mem_total - mem_avail) / mem_total * 100.0
            mem_bytes = mem_total - mem_avail
        prev = self._prev
        self._prev = (ts, busy, total, net_total)
        if prev is None:
            return None
        prev_ts, prev_busy, prev_total, prev_net = prev
        if (
            busy is not None
            and total is not None
            and prev_busy is not None
            and prev_total is not None
            and total > prev_total
        ):
            cpu = max(0.0, (busy - prev_busy) / (total - prev_total) * 100.0)
        if ts > prev_ts and net_total >= prev_net:
            rate = (net_total - prev_net) / ((ts - prev_ts) / 1000.0)
        return (ts, cpu, mem, mem_bytes, rate)


class DockerLogSource(LogSource):
    """Follows `docker logs -f -t` (or `docker service logs -f -t`) -- an
    asyncio subprocess for the local daemon (not docker-py: its log-follow
    is a blocking generator with no clean way to abort from another
    coroutine/thread, whereas an asyncio subprocess can just be terminated
    on stop()), or `sudo docker logs -f -t ...` over a persistent paramiko
    channel for a remote ssh:// source (see _exec_remote_docker's docstring
    for why sudo)."""

    def __init__(
        self,
        sid,
        name,
        host,
        target_type,
        target,
        transforms,
        state: State,
        tail=2000,
        ssh_key: str | None = None,
    ):
        super().__init__(sid, name, path=None, live=True, transforms=transforms)
        self.path = f"docker://{host or 'local'}/{target_type}/{target}"
        self.host = host
        self.ssh_key = ssh_key
        # narrows the base class's Optional declaration -- see
        # DockerStatsSource.__init__'s matching comment.
        self._state: State = state
        self.error: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        self._ssh_client: paramiko.SSHClient | None = None
        self._channel: paramiko.Channel | None = None
        sub = ["service", "logs"] if target_type == "service" else ["logs"]
        self._args = sub + ["-f", "-t", "--tail", str(tail), target]
        self._task = asyncio.ensure_future(self._follow())

    def stop(self):
        self._task.cancel()
        self._close_conn()

    def _close_conn(self):
        """Tears down whatever the current connection attempt holds, so a
        reconnect (br-DEDUP-009) always starts from a clean slate -- also
        used directly by stop()."""
        if self._proc is not None and self._proc.returncode is None:
            self._proc.terminate()
        self._proc = None
        if self._channel is not None:
            try:
                self._channel.close()
            except Exception as e:
                logger.debug("error closing ssh channel for %s: %s", self.path, e)
            self._channel = None
        if self._ssh_client is not None:
            try:
                self._ssh_client.close()
            except Exception as e:
                logger.debug("error closing ssh client for %s: %s", self.path, e)
            self._ssh_client = None

    async def _follow(self):
        # br-DEDUP-009: a dead/restarted container (or a transient ssh/
        # docker hiccup) ends this stream with a clean EOF, not an
        # exception -- reconnecting with backoff (mirroring
        # DockerStatsSource._loop's own retry-forever pattern) instead of
        # giving up for good means this source's log feed recovers the same
        # way the paired stats source already does, rather than looking
        # "healthy in stats but permanently stale in logs".
        backoff = 1.0
        while True:
            try:
                read_chunk = await (self._start_remote() if self.host else self._start_local())
                self.error = None  # connected -- clears any error from a previous attempt
                last_emit = 0.0
                pending = 0
                while True:
                    # blocks until data or true EOF -- never returns b"" while
                    # the stream is merely idle (docker logs -f between lines)
                    chunk = await read_chunk()
                    if not chunk:
                        self.error = "log stream ended -- reconnecting"
                        break
                    pending += self.ingest_chunk(chunk)
                    now = time.time()
                    if pending and now - last_emit > 0.5:  # throttle SSE chatter
                        self._state.broadcast({"type": "update", "source": self.id})
                        pending, last_emit = 0, now
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.debug("log follow failed for %s: %s", self.path, e)
                self.error = f"{type(e).__name__}: {e}"[:500]
            else:
                backoff = 1.0  # a stream that actually ran resets the backoff
            self._state.broadcast({"type": "update", "source": self.id})
            self._close_conn()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def _start_local(self):
        self._proc = await asyncio.create_subprocess_exec(
            "docker",
            *self._args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout = self._proc.stdout
        assert stdout is not None  # guaranteed by stdout=PIPE above

        async def read_chunk():
            return await stdout.read(65536)

        return read_chunk

    async def _start_remote(self):
        assert self.host is not None  # only ever called from _follow's own `if self.host` guard
        self._ssh_client = await asyncio.to_thread(_connect_ssh, self.host, self.ssh_key)
        cmd = "sudo docker " + " ".join(shlex.quote(a) for a in self._args)
        logger.info("ssh: starting persistent log follow for %s: `%s`", self.path, cmd)
        _stdin, stdout_f, _stderr = await asyncio.to_thread(self._ssh_client.exec_command, cmd)
        channel = stdout_f.channel
        self._channel = channel
        channel.set_combine_stderr(True)

        async def read_chunk():
            return await asyncio.to_thread(channel.recv, 65536)

        return read_chunk


# ── state, tailing, SSE ──────────────────────────────────────────────────────


class MultiSegmentSample(Exception):
    """Raised by State.load_sample() when a .cttc archive holds more than
    one recorded segment (see the Recording feature -- multiple Record/
    Pause spans flushed into the same file) and no segment index was given
    to pick one. Carries enough per-segment metadata for the client to show
    a "which recording do you want to load" picker."""

    def __init__(self, segments: list[dict]):
        super().__init__("multiple recorded segments -- choose one")
        self.segments = segments


class State:
    def __init__(
        self,
        transforms_dir: Path,
        sessions_dir: Path | None = None,
        redis_tcp_port: int | None = None,
    ):
        self.sources: dict[str, Source] = {}
        self.registry = TransformRegistry(transforms_dir)
        self.listeners: list[asyncio.Queue] = []
        self.next_id = 1
        self.rolling_buffers = RollingBufferManager(self)
        self.recording_sessions = RecordingSessionManager(
            self, sessions_dir or transforms_dir / "sessions"
        )
        self.scheduler = Scheduler(self.recording_sessions)
        self.events = EventManager(self, self.rolling_buffers, self.recording_sessions)
        self.redis_log = RedisLog(tcp_port=redis_tcp_port)

    def broadcast(self, event: dict):
        for q in list(self.listeners):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def open_file(self, path: str, kind: str, name: str | None, live: bool, transforms: list[str]):
        p = Path(path).expanduser()
        if not p.is_file():
            raise FileNotFoundError(path)
        if kind == "auto":
            kind = sniff_kind(p)
        sid = f"s{self.next_id}"
        self.next_id += 1
        label = name or p.stem
        if kind == "stats":
            src = StatsSource(sid, label, p, live)
        else:
            fns = self.registry.load(transforms)
            src = LogSource(sid, label, p, live, fns)
        src._state = self
        read_all(src)
        self.sources[sid] = src
        logger.info("opened source %s: %s (%s, live=%s)", sid, path, kind, live)
        return src

    def _open_or_reuse(self, path: str, make):
        """Return the id of a source already open at exactly this target
        path, or construct one via make(sid) and register it. Single-
        threaded event loop means this check-then-insert can never race
        (no `await` between the lookup and the insert) -- see docs/
        architecture/remote-server.md's "Single collector, multiple
        viewers": two collectors for one target would hand a viewer two
        slightly-different series for it with no way to tell which is real.

        A reused source keeps whatever interval/ssh_key/transforms it was
        originally started with -- a second request's differing settings
        are silently ignored rather than mutating a collector another
        client may already be relying on. Close and reopen it to change
        those."""
        for s in self.sources.values():
            if getattr(s, "path", None) == path:
                return s.id
        sid = f"s{self.next_id}"
        self.next_id += 1
        self.sources[sid] = make(sid)
        return sid

    def _update_poll_interval(self, sid: str, interval: float):
        """Applies a *changed* poll interval to an already-running stats/host
        collector reused by _open_or_reuse (whose own docstring otherwise
        says differing settings on reuse are silently ignored) -- Edit
        Docker Daemon's whole point is to let you change the poll interval
        for a daemon you're already collecting from, so silently discarding
        it there would make that control a no-op the moment anything is
        already running. Safe to mutate in place with no lock: this runs on
        the single-threaded event loop with no `await` before the source's
        own poll loop next reads self.interval (see DockerStatsSource/
        HostStatsSource's asyncio.sleep(self.interval - ...) below), and
        transforms/ssh_key still follow the documented reuse-keeps-original
        behavior -- only the interval, since that's the one thing the UI
        that triggers this (Update Docker Daemon) actually claims to change."""
        src = self.sources.get(sid)
        if isinstance(src, StatsSource) and src.interval != interval:
            logger.info(
                "collect_docker: updating poll interval for %s: %s -> %s",
                src.path,
                src.interval,
                interval,
            )
            src.interval = interval

    def collect_docker(
        self,
        host: str | None,
        stats: bool,
        logs: list[dict],
        transforms: list[str],
        interval: float,
        host_stats: bool = True,
        ssh_key: str | None = None,
    ):
        host = normalize_docker_host(host)
        logger.info(
            "collect_docker: host=%s stats=%s host_stats=%s logs=%d interval=%s",
            host or "local",
            stats,
            host_stats,
            len(logs),
            interval,
        )
        opened = []
        hostname = (host or "local").split("@")[-1]
        hostkey = host or "local"
        if stats:
            sid = self._open_or_reuse(
                f"docker://{hostkey}/stats",
                lambda sid: DockerStatsSource(
                    sid, f"stats@{hostname}", host, interval, self, ssh_key=ssh_key
                ),
            )
            self._update_poll_interval(sid, interval)
            opened.append(sid)
        if host_stats:
            sid = self._open_or_reuse(
                f"docker://{hostkey}/host",
                lambda sid: HostStatsSource(
                    sid, f"host@{hostname}", host, interval, self, ssh_key=ssh_key
                ),
            )
            self._update_poll_interval(sid, interval)
            opened.append(sid)
        for item in logs:
            target = item["name"]
            ttype = item.get("type", "container")
            fns = self.registry.load(transforms)  # loaded eagerly; harmless to discard on reuse
            opened.append(
                self._open_or_reuse(
                    f"docker://{hostkey}/{ttype}/{target}",
                    lambda sid, t=target, ty=ttype, f=fns: DockerLogSource(
                        sid, t, host, ty, t, f, self, ssh_key=ssh_key
                    ),
                )
            )
        if host:
            # Remembered so the gateway can reconnect this remote daemon on
            # its own restart (see redis_log.RedisLog.known_daemons, read at
            # startup in lifespan()) -- no new secret involved: ssh_key here
            # is only ever a path that must already resolve inside this
            # container's own filesystem (see _connect_ssh's docstring), not
            # key content transmitted over HTTP.
            asyncio.ensure_future(
                self.redis_log.remember_daemon(
                    host,
                    {
                        "host": host,
                        "ssh_key": ssh_key,
                        "stats": stats,
                        "logs": logs,
                        "transforms": transforms,
                        "interval": interval,
                        "host_stats": host_stats,
                    },
                )
            )
        return opened

    async def _write_segment(
        self,
        z: zipfile.ZipFile,
        seg_idx: int,
        t0: float,
        t1: float,
        include_host: bool,
        source_ids: set[str] | None = None,
    ) -> list[dict]:
        """Write one segment's per-source log/metric slices in [t0, t1] into
        the already-open zip `z`, namespaced under seg{seg_idx}/ so multiple
        segments (recorded across separate Record/Pause spans, possibly
        merged in from an earlier archive -- see merge_sample_bytes) never
        collide on filename. Returns that segment's manifest sources list.
        `source_ids`, if given, restricts output to that subset (used by the
        rolling buffer feature to freeze the set of sources live at
        buffer-start time, ignoring sources opened/closed afterward).
        Redis-backed now (see redis_log.py) -- per-source slices are fetched
        concurrently via asyncio.gather rather than serial round trips."""
        items = [
            (i, s)
            for i, s in enumerate(self.sources.values())
            if (source_ids is None or s.id in source_ids)
            and (include_host or not getattr(s, "is_host", False))
        ]

        async def log_slice(s):
            return await self.redis_log.range_by_score_with_payload(s._entity, t0, t1 + 1)

        async def stats_slice(s):
            svcs = sorted(s._services)
            per_svc = await asyncio.gather(
                *(self.redis_log.range_by_score_with_payload(s._entity_for(svc), t0, t1 + 1) for svc in svcs)
            )
            return dict(zip(svcs, per_svc))

        results = await asyncio.gather(
            *(log_slice(s) if s.kind == "log" else stats_slice(s) for _i, s in items)
        )

        meta = []
        for (i, s), result in zip(items, results):
            if s.kind == "log":
                rows = result
                if not rows:
                    continue
                fn = f"seg{seg_idx}/logs/{i}.jsonl"
                z.writestr(
                    fn,
                    b"\n".join(
                        jdumps({"ts": ts, "text": payload.get("text", "")}) for ts, payload in rows
                    ),
                )
                meta.append({"type": "log", "name": s.name, "file": fn, "count": len(rows)})
            else:
                ser = {
                    svc: [
                        [ts, p.get("cpu"), p.get("mem"), p.get("mem_bytes"), p.get("net")]
                        for ts, p in rows
                    ]
                    for svc, rows in result.items()
                    if rows
                }
                swarm = sorted(s._swarm)
                if not ser:
                    continue
                fn = f"seg{seg_idx}/stats/{i}.json"
                z.writestr(fn, jdumps({"series": ser, "swarm": swarm}))
                meta.append({"type": "stats", "name": s.name, "file": fn, "is_host": s.is_host})
        return meta

    async def build_sample_bytes(
        self,
        t0: float,
        t1: float,
        include_host: bool = True,
        source_ids: set[str] | None = None,
    ) -> tuple[bytes, list[dict]]:
        """Build a one-segment .cttc sample's bytes (the ordinary Capture
        Metrics / --static export path -- see merge_sample_bytes for the
        Recording feature's multi-segment append). Returns (data, meta);
        meta's length is the "how many sources" count callers report.
        `source_ids` restricts the segment to that subset of sources (see
        rolling_buffer.RollingBufferManager)."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            meta = await self._write_segment(z, 0, t0, t1, include_host, source_ids)
            segment = {"from": t0, "to": t1, "created": now_iso(), "sources": meta}
            z.writestr("manifest.json", jdumps({"version": 2, "segments": [segment]}))
        return buf.getvalue(), meta

    @staticmethod
    def _read_segments(data: bytes) -> list[dict]:
        """Normalizes any .cttc archive -- legacy single-segment (no
        "segments" key, un-prefixed file paths) or the current multi-segment
        shape alike -- into a list of
        {"from", "to", "created", "sources", "_members": {relpath: bytes}}.
        Reading each member's raw bytes here (rather than just the manifest)
        lets merge_sample_bytes copy prior segments into a new archive
        byte-for-byte, with zero awareness of whether they were originally
        legacy or multi-segment."""
        segments = []
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            man = jloads(z.read("manifest.json"))
            raw_segments = man.get("segments")
            if raw_segments is None:
                raw_segments = [
                    {
                        "from": man.get("from"),
                        "to": man.get("to"),
                        "created": man.get("created", now_iso()),
                        "sources": man.get("sources", []),
                    }
                ]
            for seg in raw_segments:
                members = {src["file"]: z.read(src["file"]) for src in seg["sources"]}
                segments.append({**seg, "_members": members})
        return segments

    async def merge_sample_bytes(
        self, existing: bytes | None, t0: float, t1: float, include_host: bool = True
    ) -> tuple[bytes, list[dict], int]:
        """Append a new segment covering [t0, t1] to `existing` (raw bytes
        of a previously recorded/exported .cttc, or None to start fresh),
        returning the combined archive bytes, the new segment's own sources
        meta, and its index. Backs /sample/record -- each Record/Pause span
        of the Recording feature flushes one more segment into the same
        archive this way, rather than each span becoming its own file."""
        prior = self._read_segments(existing) if existing else []
        seg_idx = len(prior)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for seg in prior:
                for relpath, content in seg["_members"].items():
                    z.writestr(relpath, content)
            new_meta = await self._write_segment(z, seg_idx, t0, t1, include_host)
            segments_manifest = [
                {
                    "from": seg["from"],
                    "to": seg["to"],
                    "created": seg["created"],
                    "sources": seg["sources"],
                }
                for seg in prior
            ]
            segments_manifest.append(
                {"from": t0, "to": t1, "created": now_iso(), "sources": new_meta}
            )
            z.writestr("manifest.json", jdumps({"version": 2, "segments": segments_manifest}))
        return buf.getvalue(), new_meta, seg_idx

    async def export_sample(
        self, path: str, t0: float, t1: float, include_host: bool = True
    ) -> dict:
        """Write a .cttc sample to a server-side path. See
        build_sample_bytes() for the format."""
        data, meta = await self.build_sample_bytes(t0, t1, include_host)
        p = Path(path).expanduser()
        p.write_bytes(data)
        return {"path": str(p), "sources": len(meta)}

    async def load_sample(self, path: str, segment: int | None = None) -> list[str]:
        """Open a .cttc sample as a set of static sources. If it holds more
        than one recorded segment and `segment` isn't given, raises
        MultiSegmentSample (carrying each segment's from/to/created/source
        count) so the caller can ask the user which one to load instead of
        silently picking one.

        Every row gets its own redis_log entry -- collected here and handed
        to bulk_record() in one go at the end, rather than calling
        redis_log.record() per row: record() is the non-blocking hot path
        meant for real-time ingestion (see its docstring), and a recording
        of any real length routinely holds far more rows than its queue's
        capacity, arriving here in one synchronous burst instead of spread
        over real time -- record() would silently drop most of it
        (br-REDIS-018)."""
        p = Path(path).expanduser()
        opened = []
        rows: list[tuple[str, float, dict]] = []
        raw = p.read_bytes()
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            man = jloads(z.read("manifest.json"))
            raw_segments = man.get("segments")
            if raw_segments is None:
                raw_segments = [
                    {
                        "from": man.get("from"),
                        "to": man.get("to"),
                        "created": man.get("created", now_iso()),
                        "sources": man.get("sources", []),
                    }
                ]
            if len(raw_segments) > 1 and segment is None:
                raise MultiSegmentSample(
                    [
                        {
                            "index": i,
                            "from": seg["from"],
                            "to": seg["to"],
                            "created": seg.get("created"),
                            "source_count": len(seg["sources"]),
                        }
                        for i, seg in enumerate(raw_segments)
                    ]
                )
            seg = raw_segments[segment or 0]
            for meta in seg["sources"]:
                sid = f"s{self.next_id}"
                self.next_id += 1
                if meta["type"] == "log":
                    src = LogSource(sid, meta["name"], p, live=False, transforms=[])
                    src._state = self
                    for line in z.read(meta["file"]).splitlines():
                        if not line.strip():
                            continue
                        e = jloads(line)
                        src.seq += 1
                        ts = float(e["ts"])
                        text = str(e.get("text", ""))
                        uid = make_uid(meta["name"], src.seq, text)
                        row = (ts, src.seq, uid, text)
                        src._last_row = row
                        rows.append((meta["name"], ts, {"uid": uid, "text": text}))
                else:
                    src = StatsSource(sid, meta["name"], p, live=False)
                    src._state = self
                    d = jloads(z.read(meta["file"]))
                    for svc, lst in d["series"].items():
                        src._services.add(svc)
                        for row in lst:
                            ts, cpu, mem, mem_bytes, rate = tuple(row)
                            src.count += 1
                            rows.append(
                                (
                                    svc,
                                    ts,
                                    {"cpu": cpu, "mem": mem, "mem_bytes": mem_bytes, "net": rate},
                                )
                            )
                    src._swarm = set(d.get("swarm", []))
                    if meta.get("is_host"):
                        src.is_host = True
                self.sources[sid] = src
                opened.append(sid)
        await self.redis_log.bulk_record(rows)
        return opened

    def close_source(self, sid: str):
        src = self.sources.pop(sid, None)
        if src is None:
            logger.info("closed source %s (already gone)", sid)
            return
        src.stop()  # a no-op for static/file-tailed sources, see LogSource/StatsSource.stop
        logger.info("closed source %s (%s)", sid, src.path)

    async def describe(self):
        """Per-source min/max/total, gathered concurrently across every
        open source (Redis-backed now, see redis_log.py) rather than
        serial awaits -- /sources and export requests fan out across every
        source, so this stays one round trip of latency, not N."""
        items = list(self.sources.values())

        async def one(s):
            rng = await s.range()
            total = await s.total() if s.kind == "log" else s.count
            return rng, total

        results = await asyncio.gather(*(one(s) for s in items))
        out = []
        for s, (rng, total) in zip(items, results):
            d = {
                "id": s.id,
                "name": s.name,
                "kind": s.kind,
                "path": str(s.path),
                "live": s.live,
                "skipped": s.skipped,
                "min_ts": rng[0] if rng else None,
                "max_ts": rng[1] if rng else None,
                "error": getattr(s, "error", None),
                "total": total,
            }
            if s.kind == "log":
                d["transforms"] = [n for n, _ in s.transforms]
            else:
                d["services"] = s.services()
                d["is_host"] = getattr(s, "is_host", False)
            out.append(d)
        return out


def sniff_kind(path: Path) -> str:
    with open(path, "rb") as f:
        head = f.read(65536).lstrip()
    if head.startswith(b"["):
        return "stats" if b"CPUPerc" in head else "log"
    first = head.split(b"\n", 1)[0]
    if first.startswith(b"{") and b"CPUPerc" in first:
        return "stats"
    return "log"


def read_all(src):
    with open(src.path, "rb") as f:
        f.seek(src.offset)
        data = f.read()
        src.offset = f.tell()
    src.ingest_chunk(data)


async def tail_loop(state: State, interval: float = 1.0):
    """Polls every live file source for growth and re-reads it -- see
    read_all(). Each source's stat/read/broadcast is isolated (br-ORCH-005):
    an unhandled exception from one (a permissions error transient enough not
    to be an OSError, a malformed transform raising mid-ingest, anything past
    what the narrower OSError catches below predicted) is logged and skipped,
    not left to kill this loop and silently stop tailing every OTHER live
    file source for the rest of the gateway's uptime."""
    while True:
        await asyncio.sleep(interval)
        for src in list(state.sources.values()):
            if not src.live or not isinstance(src.path, Path):
                continue
            try:
                try:
                    size = src.path.stat().st_size
                except OSError as e:
                    logger.debug("tail: could not stat %s: %s", src.path, e)
                    continue
                if size < src.offset:  # truncated/rotated: start over
                    src.offset = 0
                if size > src.offset:
                    try:
                        await asyncio.to_thread(read_all, src)
                    except OSError as e:
                        logger.debug("tail: could not read %s: %s", src.path, e)
                        continue
                    state.broadcast({"type": "update", "source": src.id})
            except Exception:
                logger.exception("tail_loop: failed to tail %s", src.path)


async def sessions_loop(state: State, interval: float = 1.0):
    """Drives recording_session.py's duration-elapsed/TTL-sweep checks,
    scheduler.py's due-schedule firing, rolling_buffer.py's ad-hoc-buffer
    TTL sweep (br-RBUF-005), and events.py's condition checks -- see each
    module's docstring. Each tick is isolated so an unhandled exception
    from one never stops the others, or this loop itself (br-ORCH-004): a
    single bad beat is logged and skipped, not fatal."""
    while True:
        await asyncio.sleep(interval)
        try:
            state.scheduler.tick()
        except Exception:
            logger.exception("sessions_loop: scheduler tick failed")
        try:
            await state.recording_sessions.tick()
        except Exception:
            logger.exception("sessions_loop: recording_sessions tick failed")
        try:
            state.rolling_buffers.tick()
        except Exception:
            logger.exception("sessions_loop: rolling_buffers tick failed")
        try:
            await state.events.tick()
        except Exception:
            logger.exception("sessions_loop: events tick failed")


# ── HTTP API (FastAPI) ────────────────────────────────────────────────────────


def bad_request(msg: str) -> ValueError:
    """Routes `raise bad_request(...)` for a missing/invalid param -- caught
    by the ValueError exception handler below, which wraps it in the same
    {"error": "bad request: ..."} shape every other 400 already uses."""
    return ValueError(msg)


@asynccontextmanager
async def lifespan(app: FastAPI):
    state: State = app.state.cttc
    await state.redis_log.start()
    # Command-line files (uv run server.py file1 file2 ...) must be opened
    # only *after* redis_log.start() above -- Redis is the sole store now
    # (see redis_log.py's module docstring), and record() silently no-ops
    # while self.enabled is still False (start() hasn't run yet). Opening
    # these from _run() instead, before uvicorn's serve() ever triggers
    # this lifespan, used to mean every CLI-supplied file's data was queued
    # and dropped before there was anywhere for it to land -- /range would
    # report {min_ts: null, max_ts: null} forever, since nothing else ever
    # changes for a static (non-live) source to trigger a client re-check.
    for f, live in getattr(app.state, "cli_files", []):
        try:
            state.open_file(f, "auto", None, live=live, transforms=[])
        except Exception as e:
            logger.warning("could not open %s: %s", f, e)
    # Always-on collection: local Docker + local host telemetry start the
    # moment the gateway boots, no client/Set Docker Daemon action needed.
    # Remote hosts previously configured (see collect_docker's
    # remember_daemon call) are replayed too, so the gateway can reconnect
    # them on its own restart -- harmless if a client's own auto-reconnect
    # (app.js) also calls /docker/collect for the same host moments later,
    # since _open_or_reuse already dedupes by path. Gated on --auto-collect
    # (see main()'s help text): off by default so the bare/embedded process
    # and the test suite don't get an unprompted background collector.
    if getattr(app.state, "auto_collect", False):
        try:
            state.collect_docker(None, True, [], [], 5.0, True, None)
        except Exception as e:
            logger.warning("lifespan: local auto-collect failed: %s", e)
        for daemon in await state.redis_log.known_daemons():
            try:
                state.collect_docker(
                    daemon.get("host"),
                    daemon.get("stats", True),
                    daemon.get("logs", []),
                    daemon.get("transforms", []),
                    daemon.get("interval", 5.0),
                    daemon.get("host_stats", True),
                    daemon.get("ssh_key"),
                )
            except Exception as e:
                logger.warning(
                    "lifespan: auto-collect for remembered daemon %s failed: %s",
                    daemon.get("host"),
                    e,
                )
    yield
    await state.redis_log.stop()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-CTTC-Source-Count", "Content-Disposition"],
)


@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError):
    return Response(
        jdumps({"error": f"bad request: {exc}"}), media_type="application/json", status_code=400
    )


@app.exception_handler(KeyError)
async def _key_error_handler(request: Request, exc: KeyError):
    return Response(
        jdumps({"error": f"bad request: missing {exc}"}),
        media_type="application/json",
        status_code=400,
    )


@app.exception_handler(ValueError)
async def _value_error_handler(request: Request, exc: ValueError):
    return Response(
        jdumps({"error": f"bad request: {exc}"}), media_type="application/json", status_code=400
    )


@app.exception_handler(DockerPsError)
async def _docker_ps_error_handler(request: Request, exc: DockerPsError):
    logger.error("%s failed: %s", request.url.path, exc)
    return Response(
        jdumps({"error": str(exc), "log": exc.log}), media_type="application/json", status_code=502
    )


@app.exception_handler(RuntimeError)
async def _runtime_error_handler(request: Request, exc: RuntimeError):
    logger.error("%s failed: %s", request.url.path, exc)
    return Response(jdumps({"error": str(exc)}), media_type="application/json", status_code=502)


@app.exception_handler(Exception)
async def _unhandled_error_handler(request: Request, exc: Exception):
    # Any exception type not covered above -- always send a real response;
    # see the git history for why this matters (a bug here used to mean the
    # client saw a dropped connection with literally no diagnostic at all).
    logger.exception("unhandled error on %s", request.url.path)
    return Response(
        jdumps({"error": f"unexpected server error: {exc}"}),
        media_type="application/json",
        status_code=500,
    )


@app.middleware("http")
async def _access_log(request: Request, call_next):
    # Detailed REST activity log for every request this server handles --
    # uvicorn's own access log is disabled (see main()'s access_log=False,
    # which just prints a bare "METHOD path HTTP/1.1" 200 OK" line with no
    # timing/client/size) in favor of this single, consistent line covering
    # every route including the ones handled by the exception handlers
    # above (their response status code comes back through call_next()
    # like any other, no separate logging needed there). Deliberately never
    # logs request/response *bodies* -- those can be arbitrarily large
    # (file uploads, log/metric payloads) or sensitive (ssh keys, private
    # key PEMs) -- just method/path/query/client/status/size/timing.
    start = time.monotonic()
    client = request.client.host if request.client else "?"
    query = f"?{request.url.query}" if request.url.query else ""
    try:
        response = await call_next(request)
    except Exception as e:
        elapsed_ms = (time.monotonic() - start) * 1000
        logger.info(
            "%s %s%s from %s -> unhandled exception after %.1fms: %s",
            request.method,
            request.url.path,
            query,
            client,
            elapsed_ms,
            e,
        )
        raise
    elapsed_ms = (time.monotonic() - start) * 1000
    size = response.headers.get("content-length", "?")
    logger.info(
        "%s %s%s from %s -> %d (%s bytes, %.1fms)",
        request.method,
        request.url.path,
        query,
        client,
        response.status_code,
        size,
        elapsed_ms,
    )
    return response


@app.middleware("http")
async def _options_preflight(request: Request, call_next):
    # CORSMiddleware only answers OPTIONS itself when the request looks like
    # a real browser CORS preflight (Origin + Access-Control-Request-Method
    # headers present) -- Electron's fetch() always sends both, but plain
    # tooling/tests hitting OPTIONS directly wouldn't get a response
    # otherwise, since none of the actual routes declare an OPTIONS method
    # of their own (this mirrors the old server's unconditional do_OPTIONS
    # handler). A middleware (not a catch-all route) so it never shadows a
    # real 404/405 for GET/POST against an actually-unknown path.
    if request.method == "OPTIONS":
        return Response(
            status_code=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-CTTC-Filename, X-CTTC-Private-Key, X-CTTC-Transforms, X-CTTC-Token",
            },
        )
    return await call_next(request)


@app.middleware("http")
async def _require_api_token(request: Request, call_next):
    """Gates every route behind a shared-secret token when one is configured
    (br-NET-004): Docker-based deployments (a local "This machine" container
    or a remote gateway) always bind 0.0.0.0 with `network_mode: host` (see
    docker-compose.yml/Dockerfile), so without this, anyone who could reach
    the port at all -- the whole LAN, or further if port-forwarded -- had
    full unauthenticated access: collect arbitrary docker sources, read
    every log, upload files, even POST /shutdown. main.js generates a
    random token at provision time (the same trust moment the ssh key
    already establishes for a remote gateway) and passes it here via
    CTTC_API_TOKEN; the bare/native embedded path (127.0.0.1 only, never
    network-reachable) leaves this unset, so it stays exactly as permissive
    as it always was -- this only ever tightens a deployment that opted
    into being reachable from the network in the first place.

    OPTIONS is exempt: a CORS preflight can't carry the real header yet
    (that's exactly what it's asking permission for), so gating it here
    would break every actual request that needs one, not just
    unauthenticated ones.

    A `?token=` query param is accepted as a fallback alongside the header
    for one reason: the browser's native EventSource (app.js's /events SSE
    stream) has no way to attach a custom header at all, by spec -- the
    query string is the only channel it has. Every other request goes
    through get()/post()/authHeaders() and always uses the header.
    """
    expected = getattr(request.app.state, "api_token", None)
    if expected and request.method != "OPTIONS":
        got = request.headers.get("x-cttc-token") or request.query_params.get("token")
        if got != expected:
            logger.warning(
                "rejected %s %s from %s: missing/incorrect X-CTTC-Token",
                request.method,
                request.url.path,
                request.client.host if request.client else "?",
            )
            return Response(
                jdumps({"error": "missing or incorrect X-CTTC-Token"}),
                media_type="application/json",
                status_code=401,
            )
    return await call_next(request)


def get_state(request: Request) -> State:
    return request.app.state.cttc


def get_log_source(request: Request, source: str) -> LogSource:
    st = get_state(request)
    src = st.sources.get(source)
    if src is None or src.kind != "log":
        raise bad_request(f"unknown log source: {source}")
    return src


@app.get("/health")
async def route_health():
    """Cheap liveness probe -- no state/docker/disk access, just confirms the
    process is up and answering HTTP, for the renderer's status indicator."""
    return {"ok": True}


@app.get("/mlog")
async def route_mlog():
    """Ship Logs (Settings > Collect CTTC Own Logs, main.js's "ship-logs"):
    `docker logs` on the gateway's own container, named after it -- see
    gather_own_container_logs(). The filename travels in a header (like
    /sample/record's segment index) since a plain download response has no
    other structured place to carry it."""
    name, data = await gather_own_container_logs()
    return Response(
        content=data,
        media_type="text/plain",
        headers={
            "X-CTTC-Gateway-Name": name,
            "Content-Disposition": f'attachment; filename="{name}.log"',
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "X-CTTC-Gateway-Name",
        },
    )


@app.get("/sources")
async def route_sources(request: Request):
    st = get_state(request)
    return {"sources": await st.describe(), "json_impl": JSON_IMPL}


@app.get("/transforms")
async def route_transforms(request: Request):
    return {"transforms": get_state(request).registry.available()}


@app.get("/ssh/keys")
async def route_ssh_keys():
    return {"keys": list_ssh_keys()}


@app.get("/range")
async def route_range(request: Request):
    lo = hi = None
    for s in await get_state(request).describe():
        if s["min_ts"] is not None:
            lo = s["min_ts"] if lo is None else min(lo, s["min_ts"])
            hi = s["max_ts"] if hi is None else max(hi, s["max_ts"])
    return {"min_ts": lo, "max_ts": hi}


@app.get("/series")
async def route_series(
    request: Request, from_: str = Query("", alias="from"), to: str = "", px: str = "800"
):
    if not from_ or not to:
        raise bad_request("'from' and 'to' are required")
    t0, t1, pxi = float(from_), float(to), int(px)
    st = get_state(request)
    out = []
    for s in st.sources.values():
        if s.kind == "stats":
            out.extend(await s.bucketed(t0, t1, pxi))
    return {"from": t0, "to": t1, "px": pxi, "services": out}


@app.get("/logs")
async def route_logs(request: Request, source: str = "", start: str = "0", count: str = "200"):
    src = get_log_source(request, source)
    starti, counti = int(start), min(int(count), 2000)
    return {"total": await src.total(), "rows": await src.slice(starti, counti)}


@app.get("/point")
async def route_point(request: Request, t: str = ""):
    if not t:
        raise bad_request("'t' is required")
    tf = float(t)
    out = {}
    for s in get_state(request).sources.values():
        if s.kind == "stats":
            out.update(await s.point_at(tf))
    return {"t": tf, "services": out}


@app.get("/index_at")
async def route_index_at(request: Request, source: str = "", t: str = ""):
    src = get_log_source(request, source)
    if not t:
        raise bad_request("'t' is required")
    return {"index": await src.index_at(float(t))}


@app.get("/ticks")
async def route_ticks(
    request: Request,
    source: str = "",
    from_: str = Query("", alias="from"),
    to: str = "",
    px: str = "800",
):
    src = get_log_source(request, source)
    if not from_ or not to:
        raise bad_request("'from' and 'to' are required")
    return {"counts": await src.ticks(float(from_), float(to), int(px))}


@app.get("/logs/find")
async def route_logs_find(
    request: Request, source: str = "", q: str = "", start: str = "0", dir: str = "fwd"
):
    src = get_log_source(request, source)
    idx = await src.find(q, int(start), dir != "back")
    return {"index": idx}


@app.get("/files/download")
async def route_files_download(
    request: Request, from_: str = Query("", alias="from"), to: str = "", include_host: str = "1"
):
    if not from_ or not to:
        raise bad_request("'from' and 'to' are required")
    st = get_state(request)
    t0, t1 = float(from_), float(to)
    inc = include_host.lower() not in ("0", "false")
    data, filename, count = await files.download_sample(st, t0, t1, inc)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "X-CTTC-Source-Count": str(count),
            # CORSMiddleware only adds Access-Control-Expose-Headers for
            # requests that actually carry an Origin header -- set it
            # explicitly here too so it's unconditional, matching every
            # other response (the renderer needs this header exposed to
            # read X-CTTC-Source-Count/Content-Disposition via fetch() at
            # all, cross-origin or not).
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "X-CTTC-Source-Count, Content-Disposition",
        },
    )


SSE_KEEPALIVE_INTERVAL = 15  # seconds; a module constant so tests can shrink it


@app.get("/events")
async def route_events(request: Request):
    st = get_state(request)
    q: asyncio.Queue = asyncio.Queue(maxsize=256)
    st.listeners.append(q)

    async def gen():
        try:
            while True:
                if await request.is_disconnected():
                    return
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=SSE_KEEPALIVE_INTERVAL)
                    yield b"data: " + jdumps(ev) + b"\n\n"
                except TimeoutError:
                    yield b": keepalive\n\n"
        finally:
            st.listeners.remove(q)

    return StreamingResponse(
        gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


@app.post("/open")
async def route_open(request: Request):
    body = await request.json() if await request.body() else {}
    st = get_state(request)
    opened, errors, needs_selection = [], [], []
    for f in body.get("files", []):
        try:
            if is_cttc_archive(str(f["path"])):
                opened.extend(await st.load_sample(f["path"], segment=f.get("segment")))
                continue
            src = st.open_file(
                f["path"],
                f.get("kind", "auto"),
                f.get("name"),
                bool(f.get("live", True)),
                f.get("transforms", []),
            )
            opened.append(src.id)
        except MultiSegmentSample as e:
            needs_selection.append({"path": f.get("path"), "segments": e.segments})
        except Exception as e:
            errors.append({"path": f.get("path"), "error": str(e)})
    st.broadcast({"type": "sources"})
    return {
        "opened": opened,
        "errors": errors,
        "needs_selection": needs_selection,
        "sources": await st.describe(),
    }


@app.post("/close")
async def route_close(request: Request):
    body = await request.json() if await request.body() else {}
    st = get_state(request)
    sid = body.get("id")
    if not isinstance(sid, str):
        raise bad_request("'id' is required")
    st.close_source(sid)
    st.broadcast({"type": "sources"})
    return {"ok": True}


@app.post("/sample/export")
async def route_sample_export(request: Request):
    body = await request.json()
    st = get_state(request)
    return await st.export_sample(
        body["path"],
        float(body["from"]),
        float(body["to"]),
        bool(body.get("include_host", True)),
    )


@app.post("/sample/record")
async def route_sample_record(request: Request):
    """Recording feature: flush the current [from, to) span as one more
    segment into a .cttc archive, byte-oriented like /files/upload|download
    (no shared-filesystem assumption -- the client already holds the
    previous archive's bytes locally, from having written them there after
    the last Record/Pause/Stop). Request body is the *existing* archive's
    raw bytes (empty body means "first segment, nothing to merge into");
    response body is the combined archive's raw bytes, for the client to
    write back over its local copy."""
    existing = await request.body()
    t0 = float(request.headers.get("X-CTTC-From", ""))
    t1 = float(request.headers.get("X-CTTC-To", ""))
    inc = (request.headers.get("X-CTTC-Include-Host") or "1").lower() not in ("0", "false")
    st = get_state(request)
    data, meta, seg_idx = await st.merge_sample_bytes(existing or None, t0, t1, inc)
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "X-CTTC-Source-Count": str(len(meta)),
            "X-CTTC-Segment-Index": str(seg_idx),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "X-CTTC-Source-Count, X-CTTC-Segment-Index",
        },
    )


@app.post("/buffer/start")
async def route_buffer_start(request: Request):
    body = await request.json()
    st = get_state(request)
    buffer_id = st.rolling_buffers.start(float(body["minutes"]))
    return {"buffer_id": buffer_id}


@app.post("/buffer/{buffer_id}/pause")
async def route_buffer_pause(buffer_id: str, request: Request):
    st = get_state(request)
    try:
        st.rolling_buffers.pause(buffer_id)
    except UnknownBuffer:
        raise HTTPException(status_code=404, detail=f"unknown buffer: {buffer_id}")
    return {"ok": True}


@app.post("/buffer/{buffer_id}/stop")
async def route_buffer_stop(buffer_id: str, request: Request):
    st = get_state(request)
    try:
        data, meta = await st.rolling_buffers.stop(buffer_id)
    except UnknownBuffer:
        raise HTTPException(status_code=404, detail=f"unknown buffer: {buffer_id}")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "X-CTTC-Source-Count": str(len(meta)),
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Expose-Headers": "X-CTTC-Source-Count",
        },
    )


@app.post("/session/start")
async def route_session_start(request: Request):
    """Start an on-demand recording session (see recording_session.py).
    Returns the session_id immediately -- the client polls
    /session/{id}/status until "completed", then GETs /session/{id}/download
    for the .cttc-record bytes."""
    body = await request.json() if await request.body() else {}
    st = get_state(request)
    session_id = st.recording_sessions.start(
        duration_minutes=float(body["duration_minutes"]) if "duration_minutes" in body else None,
        safe=bool(body.get("safe", False)),
        max_keep_seconds=float(body["max_keep_seconds"]) if body.get("max_keep_seconds") else None,
    )
    return {"session_id": session_id}


@app.post("/session/{session_id}/stop")
async def route_session_stop(session_id: str, request: Request):
    st = get_state(request)
    try:
        await st.recording_sessions.stop(session_id)
    except UnknownSession:
        raise HTTPException(status_code=404, detail=f"unknown session: {session_id}")
    return {"ok": True}


@app.post("/session/{session_id}/safe")
async def route_session_safe(session_id: str, request: Request):
    """Flag a session as safe from the default TTL sweep, kept instead for
    up to `max_keep_seconds` from completion -- call this when a recording
    is expected to (or already did) run longer than the gateway's default
    retention window, so it isn't erased before the client collects it."""
    body = await request.json()
    st = get_state(request)
    try:
        st.recording_sessions.mark_safe(session_id, float(body["max_keep_seconds"]))
    except UnknownSession:
        raise HTTPException(status_code=404, detail=f"unknown session: {session_id}")
    return {"ok": True}


@app.get("/session/{session_id}/status")
async def route_session_status(session_id: str, request: Request):
    st = get_state(request)
    try:
        return st.recording_sessions.status_of(session_id)
    except UnknownSession:
        raise HTTPException(status_code=404, detail=f"unknown session: {session_id}")


@app.get("/session/{session_id}/download")
async def route_session_download(session_id: str, request: Request):
    st = get_state(request)
    try:
        data = st.recording_sessions.download(session_id)
    except UnknownSession:
        raise HTTPException(
            status_code=404, detail=f"unknown or not-yet-completed session: {session_id}"
        )
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{session_id}{RECORD_EXT}"',
            "Access-Control-Allow-Origin": "*",
        },
    )


@app.post("/session/ttl")
async def route_session_ttl(request: Request):
    """Set the gateway's default retention TTL (seconds) for completed
    recording sessions not flagged safe -- 24h unless a client changes it
    here (see recording_session.py's module docstring)."""
    body = await request.json()
    st = get_state(request)
    st.recording_sessions.set_default_ttl(float(body["seconds"]))
    return {"ok": True}


@app.post("/logs/ttl")
async def route_logs_ttl(request: Request):
    """Set the gateway's retention TTL (seconds) for the durable Redis-backed
    log/telemetry store (see redis_log.py) -- default 3 days. Applies to
    future writes *and* re-applies to every already-stored entry (a no-op,
    like the rest of redis_log, when the durable store is disabled)."""
    body = await request.json()
    st = get_state(request)
    await st.redis_log.set_ttl(float(body["seconds"]))
    return {"ok": True}


@app.post("/scheduler/create")
async def route_scheduler_create(request: Request):
    """Register a schedule -- give exactly one of `start_at` (epoch ms,
    one-shot) or `cron` (a 5-field cron expression, recurring). Returns the
    schedule_id; poll /scheduler/{id} to discover each fired occurrence's
    session_id as it's triggered, then poll/download it via the ordinary
    /session/* endpoints."""
    body = await request.json()
    st = get_state(request)
    try:
        schedule_id = st.scheduler.create(
            duration_minutes=float(body["duration_minutes"]),
            start_at=float(body["start_at"]) if body.get("start_at") is not None else None,
            cron=body.get("cron"),
            safe=bool(body.get("safe", False)),
            max_keep_seconds=float(body["max_keep_seconds"])
            if body.get("max_keep_seconds")
            else None,
        )
    except InvalidSchedule as e:
        raise bad_request(str(e))
    return {"schedule_id": schedule_id}


@app.get("/scheduler/{schedule_id}")
async def route_scheduler_status(schedule_id: str, request: Request):
    st = get_state(request)
    try:
        return st.scheduler.status_of(schedule_id)
    except UnknownSchedule:
        raise HTTPException(status_code=404, detail=f"unknown schedule: {schedule_id}")


@app.post("/scheduler/{schedule_id}/cancel")
async def route_scheduler_cancel(schedule_id: str, request: Request):
    st = get_state(request)
    try:
        st.scheduler.cancel(schedule_id)
    except UnknownSchedule:
        raise HTTPException(status_code=404, detail=f"unknown schedule: {schedule_id}")
    return {"ok": True}


def _parse_condition(body: dict):
    ctype = body.get("type")
    if ctype == "metric":
        return MetricCondition(
            metric=body["metric"], op=body["op"], threshold=float(body["threshold"])
        )
    if ctype == "log":
        return LogCondition(pattern=body["pattern"])
    raise bad_request(f"condition.type must be 'metric' or 'log', got {ctype!r}")


def _parse_action(body: dict) -> Action:
    kind = body.get("kind")
    if kind not in ("snapshot", "recording"):
        raise bad_request(f"action.kind must be 'snapshot' or 'recording', got {kind!r}")
    return Action(
        kind=kind,
        minutes=float(body["minutes"]) if body.get("minutes") is not None else None,
        duration_minutes=float(body["duration_minutes"])
        if body.get("duration_minutes") is not None
        else None,
        safe=bool(body.get("safe", False)),
        max_keep_seconds=float(body["max_keep_seconds"]) if body.get("max_keep_seconds") else None,
    )


@app.post("/events/create")
async def route_events_create(request: Request):
    """Register a gateway-hosted event -- see events.py's module docstring.
    `source_ids` picks which systems are watched (omit/empty for every
    currently-open source); `conditions` is a non-empty list of
    `{"type": "metric", "metric": "cpu"|"mem"|"net", "op": ">"|"<"|">="|"<="|"=",
    "threshold": N}` and/or `{"type": "log", "pattern": "<regex>"}`;
    `match` ("any", the default, or "all") picks whether one or every
    condition must hold; `action` is either
    `{"kind": "snapshot", "minutes": N, ...}` or
    `{"kind": "recording", "duration_minutes": N, ...}` (both accept the
    same `safe`/`max_keep_seconds` as /session/*)."""
    body = await request.json()
    st = get_state(request)
    try:
        conditions = [_parse_condition(c) for c in body.get("conditions") or []]
        action = _parse_action(body.get("action") or {})
        event_id = await st.events.create(
            name=body.get("name", ""),
            source_ids=set(body.get("source_ids") or []),
            conditions=conditions,
            action=action,
            match=body.get("match", "any"),
        )
    except InvalidEvent as e:
        raise bad_request(str(e))
    except (KeyError, TypeError) as e:
        raise bad_request(f"malformed event request: {e}")
    return {"event_id": event_id}


@app.get("/events/list")
async def route_events_list(request: Request):
    # NOT "/events" -- that path is already the SSE stream (see route_events
    # above, `new EventSource(API + "/events")` in app.js); registering
    # another handler on the exact same path would shadow one of them (a
    # plain fetch() to a live SSE stream never resolves .json(), which is
    # exactly the silent-hang bug this comment is here to keep from
    # regressing -- see the events.py feature's own event listing, unrelated
    # to this file's live-update SSE "events").
    st = get_state(request)
    return {"event_ids": st.events.list_ids()}


@app.get("/events/{event_id}")
async def route_events_status(event_id: str, request: Request):
    st = get_state(request)
    try:
        return st.events.status_of(event_id)
    except UnknownEvent:
        raise HTTPException(status_code=404, detail=f"unknown event: {event_id}")


@app.post("/events/{event_id}/enable")
async def route_events_enable(event_id: str, request: Request):
    st = get_state(request)
    try:
        st.events.enable(event_id)
    except UnknownEvent:
        raise HTTPException(status_code=404, detail=f"unknown event: {event_id}")
    return {"ok": True}


@app.post("/events/{event_id}/disable")
async def route_events_disable(event_id: str, request: Request):
    st = get_state(request)
    try:
        st.events.disable(event_id)
    except UnknownEvent:
        raise HTTPException(status_code=404, detail=f"unknown event: {event_id}")
    return {"ok": True}


@app.post("/events/{event_id}/reset")
async def route_events_reset(event_id: str, request: Request):
    st = get_state(request)
    try:
        st.events.reset(event_id)
    except UnknownEvent:
        raise HTTPException(status_code=404, detail=f"unknown event: {event_id}")
    return {"ok": True}


@app.post("/events/{event_id}/update")
async def route_events_update(event_id: str, request: Request):
    """Edit Event: change an existing event in place (same id, same
    trigger history). Same body shape as /events/create, but every field
    is optional -- only the ones present are changed (see
    EventManager.update)."""
    body = await request.json()
    st = get_state(request)
    try:
        await st.events.update(
            event_id,
            name=body.get("name"),
            source_ids=set(body["source_ids"]) if "source_ids" in body else None,
            conditions=[_parse_condition(c) for c in body["conditions"]]
            if "conditions" in body
            else None,
            action=_parse_action(body["action"]) if "action" in body else None,
            match=body.get("match"),
        )
    except UnknownEvent:
        raise HTTPException(status_code=404, detail=f"unknown event: {event_id}")
    except InvalidEvent as e:
        raise bad_request(str(e))
    except (KeyError, TypeError) as e:
        raise bad_request(f"malformed event request: {e}")
    return {"ok": True}


@app.post("/events/{event_id}/cancel")
async def route_events_cancel(event_id: str, request: Request):
    st = get_state(request)
    try:
        await st.events.cancel(event_id)
    except UnknownEvent:
        raise HTTPException(status_code=404, detail=f"unknown event: {event_id}")
    return {"ok": True}


@app.post("/docker/ps")
async def route_docker_ps(request: Request):
    body = await request.json() if await request.body() else {}
    host = body.get("host") or None
    ssh_key = body.get("ssh_key") or None
    return await docker_ps(host, ssh_key)


@app.post("/docker/collect")
async def route_docker_collect(request: Request):
    body = await request.json()
    st = get_state(request)
    host = body.get("host") or None
    ssh_key = body.get("ssh_key") or None
    opened = st.collect_docker(
        host,
        bool(body.get("stats", True)),
        body.get("logs", []),
        body.get("transforms", []),
        float(body.get("interval", 5)),
        bool(body.get("host_stats", True)),
        ssh_key,
    )
    st.broadcast({"type": "sources"})
    return {"opened": opened, "sources": await st.describe()}


@app.post("/docker/forget")
async def route_docker_forget(request: Request):
    """br-REDIS-017: the counterpart to /docker/collect's remember_daemon --
    without this, Remove Docker Host only ever closed the in-memory sources
    (see /close), leaving the Redis-side registry entry to be silently
    replayed and reconnected on the gateway's own next restart."""
    body = await request.json()
    st = get_state(request)
    host = normalize_docker_host(body.get("host") or None)
    await st.redis_log.forget_daemon(host)
    return {"ok": True}


@app.post("/files/upload")
async def route_files_upload(request: Request):
    data = await request.body()
    filename = request.headers.get("X-CTTC-Filename") or "upload"
    transforms = [t for t in (request.headers.get("X-CTTC-Transforms") or "").split(",") if t]
    segment_raw = request.headers.get("X-CTTC-Segment")
    segment = int(segment_raw) if segment_raw not in (None, "") else None
    st = get_state(request)
    needs_selection = []
    try:
        opened = await files.upload_and_open(st, filename, data, transforms, segment=segment)
        errors = []
    except MultiSegmentSample as e:
        opened, errors = [], []
        needs_selection.append({"path": filename, "segments": e.segments})
    except Exception as e:
        opened, errors = [], [{"path": filename, "error": str(e)}]
    if opened:
        st.broadcast({"type": "sources"})
    return {
        "opened": opened,
        "errors": errors,
        "needs_selection": needs_selection,
        "sources": await st.describe(),
    }


@app.post("/shutdown")
async def route_shutdown(request: Request):
    server = request.app.state.uvicorn_server

    async def _stop():
        await asyncio.sleep(0.1)
        server.should_exit = True

    asyncio.ensure_future(_stop())
    return {"ok": True}


def main():
    logging.basicConfig(
        level=logging.DEBUG if os.environ.get("CTTC_DEBUG") else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument(
        "--host",
        default="127.0.0.1",
        help="bind address -- 0.0.0.0 for a container/remote-server deployment "
        "the client reaches directly over HTTP (see docker-compose.yml)",
    )
    ap.add_argument("--transforms-dir", default=str(Path(__file__).parent / "transforms"))
    ap.add_argument(
        "--sessions-dir",
        default=str(Path(__file__).parent / "sessions"),
        help="where recording_session.py stores completed .cttc-record files "
        "awaiting client collection",
    )
    ap.add_argument(
        "--naive-tz",
        choices=["utc", "local"],
        default="utc",
        help="timezone assumed for timestamps that carry no offset",
    )
    ap.add_argument("--static", action="store_true", help="open files without tailing")
    ap.add_argument(
        "--redis-port",
        type=int,
        default=redis_log.DEFAULT_TCP_PORT,
        help="TCP port for the bundled Redis instance (see redis_log.py) -- bound to "
        "127.0.0.1 only, for pointing an external tool (redis-cli, RedisInsight) at it "
        "to inspect the store; the unix socket used for everything server.py itself does "
        "is unaffected by this",
    )
    ap.add_argument(
        "--auto-collect",
        action="store_true",
        help="start collecting local Docker + local host telemetry immediately on boot "
        "(and reconnect any remote hosts remembered in the Redis-backed daemon registry, "
        "see redis_log.py), instead of waiting for a client's /docker/collect. Set by the "
        "containerized gateway image's own entrypoint; off by default for the bare/embedded "
        "process (see main.js) and for tests, where an unprompted background collector "
        "would be a surprise.",
    )
    ap.add_argument(
        "--api-token",
        default=os.environ.get("CTTC_API_TOKEN"),
        help="shared-secret required (as the X-CTTC-Token header) on every request when "
        "set -- see _require_api_token (br-NET-004). Read from CTTC_API_TOKEN by default "
        "so main.js's docker-compose invocations (which set the env var, not this flag "
        "directly) and a bare `uv run server.py` both pick it up the same way. Unset for "
        "the bare/embedded 127.0.0.1-only path, which was never network-reachable in the "
        "first place.",
    )
    ap.add_argument("files", nargs="*")
    args = ap.parse_args()

    global NAIVE_TZ
    if args.naive_tz == "local":
        NAIVE_TZ = datetime.now().astimezone().tzinfo

    asyncio.run(_run(args))


async def _run(args):
    import socket as _socket

    state = State(
        Path(args.transforms_dir), Path(args.sessions_dir), redis_tcp_port=args.redis_port
    )
    app.state.cttc = state
    app.state.auto_collect = args.auto_collect
    app.state.api_token = args.api_token
    # Opened by lifespan() itself, *after* redis_log.start() -- see its own
    # comment there for why this can't happen here anymore.
    app.state.cli_files = [(f, not args.static) for f in args.files]

    # Bind our own socket first so the *actual* port (when --port 0 asks for
    # any free one) is known before uvicorn starts serving -- main.js reads
    # exactly one {"port": N} json line from stdout to learn it.
    sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
    sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    sock.bind((args.host, args.port))
    sock.listen(128)
    port = sock.getsockname()[1]

    config = uvicorn.Config(app, fd=sock.fileno(), log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    app.state.uvicorn_server = server

    logger.info("transforms loaded from %s", args.transforms_dir)
    sys.stdout.write(jdumps({"port": port, "json": JSON_IMPL}).decode() + "\n")
    sys.stdout.flush()
    logger.info("listening on %s:%d", args.host, port)

    asyncio.ensure_future(tail_loop(state))
    asyncio.ensure_future(sessions_loop(state))
    try:
        await server.serve()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
