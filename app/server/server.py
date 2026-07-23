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
import bisect
import hashlib
import importlib.util
import io
import logging
import os
import re
import sys
import time
import zipfile
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timezone
from pathlib import Path
from typing import Literal

import docker
import orjson
import uvicorn
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

import files  # local sibling module (server/files.py) -- upload/download endpoints

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
            except OSError:
                pass
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
        self.rows: list[tuple[float, int, str, str]] = []  # (ts, seq, uid, text)
        self.seq = 0
        self.line_no = 0
        self.offset = 0
        self.skipped = 0
        self._pending_partial = b""

    def stop(self):
        pass  # static/file-tailed sources have nothing to tear down

    def ingest_chunk(self, data: bytes):
        data = self._pending_partial + data
        lines = data.split(b"\n")
        self._pending_partial = lines.pop()  # incomplete trailing line, if any
        new = []
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
                if self.rows:
                    ts, seq, uid, text = self.rows[-1]
                    self.rows[-1] = (ts, seq, uid, text + "\n" + raw)
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
            monotonic = not self.rows or new[0][0] >= self.rows[-1][0]
            if monotonic and all(a[0] <= b[0] for a, b in zip(new, new[1:])):
                self.rows.extend(new)
            else:
                for row in new:
                    bisect.insort(self.rows, row)
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
            except Exception:
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

    # API helpers (rows is only ever mutated from ingest_chunk, called either
    # from the single-threaded event loop directly or via loop.call_soon_
    # threadsafe -- never concurrently -- so plain reads here need no lock)
    def total(self) -> int:
        return len(self.rows)

    def slice(self, start: int, count: int):
        rows = self.rows[max(0, start) : max(0, start) + count]
        return [
            {"i": max(0, start) + i, "ts": r[0], "uid": r[2], "text": r[3]}
            for i, r in enumerate(rows)
        ]

    def index_at(self, t: float) -> int:
        i = bisect.bisect_left(self.rows, (t,))
        if i >= len(self.rows):
            return len(self.rows) - 1
        if i > 0 and t - self.rows[i - 1][0] < self.rows[i][0] - t:
            return i - 1
        return i

    def ticks(self, t0: float, t1: float, px: int):
        """Event-density strip: count of entries per pixel bucket."""
        px = max(1, px)
        dt = max(1.0, (t1 - t0) / px)
        counts = [0] * px
        lo = bisect.bisect_left(self.rows, (t0,))
        hi = bisect.bisect_right(self.rows, (t1 + 1,))
        for ts, *_ in self.rows[lo:hi]:
            b = int((ts - t0) / dt)
            if 0 <= b < px:
                counts[b] += 1
        return counts

    def range(self):
        if not self.rows:
            return None
        return (self.rows[0][0], self.rows[-1][0])

    def find(self, query: str, start: int, forward: bool = True) -> int | None:
        """Case-insensitive substring search, wrapping around the whole log."""
        q = query.strip().lower()
        if not q:
            return None
        n = len(self.rows)
        if n == 0:
            return None
        start = max(0, min(start, n - 1))
        order = (
            list(range(start, n)) + list(range(0, start))
            if forward
            else list(range(start, -1, -1)) + list(range(n - 1, start, -1))
        )
        for i in order:
            if q in self.rows[i][3].lower():
                return i
        return None


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
        # per service: sorted [(ts, cpu%, mem%, mem_bytes, net_rate_Bps)]
        self.series: dict[str, list[tuple]] = {}
        # services whose samples came from dotted instance names (swarm tasks)
        self._swarm: set[str] = set()
        # per container instance: last (ts, net_total) for rate calc
        self._net_prev: dict[str, tuple] = {}

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
            except Exception:
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
            except Exception:
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
        land in the same per-service series."""
        service = name.split(".")[0]
        if service != name:
            self._swarm.add(service)
        lst = self.series.setdefault(service, [])
        row = (ts, cpu, mem, mem_bytes, rate)
        if not lst or ts >= lst[-1][0]:
            lst.append(row)
        else:
            bisect.insort(lst, row)
        self.count += 1

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

    def services(self):
        return sorted(self.series.keys())

    def range(self):
        lo = hi = None
        for lst in self.series.values():
            if lst:
                lo = lst[0][0] if lo is None else min(lo, lst[0][0])
                hi = lst[-1][0] if hi is None else max(hi, lst[-1][0])
        return None if lo is None else (lo, hi)

    def bucketed(self, t0: float, t1: float, px: int):
        """Per service, per pixel bucket: max cpu%, max mem%, max net B/s."""
        px = max(1, px)
        dt = max(1.0, (t1 - t0) / px)
        out = []
        for svc in sorted(self.series):
            lst = self.series[svc]
            lo = bisect.bisect_left(lst, (t0,))
            hi = bisect.bisect_right(lst, (t1 + 1,))
            cpu = [None] * px
            mem = [None] * px
            net = [None] * px
            for ts, c, m, _mb, r in lst[lo:hi]:
                b = int((ts - t0) / dt)
                if not (0 <= b < px):
                    continue
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

    def point_at(self, t: float):
        """Per service, the single sample nearest time t — used to compare an
        arbitrary point (e.g. a loaded sample) against another point (e.g.
        live 'now') regardless of the current chart zoom window."""
        out = {}
        for svc, lst in self.series.items():
            if not lst:
                continue
            i = bisect.bisect_left(lst, (t,))
            cands = [lst[i]] if i < len(lst) else []
            if i > 0:
                cands.append(lst[i - 1])
            best = min(cands, key=lambda r: abs(r[0] - t))
            out[svc] = {
                "ts": best[0],
                "cpu": best[1],
                "mem": best[2],
                "mem_bytes": best[3],
                "net": best[4],
                "host": self.is_host,
            }
        return out


Source = LogSource | StatsSource  # everything State.sources can hold


# ── docker connectivity (docker-py + asyncio subprocess) ─────────────────────

_HOST_SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")


def normalize_docker_host(host: str | None) -> str | None:
    """ssh is the only remote transport CTTC supports, so a host string with
    no scheme (e.g. "user@other-server") is unambiguous shorthand for
    ssh://user@other-server. The client already normalizes this (see
    normalizeDockerHost in app.js); this is defense in depth for any other
    caller of the HTTP API."""
    if not host:
        return None
    return host if _HOST_SCHEME_RE.match(host) else f"ssh://{host}"


def docker_client(host: str | None) -> docker.DockerClient:
    """use_ssh_client=True shells out to the system `ssh` binary (same as
    the docker CLI) instead of docker-py's own paramiko-based transport --
    that's what makes this respect the same ssh-agent (SSH_AUTH_SOCK) and
    accept-new host-key policy the rest of the app already relies on."""
    if host:
        return docker.DockerClient(base_url=host, use_ssh_client=True, timeout=15)
    return docker.from_env(timeout=15)


def ssh_host_and_port(host: str) -> tuple[list[str], str]:
    """ssh://user@host[:port] -> (["-p", port] or [], "user@host")."""
    rest = host[len("ssh://") :]
    extra = []
    if ":" in rest.rsplit("@", 1)[-1]:
        rest, port = rest.rsplit(":", 1)
        extra = ["-p", port]
    return extra, rest


