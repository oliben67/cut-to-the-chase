#!/usr/bin/env python3
"""CTTC timeline server.

Ingests container telemetry (docker stats JSONL / JSON array) and service log
files (docker logs -t, JSONL, plain text), normalizes every record to
{uid, ts, text, fields}, optionally passes log records through user-written
transform modules, and serves time-bucketed series + indexed log rows over a
local HTTP API with SSE change notifications for live-tailed files.

Run:  uv run server.py [--port 0] [--transforms-dir transforms] [file ...]
Prints one JSON line {"port": N} on stdout once listening.
"""

from __future__ import annotations

import argparse
import base64
import bisect
import hashlib
import importlib.util
import io
import logging
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer as _ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import files  # local sibling module (server/files.py) -- upload/download endpoints

# stdout is reserved for exactly one line -- the {"port": N} json main.js
# reads to know we're listening (see main()) -- so all logging goes to
# stderr, which main.js already pipes into its own console (and, via
# mainError/broadcastLog, into every window's DevTools console too).
logger = logging.getLogger("cttc")

try:
    import orjson

    def jloads(s):
        return orjson.loads(s)

    def jdumps(obj) -> bytes:
        return orjson.dumps(obj)

    JSON_IMPL = "orjson"
except ImportError:  # degraded but functional
    import json

    def jloads(s):
        return json.loads(s)

    def jdumps(obj) -> bytes:
        return json.dumps(obj, separators=(",", ":")).encode()

    JSON_IMPL = "stdlib-json"


# ── timestamp / size parsing ─────────────────────────────────────────────────

ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})"
    r"(?:[.,](\d{1,9}))?\s*(Z|[+-]\d{2}:?\d{2})?"
)

NAIVE_TZ = timezone.utc  # overridden by --naive-tz local


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
        tz = timezone.utc
    else:
        sign = 1 if off[0] == "+" else -1
        hh, mm = int(off[1:3]), int(off[-2:])
        tz = timezone(sign * (datetime.min.resolution * 0 or __import__("datetime").timedelta(hours=hh, minutes=mm)))
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
    except (ValueError, AttributeError):
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
                        doc = line.strip('"\'# ')
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
    kind = "log"

    def __init__(self, sid: str, name: str, path: Path, live: bool, transforms):
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
        self.lock = threading.Lock()
        self._pending_partial = b""

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
                with self.lock:
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
            with self.lock:
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
        return {"ts": ts, "text": text, "fields": fields if isinstance(fields, dict) else {}, "source": self.name}

    # API helpers
    def total(self) -> int:
        with self.lock:
            return len(self.rows)

    def slice(self, start: int, count: int):
        with self.lock:
            rows = self.rows[max(0, start) : max(0, start) + count]
            return [{"i": max(0, start) + i, "ts": r[0], "uid": r[2], "text": r[3]} for i, r in enumerate(rows)]

    def index_at(self, t: float) -> int:
        with self.lock:
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
        with self.lock:
            lo = bisect.bisect_left(self.rows, (t0,))
            hi = bisect.bisect_right(self.rows, (t1 + 1,))
            for ts, *_ in self.rows[lo:hi]:
                b = int((ts - t0) / dt)
                if 0 <= b < px:
                    counts[b] += 1
        return counts

    def range(self):
        with self.lock:
            if not self.rows:
                return None
            return (self.rows[0][0], self.rows[-1][0])

    def find(self, query: str, start: int, forward: bool = True) -> int | None:
        """Case-insensitive substring search, wrapping around the whole log."""
        q = query.strip().lower()
        if not q:
            return None
        with self.lock:
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

    kind = "stats"
    is_host = False  # host-level telemetry renders in its own strip group

    def __init__(self, sid: str, name: str, path: Path, live: bool):
        self.id = sid
        self.name = name
        self.path = path
        self.live = live
        self.offset = 0
        self.skipped = 0
        self.count = 0
        self.lock = threading.Lock()
        self._pending_partial = b""
        # per service: sorted [(ts, cpu%, mem%, mem_bytes, net_rate_Bps)]
        self.series: dict[str, list[tuple]] = {}
        # services whose samples came from dotted instance names (swarm tasks)
        self._swarm: set[str] = set()
        # per container instance: last (ts, rx_total, tx_total) for rate calc
        self._net_prev: dict[str, tuple] = {}

    def ingest_chunk(self, data: bytes):
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
        service = name.split(".")[0]
        if service != name:
            self._swarm.add(service)
        cpu = parse_pct(e.get("CPUPerc", ""))
        mem = parse_pct(e.get("MemPerc", ""))
        mem_bytes = None
        if isinstance(e.get("MemUsage"), str):
            mem_bytes = parse_size(e["MemUsage"].split("/")[0])
        rate = self._net_rate(name, ts, e.get("NetIO"))
        with self.lock:
            lst = self.series.setdefault(service, [])
            row = (ts, cpu, mem, mem_bytes, rate)
            if not lst or ts >= lst[-1][0]:
                lst.append(row)
            else:
                bisect.insort(lst, row)
            self.count += 1
        return 1

    def _net_rate(self, container: str, ts: float, netio) -> float | None:
        if not isinstance(netio, str) or "/" not in netio:
            return None
        rx_s, tx_s = netio.split("/", 1)
        rx, tx = parse_size(rx_s), parse_size(tx_s)
        if rx is None or tx is None:
            return None
        prev = self._net_prev.get(container)
        self._net_prev[container] = (ts, rx, tx)
        if prev is None or ts <= prev[0]:
            return None
        d = (rx - prev[1]) + (tx - prev[2])
        if d < 0:  # counter reset (container restart)
            return None
        return d / ((ts - prev[0]) / 1000.0)

    def services(self):
        with self.lock:
            return sorted(self.series.keys())

    def range(self):
        with self.lock:
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
        with self.lock:
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
                out.append({
                    "name": svc, "cpu": cpu, "mem": mem, "net": net,
                    "host": self.is_host, "sid": self.id,
                    "ttype": "service" if svc in self._swarm else "container",
                })
        return out

    def point_at(self, t: float):
        """Per service, the single sample nearest time t — used to compare an
        arbitrary point (e.g. a loaded sample) against another point (e.g.
        live 'now') regardless of the current chart zoom window."""
        with self.lock:
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
                    "ts": best[0], "cpu": best[1], "mem": best[2],
                    "mem_bytes": best[3], "net": best[4],
                    "host": self.is_host,
                }
            return out


# ── docker collectors (local daemon or ssh://user@host) ──────────────────────

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


def docker_cmd(host: str | None) -> list[str]:
    exe = shutil.which("docker")
    if exe is None:
        raise RuntimeError("docker CLI not found on PATH")
    return [exe] + (["-H", host] if host else [])


_SSH_WRAPPERS: dict[str, str] = {}  # identity file -> wrapper dir (reused)


def ssh_key_env(key: str | None) -> dict | None:
    """Env for docker subprocesses that forces a specific ssh identity file.

    The docker CLI's ssh:// connection helper execs plain `ssh` and offers no
    flag for the identity, so we shim `ssh` on PATH with one that adds -i."""
    if not key:
        return None
    d = _SSH_WRAPPERS.get(key)
    if d is None:
        real = shutil.which("ssh") or "/usr/bin/ssh"
        d = tempfile.mkdtemp(prefix="cttc-ssh-")
        w = Path(d) / "ssh"
        w.write_text(f'#!/bin/sh\nexec "{real}" -i "{key}" -o IdentitiesOnly=yes "$@"\n')
        w.chmod(0o755)
        _SSH_WRAPPERS[key] = d
    env = os.environ.copy()
    env["PATH"] = d + os.pathsep + env.get("PATH", "")
    return env


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