def list_ssh_keys() -> list[str]:
    """Private keys under ~/.ssh (files whose header says so)."""
    keys = []
    d = Path.home() / ".ssh"
    if d.is_dir():
        for p in sorted(d.iterdir()):
            if not p.is_file() or p.suffix == ".pub":
                continue
            try:
                with open(p, "rb") as f:
                    head = f.read(80)
            except OSError:
                continue
            if b"PRIVATE KEY" in head:
                keys.append(str(p))
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


async def docker_ps(host: str | None, ssh_key: str | None = None) -> dict:
    """List containers (and swarm services, when the daemon is a manager)."""
    host = normalize_docker_host(host)
    where = host or "local"
    logger.info("docker_ps: host=%s", where)
    log: list = []
    base = ["docker"] + (["-H", host] if host else [])
    t_left = DOCKER_PS_TIMEOUT

    async def run(desc, args):
        nonlocal t_left
        t0 = time.monotonic()
        try:
            return await _run_docker_cli(desc, args, log, max(0.01, t_left))
        finally:
            t_left -= time.monotonic() - t0

    try:
        await run(
            f"docker version @ {where}", base + ["version", "--format", "{{.Server.Version}}"]
        )
    except DockerPsError as e:
        raise DockerPsError(
            f"docker is not installed (or not reachable) on {host or 'the local daemon'}: {e}",
            log,
        )

    ps_out = await run(f"docker ps @ {where}", base + ["ps", "--format", "{{json .}}"])
    containers = [
        {"id": (r := jloads(line))["ID"][:12], "name": r["Names"], "image": r["Image"]}
        for line in ps_out.splitlines()
        if line.strip()
    ]

    services = []
    try:
        svc_out = await run(
            f"docker service ls @ {where}", base + ["service", "ls", "--format", "{{json .}}"]
        )
        services = [
            {"id": (r := jloads(line))["ID"][:12], "name": r["Name"], "replicas": r["Replicas"]}
            for line in svc_out.splitlines()
            if line.strip()
        ]
    except DockerPsError:
        pass  # not a swarm manager -- same tolerance the old `docker service ls` had

    return {"containers": containers, "services": services, "log": log}


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
    """Polls per-container stats snapshots (docker-py) on an interval."""

    def __init__(
        self,
        sid: str,
        name: str,
        host: str | None,
        interval: float,
        state,
        ssh_key: str | None = None,
    ):
        super().__init__(sid, name, path=None, live=True)
        self.path = f"docker://{host or 'local'}/stats"
        self.host = host
        self.interval = interval
        self._state = state
        self.error: str | None = None
        self._task = asyncio.ensure_future(self._loop())

    def stop(self):
        self._task.cancel()

    def _sample_once(self):
        client = docker_client(self.host)
        containers = client.containers.list()
        ts = now_iso()
        ts_ms = time.time() * 1000.0
        n = 0
        for c in containers:
            try:
                raw = c.stats(stream=False)
            except Exception:
                # one container's stats() call failing (removed mid-poll,
                # a transient connection hiccup, ...) must not blank out
                # every other container's sample for this tick
                continue
            cpu, mem, mem_bytes, net_total = _cpu_mem_net_from_raw(raw)
            rate = self._net_rate(c.name, ts_ms, net_total)
            self.ingest_row(c.name, ts_ms, cpu, mem, mem_bytes, rate)
            n += 1
        return n, ts

    async def _loop(self):
        while True:
            t_start = time.time()
            try:
                n, _ts = await asyncio.to_thread(self._sample_once)
                self.error = None
                if n:
                    self._state.broadcast({"type": "update", "source": self.id})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.error = f"{type(e).__name__}: {e}"[:500]
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
        state,
        ssh_key: str | None = None,
    ):
        super().__init__(sid, name, path=None, live=True)
        self.path = f"docker://{host or 'local'}/host"
        self.host = host
        self.interval = interval
        self._state = state
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
    """Follows `docker logs -f -t` (or `docker service logs -f -t`) via an
    asyncio subprocess -- not docker-py: its log-follow is a blocking
    generator with no clean way to abort from another coroutine/thread,
    whereas an asyncio subprocess can just be terminated on stop()."""

    def __init__(
        self,
        sid,
        name,
        host,
        target_type,
        target,
        transforms,
        state,
        tail=2000,
        ssh_key: str | None = None,
    ):
        super().__init__(sid, name, path=None, live=True, transforms=transforms)
        self.path = f"docker://{host or 'local'}/{target_type}/{target}"
        self._state = state
        self.error: str | None = None
        self._proc: asyncio.subprocess.Process | None = None
        exe = "docker"
        base = [exe] + (["-H", host] if host else [])
        sub = ["service", "logs"] if target_type == "service" else ["logs"]
        self._cmd = base + sub + ["-f", "-t", "--tail", str(tail), target]
        self._task = asyncio.ensure_future(self._follow())

    def stop(self):
        if self._proc is not None and self._proc.returncode is None:
            self._proc.terminate()
        self._task.cancel()

    async def _follow(self):
        try:
            self._proc = await asyncio.create_subprocess_exec(
                *self._cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            assert self._proc.stdout is not None  # guaranteed by stdout=PIPE above
            last_emit = 0.0
            pending = 0
            while True:
                # StreamReader.read() blocks until data or true EOF -- unlike
                # the old blocking subprocess.Popen + read1() it replaces,
                # it never returns b"" while the stream is merely idle.
                chunk = await self._proc.stdout.read(65536)
                if not chunk:
                    self.error = "log stream ended"
                    self._state.broadcast({"type": "update", "source": self.id})
                    return
                pending += self.ingest_chunk(chunk)
                now = time.time()
                if pending and now - last_emit > 0.5:  # throttle SSE chatter
                    self._state.broadcast({"type": "update", "source": self.id})
                    pending, last_emit = 0, now
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"[:500]
            self._state.broadcast({"type": "update", "source": self.id})


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
    def __init__(self, transforms_dir: Path):
        self.sources: dict[str, Source] = {}
        self.registry = TransformRegistry(transforms_dir)
        self.listeners: list[asyncio.Queue] = []
        self.next_id = 1

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
            opened.append(
                self._open_or_reuse(
                    f"docker://{hostkey}/stats",
                    lambda sid: DockerStatsSource(
                        sid, f"stats@{hostname}", host, interval, self, ssh_key=ssh_key
                    ),
                )
            )
        if host_stats:
            opened.append(
                self._open_or_reuse(
                    f"docker://{hostkey}/host",
                    lambda sid: HostStatsSource(
                        sid, f"host@{hostname}", host, interval, self, ssh_key=ssh_key
                    ),
                )
            )
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
        return opened

    def _write_segment(
        self, z: zipfile.ZipFile, seg_idx: int, t0: float, t1: float, include_host: bool
    ) -> list[dict]:
        """Write one segment's per-source log/metric slices in [t0, t1] into
        the already-open zip `z`, namespaced under seg{seg_idx}/ so multiple
        segments (recorded across separate Record/Pause spans, possibly
        merged in from an earlier archive -- see merge_sample_bytes) never
        collide on filename. Returns that segment's manifest sources list."""
        meta = []
        for i, s in enumerate(self.sources.values()):
            if not include_host and getattr(s, "is_host", False):
                continue
            if s.kind == "log":
                lo = bisect.bisect_left(s.rows, (t0,))
                hi = bisect.bisect_right(s.rows, (t1 + 1,))
                rows = s.rows[lo:hi]
                if not rows:
                    continue
                fn = f"seg{seg_idx}/logs/{i}.jsonl"
                z.writestr(fn, b"\n".join(jdumps({"ts": r[0], "text": r[3]}) for r in rows))
                meta.append({"type": "log", "name": s.name, "file": fn, "count": len(rows)})
            else:
                ser = {}
                for svc, lst in s.series.items():
                    lo = bisect.bisect_left(lst, (t0,))
                    hi = bisect.bisect_right(lst, (t1 + 1,))
                    if hi > lo:
                        ser[svc] = lst[lo:hi]
                swarm = sorted(s._swarm)
                if not ser:
                    continue
                fn = f"seg{seg_idx}/stats/{i}.json"
                z.writestr(fn, jdumps({"series": ser, "swarm": swarm}))
                meta.append({"type": "stats", "name": s.name, "file": fn, "is_host": s.is_host})
        return meta

    def build_sample_bytes(
        self, t0: float, t1: float, include_host: bool = True
    ) -> tuple[bytes, list[dict]]:
        """Build a one-segment .cttc sample's bytes (the ordinary Capture
        Metrics / --static export path -- see merge_sample_bytes for the
        Recording feature's multi-segment append). Returns (data, meta);
        meta's length is the "how many sources" count callers report."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            meta = self._write_segment(z, 0, t0, t1, include_host)
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

    def merge_sample_bytes(
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
            new_meta = self._write_segment(z, seg_idx, t0, t1, include_host)
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

    def export_sample(self, path: str, t0: float, t1: float, include_host: bool = True) -> dict:
        """Write a .cttc sample to a server-side path. See
        build_sample_bytes() for the format."""
        data, meta = self.build_sample_bytes(t0, t1, include_host)
        p = Path(path).expanduser()
        p.write_bytes(data)
        return {"path": str(p), "sources": len(meta)}

    def load_sample(self, path: str, segment: int | None = None) -> list[str]:
        """Open a .cttc sample as a set of static sources. If it holds more
        than one recorded segment and `segment` isn't given, raises
        MultiSegmentSample (carrying each segment's from/to/created/source
        count) so the caller can ask the user which one to load instead of
        silently picking one."""
        p = Path(path).expanduser()
        opened = []
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
                    rows = []
                    for line in z.read(meta["file"]).splitlines():
                        if not line.strip():
                            continue
                        e = jloads(line)
                        src.seq += 1
                        rows.append(
                            (
                                float(e["ts"]),
                                src.seq,
                                make_uid(meta["name"], src.seq, e.get("text", "")),
                                str(e.get("text", "")),
                            )
                        )
                    rows.sort()
                    src.rows = rows
                else:
                    src = StatsSource(sid, meta["name"], p, live=False)
                    d = jloads(z.read(meta["file"]))
                    src.series = {svc: [tuple(r) for r in lst] for svc, lst in d["series"].items()}
                    src._swarm = set(d.get("swarm", []))
                    src.count = sum(len(v) for v in src.series.values())
                    if meta.get("is_host"):
                        src.is_host = True
                self.sources[sid] = src
                opened.append(sid)
        return opened

    def close_source(self, sid: str):
        src = self.sources.pop(sid, None)
        if src is None:
            logger.info("closed source %s (already gone)", sid)
            return
        src.stop()  # a no-op for static/file-tailed sources, see LogSource/StatsSource.stop
        logger.info("closed source %s (%s)", sid, src.path)

    def describe(self):
        out = []
        items = list(self.sources.values())
        for s in items:
            rng = s.range()
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
            }
            if s.kind == "log":
                d["total"] = s.total()
                d["transforms"] = [n for n, _ in s.transforms]
            else:
                d["total"] = s.count
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
    while True:
        await asyncio.sleep(interval)
        for src in list(state.sources.values()):
            if not src.live or not isinstance(src.path, Path):
                continue
            try:
                size = src.path.stat().st_size
            except OSError:
                continue
            if size < src.offset:  # truncated/rotated: start over
                src.offset = 0
            if size > src.offset:
                try:
                    await asyncio.to_thread(read_all, src)
                except OSError:
                    continue
                state.broadcast({"type": "update", "source": src.id})


# ── HTTP API (FastAPI) ────────────────────────────────────────────────────────


def bad_request(msg: str) -> ValueError:
    """Routes `raise bad_request(...)` for a missing/invalid param -- caught
    by the ValueError exception handler below, which wraps it in the same
    {"error": "bad request: ..."} shape every other 400 already uses."""
    return ValueError(msg)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


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
                "Access-Control-Allow-Headers": "Content-Type, X-CTTC-Filename, X-CTTC-Private-Key, X-CTTC-Transforms",
            },
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


@app.get("/sources")
async def route_sources(request: Request):
    st = get_state(request)
    return {"sources": st.describe(), "json_impl": JSON_IMPL}


@app.get("/transforms")
async def route_transforms(request: Request):
    return {"transforms": get_state(request).registry.available()}


@app.get("/ssh/keys")
async def route_ssh_keys():
    return {"keys": list_ssh_keys()}


@app.get("/range")
async def route_range(request: Request):
    lo = hi = None
    for s in get_state(request).describe():
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
            out.extend(s.bucketed(t0, t1, pxi))
    return {"from": t0, "to": t1, "px": pxi, "services": out}


@app.get("/logs")
async def route_logs(request: Request, source: str = "", start: str = "0", count: str = "200"):
    src = get_log_source(request, source)
    starti, counti = int(start), min(int(count), 2000)
    return {"total": src.total(), "rows": src.slice(starti, counti)}


@app.get("/point")
async def route_point(request: Request, t: str = ""):
    if not t:
        raise bad_request("'t' is required")
    tf = float(t)
    out = {}
    for s in get_state(request).sources.values():
        if s.kind == "stats":
            out.update(s.point_at(tf))
    return {"t": tf, "services": out}


@app.get("/index_at")
async def route_index_at(request: Request, source: str = "", t: str = ""):
    src = get_log_source(request, source)
    if not t:
        raise bad_request("'t' is required")
    return {"index": src.index_at(float(t))}


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
    return {"counts": src.ticks(float(from_), float(to), int(px))}


@app.get("/logs/find")
async def route_logs_find(
    request: Request, source: str = "", q: str = "", start: str = "0", dir: str = "fwd"
):
    src = get_log_source(request, source)
    idx = src.find(q, int(start), dir != "back")
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
    data, filename, count = files.download_sample(st, t0, t1, inc)
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
            if str(f["path"]).endswith(".cttc"):
                opened.extend(st.load_sample(f["path"], segment=f.get("segment")))
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
        "sources": st.describe(),
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
    return st.export_sample(
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
    data, meta, seg_idx = st.merge_sample_bytes(existing or None, t0, t1, inc)
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


@app.post("/docker/ps")
async def route_docker_ps(request: Request):
    body = await request.json() if await request.body() else {}
    return await docker_ps(body.get("host") or None, body.get("ssh_key") or None)


@app.post("/docker/collect")
async def route_docker_collect(request: Request):
    body = await request.json()
    st = get_state(request)
    opened = st.collect_docker(
        body.get("host") or None,
        bool(body.get("stats", True)),
        body.get("logs", []),
        body.get("transforms", []),
        float(body.get("interval", 5)),
        bool(body.get("host_stats", True)),
        body.get("ssh_key") or None,
    )
    st.broadcast({"type": "sources"})
    return {"opened": opened, "sources": st.describe()}


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
        opened = files.upload_and_open(st, filename, data, transforms, segment=segment)
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
        "sources": st.describe(),
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
        "--naive-tz",
        choices=["utc", "local"],
        default="utc",
        help="timezone assumed for timestamps that carry no offset",
    )
    ap.add_argument("--static", action="store_true", help="open files without tailing")
    ap.add_argument("files", nargs="*")
    args = ap.parse_args()

    global NAIVE_TZ
    if args.naive_tz == "local":
        NAIVE_TZ = datetime.now().astimezone().tzinfo

    asyncio.run(_run(args))


async def _run(args):
    import socket as _socket

    state = State(Path(args.transforms_dir))
    app.state.cttc = state

    for f in args.files:
        try:
            state.open_file(f, "auto", None, live=not args.static, transforms=[])
        except Exception as e:
            logger.warning("could not open %s: %s", f, e)

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
    try:
        await server.serve()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