def docker_ps(host: str | None, ssh_key: str | None = None) -> dict:
    """List containers (and swarm services, when the daemon is a manager)."""
    host = normalize_docker_host(host)
    logger.info("docker_ps: host=%s", host or "local")
    base = docker_cmd(host)
    env = ssh_key_env(ssh_key)
    log = []

    def run_logged(args):
        t0 = time.monotonic()
        try:
            out = subprocess.run(args, capture_output=True, text=True, timeout=30, env=env)
        except subprocess.TimeoutExpired:
            log.append({
                "cmd": " ".join(args), "returncode": None,
                "ms": round((time.monotonic() - t0) * 1000),
                "stderr": "timed out after 30s (host unreachable, or hung waiting on an ssh prompt)",
            })
            raise DockerPsError(f"{' '.join(args)} timed out after 30s", log)
        log.append({
            "cmd": " ".join(args),
            "returncode": out.returncode,
            "ms": round((time.monotonic() - t0) * 1000),
            "stderr": out.stderr.strip(),
        })
        return out

    # Preflight: is docker even installed/reachable at all, wherever `host`
    # resolved to (the local daemon docker_cmd(None) runs bare, or the
    # ssh:// target `-H` points at)? Without this, a missing docker install
    # only ever surfaces buried inside `docker ps`'s own connection-error
    # wrapping -- this gives that exact case ("docker not installed there")
    # its own clear, distinguishable message instead.
    probe = run_logged(base + ["version", "--format", "{{.Server.Version}}"])
    if probe.returncode != 0:
        where = host or "the local daemon"
        raise DockerPsError(f"docker is not installed (or not reachable) on {where}: {probe.stderr.strip()}", log)

    out = run_logged(base + ["ps", "--format", "json"])
    if out.returncode != 0:
        raise DockerPsError(out.stderr.strip() or "docker ps failed", log)
    containers = [jloads(line) for line in out.stdout.splitlines() if line.strip()]
    services = []
    svc = run_logged(base + ["service", "ls", "--format", "json"])
    if svc.returncode == 0:
        services = [jloads(line) for line in svc.stdout.splitlines() if line.strip()]
    return {
        "containers": [{"id": c.get("ID"), "name": c.get("Names"), "image": c.get("Image")} for c in containers],
        "services": [{"id": s.get("ID"), "name": s.get("Name"), "replicas": s.get("Replicas")} for s in services],
        "log": log,
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class DockerStatsSource(StatsSource):
    """Polls `docker stats --no-stream` on an interval and feeds itself."""

    def __init__(self, sid: str, name: str, host: str | None, interval: float, state,
                 ssh_key: str | None = None):
        super().__init__(sid, name, path=None, live=True)
        self.path = f"docker://{host or 'local'}/stats"
        self.host = host
        self.interval = interval
        self._state = state
        self._env = ssh_key_env(ssh_key)
        self._stop = threading.Event()
        self.error: str | None = None
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        cmd = docker_cmd(self.host) + ["stats", "--no-stream", "--format", "json"]
        while not self._stop.is_set():
            t_start = time.time()
            try:
                out = subprocess.run(cmd, capture_output=True, text=True,
                                     timeout=max(30, self.interval * 4), env=self._env)
                if out.returncode != 0:
                    self.error = out.stderr.strip()[:500]
                else:
                    self.error = None
                    ts = now_iso()  # stamped when the snapshot returns
                    n = 0
                    for line in out.stdout.splitlines():
                        if not line.strip():
                            continue
                        try:
                            e = jloads(line)
                        except Exception:
                            continue
                        e["timestamp"] = ts
                        n += self._ingest_entry(e)
                    if n:
                        self._state.broadcast({"type": "update", "source": self.id})
            except (subprocess.TimeoutExpired, OSError) as e:
                self.error = str(e)[:500]
            self._stop.wait(max(0.5, self.interval - (time.time() - t_start)))


class HostStatsSource(StatsSource):
    """Host-level CPU/MEM/NET for the docker host: psutil for the local
    machine, /proc read over ssh for ssh:// hosts."""

    is_host = True

    def __init__(self, sid: str, name: str, host: str | None, interval: float, state,
                 ssh_key: str | None = None):
        super().__init__(sid, name, path=None, live=True)
        self.path = f"docker://{host or 'local'}/host"
        self.host = host
        self.interval = interval
        self._state = state
        self._stop = threading.Event()
        self.error: str | None = None
        self._prev = None  # (ts, cpu_busy, cpu_total, net_total) for delta rates
        self._ssh = None
        if host:
            if host.startswith("ssh://"):
                rest = host[len("ssh://") :]
                self._ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
                if ssh_key:
                    self._ssh += ["-i", ssh_key, "-o", "IdentitiesOnly=yes"]
                if ":" in rest.rsplit("@", 1)[-1]:
                    rest, port = rest.rsplit(":", 1)
                    self._ssh += ["-p", port]
                self._ssh.append(rest)
            else:
                self.error = "host telemetry supports the local daemon or ssh:// hosts only"
        threading.Thread(target=self._loop, daemon=True).start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            t_start = time.time()
            if self.error is None or self._ssh is not None:
                try:
                    row = self._sample_ssh() if self._ssh else self._sample_local()
                    self.error = None
                    if row is not None:
                        with self.lock:
                            self.series.setdefault(self.name, []).append(row)
                            self.count += 1
                        self._state.broadcast({"type": "update", "source": self.id})
                except Exception as e:
                    self.error = f"{type(e).__name__}: {e}"[:500]
            self._stop.wait(max(0.5, self.interval - (time.time() - t_start)))

    def _sample_local(self):
        try:
            import psutil
        except ImportError:
            raise RuntimeError("psutil not installed (re-run: uv sync refreshes the venv)")
        ts = time.time() * 1000.0
        cpu = psutil.cpu_percent(interval=None)  # since previous call
        vm = psutil.virtual_memory()
        io = psutil.net_io_counters()
        net_total = io.bytes_recv + io.bytes_sent
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

    def _sample_ssh(self):
        out = subprocess.run(
            self._ssh + ["cat", "/proc/stat", "/proc/meminfo", "/proc/net/dev"],
            capture_output=True, text=True, timeout=max(30, self.interval * 4),
        )
        if out.returncode != 0:
            raise RuntimeError(out.stderr.strip()[:200] or "ssh host sample failed")
        ts = time.time() * 1000.0
        busy = total = None
        mem_total = mem_avail = None
        net_total = 0
        for line in out.stdout.splitlines():
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
                if (len(fields) >= 9 and name and name != "lo"
                        and not name.startswith(("veth", "br-", "docker"))):
                    net_total += float(fields[0]) + float(fields[8])
        cpu = mem = mem_bytes = rate = None
        if mem_total and mem_avail is not None:
            mem = (mem_total - mem_avail) / mem_total * 100.0
            mem_bytes = mem_total - mem_avail
        prev = self._prev
        self._prev = (ts, busy, total, net_total)
        if prev is None:
            return None
        if busy is not None and prev[1] is not None and total > prev[2]:
            cpu = max(0.0, (busy - prev[1]) / (total - prev[2]) * 100.0)
        if ts > prev[0] and net_total >= prev[3]:
            rate = (net_total - prev[3]) / ((ts - prev[0]) / 1000.0)
        return (ts, cpu, mem, mem_bytes, rate)


class DockerLogSource(LogSource):
    """Follows `docker logs -f -t` (or `docker service logs -f -t`)."""

    def __init__(self, sid, name, host, target_type, target, transforms, state, tail=2000,
                 ssh_key: str | None = None):
        super().__init__(sid, name, path=None, live=True, transforms=transforms)
        self.path = f"docker://{host or 'local'}/{target_type}/{target}"
        self._state = state
        self._env = ssh_key_env(ssh_key)
        self._stop = threading.Event()
        self.error: str | None = None
        base = docker_cmd(host)
        sub = ["service", "logs"] if target_type == "service" else ["logs"]
        self._cmd = base + sub + ["-f", "-t", "--tail", str(tail), target]
        threading.Thread(target=self._follow, daemon=True).start()

    def stop(self):
        self._stop.set()
        p = getattr(self, "_proc", None)
        if p is not None:
            p.terminate()

    def _follow(self):
        try:
            self._proc = subprocess.Popen(
                self._cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=self._env
            )
            last_emit = 0.0
            pending = 0
            while not self._stop.is_set():
                chunk = self._proc.stdout.read1(65536)
                if not chunk:
                    if self._proc.poll() is not None:
                        self.error = "log stream ended"
                        self._state.broadcast({"type": "update", "source": self.id})
                        return
                    time.sleep(0.2)
                    continue
                pending += self.ingest_chunk(chunk)
                now = time.time()
                if pending and now - last_emit > 0.5:  # throttle SSE chatter
                    self._state.broadcast({"type": "update", "source": self.id})
                    pending, last_emit = 0, now
        except Exception as e:
            self.error = f"{type(e).__name__}: {e}"[:500]
            self._state.broadcast({"type": "update", "source": self.id})


# ── state, tailing, SSE ──────────────────────────────────────────────────────


class State:
    def __init__(self, transforms_dir: Path):
        self.sources: dict[str, object] = {}
        self.lock = threading.Lock()
        self.registry = TransformRegistry(transforms_dir)
        self.listeners: list[queue.Queue] = []
        self.next_id = 1

    def broadcast(self, event: dict):
        for q in list(self.listeners):
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    def open_file(self, path: str, kind: str, name: str | None, live: bool, transforms: list[str]):
        p = Path(path).expanduser()
        if not p.is_file():
            raise FileNotFoundError(path)
        if kind == "auto":
            kind = sniff_kind(p)
        with self.lock:
            sid = f"s{self.next_id}"
            self.next_id += 1
        label = name or p.stem
        if kind == "stats":
            src = StatsSource(sid, label, p, live)
        else:
            fns = self.registry.load(transforms)
            src = LogSource(sid, label, p, live, fns)
        read_all(src)
        with self.lock:
            self.sources[sid] = src
        logger.info("opened source %s: %s (%s, live=%s)", sid, path, kind, live)
        return src

    def _open_or_reuse(self, path: str, make):
        """Return the id of a source already open at exactly this target
        path, or construct one via make(sid) and register it. The
        check-then-insert happens under one continuous lock hold so two
        concurrent requests for the same target (two clients racing to add
        the same container, or a session-restore racing a manual re-add)
        can never both win and start a second collector polling the same
        thing -- see docs/architecture/remote-server.md's "Single
        collector, multiple viewers": two collectors for one target would
        hand a viewer two slightly-different series for it with no way to
        tell which is real, which breaks the correlation this tool exists
        for, not just duplicate bookkeeping.

        A reused source keeps whatever interval/ssh_key/transforms it was
        originally started with -- a second request's differing settings
        are silently ignored rather than mutating a collector another
        client may already be relying on. Close and reopen it to change
        those."""
        with self.lock:
            for s in self.sources.values():
                if getattr(s, "path", None) == path:
                    return s.id
            sid = f"s{self.next_id}"
            self.next_id += 1
            self.sources[sid] = make(sid)
            return sid

    def collect_docker(self, host: str | None, stats: bool, logs: list[dict],
                       transforms: list[str], interval: float, host_stats: bool = True,
                       ssh_key: str | None = None):
        host = normalize_docker_host(host)
        logger.info("collect_docker: host=%s stats=%s host_stats=%s logs=%d interval=%s",
                 host or "local", stats, host_stats, len(logs), interval)
        opened = []
        hostname = (host or "local").split("@")[-1]
        hostkey = host or "local"
        if stats:
            opened.append(self._open_or_reuse(
                f"docker://{hostkey}/stats",
                lambda sid: DockerStatsSource(sid, f"stats@{hostname}", host, interval, self, ssh_key=ssh_key),
            ))
        if host_stats:
            opened.append(self._open_or_reuse(
                f"docker://{hostkey}/host",
                lambda sid: HostStatsSource(sid, f"host@{hostname}", host, interval, self, ssh_key=ssh_key),
            ))
        for item in logs:
            target = item["name"]
            ttype = item.get("type", "container")
            fns = self.registry.load(transforms)  # loaded eagerly; harmless to discard on reuse
            opened.append(self._open_or_reuse(
                f"docker://{hostkey}/{ttype}/{target}",
                lambda sid, t=target, ty=ttype, f=fns: DockerLogSource(sid, t, host, ty, t, f, self, ssh_key=ssh_key),
            ))
        return opened

    def build_sample_bytes(
        self, t0: float, t1: float, include_host: bool = True
    ) -> tuple[bytes, list[dict]]:
        """Build a .cttc sample's bytes: a zip of per-source log/metric
        slices in [t0, t1] plus a manifest, for every currently open source
        (unless include_host is False, which excludes host-telemetry
        sources). Returns (data, meta); meta's length is the "how many
        sources" count callers report. Split out of export_sample() so
        files.download_sample() (phase 3 of docs/architecture/
        remote-server.md) can hand a client the bytes directly instead of
        writing them to a server-side path."""
        with self.lock:
            items = list(self.sources.values())
        meta = []
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for i, s in enumerate(items):
                if not include_host and getattr(s, "is_host", False):
                    continue
                if s.kind == "log":
                    with s.lock:
                        lo = bisect.bisect_left(s.rows, (t0,))
                        hi = bisect.bisect_right(s.rows, (t1 + 1,))
                        rows = s.rows[lo:hi]
                    if not rows:
                        continue
                    fn = f"logs/{i}.jsonl"
                    z.writestr(fn, b"\n".join(jdumps({"ts": r[0], "text": r[3]}) for r in rows))
                    meta.append({"type": "log", "name": s.name, "file": fn, "count": len(rows)})
                else:
                    with s.lock:
                        ser = {}
                        for svc, lst in s.series.items():
                            lo = bisect.bisect_left(lst, (t0,))
                            hi = bisect.bisect_right(lst, (t1 + 1,))
                            if hi > lo:
                                ser[svc] = lst[lo:hi]
                        swarm = sorted(s._swarm)
                    if not ser:
                        continue
                    fn = f"stats/{i}.json"
                    z.writestr(fn, jdumps({"series": ser, "swarm": swarm}))
                    meta.append({"type": "stats", "name": s.name, "file": fn, "is_host": s.is_host})
            z.writestr("manifest.json", jdumps({
                "version": 1, "from": t0, "to": t1, "created": now_iso(), "sources": meta,
            }))
        return buf.getvalue(), meta

    def export_sample(self, path: str, t0: float, t1: float, include_host: bool = True) -> dict:
        """Write a .cttc sample to a server-side path. See
        build_sample_bytes() for the format."""
        data, meta = self.build_sample_bytes(t0, t1, include_host)
        p = Path(path).expanduser()
        p.write_bytes(data)
        return {"path": str(p), "sources": len(meta)}

    def load_sample(self, path: str) -> list[str]:
        """Open a .cttc sample as a set of static sources."""
        p = Path(path).expanduser()
        opened = []
        raw = p.read_bytes()
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            man = jloads(z.read("manifest.json"))
            for meta in man.get("sources", []):
                with self.lock:
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
                        rows.append((float(e["ts"]), src.seq,
                                     make_uid(meta["name"], src.seq, e.get("text", "")),
                                     str(e.get("text", ""))))
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
                with self.lock:
                    self.sources[sid] = src
                opened.append(sid)
        return opened

    def close_source(self, sid: str):
        with self.lock:
            src = self.sources.pop(sid, None)
        if src is not None and hasattr(src, "stop"):
            src.stop()
        logger.info("closed source %s%s", sid, f" ({src.path})" if src is not None else " (already gone)")

    def describe(self):
        out = []
        with self.lock:
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


def tail_loop(state: State, interval: float = 1.0):
    while True:
        time.sleep(interval)
        with state.lock:
            items = list(state.sources.values())
        for src in items:
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
                    read_all(src)
                except OSError:
                    continue
                state.broadcast({"type": "update", "source": src.id})


# ── HTTP API ─────────────────────────────────────────────────────────────────


class ThreadingHTTPServer(_ThreadingHTTPServer):
    """Keep-alive (HTTP/1.1) connections get closed by the client all the
    time (window reload/close, Electron tearing down a popped-out window,
    the browser recycling an idle socket, ...): the next read on that socket
    then raises ECONNRESET/EPIPE while we're simply waiting for another
    request. That's expected and not a bug, so keep the default traceback
    dump (BaseServer.handle_error) for anything else but swallow these."""

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    state: State = None  # set at startup
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # quiet
        pass

    def _send(self, obj, code=200):
        body = jdumps(obj)
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, data: bytes, filename: str, source_count: int, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-CTTC-Source-Count", str(source_count))
        self.send_header("Access-Control-Allow-Origin", "*")
        # response headers are invisible to cross-origin fetch() reads unless
        # explicitly exposed -- the renderer needs this one for its status line
        self.send_header("Access-Control-Expose-Headers", "X-CTTC-Source-Count, Content-Disposition")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers",
                        "Content-Type, X-CTTC-Filename, X-CTTC-Private-Key, X-CTTC-Transforms")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        st = self.state
        try:
            if u.path == "/sources":
                self._send({"sources": st.describe(), "json_impl": JSON_IMPL})
            elif u.path == "/transforms":
                self._send({"transforms": st.registry.available()})
            elif u.path == "/ssh/keys":
                self._send({"keys": list_ssh_keys()})
            elif u.path == "/range":
                lo = hi = None
                for s in st.describe():
                    if s["min_ts"] is not None:
                        lo = s["min_ts"] if lo is None else min(lo, s["min_ts"])
                        hi = s["max_ts"] if hi is None else max(hi, s["max_ts"])
                self._send({"min_ts": lo, "max_ts": hi})
            elif u.path == "/series":
                t0, t1, px = float(q["from"]), float(q["to"]), int(q.get("px", 800))
                out = []
                with st.lock:
                    items = list(st.sources.values())
                for s in items:
                    if s.kind == "stats":
                        out.extend(s.bucketed(t0, t1, px))
                self._send({"from": t0, "to": t1, "px": px, "services": out})
            elif u.path == "/logs":
                src = self._log_source(q["source"])
                start, count = int(q.get("start", 0)), min(int(q.get("count", 200)), 2000)
                self._send({"total": src.total(), "rows": src.slice(start, count)})
            elif u.path == "/point":
                t = float(q["t"])
                out = {}
                with st.lock:
                    items = list(st.sources.values())
                for s in items:
                    if s.kind == "stats":
                        out.update(s.point_at(t))
                self._send({"t": t, "services": out})
            elif u.path == "/index_at":
                src = self._log_source(q["source"])
                self._send({"index": src.index_at(float(q["t"]))})
            elif u.path == "/ticks":
                src = self._log_source(q["source"])
                t0, t1, px = float(q["from"]), float(q["to"]), int(q.get("px", 800))
                self._send({"counts": src.ticks(t0, t1, px)})
            elif u.path == "/logs/find":
                src = self._log_source(q["source"])
                start = int(q.get("start", 0))
                forward = q.get("dir", "fwd") != "back"
                idx = src.find(q.get("q", ""), start, forward)
                self._send({"index": idx})
            elif u.path == "/events":
                self._sse()
            elif u.path == "/files/download":
                t0, t1 = float(q["from"]), float(q["to"])
                include_host = q.get("include_host", "1").lower() not in ("0", "false")
                data, filename, count = files.download_sample(st, t0, t1, include_host)
                self._send_binary(data, filename, count)
            else:
                self._send({"error": "not found"}, 404)
        except (KeyError, ValueError) as e:
            self._send({"error": f"bad request: {e}"}, 400)
        except BrokenPipeError:
            pass

    def _handle_upload(self):
        """POST /files/upload -- body is the raw file bytes (not JSON), so
        do_POST dispatches here before its generic JSON body parse. Mirrors
        /open's per-file response shape ({opened, errors})."""
        st = self.state
        try:
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length) if length else b""
            filename = self.headers.get("X-CTTC-Filename") or "upload"
            transforms = [t for t in (self.headers.get("X-CTTC-Transforms") or "").split(",") if t]
            try:
                opened = files.upload_and_open(st, filename, data, transforms)
                errors = []
            except Exception as e:
                opened, errors = [], [{"path": filename, "error": str(e)}]
            if opened:
                st.broadcast({"type": "sources"})
            self._send({"opened": opened, "errors": errors, "sources": st.describe()})
        except BrokenPipeError:
            pass

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/files/upload":
            self._handle_upload()
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = jloads(self.rfile.read(length)) if length else {}
        st = self.state
        try:
            if u.path == "/open":
                opened, errors = [], []
                for f in body.get("files", []):
                    try:
                        if str(f["path"]).endswith(".cttc"):
                            opened.extend(st.load_sample(f["path"]))
                            continue
                        src = st.open_file(
                            f["path"],
                            f.get("kind", "auto"),
                            f.get("name"),
                            bool(f.get("live", True)),
                            f.get("transforms", []),
                        )
                        opened.append(src.id)
                    except Exception as e:
                        errors.append({"path": f.get("path"), "error": str(e)})
                st.broadcast({"type": "sources"})
                self._send({"opened": opened, "errors": errors, "sources": st.describe()})
            elif u.path == "/close":
                st.close_source(body.get("id"))
                st.broadcast({"type": "sources"})
                self._send({"ok": True})
            elif u.path == "/sample/export":
                self._send(st.export_sample(
                    body["path"], float(body["from"]), float(body["to"]),
                    bool(body.get("include_host", True)),
                ))
            elif u.path == "/docker/ps":
                self._send(docker_ps(body.get("host") or None, body.get("ssh_key") or None))
            elif u.path == "/docker/collect":
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
                self._send({"opened": opened, "sources": st.describe()})
            elif u.path == "/shutdown":
                self._send({"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                self._send({"error": "not found"}, 404)
        except (KeyError, ValueError) as e:
            logger.warning("bad request on %s: %s", u.path, e)
            self._send({"error": f"bad request: {e}"}, 400)
        except RuntimeError as e:
            # docker_ps/collect_docker raise this for a failed docker/ssh
            # call (bad host, missing key, connection refused, ...) -- must
            # still send a real response, or the client just sees a bare
            # "failed to fetch" instead of the actual ssh/docker error.
            logger.error("%s failed: %s", u.path, e)
            payload = {"error": str(e)}
            if isinstance(e, DockerPsError):
                payload["log"] = e.log
            self._send(payload, 502)

    def _log_source(self, sid):
        with self.state.lock:
            src = self.state.sources.get(sid)
        if src is None or src.kind != "log":
            raise ValueError(f"unknown log source: {sid}")
        return src

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        q: queue.Queue = queue.Queue(maxsize=256)
        self.state.listeners.append(q)
        try:
            while True:
                try:
                    ev = q.get(timeout=15)
                    payload = b"data: " + jdumps(ev) + b"\n\n"
                except queue.Empty:
                    payload = b": keepalive\n\n"
                self.wfile.write(payload)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.state.listeners.remove(q)


def main():
    logging.basicConfig(
        level=logging.DEBUG if os.environ.get("CTTC_DEBUG") else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--transforms-dir", default=str(Path(__file__).parent / "transforms"))
    ap.add_argument("--naive-tz", choices=["utc", "local"], default="utc",
                    help="timezone assumed for timestamps that carry no offset")
    ap.add_argument("--static", action="store_true", help="open files without tailing")
    ap.add_argument("files", nargs="*")
    args = ap.parse_args()

    global NAIVE_TZ
    if args.naive_tz == "local":
        NAIVE_TZ = datetime.now().astimezone().tzinfo

    state = State(Path(args.transforms_dir))
    Handler.state = state
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    threading.Thread(target=tail_loop, args=(state,), daemon=True).start()
    logger.info("transforms loaded from %s", args.transforms_dir)

    for f in args.files:
        try:
            state.open_file(f, "auto", None, live=not args.static, transforms=[])
        except Exception as e:
            logger.warning("could not open %s: %s", f, e)

    sys.stdout.write(jdumps({"port": server.server_address[1], "json": JSON_IMPL}).decode() + "\n")
    sys.stdout.flush()
    logger.info("listening on 127.0.0.1:%d", server.server_address[1])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
