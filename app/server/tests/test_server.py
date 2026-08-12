"""Exhaustive tests for the CTTC timeline server.

Everything external (docker CLI, ssh, remote hosts) is faked via monkeypatch;
psutil and the HTTP stack are exercised for real. Run:

    uv run --group dev pytest --cov=server --cov-report=term-missing
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import http.client
import io
import json
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import types
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest
import uvicorn
from conftest import unique_redis_tcp_port

import redis_log
import server


def ms(y, mo, d, h=0, mi=0, s=0, us=0, tz=UTC):
    return datetime(y, mo, d, h, mi, s, us, tz).timestamp() * 1000.0


# ── timestamp / size / pct parsing ───────────────────────────────────────────


class TestParseTs:
    def test_basic_z(self):
        assert server.parse_ts("2026-01-02T03:04:05Z") == ms(2026, 1, 2, 3, 4, 5)

    def test_space_separator_and_comma_fraction(self):
        assert server.parse_ts("2026-01-02 03:04:05,5") == ms(2026, 1, 2, 3, 4, 5, 500000)

    def test_docker_nanoseconds_truncated_to_us(self):
        assert server.parse_ts("2026-01-02T03:04:05.123456789Z") == ms(2026, 1, 2, 3, 4, 5, 123456)

    def test_positive_offset_with_colon(self):
        got = server.parse_ts("2026-01-02T03:04:05+02:00")
        assert got == ms(2026, 1, 2, 3, 4, 5, tz=timezone(timedelta(hours=2)))

    def test_negative_offset_without_colon(self):
        got = server.parse_ts("2026-01-02T03:04:05-0530")
        assert got == ms(2026, 1, 2, 3, 4, 5, tz=timezone(timedelta(hours=-5, minutes=-30)))

    def test_naive_uses_naive_tz(self, monkeypatch):
        monkeypatch.setattr(server, "NAIVE_TZ", timezone(timedelta(hours=2)))
        assert server.parse_ts("2026-01-02T03:04:05") == ms(
            2026, 1, 2, 3, 4, 5, tz=timezone(timedelta(hours=2))
        )

    def test_trailing_content_ok(self):
        # parse_ts is used on the first token of docker -t lines
        assert server.parse_ts("2026-01-02T03:04:05Z   ") is not None

    def test_invalid(self):
        assert server.parse_ts("not a date") is None
        assert server.parse_ts("") is None

    def test_impossible_date(self):
        assert server.parse_ts("2026-02-30T00:00:00Z") is None


class TestParseSize:
    @pytest.mark.parametrize(
        "text,expect",
        [
            ("512MiB", 512 * 1024**2),
            ("2KiB", 2048),
            ("1.2kB", 1200.0),
            ("3GB", 3e9),
            ("1.5 MB", 1.5e6),
            ("100B", 100.0),
            ("7", 7.0),
            ("4TiB", 4 * 1024**4),
            ("1PB", 1e15),
        ],
    )
    def test_values(self, text, expect):
        assert server.parse_size(text) == pytest.approx(expect)

    def test_invalid(self):
        assert server.parse_size("abc") is None
        assert server.parse_size("") is None


class TestParsePct:
    def test_values(self):
        assert server.parse_pct("12.5%") == 12.5
        assert server.parse_pct("80") == 80.0

    def test_invalid(self):
        assert server.parse_pct("") is None
        assert server.parse_pct("x%") is None
        assert server.parse_pct(None) is None


def test_make_uid_deterministic():
    a = server.make_uid("src", 1, "line")
    assert len(a) == 16
    assert a == server.make_uid("src", 1, "line")
    assert a != server.make_uid("src", 2, "line")


# ── transforms ───────────────────────────────────────────────────────────────


@pytest.fixture
def tdir(tmp_path):
    d = tmp_path / "transforms"
    d.mkdir()
    return d


class TestTransformRegistry:
    def test_available_reads_docstring_comment_and_code(self, tdir):
        (tdir / "a_doc.py").write_text('"""Docstring here."""\ndef transform(r): return r\n')
        (tdir / "b_comment.py").write_text("# comment doc\ndef transform(r): return r\n")
        (tdir / "c_code.py").write_text("import os\ndef transform(r): return r\n")
        (tdir / "_private.py").write_text("def transform(r): return r\n")
        got = server.TransformRegistry(tdir).available()
        assert [t["name"] for t in got] == ["a_doc", "b_comment", "c_code"]
        assert got[0]["doc"] == "Docstring here."
        assert got[1]["doc"] == "comment doc"
        assert got[2]["doc"] == ""

    def test_available_missing_dir(self, tmp_path):
        assert server.TransformRegistry(tmp_path / "nope").available() == []

    def test_load_ok(self, tdir):
        (tdir / "ok.py").write_text("def transform(r): return r\n")
        fns = server.TransformRegistry(tdir).load(["ok"])
        assert fns[0][0] == "ok" and callable(fns[0][1])

    def test_load_missing(self, tdir):
        with pytest.raises(ValueError, match="not found"):
            server.TransformRegistry(tdir).load(["ghost"])

    def test_load_no_transform_fn(self, tdir):
        (tdir / "bad.py").write_text("x = 1\n")
        with pytest.raises(ValueError, match="no transform"):
            server.TransformRegistry(tdir).load(["bad"])

    def test_available_unreadable_file(self, tdir):
        p = tdir / "locked.py"
        p.write_text('"""Hidden."""\ndef transform(r): return r\n')
        p.chmod(0o000)
        try:
            got = server.TransformRegistry(tdir).available()
            assert got == [{"name": "locked", "doc": ""}]  # listed, doc unreadable
        finally:
            p.chmod(0o644)

    def test_load_spec_failure(self, tdir, monkeypatch):
        (tdir / "weird.py").write_text("def transform(r): return r\n")
        monkeypatch.setattr(server.importlib.util, "spec_from_file_location", lambda *a, **k: None)
        with pytest.raises(ValueError, match="not found"):
            server.TransformRegistry(tdir).load(["weird"])


class TestApplyTransforms:
    def rec(self):
        return {"ts": 1.0, "text": "t", "fields": {}, "source": "s"}

    def test_identity_and_order(self):
        fns = [
            ("one", lambda r: {**r, "text": r["text"] + "1"}),
            ("two", lambda r: {**r, "text": r["text"] + "2"}),
        ]
        out = server.apply_transforms(self.rec(), fns)
        assert [r["text"] for r in out] == ["t12"]

    def test_drop(self):
        assert server.apply_transforms(self.rec(), [("d", lambda r: None)]) == []

    def test_fanout(self):
        out = server.apply_transforms(self.rec(), [("f", lambda r: [r, dict(r)])])
        assert len(out) == 2

    def test_crash_keeps_record_with_error(self):
        def boom(r):
            raise RuntimeError("nope")

        out = server.apply_transforms(self.rec(), [("boom", boom)])
        assert len(out) == 1
        assert "boom: nope" in out[0]["fields"]["_transform_error"]


# ── LogSource ────────────────────────────────────────────────────────────────


async def _flush():
    # ingest_chunk's redis_log.record() enqueues via call_soon_threadsafe
    # and is pumped asynchronously; give the pump a beat before any read
    # that expects the write to already be visible in Redis.
    await asyncio.sleep(0.15)


def _restamp_gateway_id(cttc_path: Path, gateway_id: str) -> None:
    """Test helper: rewrites every source entry's gateway_id in an
    already-exported .cttc's manifest.json, simulating a sample collected
    by a genuinely different gateway install rather than just a different
    file -- the integrity hash is deliberately left stale (load_sample's
    verification is warn-only, see _manifest_hash, not a load-blocking
    gate), so this only needs to touch the one field under test."""
    with zipfile.ZipFile(cttc_path, "r") as z:
        members = {n: z.read(n) for n in z.namelist()}
    man = json.loads(members["manifest.json"])
    for seg in man["segments"]:
        for src in seg["sources"]:
            src["gateway_id"] = gateway_id
    members["manifest.json"] = json.dumps(man).encode()
    with zipfile.ZipFile(cttc_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in members.items():
            z.writestr(name, data)


def log_source(redis_log_instance, transforms=(), sid="s1"):
    src = server.LogSource(
        sid, "svc", Path("/nonexistent"), live=False, transforms=list(transforms)
    )
    src._state = types.SimpleNamespace(redis_log=redis_log_instance)
    return src


async def ingest_and_flush(src, data: bytes) -> int:
    n = src.ingest_chunk(data)
    await _flush()
    return n


class TestLogSource:
    async def test_docker_t_line(self, redis_log_instance):
        src = log_source(redis_log_instance)
        n = await ingest_and_flush(src, b"2026-01-02T03:04:05.000000000Z hello world\n")
        assert n == 1
        row = (await src.slice(0, 10))[0]
        assert row["text"] == "hello world"
        assert row["ts"] == ms(2026, 1, 2, 3, 4, 5)
        assert row["i"] == 0 and len(row["uid"]) == 16

    async def test_swarm_service_prefix_stripped(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b"2026-01-02T03:04:05Z api.1.abc123@node1    | msg here\n")
        assert (await src.slice(0, 1))[0]["text"] == "msg here"

    async def test_json_line_ts_from_fields(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b'{"time": "2026-01-02T03:04:05Z", "msg": "x"}\n')
        assert (await src.slice(0, 1))[0]["ts"] == ms(2026, 1, 2, 3, 4, 5)

    async def test_json_numeric_ts_seconds_and_ms(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b'{"ts": 1700000000}\n{"ts": 1700000000500}\n')
        rows = await src.slice(0, 2)
        assert rows[0]["ts"] == 1700000000000.0
        assert rows[1]["ts"] == 1700000000500.0

    async def test_bad_json_body_ignored(self, redis_log_instance):
        src = log_source(redis_log_instance)
        # looks like JSON but is not parseable, and has a leading timestamp
        await ingest_and_flush(src, b"2026-01-02T03:04:05Z {broken json}\n")
        assert await src.total() == 1

    async def test_continuation_within_batch(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(
            src, b"2026-01-02T03:04:05Z line one\n  at Some.stack(Frame.java:1)\n"
        )
        assert await src.total() == 1
        assert "Frame.java" in (await src.slice(0, 1))[0]["text"]

    async def test_continuation_across_chunks(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b"2026-01-02T03:04:05Z line one\n")
        await ingest_and_flush(src, b"continued\n")
        assert await src.total() == 1
        assert (await src.slice(0, 1))[0]["text"] == "line one\ncontinued"

    async def test_continuation_with_no_previous_is_skipped(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b"no timestamp at all\n")
        assert await src.total() == 0
        assert src.skipped == 1

    async def test_blank_lines_ignored(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b"\n   \n2026-01-02T03:04:05Z x\n")
        assert await src.total() == 1

    async def test_partial_trailing_line_buffered(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b"2026-01-02T03:04:05Z first\n2026-01-02T03:04:06Z par")
        assert await src.total() == 1
        await ingest_and_flush(src, b"tial\n")
        assert await src.total() == 2
        assert (await src.slice(1, 1))[0]["text"] == "partial"

    async def test_out_of_order_chunks_sorted(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b"2026-01-02T03:04:10Z late\n")
        await ingest_and_flush(src, b"2026-01-02T03:04:05Z early\n")
        texts = [r["text"] for r in await src.slice(0, 10)]
        assert texts == ["early", "late"]

    async def test_unsorted_within_chunk_sorted(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b"2026-01-02T03:04:10Z b\n2026-01-02T03:04:05Z a\n")
        assert [r["text"] for r in await src.slice(0, 10)] == ["a", "b"]

    async def test_transform_drop_and_fanout_and_missing_ts(self, redis_log_instance):
        # NOTE: the `dup` fanout below produces two records sharing the
        # exact same source ts -- Redis's schema keys each record by
        # `str(ts)` (see redis_log.py's module docstring), so an exact-ts
        # collision coalesces into a single stored record instead of two
        # (the old RAM version kept both, distinguished only by list
        # position). This is a pre-existing schema property, not something
        # this test can change -- asserted here rather than silently
        # ignored, since a real fanout transform hitting this is worth
        # knowing about.
        drop = ("drop", lambda r: None if "drop" in r["text"] else r)
        dup = ("dup", lambda r: [r, dict(r)])
        nots = ("nots", lambda r: {**r, "ts": None} if "no-ts" in r["text"] else r)
        src = log_source(redis_log_instance, [drop, dup, nots])
        await ingest_and_flush(
            src,
            b"2026-01-02T03:04:05Z keep\n2026-01-02T03:04:06Z drop me\n2026-01-02T03:04:07Z no-ts\n",
        )
        assert (
            await src.total() == 1
        )  # "keep" x2 coalesce (same ts); "drop me" gone; "no-ts" skipped
        assert src.skipped == 2

    async def test_index_at(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(
            src, b"2026-01-02T03:00:00Z a\n2026-01-02T03:00:10Z b\n2026-01-02T03:00:20Z c\n"
        )
        t0 = ms(2026, 1, 2, 3, 0, 0)
        assert await src.index_at(t0 - 1000) == 0
        assert await src.index_at(t0 + 4000) == 0  # nearer to a than b
        assert await src.index_at(t0 + 6000) == 1
        assert await src.index_at(t0 + 99999999) == 2

    async def test_index_at_empty(self, redis_log_instance):
        assert await log_source(redis_log_instance).index_at(0) == -1

    async def test_ticks(self, redis_log_instance):
        src = log_source(redis_log_instance)
        # a/b land in the same 1s bucket without sharing an exact
        # timestamp -- see test_transform_drop_and_fanout_and_missing_ts's
        # note on why an exact-ts collision can't be used here.
        await ingest_and_flush(
            src,
            b"2026-01-02T03:00:00.000000000Z a\n"
            b"2026-01-02T03:00:00.500000000Z b\n"
            b"2026-01-02T03:00:09Z c\n",
        )
        t0 = ms(2026, 1, 2, 3, 0, 0)
        counts = await src.ticks(t0, t0 + 10000, 10)
        assert counts[0] == 2 and counts[9] == 1 and sum(counts) == 3
        assert await src.ticks(t0, t0 + 10000, 0) != []  # px clamped to >= 1

    async def test_range(self, redis_log_instance):
        src = log_source(redis_log_instance)
        assert await src.range() is None
        await ingest_and_flush(src, b"2026-01-02T03:00:00Z a\n2026-01-02T03:00:10Z b\n")
        assert await src.range() == (ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 10))

    async def test_slice_clamps_negative_start(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(src, b"2026-01-02T03:00:00Z a\n")
        assert (await src.slice(-5, 10))[0]["text"] == "a"

    async def test_find_forward_backward_wrap_and_case(self, redis_log_instance):
        src = log_source(redis_log_instance)
        await ingest_and_flush(
            src,
            b"2026-01-02T03:00:00Z Alpha ERROR one\n"
            b"2026-01-02T03:00:01Z beta ok\n"
            b"2026-01-02T03:00:02Z gamma ERROR two\n",
        )
        assert await src.find("error", 0) == 0  # case-insensitive
        assert await src.find("error", 1) == 2  # forward from middle
        assert await src.find("error", 1, forward=False) == 0  # backward from middle
        assert await src.find("ERROR one", 1) == 0  # wraps past the end
        assert await src.find("two", 0, forward=False) == 2  # wraps backward
        assert await src.find("nothing-here", 0) is None
        assert await src.find("   ", 0) is None  # blank query
        got = await src.find("x", 99)
        assert got is None or got >= 0  # start clamped

    async def test_find_empty_log(self, redis_log_instance):
        assert await log_source(redis_log_instance).find("x", 0) is None


# ── StatsSource ──────────────────────────────────────────────────────────────


def stats_entry(name, ts, cpu="10%", mem="20%", memuse="100MiB / 1GiB", netio="1kB / 2kB"):
    return {
        "Name": name,
        "timestamp": ts,
        "CPUPerc": cpu,
        "MemPerc": mem,
        "MemUsage": memuse,
        "NetIO": netio,
    }


def stats_source(redis_log_instance, sid="s2"):
    src = server.StatsSource(sid, "stats", Path("/nonexistent"), live=False)
    src._state = types.SimpleNamespace(redis_log=redis_log_instance)
    return src


async def feed_stats(src, entries):
    payload = "\n".join(json.dumps(e) for e in entries) + "\n"
    n = src.ingest_chunk(payload.encode())
    await _flush()
    return n


async def stats_rows(redis_log_instance, svc, sid="s2"):
    """Redis is the store now (see redis_log.py) -- test stand-in for what
    used to be a direct `src.series[svc]` read. `svc` is the bare/host-
    qualified name a caller would pass to StatsSource._entity_for. `sid`
    must match stats_source()'s own (default "s2") -- a plain StatsSource
    (no `host` attribute at all, unlike the Docker subclasses) is qualified
    by its own id instead, so two unrelated file-based sources sharing a
    service name never interleave (see LogSource._entity's docstring)."""
    rows = await redis_log_instance.range_by_score_with_payload(server._entity_id("stats", svc, sid), 0, 10**15)
    return [(ts, p.get("cpu"), p.get("mem"), p.get("mem_bytes"), p.get("net")) for ts, p in rows]


class TestStatsSource:
    async def test_jsonl_ingest_and_net_rate(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        n = await feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:00Z", netio="1kB / 2kB"),
                stats_entry("api", "2026-01-02T03:00:10Z", netio="2kB / 4kB"),
            ],
        )
        assert n == 2 and src.count == 2
        rows = await stats_rows(redis_log_instance, "api")
        assert rows[0][4] is None  # first sample: no rate yet
        assert rows[1][4] == pytest.approx(300.0)  # 3000 B over 10 s
        assert rows[0][1] == 10.0 and rows[0][2] == 20.0
        assert rows[0][3] == pytest.approx(100 * 1024**2)

    async def test_net_counter_reset_gives_none(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:00Z", netio="9kB / 9kB"),
                stats_entry("api", "2026-01-02T03:00:10Z", netio="1kB / 1kB"),
            ],
        )
        rows = await stats_rows(redis_log_instance, "api")
        assert rows[1][4] is None

    async def test_net_same_timestamp_gives_none(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:00Z"),
                stats_entry("api", "2026-01-02T03:00:00Z", netio="5kB / 5kB"),
            ],
        )
        rows = await stats_rows(redis_log_instance, "api")
        assert rows[-1][4] is None

    async def test_bad_netio_gives_none(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(src, [stats_entry("api", "2026-01-02T03:00:00Z", netio="weird")])
        rows = await stats_rows(redis_log_instance, "api")
        assert rows[0][4] is None

    async def test_unparsable_netio_sides_give_none(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(src, [stats_entry("api", "2026-01-02T03:00:00Z", netio="abc / def")])
        rows = await stats_rows(redis_log_instance, "api")
        assert rows[0][4] is None

    async def test_blank_lines_in_jsonl_ignored(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        n = src.ingest_chunk(
            b"\n   \n" + json.dumps(stats_entry("api", "2026-01-02T03:00:00Z")).encode() + b"\n"
        )
        assert n == 1 and src.skipped == 0

    def test_stop_is_a_no_op(self, redis_log_instance):
        # static/file-tailed StatsSource has nothing to tear down -- just
        # confirms calling it doesn't raise.
        stats_source(redis_log_instance).stop()

    async def test_range_skips_a_service_with_no_data_yet(self, redis_log_instance):
        """_services can include a service that redis_log.first_last()
        returns None for (e.g. its very first sample is still in the write
        queue -- see redis_log.py's record()/_pump split) -- range() must
        skip it rather than choke on a None result."""
        src = stats_source(redis_log_instance)
        await feed_stats(src, [stats_entry("api", "2026-01-02T03:00:00Z")])
        src._services.add("ghost")  # known, but never actually recorded
        assert await src.range() == (ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 0))

    async def test_swarm_grouping_and_detection(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(
            src,
            [
                stats_entry("api.1.abc", "2026-01-02T03:00:00Z"),
                stats_entry("api.2.def", "2026-01-02T03:00:00Z"),
                stats_entry("plain", "2026-01-02T03:00:00Z"),
            ],
        )
        assert src.services() == ["api", "plain"]
        assert src._swarm == {"api"}

    async def test_skips(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        n = src.ingest_chunk(
            b'{"Name": "--", "timestamp": "2026-01-02T03:00:00Z"}\n'
            b'{"Name": "", "timestamp": "2026-01-02T03:00:00Z"}\n'
            b'{"Name": "x"}\n'  # no timestamp
            b"[1, 2]\n"  # not a dict
            b"not json at all\n"
        )
        assert n == 0 and src.count == 0 and src.skipped == 5

    async def test_whole_array_mode(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        payload = json.dumps(
            [
                stats_entry("api", "2026-01-02T03:00:00Z"),
                stats_entry("api", "2026-01-02T03:00:05Z"),
            ]
        ).encode()
        assert src.ingest_chunk(payload) == 2

    async def test_partial_array_buffered(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        payload = json.dumps([stats_entry("api", "2026-01-02T03:00:00Z")]).encode()
        assert src.ingest_chunk(payload[:10]) == 0
        assert src.ingest_chunk(payload[10:]) == 1

    async def test_out_of_order_insort(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:10Z"),
                stats_entry("api", "2026-01-02T03:00:00Z"),
            ],
        )
        rows = await stats_rows(redis_log_instance, "api")
        ts = [r[0] for r in rows]
        assert ts == sorted(ts)

    async def test_services_range_bucketed(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(
            src,
            [
                stats_entry("b", "2026-01-02T03:00:00Z", cpu="10%"),
                stats_entry("b", "2026-01-02T03:00:01Z", cpu="50%"),
                stats_entry("a.1.x", "2026-01-02T03:00:05Z", cpu="30%"),
            ],
        )
        assert src.services() == ["a", "b"]
        lo, hi = await src.range()
        assert lo == ms(2026, 1, 2, 3, 0, 0) and hi == ms(2026, 1, 2, 3, 0, 5)
        out = await src.bucketed(lo, lo + 10000, 5)  # dt = 2 s: both b samples share bucket 0
        by_name = {o["name"]: o for o in out}
        assert by_name["b"]["cpu"][0] == 50.0  # max-merged in one bucket
        assert by_name["a"]["ttype"] == "service"
        assert by_name["b"]["ttype"] == "container"
        assert all(o["host"] is False for o in out)
        assert all(o["sid"] == "s2" for o in out)

    async def test_bucketed_ignores_out_of_window(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(src, [stats_entry("api", "2026-01-02T03:00:00Z")])
        t0 = ms(2026, 1, 2, 4, 0, 0)
        out = await src.bucketed(t0, t0 + 1000, 5)
        assert len(out) == 1  # service listed, but no samples land
        assert all(v is None for v in out[0]["cpu"] + out[0]["mem"] + out[0]["net"])

    async def test_empty_range(self, redis_log_instance):
        assert await stats_source(redis_log_instance).range() is None

    async def test_point_at_nearest(self, redis_log_instance):
        src = stats_source(redis_log_instance)
        await feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:00Z", cpu="10%"),
                stats_entry("api", "2026-01-02T03:00:10Z", cpu="90%"),
            ],
        )
        src._services.add("empty")  # skipped without crashing -- no data recorded
        t0 = ms(2026, 1, 2, 3, 0, 0)
        assert (await src.point_at(t0 + 2000))["api"]["cpu"] == 10.0  # nearest is earlier
        assert (await src.point_at(t0 + 8000))["api"]["cpu"] == 90.0  # nearest is later
        after = (await src.point_at(t0 + 60000))["api"]  # past the end
        assert after["cpu"] == 90.0 and after["ts"] == t0 + 10000
        before = (await src.point_at(t0 - 60000))["api"]  # before the start
        assert before["cpu"] == 10.0
        at_t0 = await src.point_at(t0)
        assert at_t0["api"]["host"] is False
        assert at_t0["api"]["sid"] == src.id  # so callers can host-scope /point the same way as /series
        assert "empty" not in at_t0


# ── sniff_kind / read_all / tail_loop ────────────────────────────────────────


class TestSniffAndTail:
    def test_sniff_kinds(self, tmp_path):
        arr_stats = tmp_path / "a.json"
        arr_stats.write_text('[{"Name": "x", "CPUPerc": "1%"}]')
        arr_log = tmp_path / "b.json"
        arr_log.write_text('["hello"]')
        jsonl_stats = tmp_path / "c.jsonl"
        jsonl_stats.write_text('{"Name": "x", "CPUPerc": "1%"}\n')
        plain = tmp_path / "d.log"
        plain.write_text("2026-01-02T03:00:00Z hi\n")
        assert server.sniff_kind(arr_stats) == "stats"
        assert server.sniff_kind(arr_log) == "log"
        assert server.sniff_kind(jsonl_stats) == "stats"
        assert server.sniff_kind(plain) == "log"

    async def test_tail_loop_appends_truncates_and_skips(self, tmp_path):
        f = tmp_path / "t.log"
        f.write_text("2026-01-02T03:00:00Z one\n")
        st = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        await st.redis_log.start()
        src = st.open_file(str(f), "log", None, live=True, transforms=[])
        # non-Path source and vanished file are skipped without crashing
        st.sources["fake"] = types.SimpleNamespace(live=True, path="docker://x")
        gone = tmp_path / "gone.log"
        gone.write_text("2026-01-02T03:00:00Z bye\n")
        gsrc = st.open_file(str(gone), "log", None, live=True, transforms=[])
        gone.unlink()

        task = asyncio.ensure_future(server.tail_loop(st, 0.03))
        try:
            with open(f, "a") as fh:
                fh.write("2026-01-02T03:00:01Z two\n")
            deadline = time.time() + 3
            while await src.total() < 2 and time.time() < deadline:
                await asyncio.sleep(0.05)
            assert await src.total() == 2

            f.write_text("2026-01-02T03:00:02Z rewritten\n")  # truncation -> re-read
            deadline = time.time() + 3
            while await src.total() < 3 and time.time() < deadline:
                await asyncio.sleep(0.05)
            assert await src.total() == 3
            assert await gsrc.total() == 1  # unchanged, stat() failed quietly
        finally:
            task.cancel()
            await st.redis_log.stop()

    async def test_tail_loop_survives_read_failure(self, tmp_path, monkeypatch):
        f = tmp_path / "r.log"
        f.write_text("2026-01-02T03:00:00Z one\n")
        st = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        await st.redis_log.start()
        src = st.open_file(str(f), "log", None, live=True, transforms=[])

        def broken_read(_src):
            raise OSError("disk on fire")

        monkeypatch.setattr(server, "read_all", broken_read)
        task = asyncio.ensure_future(server.tail_loop(st, 0.03))
        try:
            with open(f, "a") as fh:
                fh.write("2026-01-02T03:00:01Z two\n")
            await asyncio.sleep(0.3)  # loop hits OSError and keeps running
            assert await src.total() == 1
        finally:
            task.cancel()
            await st.redis_log.stop()

    async def test_tail_loop_survives_a_non_oserror_failure_on_one_source(self, tmp_path, monkeypatch):
        # br-ORCH-005: only OSError used to be caught per-source -- any other
        # exception (a malformed transform raising inside ingest_chunk, say)
        # propagated out of the for-loop and killed tail_loop's `while True`
        # outright, silently stopping log tailing for every OTHER live file
        # source too, for the rest of the gateway's uptime.
        broken_path = tmp_path / "broken.log"
        broken_path.write_text("2026-01-02T03:00:00Z one\n")
        healthy_path = tmp_path / "healthy.log"
        healthy_path.write_text("2026-01-02T03:00:00Z one\n")
        st = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        await st.redis_log.start()
        broken_src = st.open_file(str(broken_path), "log", None, live=True, transforms=[])
        healthy_src = st.open_file(str(healthy_path), "log", None, live=True, transforms=[])

        real_read_all = server.read_all

        def flaky_read(src):
            if src is broken_src:
                raise ValueError("malformed transform blew up mid-ingest")
            return real_read_all(src)

        monkeypatch.setattr(server, "read_all", flaky_read)
        task = asyncio.ensure_future(server.tail_loop(st, 0.03))
        try:
            with open(broken_path, "a") as fh:
                fh.write("2026-01-02T03:00:01Z two\n")
            with open(healthy_path, "a") as fh:
                fh.write("2026-01-02T03:00:01Z two\n")
            deadline = time.time() + 3
            while await healthy_src.total() < 2 and time.time() < deadline:
                await asyncio.sleep(0.05)
            # the broken source's ValueError must not have killed the loop --
            # the healthy source, ticked in the same and later iterations,
            # still picked up its own growth.
            assert await healthy_src.total() == 2
            assert await broken_src.total() == 1  # never advanced past its failure, but didn't crash anything else
        finally:
            task.cancel()
            await st.redis_log.stop()


# ── ssh helpers ──────────────────────────────────────────────────────────────


class TestSshHelpers:
    def test_ssh_host_and_port(self):
        assert server.ssh_host_and_port("ssh://user@host") == ([], "user@host")
        assert server.ssh_host_and_port("ssh://user@host:2222") == (["-p", "2222"], "user@host")

    def test_list_ssh_keys(self, tmp_path, monkeypatch):
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        assert server.list_ssh_keys() == []  # no ~/.ssh at all
        d = tmp_path / ".ssh"
        d.mkdir()
        (d / "id_ed25519").write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n...")
        (d / "id_ed25519.pub").write_text("ssh-ed25519 AAA")
        (d / "config").write_text("Host *\n")
        (d / "known_hosts").write_text("github.com ssh-rsa AAA")
        (d / "subdir").mkdir()
        locked = d / "locked_key"
        locked.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n...")
        locked.chmod(0o000)
        try:
            keys = server.list_ssh_keys()
            assert keys == ["id_ed25519"]  # unreadable key skipped quietly, basename only
        finally:
            locked.chmod(0o644)


# ── docker SDK (fully mocked) ────────────────────────────────────────────────


def ok(stdout="", stderr=""):
    return types.SimpleNamespace(returncode=0, stdout=stdout, stderr=stderr)


def fail(stderr="boom"):
    return types.SimpleNamespace(returncode=1, stdout="", stderr=stderr)


@pytest.fixture
def docker_cli():
    """No-op placeholder, kept so existing test signatures needn't change --
    docker-py needs no `docker` binary on PATH the way the old CLI-shelling
    code did. Tests patch server.docker_client directly instead."""
    yield


class FakeImage:
    def __init__(self, tag):
        self.tags = [tag] if tag else []
        self.short_id = "sha256:deadbeef"


class FakeContainer:
    def __init__(
        self, name, image="nginx", stats_raw=None, cid="c1", logs_lines=None, log_error=None
    ):
        self.name = name
        self.short_id = cid
        self.image = FakeImage(image)
        self.attrs = {"Config": {"Image": image}}
        self._stats_raw = stats_raw or {}
        self._logs_lines = logs_lines if logs_lines is not None else []
        self._log_error = log_error

    def stats(self, stream=False):
        if isinstance(self._stats_raw, Exception):
            raise self._stats_raw
        return self._stats_raw

    def logs(self, **kw):
        if self._log_error:
            raise self._log_error
        return iter(self._logs_lines)


class FakeService(FakeContainer):
    def __init__(self, name, running=2, desired=2, sid="s1", logs_lines=None, log_error=None):
        super().__init__(name, cid=sid, logs_lines=logs_lines, log_error=log_error)
        self.attrs = {"ServiceStatus": {"RunningTasks": running, "DesiredTasks": desired}}


class FakeCollection:
    def __init__(self, items=None, error=None):
        self._items = items or []
        self._error = error

    def list(self, **kw):
        if self._error:
            raise self._error
        return self._items

    def get(self, name):
        for it in self._items:
            if it.name == name:
                return it
        raise LookupError(name)


class FakeDockerClient:
    def __init__(self, containers=None, services=None, services_error=None, version_error=None):
        self.containers = FakeCollection(containers)
        self.services = FakeCollection(services, services_error)
        self._version_error = version_error

    def version(self):
        if self._version_error:
            raise self._version_error
        return {"Version": "27.0.0"}


def raw_stats(cpu_pct=10.0, mem_bytes=1024 * 1024, mem_limit=4 * 1024 * 1024, net_total=2000):
    """A minimal docker-py raw stats() dict that _cpu_mem_net_from_raw can
    compute a plausible cpu_pct/mem_bytes/net_total straight back out of --
    the exact absolute counter values don't matter, only their deltas and
    ratios do (see _cpu_mem_net_from_raw's own docstring)."""
    online = 2
    sys_delta = 1_000_000_000
    cpu_delta = int(sys_delta * (cpu_pct / 100.0) / online)
    return {
        "cpu_stats": {
            "cpu_usage": {"total_usage": cpu_delta, "percpu_usage": [1, 1]},
            "system_cpu_usage": sys_delta,
            "online_cpus": online,
        },
        "precpu_stats": {"cpu_usage": {"total_usage": 0}, "system_cpu_usage": 0},
        "memory_stats": {"usage": mem_bytes, "limit": mem_limit, "stats": {"cache": 0}},
        "networks": {"eth0": {"rx_bytes": net_total // 2, "tx_bytes": net_total - net_total // 2}},
    }


class FakeSSHClient:
    """Stand-in for paramiko.SSHClient -- tests patch server._connect_ssh to
    return one of these instead of ever opening a real ssh connection."""

    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class FakeChannel:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    def set_combine_stderr(self, v):
        pass

    def recv(self, n):
        return self._chunks.pop(0) if self._chunks else b""

    def close(self):
        pass


class FakeSSHClientStreaming(FakeSSHClient):
    """FakeSSHClient whose exec_command() drives a FakeChannel -- for
    DockerLogSource's remote (paramiko-streaming) path."""

    def __init__(self, chunks):
        super().__init__()
        self.channel = FakeChannel(chunks)
        self.last_cmd = None

    def exec_command(self, cmd, timeout=None):
        self.last_cmd = cmd
        stdout = types.SimpleNamespace(channel=self.channel)
        return None, stdout, None


class TestSshParamikoHelpers:
    def test_parse_ssh_target_full(self):
        assert server._parse_ssh_target("ssh://user@host:2222") == ("host", "user", 2222)

    def test_parse_ssh_target_no_user_default_port(self):
        assert server._parse_ssh_target("ssh://host") == ("host", None, 22)

    def test_parse_docker_size_binary_and_decimal_units(self):
        assert server._parse_docker_size("648B") == 648.0
        assert server._parse_docker_size("12.3MiB") == pytest.approx(12.3 * 1024**2)
        assert server._parse_docker_size("1.9GB") == pytest.approx(1.9 * 1000**3)

    def test_parse_docker_size_garbage_is_zero(self):
        assert server._parse_docker_size("--") == 0.0

    def test_exec_remote_docker_logs_the_command_and_a_clean_exit_at_debug(self, caplog):
        class FakeExecClient:
            def exec_command(self, cmd, timeout=None):
                stdout = types.SimpleNamespace(
                    read=lambda: b"ok\n", channel=types.SimpleNamespace(recv_exit_status=lambda: 0)
                )
                stderr = types.SimpleNamespace(read=lambda: b"")
                return None, stdout, stderr

        with caplog.at_level("DEBUG", logger="cttc"):
            out, err, rc = server._exec_remote_docker(FakeExecClient(), ["ps"], timeout=5)
        assert (out, err, rc) == ("ok\n", "", 0)
        messages = [r.message for r in caplog.records if r.name == "cttc"]
        assert any("sudo docker ps" in m and "exit 0" in m for m in messages), messages

    def test_exec_remote_docker_logs_a_nonzero_exit_at_info_with_stderr(self, caplog):
        class FakeExecClient:
            def exec_command(self, cmd, timeout=None):
                stdout = types.SimpleNamespace(
                    read=lambda: b"", channel=types.SimpleNamespace(recv_exit_status=lambda: 1)
                )
                stderr = types.SimpleNamespace(read=lambda: b"permission denied")
                return None, stdout, stderr

        with caplog.at_level("INFO", logger="cttc"):
            _out, err, rc = server._exec_remote_docker(FakeExecClient(), ["ps"], timeout=5)
        assert rc == 1 and err == "permission denied"
        messages = [r.message for r in caplog.records if r.name == "cttc"]
        assert any("exit 1" in m and "permission denied" in m for m in messages), messages


class TestNormalizeDockerHost:
    def test_none_and_empty(self):
        assert server.normalize_docker_host(None) is None
        assert server.normalize_docker_host("") is None

    def test_bare_user_at_host_gets_ssh_scheme(self):
        assert server.normalize_docker_host("user@other-server") == "ssh://user@other-server"

    def test_already_schemed_ssh_left_alone(self):
        assert server.normalize_docker_host("ssh://user@other-server") == "ssh://user@other-server"

    def test_non_ssh_scheme_raises_a_clean_error(self):
        # br-CONN-002: used to be passed through untouched, then silently
        # parsed into garbage further down (_parse_ssh_target/
        # ssh_host_and_port strip a literal "ssh://" -- exactly 6 chars --
        # off *any* scheme prefix unconditionally, since every scheme here
        # happens to also be 6 characters long) instead of ever surfacing
        # a clean "unsupported transport" error.
        with pytest.raises(ValueError, match="unsupported docker host transport 'tcp'"):
            server.normalize_docker_host("tcp://1.2.3.4:2375")

    def test_bad_port_raises_a_clean_error(self):
        # br-CONN-005: _parse_ssh_target's bare `int(port_s)` used to raise
        # Python's own raw "invalid literal for int()..." ValueError, and
        # only late -- mid ssh-connect, inside a background poll loop (an
        # opaque self.error string) or wrapped into a 502 DockerPsError by
        # docker_ps -- instead of a clean error raised immediately here.
        with pytest.raises(ValueError, match=r"invalid ssh port 'notaport'"):
            server.normalize_docker_host("ssh://h:notaport")

    def test_bad_port_raises_a_clean_error_with_user(self):
        with pytest.raises(ValueError, match=r"invalid ssh port 'notaport'"):
            server.normalize_docker_host("ssh://user@h:notaport")

    def test_bare_host_with_bad_port_also_raises(self):
        # the bare `user@host:port` shorthand (no explicit ssh:// scheme
        # yet) must be validated too, not just an already-schemed host.
        with pytest.raises(ValueError, match=r"invalid ssh port 'notaport'"):
            server.normalize_docker_host("user@h:notaport")

    def test_port_zero_and_out_of_range_rejected(self):
        with pytest.raises(ValueError, match=r"invalid ssh port '0'"):
            server.normalize_docker_host("ssh://h:0")
        with pytest.raises(ValueError, match=r"invalid ssh port '99999999'"):
            server.normalize_docker_host("ssh://h:99999999")

    def test_valid_port_is_left_alone(self):
        assert server.normalize_docker_host("ssh://user@h:2222") == "ssh://user@h:2222"
        with pytest.raises(ValueError, match="unsupported docker host transport 'http'"):
            server.normalize_docker_host("http://example.com")


class TestDockerPs:
    """docker_ps shells out to the real `docker` CLI as an asyncio subprocess
    (not docker-py's use_ssh_client transport, whose SSHSocket.recv() ignores
    its own configured timeout and can hang a worker thread forever on a bad
    ssh host) -- so it can genuinely kill a hung invocation on timeout."""

    async def test_normalizes_bare_user_at_host(self, monkeypatch):
        client = FakeSSHClient()
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: client)
        captured = []

        def fake_exec_remote(c, args, timeout):
            captured.append(list(args))
            if args[-1] == "{{.Server.Version}}":
                return "27.0.0\n", "", 0
            return "", "", 0

        monkeypatch.setattr(server, "_exec_remote_docker", fake_exec_remote)
        await server.docker_ps("u@h")
        assert captured[0] == ["version", "--format", "{{.Server.Version}}"]
        assert client.closed  # docker_ps always closes the ssh connection it opened

    async def test_ok_with_services(self, monkeypatch):
        ps_line = json.dumps({"ID": "1" * 20, "Names": "web", "Image": "nginx"}).encode()
        svc_line = json.dumps({"ID": "s" * 20, "Name": "api", "Replicas": "2/2"}).encode()

        async def fake_exec(*args, **k):
            if args[-3] == "version":
                return FakeAsyncProc(communicate_result=(b"27.0.0\n", b""))
            if "service" in args:
                return FakeAsyncProc(communicate_result=(svc_line + b"\n", b""))
            return FakeAsyncProc(communicate_result=(ps_line + b"\n", b""))

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        got = await server.docker_ps(None)
        assert got["containers"] == [{"id": "1" * 12, "name": "web", "image": "nginx"}]
        assert got["services"] == [{"id": "s" * 12, "name": "api", "replicas": "2/2"}]
        assert got["log"][0]["returncode"] == 0

    async def test_excludes_the_gateway_container_itself(self, monkeypatch):
        web_line = json.dumps({"ID": "1" * 20, "Names": "web", "Image": "nginx"}).encode()
        gw_line = json.dumps(
            {"ID": "2" * 20, "Names": "cttc-gateway-cttc-gateway-1", "Image": "cttc-gateway:latest"}
        ).encode()
        gw_line_tagless = json.dumps(
            {"ID": "3" * 20, "Names": "some-other-gw", "Image": "myrepo/cttc-gateway"}
        ).encode()

        async def fake_exec(*args, **k):
            if args[-3] == "version":
                return FakeAsyncProc(communicate_result=(b"27.0.0\n", b""))
            if "service" in args:
                return FakeAsyncProc(returncode=1, communicate_result=(b"", b"not a swarm manager"))
            return FakeAsyncProc(
                communicate_result=(
                    web_line + b"\n" + gw_line + b"\n" + gw_line_tagless + b"\n",
                    b"",
                )
            )

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        got = await server.docker_ps(None)
        assert got["containers"] == [{"id": "1" * 12, "name": "web", "image": "nginx"}]

    async def test_does_not_exclude_cttc_gateway_image_on_a_remote_host(self, monkeypatch):
        # a remote ssh:// source is, by definition, a *different* machine --
        # a container there that merely happens to share the "cttc-gateway"
        # image/tag has nothing to do with this gateway and must be shown,
        # unlike the local-daemon case above.
        web_line = json.dumps({"ID": "1" * 20, "Names": "web", "Image": "nginx"}).encode()
        gw_line = json.dumps(
            {"ID": "2" * 20, "Names": "some-gateway", "Image": "cttc-gateway:latest"}
        ).encode()
        client = FakeSSHClient()
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: client)

        def fake_exec_remote(c, args, timeout):
            if args[0] == "version":
                return "27.0.0\n", "", 0
            if args[0] == "service":
                return "", "not a swarm manager", 1
            return (web_line + b"\n" + gw_line + b"\n").decode(), "", 0

        monkeypatch.setattr(server, "_exec_remote_docker", fake_exec_remote)
        got = await server.docker_ps("ssh://u@h")
        assert got["containers"] == [
            {"id": "1" * 12, "name": "web", "image": "nginx"},
            {"id": "2" * 12, "name": "some-gateway", "image": "cttc-gateway:latest"},
        ]

    async def test_service_ls_failure_tolerated(self, monkeypatch):
        ps_line = json.dumps({"ID": "1" * 20, "Names": "web", "Image": "nginx"}).encode()

        async def fake_exec(*args, **k):
            if args[-3] == "version":
                return FakeAsyncProc(communicate_result=(b"27.0.0\n", b""))
            if "service" in args:
                return FakeAsyncProc(returncode=1, communicate_result=(b"", b"not a swarm manager"))
            return FakeAsyncProc(communicate_result=(ps_line + b"\n", b""))

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        assert (await server.docker_ps(None))["services"] == []

    async def test_preflight_reports_missing_docker(self, monkeypatch):
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: FakeSSHClient())
        monkeypatch.setattr(
            server, "_exec_remote_docker", lambda c, a, t: ("", "command not found: docker", 1)
        )
        with pytest.raises(server.DockerPsError, match="not installed"):
            await server.docker_ps("ssh://u@h")

    async def test_ssh_connect_failure_reported(self, monkeypatch):
        def boom(host, key):
            raise OSError("Connection refused")

        monkeypatch.setattr(server, "_connect_ssh", boom)
        with pytest.raises(server.DockerPsError, match="could not ssh to"):
            await server.docker_ps("ssh://u@h")

    async def test_failure_raises_and_carries_log(self, monkeypatch):
        async def fake_exec(*args, **k):
            if args[-3] == "version":
                return FakeAsyncProc(communicate_result=(b"27.0.0\n", b""))
            return FakeAsyncProc(returncode=1, communicate_result=(b"", b"no daemon"))

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        with pytest.raises(server.DockerPsError, match="no daemon") as ei:
            await server.docker_ps(None)
        assert ei.value.log[-1]["returncode"] != 0

    async def test_timeout_raises_with_log(self, monkeypatch):
        monkeypatch.setattr(server, "DOCKER_PS_TIMEOUT", 0.05)

        class HangingProc(FakeAsyncProc):
            async def communicate(self):
                await asyncio.sleep(1)
                return await super().communicate()

        async def fake_exec(*args, **k):
            return HangingProc()

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        with pytest.raises(server.DockerPsError, match="timed out"):
            await server.docker_ps(None)


class TestGatherOwnContainerLogs:
    """/mlog (Ship Logs): finds the gateway's own running container by
    image basename -- same filtering logic docker_ps() uses to hide it from
    the monitorable-target list -- then `docker logs` it."""

    async def test_finds_and_logs_own_container(self, monkeypatch):
        gw_line = json.dumps(
            {"ID": "2" * 20, "Names": "cttc-gateway-cttc-gateway-1", "Image": "cttc-gateway:latest"}
        ).encode()
        web_line = json.dumps({"ID": "1" * 20, "Names": "web", "Image": "nginx"}).encode()

        async def fake_exec(*args, **k):
            if args[1] == "ps":
                return FakeAsyncProc(communicate_result=(web_line + b"\n" + gw_line + b"\n", b""))
            assert args[1] == "logs"
            assert args[2] == "2" * 20
            return FakeAsyncProc(communicate_result=(b"log line 1\nlog line 2\n", b""))

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        name, data = await server.gather_own_container_logs()
        assert name == "cttc-gateway-cttc-gateway-1"
        assert data == b"log line 1\nlog line 2\n"

    async def test_no_own_container_found(self, monkeypatch):
        web_line = json.dumps({"ID": "1" * 20, "Names": "web", "Image": "nginx"}).encode()

        async def fake_exec(*args, **k):
            return FakeAsyncProc(communicate_result=(web_line + b"\n", b""))

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        name, data = await server.gather_own_container_logs()
        assert name == "gateway"
        assert b"could not find" in data

    async def test_docker_unreachable(self, monkeypatch):
        async def fake_exec(*args, **k):
            raise OSError("docker not found")

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        name, data = await server.gather_own_container_logs()
        assert name == "gateway"
        assert b"could not find" in data

    async def test_docker_logs_itself_times_out(self, monkeypatch):
        gw_line = json.dumps({"ID": "2" * 20, "Names": "gw", "Image": "cttc-gateway"}).encode()

        class HangingProc(FakeAsyncProc):
            async def communicate(self):
                await asyncio.sleep(3600)

        async def fake_exec(*args, **k):
            if args[1] == "ps":
                return FakeAsyncProc(communicate_result=(gw_line + b"\n", b""))
            return HangingProc()

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        name, data = await server.gather_own_container_logs(timeout=0.05)
        assert name == "gw"
        assert b"could not gather gateway logs" in data


class FakeState:
    def __init__(self, redis_log=None):
        self.events = []
        self.redis_log = redis_log

    def broadcast(self, ev):
        self.events.append(ev)


async def stats_rows_of(fake_state, svc):
    """Test stand-in for what used to be a direct `src.series[svc]` read
    -- Redis is the store now (see redis_log.py). `svc` is the bare/host-
    qualified name a caller would pass to StatsSource._entity_for; the
    "stats:" kind prefix (br-DEDUP-006) is added here to match."""
    rows = await fake_state.redis_log.range_by_score_with_payload(f"stats:{svc}", 0, 10**15)
    return [(ts, p.get("cpu"), p.get("mem"), p.get("mem_bytes"), p.get("net")) for ts, p in rows]


class TestEntityId:
    """br-DEDUP-006: the Redis entity id every Source read/write actually
    keys on (see LogSource._entity/StatsSource._entity_for)."""

    def test_bare_for_no_host(self):
        assert server._entity_id("log", "nginx", None) == "log:nginx"
        assert server._entity_id("log", "nginx", "") == "log:nginx"

    def test_qualified_for_a_remote_host(self):
        assert server._entity_id("log", "nginx", "ssh://u@h") == "log:nginx@h"

    def test_hostname_derivation_matches_the_rest_of_the_module(self):
        # same `host.split("@")[-1]` collect_docker itself already uses for
        # host@<hostname> naming -- consistent, even where that derivation
        # has its own separate known gap (br-DEDUP-007, ssh port handling).
        assert server._entity_id("log", "nginx", "ssh://u@h:2222") == "log:nginx@h:2222"

    def test_already_qualified_name_is_left_untouched(self):
        # HostStatsSource pre-builds "host@<hostname>" itself before ever
        # reaching ingest_row -- must not double-qualify into
        # "host@<hostname>@<hostname>".
        assert server._entity_id("stats", "host@h", "ssh://u@h") == "stats:host@h"

    def test_two_different_hosts_never_produce_the_same_entity_id(self):
        assert server._entity_id("log", "nginx", "ssh://u@h1") != server._entity_id("log", "nginx", "ssh://u@h2")
        assert server._entity_id("log", "nginx", "ssh://u@h1") != server._entity_id("log", "nginx", None)

    def test_log_and_stats_never_collide_for_the_same_name_and_host(self):
        # br-DEDUP-006 regression: a local container's log entity and its
        # stats entity used to both resolve to the exact same bare name,
        # sharing one Redis key -- every stats sample (no "text" field)
        # then rendered as a blank-text row in that container's log panel,
        # at the stats poll interval.
        assert server._entity_id("log", "web", None) != server._entity_id("stats", "web", None)
        assert server._entity_id("log", "web", "ssh://u@h") != server._entity_id("stats", "web", "ssh://u@h")


class TestDockerStatsSource:
    async def test_polls_and_ingests(self, docker_cli, monkeypatch):
        client = FakeDockerClient(
            containers=[
                FakeContainer(
                    "api.1.x",
                    stats_raw=raw_stats(cpu_pct=10.0, mem_bytes=1_000_000, mem_limit=4_000_000),
                ),
            ]
        )
        monkeypatch.setattr(server, "docker_client", lambda host: client)
        st = FakeState()
        src = server.DockerStatsSource("d1", "stats@local", None, 0.05, st)
        try:
            deadline = time.time() + 3
            while not src._services and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "api" in src._services
            assert src.error is None
            assert any(e["type"] == "update" for e in st.events)
            assert src.path == "docker://local/stats"
        finally:
            src.stop()

    async def test_error_captured(self, docker_cli, monkeypatch):
        def factory(host):
            raise RuntimeError("cannot connect")

        monkeypatch.setattr(server, "docker_client", factory)
        src = server.DockerStatsSource("d2", "stats@local", None, 0.05, FakeState())
        try:
            deadline = time.time() + 3
            while src.error is None and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "cannot connect" in src.error
        finally:
            src.stop()

    async def test_container_stats_failure_skipped_not_fatal(self, docker_cli, monkeypatch):
        # one container's stats() call blowing up shouldn't stop the others
        good = FakeContainer("good", stats_raw=raw_stats())
        bad = FakeContainer("bad", stats_raw=RuntimeError("boom"))
        client = FakeDockerClient(containers=[bad, good])
        monkeypatch.setattr(server, "docker_client", lambda host: client)
        src = server.DockerStatsSource("d3", "stats@local", None, 0.05, FakeState())
        try:
            deadline = time.time() + 3
            while "good" not in src._services and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "good" in src._services
            assert "bad" not in src._services
        finally:
            src.stop()

    async def test_remote_polls_via_ssh_sudo_docker_stats(self, docker_cli, monkeypatch):
        client = FakeSSHClient()
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: client)
        row = {
            "Name": "web",
            "CPUPerc": "12.50%",
            "MemPerc": "3.00%",
            "MemUsage": "12.3MiB / 1.907GiB",
            "NetIO": "648B / 1.2kB",
        }
        captured = []

        def fake_exec(c, args, timeout):
            captured.append(list(args))
            return json.dumps(row) + "\n", "", 0

        monkeypatch.setattr(server, "_exec_remote_docker", fake_exec)
        src = server.DockerStatsSource("d4", "stats@h", "ssh://u@h", 0.05, FakeState())
        try:
            deadline = time.time() + 3
            while not src._services and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "web" in src._services
            assert captured[0] == ["stats", "--no-stream", "--format", "{{json .}}"]
            assert src.path == "docker://ssh://u@h/stats"
        finally:
            src.stop()
        assert client.closed  # stop() closes the persistent ssh connection

    async def test_remote_stats_failure_reconnects_next_tick(self, docker_cli, monkeypatch):
        clients = [FakeSSHClient(), FakeSSHClient()]
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: clients.pop(0))
        monkeypatch.setattr(server, "_exec_remote_docker", lambda c, a, **kw: ("", "boom", 1))
        src = server.DockerStatsSource("d5", "stats@h", "ssh://u@h", 0.05, FakeState())
        try:
            deadline = time.time() + 3
            while src.error is None and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "boom" in src.error
            # the failed connection should have been closed and cleared, so
            # the next tick reconnects (draining the second fake client too)
            deadline = time.time() + 3
            while clients and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert not clients
        finally:
            src.stop()

    async def test_same_service_name_from_different_hosts_does_not_interleave_data(
        self, docker_cli, monkeypatch, redis_log_instance
    ):
        # br-DEDUP-006: a local and a remote DockerStatsSource that both
        # happen to discover a service named "nginx" must not collide into
        # the same Redis entity -- each host's history stays independent.
        local_client = FakeDockerClient(
            containers=[FakeContainer("nginx", stats_raw=raw_stats(cpu_pct=1.0))]
        )
        monkeypatch.setattr(server, "docker_client", lambda host: local_client)

        remote_row = {
            "Name": "nginx",
            "CPUPerc": "9.00%",
            "MemPerc": "5.00%",
            "MemUsage": "10MiB / 100MiB",
            "NetIO": "0B / 0B",
        }
        remote_client = FakeSSHClient()
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: remote_client)
        monkeypatch.setattr(
            server, "_exec_remote_docker", lambda c, a, timeout=15: (json.dumps(remote_row) + "\n", "", 0)
        )

        st = FakeState(redis_log=redis_log_instance)
        local_src = server.DockerStatsSource("d10", "stats@local", None, 0.05, st)
        remote_src = server.DockerStatsSource("d11", "stats@remotehost", "ssh://u@remotehost", 0.05, st)
        try:
            deadline = time.time() + 3
            while (
                "nginx" not in local_src._services or "nginx" not in remote_src._services
            ) and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "nginx" in local_src._services
            assert "nginx" in remote_src._services

            # _services (in-memory) landing doesn't mean the matching
            # record() call has been *flushed* to Redis yet (sRate, see
            # redis_log.py) -- poll the actual read path too, not just the
            # in-memory signal.
            deadline = time.time() + 3
            while not (await stats_rows_of(st, "nginx")) and time.time() < deadline:
                await asyncio.sleep(0.02)

            # each Source's own read methods must see only its own host's data
            local_rows = await stats_rows_of(st, "nginx")
            remote_rows = await stats_rows_of(st, "nginx@remotehost")
            assert local_rows and local_rows[0][1] == pytest.approx(1.0), local_rows
            assert remote_rows and remote_rows[0][1] == pytest.approx(9.0), remote_rows

            # and via the Source-level API actually used by /series etc.
            local_point = await local_src.point_at(local_rows[0][0])
            remote_point = await remote_src.point_at(remote_rows[0][0])
            assert local_point["nginx"]["cpu"] == pytest.approx(1.0)
            assert remote_point["nginx"]["cpu"] == pytest.approx(9.0)
        finally:
            local_src.stop()
            remote_src.stop()


class FakeAsyncStdout:
    def __init__(self, chunks, hang_after=False):
        self._chunks = list(chunks)
        self._hang_after = hang_after  # simulate a still-live, merely idle stream

    async def read(self, n):
        if self._chunks:
            return self._chunks.pop(0)
        if self._hang_after:
            await asyncio.sleep(3600)
        return b""


class FakeAsyncProc:
    """Stand-in for asyncio.subprocess.Process."""

    def __init__(
        self,
        chunks=None,
        communicate_result=None,
        communicate_error=None,
        returncode=0,
        hang_after=False,
    ):
        self.stdout = FakeAsyncStdout(chunks or [], hang_after=hang_after)
        self.returncode = None  # asyncio only sets this once the process actually exits
        self.terminated = False
        self._exit_code = returncode
        self._communicate_result = communicate_result or (b"", b"")
        self._communicate_error = communicate_error

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.terminated = True
        self.returncode = -9

    async def wait(self):
        return self.returncode

    async def communicate(self):
        if self._communicate_error:
            raise self._communicate_error
        self.returncode = self._exit_code  # real communicate() waits for exit
        return self._communicate_result


class TestDockerLogSource:
    async def test_follows_and_reports_end(self, docker_cli, monkeypatch, redis_log_instance):
        proc = FakeAsyncProc([b"2026-01-02T03:04:05Z hello\n2026-01-02T03:04:06Z world\n"])

        async def fake_exec(*a, **k):
            return proc

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        st = FakeState(redis_log=redis_log_instance)
        src = server.DockerLogSource("l1", "web", None, "container", "web", [], st)
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            await asyncio.sleep(0.02)
        # src.error lands as soon as the fake stream ends (in-memory,
        # immediate) -- the matching record() calls still need their own
        # flush cycle to actually land in Redis (sRate), so poll total()
        # too rather than asserting on it right away.
        deadline = time.time() + 3
        while await src.total() < 2 and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert await src.total() == 2
        assert src.error == "log stream ended -- reconnecting"
        assert src.path == "docker://local/container/web"
        src.stop()

    async def test_service_target_uses_service_logs(
        self, docker_cli, monkeypatch, redis_log_instance
    ):
        client = FakeSSHClientStreaming([b"2026-01-02T03:04:05Z hello\n"])
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: client)
        src = server.DockerLogSource(
            "l2",
            "api",
            "ssh://u@h",
            "service",
            "api",
            [],
            FakeState(redis_log=redis_log_instance),
            ssh_key="/tmp/k",
        )
        deadline = time.time() + 3
        while await src.total() < 1 and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert await src.total() == 1
        assert src.path == "docker://ssh://u@h/service/api"
        assert client.last_cmd.startswith("sudo docker service logs")
        src.stop()
        assert client.closed  # stop() closes the ssh connection it opened

    async def test_remote_log_stream_ends(self, docker_cli, monkeypatch):
        client = FakeSSHClientStreaming([b"one line\n"])
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: client)
        src = server.DockerLogSource("l5", "web", "ssh://u@h", "container", "web", [], FakeState())
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert src.error == "log stream ended -- reconnecting"
        src.stop()

    async def test_stream_end_triggers_a_reconnect_rather_than_giving_up(
        self, docker_cli, monkeypatch, redis_log_instance
    ):
        # br-DEDUP-009: a dead/restarted container must not leave the log
        # feed permanently stale -- once the first stream ends, _follow has
        # to reconnect (a fresh create_subprocess_exec call) rather than
        # returning for good.
        procs = [
            FakeAsyncProc([b"2026-01-02T03:04:05Z first\n"]),
            FakeAsyncProc([b"2026-01-02T03:04:06Z second\n"]),
        ]
        calls = {"n": 0}

        async def fake_exec(*a, **k):
            proc = procs[min(calls["n"], len(procs) - 1)]
            calls["n"] += 1
            return proc

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        real_sleep = asyncio.sleep
        monkeypatch.setattr(server.asyncio, "sleep", lambda _s: real_sleep(0))  # skip the backoff
        st = FakeState(redis_log=redis_log_instance)
        src = server.DockerLogSource("l7", "web", None, "container", "web", [], st)
        deadline = time.time() + 3
        while await src.total() < 2 and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert await src.total() == 2  # reconnected and ingested the second stream's line too
        assert calls["n"] >= 2
        src.stop()

    async def test_remote_ssh_connect_failure_recorded(self, docker_cli, monkeypatch):
        def boom(host, key):
            raise OSError("Connection refused")

        monkeypatch.setattr(server, "_connect_ssh", boom)
        src = server.DockerLogSource("l6", "web", "ssh://u@h", "container", "web", [], FakeState())
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert "Connection refused" in src.error
        src.stop()

    async def test_spawn_failure_recorded(self, docker_cli, monkeypatch):
        async def fake_exec(*a, **k):
            raise OSError("exec failed")

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        src = server.DockerLogSource("l3", "web", None, "container", "web", [], FakeState())
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert "exec failed" in src.error
        src.stop()

    async def test_stop_terminates_the_subprocess(
        self, docker_cli, monkeypatch, redis_log_instance
    ):
        # hang_after=True keeps the fake stream "live but idle" (as a real
        # tailing `docker logs -f` would be between log lines) so stop()
        # has to actually terminate it rather than finding it already ended.
        proc = FakeAsyncProc([b"2026-01-02T03:04:05Z hello\n"], hang_after=True)

        async def fake_exec(*a, **k):
            return proc

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        src = server.DockerLogSource(
            "l4", "web", None, "container", "web", [], FakeState(redis_log=redis_log_instance)
        )
        deadline = time.time() + 3
        while await src.total() < 1 and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert await src.total() == 1
        src.stop()
        assert proc.terminated

    async def test_same_container_name_from_different_hosts_does_not_interleave_data(
        self, docker_cli, monkeypatch, redis_log_instance
    ):
        # br-DEDUP-006: a local and a remote DockerLogSource for the same
        # container name ("web") must not collide into the same Redis
        # entity -- each host's history stays independent.
        local_proc = FakeAsyncProc([b"2026-01-02T03:04:05Z from local\n"])
        remote_client = FakeSSHClientStreaming([b"2026-01-02T03:04:05Z from remote\n"])

        async def fake_exec(*a, **k):
            return local_proc

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        monkeypatch.setattr(server, "_connect_ssh", lambda host, key: remote_client)

        st = FakeState(redis_log=redis_log_instance)
        local_src = server.DockerLogSource("l10", "web", None, "container", "web", [], st)
        remote_src = server.DockerLogSource(
            "l11", "web", "ssh://u@remotehost", "container", "web", [], st
        )
        try:
            deadline = time.time() + 3
            while (
                await local_src.total() < 1 or await remote_src.total() < 1
            ) and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert await local_src.total() == 1
            assert await remote_src.total() == 1
            local_rows = await local_src.slice(0, 10)
            remote_rows = await remote_src.slice(0, 10)
            assert local_rows[0]["text"] == "from local"
            assert remote_rows[0]["text"] == "from remote"
            # confirm they're actually different Redis entities, not just
            # coincidentally-consistent reads through each Source's own view
            assert await redis_log_instance.total("log:web") == 1
            assert await redis_log_instance.total("log:web@remotehost") == 1
        finally:
            local_src.stop()
            remote_src.stop()


# ── HostStatsSource ──────────────────────────────────────────────────────────


def proc_files(user, system, idle, iowait, rx, tx):
    return (
        f"cpu  {user} 0 {system} {idle} {iowait} 0 0 0 0 0\n"
        "cpu0 1 0 1 1 1 0 0 0 0 0\n"
        "MemTotal:        1000000 kB\n"
        "MemAvailable:     400000 kB\n"
        "MemFree:          100000 kB\n"
        "Inter-|   Receive                                                |  Transmit\n"
        f" eth0: {rx} 0 0 0 0 0 0 0 {tx} 0 0 0 0 0 0 0\n"
        " lo: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0\n"
        " veth12: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n"
        " br-abc: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n"
        " docker0: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n"
    )


class TestHostStatsSource:
    async def test_local_psutil_samples(self, redis_log_instance):
        st = FakeState(redis_log=redis_log_instance)
        src = server.HostStatsSource("h1", "host@local", None, 0.05, st)
        try:
            deadline = time.time() + 5
            rows = []
            while not rows and time.time() < deadline:
                await asyncio.sleep(0.05)
                rows = await stats_rows_of(st, "host@local")
            assert rows, "expected at least one host sample"
            _ts, cpu, mem, mem_bytes, _rate = rows[0]
            assert 0 <= cpu <= 100 * 64  # cpu_percent can exceed 100 on multicore? no; be lax
            assert 0 < mem <= 100
            assert mem_bytes > 0
            assert src.error is None
            assert src.path == "docker://local/host"
        finally:
            src.stop()

    async def test_ssh_sampling_and_interface_filter(self, monkeypatch, redis_log_instance):
        samples = [
            proc_files(100, 100, 700, 100, 1000, 2000),
            proc_files(150, 150, 900, 100, 4000, 5000),
        ]
        calls = []

        async def fake_exec(*args, **k):
            calls.append(args)
            sample = samples[0] if len(calls) == 1 else samples[1]
            return FakeAsyncProc(communicate_result=(sample.encode(), b""))

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        st = FakeState(redis_log=redis_log_instance)
        src = server.HostStatsSource(
            "h2", "host@h", "ssh://user@h:2222", 0.05, st, ssh_key="/tmp/key"
        )
        try:
            deadline = time.time() + 5
            rows = []
            while not rows and time.time() < deadline:
                await asyncio.sleep(0.05)
                rows = await stats_rows_of(st, "host@h")
            assert "-p" in calls[0] and "2222" in calls[0]
            assert calls[0][-4:] == ("cat", "/proc/stat", "/proc/meminfo", "/proc/net/dev")
            _ts, cpu, mem, mem_bytes, rate = rows[0]
            # busy: 200 -> 300 (delta 100) of total 1000 -> 1300 (delta 300)
            assert cpu == pytest.approx(100 / 300 * 100, rel=1e-3)
            assert mem == pytest.approx(60.0)
            assert mem_bytes == pytest.approx(600000 * 1024)
            assert rate > 0  # 6000 bytes over the poll gap; lo/veth/br/docker0 excluded
        finally:
            src.stop()

    async def test_unsupported_host_scheme(self):
        src = server.HostStatsSource("h3", "host@x", "tcp://1.2.3.4:2375", 0.05, FakeState())
        try:
            assert "ssh://" in src.error
            await asyncio.sleep(0.12)  # loop must idle without sampling
            assert src._services == set()
        finally:
            src.stop()

    async def test_ssh_failure_recorded(self, monkeypatch):
        async def fake_exec(*a, **k):
            return FakeAsyncProc(communicate_result=(b"", b"Permission denied"), returncode=1)

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        src = server.HostStatsSource("h4", "host@h", "ssh://u@h", 0.05, FakeState())
        try:
            deadline = time.time() + 3
            while src.error is None and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "Permission denied" in src.error
        finally:
            src.stop()

    async def test_local_without_psutil_reports_error(self, monkeypatch):
        src = server.HostStatsSource("h5", "host@x", "tcp://nope", 0.05, FakeState())
        src.stop()  # loop idles; call the sampler directly
        monkeypatch.setitem(sys.modules, "psutil", None)
        with pytest.raises(RuntimeError, match="psutil not installed"):
            src._sample_local()


# ── State ────────────────────────────────────────────────────────────────────


@pytest.fixture
async def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    (tdir / "upper.py").write_text(
        '"""Uppercase text."""\n'
        "def transform(r):\n"
        '    r["text"] = r["text"].upper()\n'
        "    return r\n"
    )
    st = server.State(tdir, redis_flush_interval_seconds=0.05, redis_data_dir=str(tdir / "redis-data"))
    await st.redis_log.start()
    yield st
    await st.redis_log.stop()


@pytest.fixture
def log_file(tmp_path):
    f = tmp_path / "svc.log"
    f.write_text("2026-01-02T03:00:00Z alpha\n2026-01-02T03:00:10Z beta\n")
    return f


@pytest.fixture
def stats_file(tmp_path):
    f = tmp_path / "stats.jsonl"
    f.write_text(
        "\n".join(json.dumps(stats_entry("api", f"2026-01-02T03:00:0{i}Z")) for i in range(3))
        + "\n"
    )
    return f


def _no_op_docker(monkeypatch):
    """collect_docker's sources spawn background asyncio tasks that
    immediately try to reach docker/ssh -- give them a harmless no-op
    target so those tasks don't spam errors during the test (dedup logic,
    or the /docker/collect endpoint contract, don't depend on any of this
    actually succeeding)."""
    monkeypatch.setattr(server, "docker_client", lambda host: FakeDockerClient(containers=[]))

    async def fake_exec(*a, **k):
        return FakeAsyncProc([])

    monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)


class TestState:
    async def test_open_file_auto_and_kinds(self, state, log_file, stats_file):
        lg = state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        stt = state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        await _flush()
        assert lg.kind == "log" and await lg.total() == 2 and lg.name == "svc"
        assert stt.kind == "stats" and stt.count == 3

    async def test_open_file_with_transform_and_name(self, state, log_file):
        src = state.open_file(str(log_file), "log", "custom", live=True, transforms=["upper"])
        await _flush()
        assert src.name == "custom"
        assert (await src.slice(0, 1))[0]["text"] == "ALPHA"

    async def test_open_file_missing(self, state):
        with pytest.raises(FileNotFoundError):
            state.open_file("/no/such/file.log", "auto", None, live=False, transforms=[])

    async def test_close_source(self, state, log_file):
        src = state.open_file(str(log_file), "log", None, live=False, transforms=[])
        stopped = []
        src.stop = lambda: stopped.append(True)
        state.close_source(src.id)
        assert stopped == [True]
        assert src.id not in state.sources
        state.close_source("ghost")  # no-op

    async def test_describe(self, state, log_file, stats_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=["upper"])
        state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        await _flush()
        d = {s["name"]: s for s in await state.describe()}
        assert d["svc"]["kind"] == "log" and d["svc"]["total"] == 2
        assert d["svc"]["transforms"] == ["upper"]
        assert d["stats"]["kind"] == "stats" and d["stats"]["services"] == ["api"]
        assert d["stats"]["min_ts"] is not None
        assert d["stats"]["is_host"] is False
        assert "is_host" not in d["svc"]  # log sources don't carry the flag
        # br-DHOST-030: a loaded file is never docker-collected, so it has no
        # real host identity -- distinct from a *local* docker source, which
        # also reports None here (see test_collect_docker_describe_host below).
        assert d["svc"]["host"] is None
        assert d["stats"]["host"] is None

    async def test_collect_docker_describe_host(self, state, docker_cli, monkeypatch):
        """describe()'s "host" field (br-DHOST-030) is the real Docker host
        identity -- None for the local daemon, the ssh:// string for a
        remote one -- not to be confused with bucketed()'s own "host" field
        (is_host boolean), which describe() doesn't touch."""
        _no_op_docker(monkeypatch)
        local_ids = state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=0.05, host_stats=True
        )
        remote_ids = state.collect_docker(
            "ssh://u@remotehost", stats=True, logs=[], transforms=[], interval=0.05, host_stats=True
        )
        await _flush()
        d = {s["id"]: s for s in await state.describe()}
        for sid in local_ids:
            assert d[sid]["host"] is None
        for sid in remote_ids:
            assert d[sid]["host"] == "ssh://u@remotehost"
        for sid in local_ids + remote_ids:
            state.close_source(sid)

    async def test_collect_docker_all_sources(self, state, docker_cli, monkeypatch):
        _no_op_docker(monkeypatch)
        opened = state.collect_docker(
            None, stats=True, logs=[{"name": "web"}], transforms=[], interval=0.05, host_stats=True
        )
        assert len(opened) == 3
        kinds = sorted(type(state.sources[sid]).__name__ for sid in opened)
        assert kinds == ["DockerLogSource", "DockerStatsSource", "HostStatsSource"]
        for sid in opened:
            state.close_source(sid)

    async def test_collect_docker_flags_off(self, state, docker_cli, monkeypatch):
        _no_op_docker(monkeypatch)
        opened = state.collect_docker(
            None, stats=False, logs=[], transforms=[], interval=0.05, host_stats=False
        )
        assert opened == []

    async def test_collect_docker_dedupes_stats_and_host_stats(
        self, state, docker_cli, monkeypatch
    ):
        _no_op_docker(monkeypatch)
        first = state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=0.05, host_stats=True
        )
        second = state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=0.05, host_stats=True
        )
        assert first == second
        assert len(state.sources) == 2  # not 4 -- the second call reused both
        for sid in first:
            state.close_source(sid)

    async def test_collect_docker_dedupes_logs(self, state, docker_cli, monkeypatch):
        _no_op_docker(monkeypatch)
        first = state.collect_docker(
            None,
            stats=False,
            host_stats=False,
            logs=[{"name": "web", "type": "container"}],
            transforms=[],
            interval=0.05,
        )
        second = state.collect_docker(
            None,
            stats=False,
            host_stats=False,
            logs=[{"name": "web", "type": "container"}],
            transforms=[],
            interval=0.05,
        )
        assert first == second
        assert len(state.sources) == 1
        state.close_source(first[0])

    async def test_collect_docker_distinct_targets_not_deduped(
        self, state, docker_cli, monkeypatch
    ):
        _no_op_docker(monkeypatch)
        by_name = state.collect_docker(
            None,
            stats=False,
            host_stats=False,
            logs=[{"name": "web", "type": "container"}],
            transforms=[],
            interval=0.05,
        )
        by_type = state.collect_docker(
            None,
            stats=False,
            host_stats=False,
            logs=[{"name": "web", "type": "service"}],  # same name, different type
            transforms=[],
            interval=0.05,
        )
        by_host = state.collect_docker(
            "ssh://u@other",
            stats=False,
            host_stats=False,
            logs=[{"name": "web", "type": "container"}],  # same name/type, different host
            transforms=[],
            interval=0.05,
        )
        ids = by_name + by_type + by_host
        assert len(set(ids)) == 3  # all distinct -- nothing wrongly collapsed
        for sid in ids:
            state.close_source(sid)

    async def test_collect_docker_reuse_applies_a_new_poll_interval_but_ignores_other_settings(
        self, state, docker_cli, monkeypatch
    ):
        """A reused stats/host-stats collector picks up a *changed* poll
        interval from the new call (see _update_poll_interval) -- Edit
        Docker Daemon's poll interval field must actually take effect even
        when collection for that daemon is already running, not silently
        no-op forever until you close and reopen it by hand. Everything
        else about the reused source (here: nothing else varies for stats,
        but see the log-source-side reuse tests for transforms/ssh_key)
        still follows the original documented reuse semantics."""
        _no_op_docker(monkeypatch)
        first = state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=1.0, host_stats=False
        )
        second = state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=99.0, host_stats=False
        )  # different interval, same target
        assert second == first  # still the exact same collector, not a second one
        src = state.sources[first[0]]
        assert src.interval == 99.0  # the new call's interval was applied
        state.close_source(first[0])

    async def test_collect_docker_reuse_is_a_no_op_when_the_interval_is_unchanged(
        self, state, docker_cli, monkeypatch
    ):
        _no_op_docker(monkeypatch)
        first = state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=1.0, host_stats=False
        )
        src = state.sources[first[0]]
        src.interval = 1.0  # sanity: still what we started it with
        state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=1.0, host_stats=False
        )
        assert src.interval == 1.0
        state.close_source(first[0])

    async def test_collect_docker_repeated_calls_for_the_same_target_start_only_one(
        self, state, docker_cli, monkeypatch
    ):
        """The real point of _open_or_reuse: N requests for the identical
        target must all resolve to the same single collector. There's no
        lock guarding this anymore, by design -- collect_docker is only
        ever called from request handlers on the single-threaded event
        loop, and _open_or_reuse has no `await` in it, so each call already
        runs to completion atomically with respect to every other
        coroutine before the next one gets a turn (unlike the old
        threading-based server, real concurrent OS-thread calls into it are
        not a scenario that can happen anymore)."""
        _no_op_docker(monkeypatch)
        results = [
            state.collect_docker(
                None, stats=True, logs=[], transforms=[], interval=0.05, host_stats=False
            )[0]
            for _ in range(16)
        ]
        assert len(set(results)) == 1, f"expected one winner id, got {set(results)}"
        assert len(state.sources) == 1
        state.close_source(results[0])

    async def test_broadcast_full_queue_dropped(self, state):
        full = asyncio.Queue(maxsize=1)
        full.put_nowait({"x": 1})
        state.listeners.append(full)
        state.broadcast({"type": "sources"})  # must not raise
        state.listeners.remove(full)


class TestSampleRoundTrip:
    async def test_export_and_load(self, state, log_file, stats_file, tmp_path):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        st_src = state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        st_src.is_host = True  # exercise the host flag
        st_src._swarm.add("api")
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        out = tmp_path / "slice.cttc"
        r = await state.export_sample(str(out), t0, t1)
        assert r["sources"] == 2

        names = zipfile.ZipFile(out).namelist()
        assert "manifest.json" in names

        # A genuinely separate RedisLog (own redis-server, own unix socket)
        # -- st2's re-loaded "svc" source must not see `state`'s original
        # "svc" history, exactly as two independent Source objects sharing
        # an entity name would collide if they shared one Redis (see
        # redis_log.py's module docstring on the sole-source-of-truth
        # scope boundary).
        st2 = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        st2.redis_log = redis_log.RedisLog(
            socket_path=f"/tmp/cttc-test-{uuid.uuid4().hex[:8]}.sock",
            tcp_port=unique_redis_tcp_port(),
            flush_interval_seconds=0.05,
            data_dir=tmp_path / "redis-data-2",
        )
        await st2.redis_log.start()
        try:
            opened = await st2.load_sample(str(out))
            assert len(opened) == 2
            d = {s["name"]: s for s in await st2.describe()}
            assert d["svc"]["total"] == 1  # only "alpha" is inside [t0, t1]
            lg = st2.sources[[s for s in opened if st2.sources[s].kind == "log"][0]]
            assert (await lg.slice(0, 1))[0]["text"] == "alpha"
            stt = st2.sources[[s for s in opened if st2.sources[s].kind == "stats"][0]]
            assert stt.is_host is True
            assert stt._swarm == {"api"}
            assert stt.live is False and lg.live is False
        finally:
            await st2.redis_log.stop()

    async def test_load_sample_twice_with_same_provenance_reuses_the_same_entity(
        self, state, tmp_path
    ):
        """Content-addressed identity (System Observability spec's
        "Collision Prevention": Gateway + Docker Host + Container):
        the identical (gateway, docker host, container) loaded twice
        resolves to the same Redis entity -- idempotent, not duplicated.
        "Should not be able to re-open that data more than once" now holds
        at the storage layer too, not just the client's own path-based
        dedup (ui-EXPORT-017/018)."""
        log = tmp_path / "svc.log"
        log.write_text("2026-01-02T03:00:00Z only-line\n")
        state.open_file(str(log), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        out = tmp_path / "sample.cttc"
        r = await state.export_sample(str(out), t0, t1)
        assert r["sources"] == 1

        opened1 = await state.load_sample(str(out))
        opened2 = await state.load_sample(str(out))
        loaded1 = state.sources[opened1[0]]
        loaded2 = state.sources[opened2[0]]
        assert loaded1._entity == loaded2._entity, "same provenance -- same content-addressed entity"
        assert await loaded1.total() == 1, "re-loading the identical file doesn't duplicate rows"
        assert await loaded2.total() == 1

    async def test_load_sample_different_gateway_provenance_does_not_collide(self, state, tmp_path):
        """Two loads sharing a bare container name but genuinely different
        provenance (a different gateway, here) must never collide --
        content-addressing keeps them apart the same way host-qualification
        already keeps two live docker hosts' same-named containers apart
        (br-DEDUP-006)."""
        f1 = tmp_path / "first"
        f1.mkdir()
        log1 = f1 / "svc.log"
        log1.write_text("2026-01-02T03:00:00Z first-only\n")
        state.open_file(str(log1), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        out1 = tmp_path / "first.cttc"
        r1 = await state.export_sample(str(out1), t0, t1)
        assert r1["sources"] == 1

        f2 = tmp_path / "second"
        f2.mkdir()
        log2 = f2 / "svc.log"
        log2.write_text("2026-01-02T04:00:00Z second-only\n")
        state.open_file(str(log2), "auto", None, live=False, transforms=[])
        await _flush()
        t2_0, t2_1 = ms(2026, 1, 2, 4, 0, 0), ms(2026, 1, 2, 4, 0, 5)
        out2 = tmp_path / "second.cttc"
        r2 = await state.export_sample(str(out2), t2_0, t2_1)
        assert r2["sources"] == 1
        _restamp_gateway_id(out2, "a-genuinely-different-gateway")

        opened1 = await state.load_sample(str(out1))
        opened2 = await state.load_sample(str(out2))
        loaded1 = state.sources[opened1[0]]
        loaded2 = state.sources[opened2[0]]
        assert loaded1._entity != loaded2._entity, "different gateway provenance -- must not collide"
        assert await loaded1.total() == 1, "first load's entity shows only its own row"
        assert await loaded2.total() == 1, "second load's entity shows only its own row -- not merged with the first"
        assert (await loaded1.slice(0, 1))[0]["text"] == "first-only"
        assert (await loaded2.slice(0, 1))[0]["text"] == "second-only"

    async def test_manifest_carries_provenance_and_a_verifying_integrity_hash(
        self, state, log_file, tmp_path
    ):
        """System Observability spec's "Manifest & Security": every
        exported source is stamped with its gateway/docker-host/container
        identity, and the manifest carries a hash of itself (everything
        but the hash field) for tamper-evidence."""
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        out = tmp_path / "slice.cttc"
        await state.export_sample(str(out), t0, t1)

        man = json.loads(zipfile.ZipFile(out).read("manifest.json"))
        assert man["version"] == 3
        assert "integrity_sha256" in man
        src = man["segments"][0]["sources"][0]
        assert src["gateway_id"] == state.gateway_id
        assert src["docker_host_id"] == "local"
        assert src["container_id"] == "svc"

        # Recomputing the same way load_sample does must match -- the hash
        # actually verifies a clean export, not just "a field exists."
        without_hash = dict(man)
        without_hash.pop("integrity_sha256")
        assert server._manifest_hash(without_hash) == man["integrity_sha256"]

    async def test_tampered_manifest_hash_still_loads_but_logs_a_warning(
        self, state, log_file, tmp_path, caplog
    ):
        """Tamper-evidence, not an access-control gate (confirmed with the
        user): a manifest whose integrity hash no longer matches still
        loads -- same bias toward a permissive read over a hard failure on
        an unexpected file as the rest of this codebase -- but is logged
        so the discrepancy isn't silent."""
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        out = tmp_path / "slice.cttc"
        await state.export_sample(str(out), t0, t1)
        _restamp_gateway_id(out, "tampered-after-the-hash-was-computed")

        with caplog.at_level("WARNING", logger="cttc"):
            opened = await state.load_sample(str(out))
        assert len(opened) == 1, "still loads despite the mismatched hash"
        assert any("integrity" in rec.message for rec in caplog.records)

    async def test_load_sample_accepts_a_legacy_v2_manifest_with_no_provenance(
        self, state, log_file, tmp_path
    ):
        """A pre-v3 export (no gateway_id/docker_host_id/container_id, no
        integrity_sha256) must still load -- backward compatible, just
        without content-addressed reuse (falls back to this gateway's own
        id / "local" / the bare name, see load_sample)."""
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        out = tmp_path / "legacy.cttc"
        await state.export_sample(str(out), t0, t1)

        with zipfile.ZipFile(out, "r") as z:
            members = {n: z.read(n) for n in z.namelist()}
        man = json.loads(members["manifest.json"])
        for seg in man["segments"]:
            for src in seg["sources"]:
                src.pop("gateway_id", None)
                src.pop("docker_host_id", None)
                src.pop("container_id", None)
        man.pop("integrity_sha256", None)
        man["version"] = 2
        members["manifest.json"] = json.dumps(man).encode()
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in members.items():
                z.writestr(name, data)

        opened = await state.load_sample(str(out))
        assert len(opened) == 1
        assert await state.sources[opened[0]].total() == 1

    async def test_export_empty_range(self, state, log_file, stats_file, tmp_path):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        await _flush()
        out = tmp_path / "empty.cttc"
        r = await state.export_sample(str(out), 0.0, 1.0)  # both log and stats out of range
        assert r["sources"] == 0
        assert zipfile.ZipFile(out).namelist() == ["manifest.json"]

    async def test_export_include_host_false(self, state, stats_file, tmp_path):
        src = state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        src.is_host = True
        await _flush()
        out = tmp_path / "nohost.cttc"
        t0 = ms(2026, 1, 2, 3, 0, 0)
        r = await state.export_sample(str(out), t0, t0 + 60000, include_host=False)
        assert r["sources"] == 0
        st2 = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        st2.redis_log = state.redis_log
        assert await st2.load_sample(str(out)) == []

    async def test_load_sample_skips_blank_log_lines(self, state, tmp_path):
        out = tmp_path / "crafted.cttc"
        with zipfile.ZipFile(out, "w") as z:
            z.writestr("logs/0.jsonl", '{"ts": 1000, "text": "a"}\n\n   \n{"ts": 2000}\n')
            z.writestr(
                "manifest.json",
                json.dumps(
                    {
                        "version": 1,
                        "sources": [{"type": "log", "name": "crafted", "file": "logs/0.jsonl"}],
                    }
                ),
            )
        opened = await state.load_sample(str(out))
        await _flush()
        src = state.sources[opened[0]]
        assert await src.total() == 2
        assert (await src.slice(1, 1))[0]["text"] == ""  # missing text defaults to empty


class TestMultiSegmentSample:
    """Recording feature: Record/Pause spans get flushed into the same
    .cttc archive one segment at a time via merge_sample_bytes(), and
    load_sample() must ask (via MultiSegmentSample) which one to load once
    there's more than one."""

    async def test_merge_from_scratch_is_a_single_segment(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        data, meta, seg_idx = await state.merge_sample_bytes(None, t0, t1)
        assert seg_idx == 0
        assert len(meta) == 1
        man = json.loads(zipfile.ZipFile(io.BytesIO(data)).read("manifest.json"))
        assert len(man["segments"]) == 1
        assert man["segments"][0]["from"] == t0 and man["segments"][0]["to"] == t1

    async def test_merge_appends_a_second_segment_without_losing_the_first(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        first, _meta1, idx1 = await state.merge_sample_bytes(None, t0, t1)
        t2, t3 = ms(2026, 1, 2, 3, 0, 5), ms(2026, 1, 2, 3, 0, 10)
        second, meta2, idx2 = await state.merge_sample_bytes(first, t2, t3)
        assert idx1 == 0 and idx2 == 1
        assert len(meta2) == 1
        man = json.loads(zipfile.ZipFile(io.BytesIO(second)).read("manifest.json"))
        assert len(man["segments"]) == 2
        assert man["segments"][0]["from"] == t0
        assert man["segments"][1]["from"] == t2
        # the first segment's own member bytes must be intact, unchanged
        z = zipfile.ZipFile(io.BytesIO(second))
        assert z.read(man["segments"][0]["sources"][0]["file"])

    async def test_merge_onto_a_legacy_single_segment_file(self, state, log_file, tmp_path):
        # a file exported before the Recording feature (build_sample_bytes'
        # own one-segment shape) must still be a valid base to append onto
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        legacy, _meta = await state.build_sample_bytes(t0, t1)
        t2, t3 = ms(2026, 1, 2, 3, 0, 5), ms(2026, 1, 2, 3, 0, 10)
        merged, meta2, idx2 = await state.merge_sample_bytes(legacy, t2, t3)
        assert idx2 == 1 and len(meta2) == 1
        st2 = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        st2.redis_log = state.redis_log
        out = tmp_path / "merged.cttc"
        out.write_bytes(merged)
        with pytest.raises(server.MultiSegmentSample) as ei:
            await st2.load_sample(str(out))
        assert [s["index"] for s in ei.value.segments] == [0, 1]

    async def test_load_sample_with_explicit_segment_picks_that_one(
        self, state, log_file, tmp_path
    ):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        first, _m1, _i1 = await state.merge_sample_bytes(None, t0, t1)
        t2, t3 = ms(2026, 1, 2, 3, 0, 5), ms(2026, 1, 2, 3, 0, 10)
        merged, _m2, _i2 = await state.merge_sample_bytes(first, t2, t3)
        out = tmp_path / "two-segments.cttc"
        out.write_bytes(merged)

        # Two genuinely separate RedisLogs -- both segments' sources are
        # named "svc" (same original file), so sharing one Redis between
        # st2 and st3 would merge their histories under that one entity
        # name (see redis_log.py's sole-source-of-truth scope boundary).
        st2 = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        st2.redis_log = redis_log.RedisLog(
            socket_path=f"/tmp/cttc-test-{uuid.uuid4().hex[:8]}.sock",
            tcp_port=unique_redis_tcp_port(),
            flush_interval_seconds=0.05,
            data_dir=tmp_path / "redis-data-2",
        )
        await st2.redis_log.start()
        st3 = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        st3.redis_log = redis_log.RedisLog(
            socket_path=f"/tmp/cttc-test-{uuid.uuid4().hex[:8]}.sock",
            tcp_port=unique_redis_tcp_port(),
            flush_interval_seconds=0.05,
            data_dir=tmp_path / "redis-data-3",
        )
        await st3.redis_log.start()
        try:
            opened0 = await st2.load_sample(str(out), segment=0)
            await _flush()
            assert len(opened0) == 1
            assert (await st2.sources[opened0[0]].slice(0, 1))[0]["text"] == "alpha"

            opened1 = await st3.load_sample(str(out), segment=1)
            await _flush()
            assert len(opened1) == 1
            assert (await st3.sources[opened1[0]].slice(0, 1))[0]["text"] == "beta"
        finally:
            await st2.redis_log.stop()
            await st3.redis_log.stop()

    async def test_switching_segments_in_one_state_keeps_each_segments_own_data(
        self, state, log_file, tmp_path
    ):
        """Regression for the recording feature's segment-switch path
        (#record-sections' onchange -> uploadFile(path, index)): unlike
        test_load_sample_with_explicit_segment_picks_that_one, this uses one
        shared State/Redis for both loads (closing segment 0's sources
        before loading segment 1), exactly like the real app switching
        between recorded segments -- confirms content-addressing (see
        _content_entity_id) keeps them from colliding even without two
        separate Redis instances to fall back on."""
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        first, _m1, _i1 = await state.merge_sample_bytes(None, t0, t1)
        t2, t3 = ms(2026, 1, 2, 3, 0, 5), ms(2026, 1, 2, 3, 0, 10)
        merged, _m2, _i2 = await state.merge_sample_bytes(first, t2, t3)
        out = tmp_path / "two-segments.cttc"
        out.write_bytes(merged)

        opened0 = await state.load_sample(str(out), segment=0)
        await _flush()
        assert (await state.sources[opened0[0]].slice(0, 1))[0]["text"] == "alpha"
        for sid in opened0:
            state.close_source(sid)

        opened1 = await state.load_sample(str(out), segment=1)
        await _flush()
        assert (await state.sources[opened1[0]].slice(0, 1))[0]["text"] == "beta"

    async def test_single_segment_file_loads_without_a_segment_arg(self, state, log_file, tmp_path):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        data, _meta, _idx = await state.merge_sample_bytes(None, t0, t1)
        out = tmp_path / "one-segment.cttc"
        out.write_bytes(data)
        st2 = server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data"))
        st2.redis_log = state.redis_log
        assert len(await st2.load_sample(str(out))) == 1  # no MultiSegmentSample raised

    async def test_merge_over_a_wide_range_only_returns_genuinely_captured_rows(self, state, log_file):
        """br-ORPHAN-005 (REQ-0067): resuming a crash-interrupted recording
        from its original segmentStart, however long ago, must never
        fabricate data for the stretch where nothing was actually
        collected -- it should just come back empty for that portion while
        still picking up whatever genuinely exists. Simulates that by
        requesting a segment far wider than the fixture's actual data
        range, the same shape as flushRecordingSegment's real call once a
        recording is resumed via "Resume from the interruption point"."""
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        # log_file's only two rows are at 03:00:00 and 03:00:10 -- request
        # a segment spanning a full hour around them, well past both ends.
        t0, t1 = ms(2026, 1, 2, 2, 0, 0), ms(2026, 1, 2, 4, 0, 0)
        data, meta, seg_idx = await state.merge_sample_bytes(None, t0, t1)
        assert seg_idx == 0
        assert len(meta) == 1
        man = json.loads(zipfile.ZipFile(io.BytesIO(data)).read("manifest.json"))
        # the manifest honestly records the full requested range as the
        # segment's span (what the resumed recording's highlight band will
        # show) ...
        assert man["segments"][0]["from"] == t0 and man["segments"][0]["to"] == t1
        # ... but the row content underneath is only ever the two rows
        # that genuinely exist -- nothing fabricated for the empty hour on
        # either side.
        rows = (
            zipfile.ZipFile(io.BytesIO(data))
            .read(man["segments"][0]["sources"][0]["file"])
            .decode()
            .splitlines()
        )
        assert len(rows) == 2
        assert [json.loads(r)["text"] for r in rows] == ["alpha", "beta"]


# ── HTTP API ─────────────────────────────────────────────────────────────────


def boot_server(state):
    """Boots the real FastAPI app (via uvicorn) in a background thread with
    its own event loop, on an OS-assigned port -- get/post/get_raw/post_raw
    below hit it over a real TCP socket exactly like main.js's Electron
    client does, so these tests exercise the actual HTTP contract, not an
    in-process shortcut. Returns (base_url, srv, thread); caller is
    responsible for srv.should_exit = True + thread.join()."""
    server.app.state.cttc = state

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = sock.getsockname()[1]

    config = uvicorn.Config(server.app, fd=sock.fileno(), log_level="warning", access_log=False)
    srv = uvicorn.Server(config)
    server.app.state.uvicorn_server = srv

    loop = asyncio.new_event_loop()

    def run():
        asyncio.set_event_loop(loop)
        loop.run_until_complete(srv.serve())

    t = threading.Thread(target=run, daemon=True)
    t.start()
    deadline = time.time() + 5
    while not srv.started and time.time() < deadline:
        time.sleep(0.01)

    return f"http://127.0.0.1:{port}", srv, t


@pytest.fixture
def api(tmp_path, log_file, stats_file):
    """Deliberately does NOT reuse the `state` fixture (which starts its
    own RedisLog on the pytest event loop): the HTTP server here runs on a
    *separate* event loop in a background thread (see boot_server), and
    redis.asyncio's client/connection pool is bound to whichever loop
    first used it -- reusing a client across two different loops raises
    ("Future attached to a different loop"). Building a fresh, unstarted
    State here and letting boot_server's lifespan() start its RedisLog
    keeps everything -- client, pump task, and every route handler's reads
    -- on the one loop that actually serves requests. Sources are opened
    only *after* boot_server returns (i.e. after lifespan has finished),
    via `state.open_file()`'s call_soon_threadsafe write path, which is
    safe to call from any thread."""
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    (tdir / "upper.py").write_text(
        '"""Uppercase text."""\n'
        "def transform(r):\n"
        '    r["text"] = r["text"].upper()\n'
        "    return r\n"
    )
    state = server.State(tdir, redis_flush_interval_seconds=0.05, redis_data_dir=str(tdir / "redis-data"))
    base, srv, t = boot_server(state)
    state.open_file(str(log_file), "auto", None, live=False, transforms=[])
    state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
    time.sleep(0.3)  # let redis_log's pump (on the server's own loop) catch up
    yield base, state
    srv.should_exit = True
    t.join(timeout=5)


def get(base, path, headers=None):
    req = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def post(base, path, body=None, headers=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(base + path, data=data, method="POST", headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def get_raw(base, path):
    """Like get(), but for binary (non-JSON) responses: /files/download.
    Deliberately doesn't dict()-wrap the headers -- that would lose
    email.message.Message's case-insensitive lookup, and uvicorn (unlike
    the old http.server) sends header names lowercased on the wire."""
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def post_raw(base, path, data, headers=None):
    """Like post(), but for a raw binary body + custom headers: /files/upload."""
    req = urllib.request.Request(base + path, data=data, method="POST", headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def post_raw_binary(base, path, data, headers=None):
    """Like post_raw(), but for an endpoint whose *response* body is also
    raw bytes, not JSON: /sample/record."""
    req = urllib.request.Request(base + path, data=data, method="POST", headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


class TestHttpApi:
    def test_sources_and_range(self, api):
        base, _ = api
        code, j = get(base, "/sources")
        assert code == 200 and len(j["sources"]) == 2 and j["json_impl"] == server.JSON_IMPL
        code, j = get(base, "/range")
        assert j["min_ts"] == ms(2026, 1, 2, 3, 0, 0)
        assert j["max_ts"] == ms(2026, 1, 2, 3, 0, 10)

    def test_every_request_is_access_logged_in_detail(self, api, caplog):
        base, _ = api
        with caplog.at_level("INFO", logger="cttc"):
            code, _ = get(base, "/sources")
        assert code == 200
        lines = [r.message for r in caplog.records if r.name == "cttc"]
        match = next((m for m in lines if "/sources" in m), None)
        assert match, lines
        assert match.startswith("GET /sources")
        assert "200" in match
        assert "ms)" in match  # timing recorded

    def test_access_log_includes_query_string_and_client(self, api, caplog):
        base, st = api
        sid = next(s.id for s in st.sources.values() if s.kind == "log")
        with caplog.at_level("INFO", logger="cttc"):
            get(base, f"/logs?source={sid}&start=0&count=10")
        match = next(
            (r.message for r in caplog.records if r.name == "cttc" and "/logs" in r.message), None
        )
        assert match
        assert f"?source={sid}&start=0&count=10" in match
        assert "127.0.0.1" in match

    def test_access_log_reflects_error_status_codes(self, api, caplog):
        base, _ = api
        with caplog.at_level("INFO", logger="cttc"):
            get(base, "/logs?source=nope")
        match = next(
            (r.message for r in caplog.records if r.name == "cttc" and "/logs" in r.message), None
        )
        assert match and " 400 " in match

    def test_range_empty(self, tmp_path):
        base, srv, t = boot_server(server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data")))
        try:
            _, j = get(base, "/range")
            assert j == {"min_ts": None, "max_ts": None}
        finally:
            srv.should_exit = True
            t.join(timeout=5)

    def test_series(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _, j = get(base, f"/series?from={t0}&to={t0 + 10000}&px=20")
        assert j["px"] == 20
        assert [s["name"] for s in j["services"]] == ["api"]
        assert any(v is not None for v in j["services"][0]["cpu"])

    def test_series_default_px(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _, j = get(base, f"/series?from={t0}&to={t0 + 1000}")
        assert j["px"] == 800

    def test_stats_export_summary(self, api):
        base, st = api
        sid = next(s.id for s in st.sources.values() if s.kind == "stats")
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _, j = get(base, f"/stats_export?from={t0}&to={t0 + 10000}&granularity=summary")
        assert j["granularity"] == "summary"
        assert [s["name"] for s in j["services"]] == ["api"]
        svc = j["services"][0]
        assert svc["sid"] == sid  # lets the client scope results to the active sample, like bucketed()'s own "sid"
        assert svc["count"] == 3  # stats_file seeds 3 rows, see its own fixture
        assert svc["cpu"] == {"min": 10.0, "avg": 10.0, "max": 10.0}
        assert svc["mem"] == {"min": 20.0, "avg": 20.0, "max": 20.0}

    def test_stats_export_full(self, api):
        base, st = api
        sid = next(s.id for s in st.sources.values() if s.kind == "stats")
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _, j = get(base, f"/stats_export?from={t0}&to={t0 + 10000}&granularity=full")
        assert j["granularity"] == "full"
        svc = j["services"][0]
        assert svc["sid"] == sid
        assert len(svc["samples"]) == 3
        assert svc["samples"][0]["cpu"] == 10.0
        assert svc["samples"][0]["mem"] == 20.0

    def test_stats_export_default_granularity_is_summary(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _, j = get(base, f"/stats_export?from={t0}&to={t0 + 10000}")
        assert j["granularity"] == "summary"

    def test_stats_export_requires_from_and_to(self, api):
        base, _ = api
        status, _ = get(base, "/stats_export?from=1")
        assert status == 400
        status, _ = get(base, "/stats_export?to=1")
        assert status == 400

    def test_stats_export_rejects_a_bad_granularity(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        status, _ = get(base, f"/stats_export?from={t0}&to={t0 + 1000}&granularity=bogus")
        assert status == 400

    def test_logs_index_ticks(self, api):
        base, st = api
        sid = next(s.id for s in st.sources.values() if s.kind == "log")
        _, j = get(base, f"/logs?source={sid}&start=0&count=10")
        assert j["total"] == 2 and j["rows"][0]["text"] == "alpha"
        _, j = get(base, f"/logs?source={sid}")  # defaults
        assert len(j["rows"]) == 2
        _, j = get(base, f"/index_at?source={sid}&t={ms(2026, 1, 2, 3, 0, 9)}")
        assert j["index"] == 1
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _, j = get(base, f"/ticks?source={sid}&from={t0}&to={t0 + 11000}&px=11")
        assert sum(j["counts"]) == 2

    def test_log_endpoints_reject_stats_source(self, api):
        base, st = api
        sid = next(s.id for s in st.sources.values() if s.kind == "stats")
        code, j = get(base, f"/logs?source={sid}")
        assert code == 400 and "unknown log source" in j["error"]

    def test_transforms_listing(self, api):
        base, _ = api
        _, j = get(base, "/transforms")
        assert j["transforms"][0]["name"] == "upper"
        assert j["transforms"][0]["doc"] == "Uppercase text."

    def test_ssh_keys_endpoint(self, api, monkeypatch):
        base, _ = api
        monkeypatch.setattr(server, "list_ssh_keys", lambda: ["/home/u/.ssh/id_rsa"])
        _, j = get(base, "/ssh/keys")
        assert j["keys"] == ["/home/u/.ssh/id_rsa"]

    def test_ssh_keys_endpoint_never_discloses_full_paths(self, api, tmp_path, monkeypatch):
        # br-NET-005: any client reachable on the port could enumerate the
        # operator's private-key file paths (and thus their username/home
        # dir); only basenames may cross the wire.
        base, _ = api
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        d = tmp_path / ".ssh"
        d.mkdir()
        (d / "id_ed25519").write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n...")
        _, j = get(base, "/ssh/keys")
        assert j["keys"] == ["id_ed25519"]
        assert all("/" not in k and str(tmp_path) not in k for k in j["keys"])

    def test_missing_params_400(self, api):
        base, _ = api
        code, j = get(base, "/series")
        assert code == 400 and "bad request" in j["error"]

    def test_index_at_and_ticks_missing_params_400(self, api):
        base, st = api
        sid = next(s.id for s in st.sources.values() if s.kind == "log")
        code, j = get(base, f"/index_at?source={sid}")  # missing t
        assert code == 400 and "'t' is required" in j["error"]
        code, j = get(base, f"/ticks?source={sid}&from=0")  # missing to
        assert code == 400 and "'from' and 'to' are required" in j["error"]

    def test_close_missing_id_400(self, api):
        base, _ = api
        code, j = post(base, "/close", {})
        assert code == 400 and "'id' is required" in j["error"]

    def test_health(self, api):
        base, _ = api
        code, j = get(base, "/health")
        assert code == 200 and j == {"ok": True}

    def test_unknown_paths_404(self, api):
        base, _ = api
        assert get(base, "/nope")[0] == 404
        assert post(base, "/nope")[0] == 404

    def test_options_preflight(self, api):
        base, _ = api
        conn = http.client.HTTPConnection(base.split("//")[1], timeout=5)
        conn.request("OPTIONS", "/open")
        resp = conn.getresponse()
        assert resp.status == 204
        assert resp.getheader("Access-Control-Allow-Origin") == "*"
        conn.close()

    def test_open_close_and_errors(self, api, tmp_path):
        base, st = api
        extra = tmp_path / "extra.log"
        extra.write_text("2026-01-02T03:00:20Z gamma\n")
        code, j = post(
            base,
            "/open",
            {
                "files": [
                    {"path": str(extra), "live": False},
                    {"path": "/no/such/file"},
                ]
            },
        )
        assert code == 200
        assert len(j["opened"]) == 1
        assert j["errors"][0]["path"] == "/no/such/file"
        sid = j["opened"][0]
        _, j = post(base, "/close", {"id": sid})
        assert j["ok"] is True
        assert sid not in st.sources

    def test_sample_export_and_reload_via_open(self, api, tmp_path):
        base, _ = api
        out = tmp_path / "range.cttc-metric"
        t0 = ms(2026, 1, 2, 3, 0, 0)
        code, j = post(base, "/sample/export", {"path": str(out), "from": t0, "to": t0 + 11000})
        assert code == 200 and j["sources"] == 2
        code, j = post(base, "/open", {"files": [{"path": str(out)}]})
        assert code == 200 and len(j["opened"]) == 2 and j["errors"] == []

    def test_sample_record_first_segment_from_empty_body(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        code, headers, data = post_raw_binary(
            base,
            "/sample/record",
            b"",
            {"X-CTTC-From": str(t0), "X-CTTC-To": str(t0 + 5000)},
        )
        assert code == 200
        assert headers["X-CTTC-Segment-Index"] == "0"
        man = json.loads(zipfile.ZipFile(io.BytesIO(data)).read("manifest.json"))
        assert len(man["segments"]) == 1

    def test_sample_record_second_segment_appends(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _code, _h, first = post_raw_binary(
            base, "/sample/record", b"", {"X-CTTC-From": str(t0), "X-CTTC-To": str(t0 + 5000)}
        )
        code, headers, second = post_raw_binary(
            base,
            "/sample/record",
            first,
            {"X-CTTC-From": str(t0 + 5000), "X-CTTC-To": str(t0 + 10000)},
        )
        assert code == 200
        assert headers["X-CTTC-Segment-Index"] == "1"
        man = json.loads(zipfile.ZipFile(io.BytesIO(second)).read("manifest.json"))
        assert len(man["segments"]) == 2

    def test_sample_record_include_host_false(self, api):
        base, state = api
        for s in state.sources.values():
            if s.kind == "stats":
                s.is_host = True
        t0 = ms(2026, 1, 2, 3, 0, 0)
        code, _headers, data = post_raw_binary(
            base,
            "/sample/record",
            b"",
            {
                "X-CTTC-From": str(t0),
                "X-CTTC-To": str(t0 + 20000),
                "X-CTTC-Include-Host": "0",
            },
        )
        assert code == 200
        man = json.loads(zipfile.ZipFile(io.BytesIO(data)).read("manifest.json"))
        assert all(s["type"] != "stats" for s in man["segments"][0]["sources"])

    def test_open_multi_segment_file_returns_needs_selection(self, api, tmp_path):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _code, _h, first = post_raw_binary(
            base, "/sample/record", b"", {"X-CTTC-From": str(t0), "X-CTTC-To": str(t0 + 5000)}
        )
        _code, _h, second = post_raw_binary(
            base,
            "/sample/record",
            first,
            {"X-CTTC-From": str(t0 + 5000), "X-CTTC-To": str(t0 + 10000)},
        )
        out = tmp_path / "recorded.cttc-record"
        out.write_bytes(second)

        code, j = post(base, "/open", {"files": [{"path": str(out)}]})
        assert code == 200
        assert j["opened"] == []
        assert j["errors"] == []
        assert len(j["needs_selection"]) == 1
        segs = j["needs_selection"][0]["segments"]
        assert [s["index"] for s in segs] == [0, 1]

        # picking one this time opens it normally
        code, j = post(base, "/open", {"files": [{"path": str(out), "segment": 1}]})
        assert code == 200
        assert len(j["opened"]) == 1
        assert j["needs_selection"] == []

    def test_docker_ps_endpoint(self, api, monkeypatch):
        base, _ = api

        async def fake_ps(host, ssh_key=None):
            return {"containers": [], "services": [], "host": host, "key": ssh_key}

        monkeypatch.setattr(server, "docker_ps", fake_ps)
        _, j = post(base, "/docker/ps", {"host": "ssh://u@h", "ssh_key": "/k"})
        assert j["host"] == "ssh://u@h" and j["key"] == "/k"

    def test_docker_ps_endpoint_rejects_a_non_ssh_scheme(self, api):
        # br-CONN-002: used to be silently parsed into garbage (an ssh
        # attempt to a nonsense host:port) instead of rejected with a
        # clean error. Real docker_ps, not monkeypatched -- normalize_docker_host
        # raises before it ever touches a subprocess/ssh client.
        base, _ = api
        code, j = post(base, "/docker/ps", {"host": "tcp://1.2.3.4:2375"})
        assert code == 400
        assert "unsupported docker host transport" in j["error"]

    def test_docker_ps_endpoint_rejects_a_bad_port(self, api):
        # br-CONN-005: real docker_ps, not monkeypatched -- normalize_docker_host
        # raises before it ever touches a subprocess/ssh client.
        base, _ = api
        code, j = post(base, "/docker/ps", {"host": "ssh://h:notaport"})
        assert code == 400
        assert "invalid ssh port" in j["error"]

    def test_docker_ps_endpoint_reports_runtime_error(self, api, monkeypatch):
        # a failed ssh/docker call must still get a real response (not a
        # dropped connection the client sees as "failed to fetch")
        base, _ = api

        def boom(host, ssh_key=None):
            raise RuntimeError("Permission denied (publickey)")

        monkeypatch.setattr(server, "docker_ps", boom)
        code, j = post(base, "/docker/ps", {"host": "ssh://u@h"})
        assert code == 502 and "Permission denied" in j["error"]

    def test_docker_ps_endpoint_reports_attempted_log(self, api, monkeypatch):
        # DockerPsError (unlike a plain RuntimeError) carries the commands
        # actually attempted, so the client can render them even on failure.
        base, _ = api

        def boom(host, ssh_key=None):
            raise server.DockerPsError(
                "timed out",
                [{"cmd": "docker ps", "returncode": None, "ms": 30000, "stderr": "timed out"}],
            )

        monkeypatch.setattr(server, "docker_ps", boom)
        code, j = post(base, "/docker/ps", {"host": "ssh://u@h"})
        assert code == 502 and j["log"][0]["cmd"] == "docker ps"

    def test_unhandled_exception_still_gets_a_response(self, api, monkeypatch):
        # any exception type NOT explicitly handled (an OSError from a
        # wedged subprocess, a plain bug, ...) used to propagate out of
        # do_POST entirely -- http.server then just drops the connection
        # with zero bytes sent, which the browser reports as
        # ERR_EMPTY_RESPONSE / ERR_TOO_MANY_RETRIES with no diagnostic at
        # all. Must always get a real (500) response instead.
        base, _ = api

        def boom(host, ssh_key=None):
            raise OSError("wedged subprocess pipe")

        monkeypatch.setattr(server, "docker_ps", boom)
        code, j = post(base, "/docker/ps", {"host": "ssh://u@h"})
        assert code == 500 and "wedged subprocess pipe" in j["error"]

    def test_docker_collect_endpoint(self, api, docker_cli, monkeypatch):
        base, st = api
        _no_op_docker(monkeypatch)
        code, j = post(
            base,
            "/docker/collect",
            {
                "stats": True,
                "host_stats": True,
                "logs": [{"name": "web", "type": "container"}],
                "interval": 0.05,
            },
        )
        assert code == 200 and len(j["opened"]) == 3
        for sid in j["opened"]:
            st.close_source(sid)

    def test_docker_collect_endpoint_rejects_a_non_ssh_scheme(self, api):
        # br-CONN-002
        base, st = api
        before = set(st.sources)
        code, j = post(
            base,
            "/docker/collect",
            {"host": "tcp://1.2.3.4:2375", "stats": True, "host_stats": False, "logs": []},
        )
        assert code == 400
        assert "unsupported docker host transport" in j["error"]
        assert set(st.sources) == before, "nothing should have been opened"

    def test_docker_collect_endpoint_rejects_a_bad_port(self, api):
        # br-CONN-005
        base, st = api
        before = set(st.sources)
        code, j = post(
            base,
            "/docker/collect",
            {"host": "ssh://h:notaport", "stats": True, "host_stats": False, "logs": []},
        )
        assert code == 400
        assert "invalid ssh port" in j["error"]
        assert set(st.sources) == before, "nothing should have been opened"

    def test_docker_forget_endpoint_calls_forget_daemon_with_the_normalized_host(self, api, monkeypatch):
        # br-REDIS-017: Remove Docker Host must actually reach the server's
        # Redis-side daemon registry, not just close in-memory sources --
        # this is the route that lets it do so.
        base, st = api
        captured = {}

        async def fake_forget(host):
            captured["host"] = host

        monkeypatch.setattr(st.redis_log, "forget_daemon", fake_forget)
        code, j = post(base, "/docker/forget", {"host": "u@h"})
        assert code == 200 and j == {"ok": True}
        assert captured["host"] == "ssh://u@h"  # normalize_docker_host adds the scheme

    def test_point_endpoint(self, api):
        base, _ = api
        t = ms(2026, 1, 2, 3, 0, 1)
        _, j = get(base, f"/point?t={t}")
        assert j["t"] == t
        assert j["services"]["api"]["cpu"] == 10.0
        assert abs(j["services"]["api"]["ts"] - t) < 1500
        assert get(base, "/point")[0] == 400  # t is required

    def test_logs_find_endpoint(self, api):
        base, st = api
        sid = next(s.id for s in st.sources.values() if s.kind == "log")
        _, j = get(base, f"/logs/find?source={sid}&q=beta&start=0")
        assert j["index"] == 1
        _, j = get(base, f"/logs/find?source={sid}&q=alpha&start=1&dir=back")
        assert j["index"] == 0
        _, j = get(base, f"/logs/find?source={sid}&q=zzz")
        assert j["index"] is None

    def test_export_include_host_flag_over_http(self, api, tmp_path):
        base, st = api
        for s in st.sources.values():
            if s.kind == "stats":
                s.is_host = True
        out = tmp_path / "nohost-http.cttc"
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _, j = post(
            base,
            "/sample/export",
            {"path": str(out), "from": t0, "to": t0 + 60000, "include_host": False},
        )
        assert j["sources"] == 1  # only the log made it in

    def test_get_broken_pipe_swallowed(self, api, monkeypatch):
        # BrokenPipeError from business logic is just another exception now
        # -- the catch-all handler always tries to answer with a real
        # response (see server.py's _unhandled_error_handler); if the
        # client really has disconnected, that write harmlessly fails at
        # the transport layer instead of ever reaching this assertion.
        base, st = api

        def explode():
            raise BrokenPipeError()

        monkeypatch.setattr(st, "describe", explode)
        code, j = get(base, "/sources")
        assert code == 500 and "error" in j

    def test_sse_keepalive_comment(self, api, monkeypatch):
        base, _st = api
        monkeypatch.setattr(server, "SSE_KEEPALIVE_INTERVAL", 0.05)  # shrink the 15s wait
        conn = http.client.HTTPConnection(base.split("//")[1], timeout=5)
        conn.request("GET", "/events")
        resp = conn.getresponse()
        line = resp.readline()
        assert line.startswith(b": keepalive")
        resp.close()
        conn.close()

    def test_sse_event_delivery_and_cleanup(self, api):
        base, st = api
        host = base.split("//")[1]
        conn = http.client.HTTPConnection(host, timeout=5)
        conn.request("GET", "/events")
        sock = conn.sock  # getresponse() may detach conn.sock
        resp = conn.getresponse()
        deadline = time.time() + 3
        while not st.listeners and time.time() < deadline:
            time.sleep(0.02)
        st.broadcast({"type": "ping"})
        line = resp.readline()
        assert line.startswith(b"data:") and b"ping" in line
        # force an immediate RST so the handler's next write fails (a plain
        # close is a half-close, which the server can keep writing into)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        resp.close()  # the streaming response owns the socket, not conn
        sock.close()
        conn.close()
        deadline = time.time() + 5
        while st.listeners and time.time() < deadline:
            st.broadcast({"type": "flush"})
            time.sleep(0.05)
        assert st.listeners == []

    def test_shutdown_endpoint(self, tmp_path):
        base, _srv, t = boot_server(server.State(tmp_path, redis_flush_interval_seconds=0.05, redis_data_dir=str(tmp_path / "redis-data")))
        code, j = post(base, "/shutdown")
        assert code == 200 and j["ok"] is True
        t.join(timeout=5)
        assert not t.is_alive()


class TestBufferSessionSchedulerEndpoints:
    """HTTP-level coverage for /buffer/*, /session/*, /logs/rate, and
    /scheduler/* -- these managers (rolling_buffer.py, recording_session.py,
    scheduler.py) each have their own thorough unit tests, but none of that
    exercised the actual FastAPI routes wrapping them (request body
    parsing, 404 mapping for unknown ids, response shapes) until now."""

    def test_buffer_start_pause_stop(self, api):
        base, _ = api
        code, j = post(base, "/buffer/start", {"minutes": 5})
        assert code == 200 and j["buffer_id"]
        buffer_id = j["buffer_id"]

        code, j = post(base, f"/buffer/{buffer_id}/pause")
        assert code == 200 and j["ok"] is True

        code, headers, data = post_raw_binary(base, f"/buffer/{buffer_id}/stop", b"")
        assert code == 200
        # source count isn't asserted here: the buffer's window is
        # [start_ts, now], and the api fixture's sources are static files
        # with fixed historical timestamps unrelated to wall-clock "now" --
        # the header's presence/shape is what this test is really after.
        assert "X-CTTC-Source-Count" in headers
        assert data[:2] == b"PK"  # zip magic

    def test_buffer_pause_and_stop_unknown_id_is_404(self, api):
        base, _ = api
        assert post(base, "/buffer/nope/pause")[0] == 404
        assert post_raw_binary(base, "/buffer/nope/stop", b"")[0] == 404

    def test_buffer_start_rejects_once_the_ad_hoc_cap_is_reached(self, api):
        # br-RBUF-005: POST /buffer/start used to be completely uncapped.
        import rolling_buffer

        base, state = api
        for _ in range(rolling_buffer.MAX_OPEN):
            state.rolling_buffers.start(5)
        code, j = post(base, "/buffer/start", {"minutes": 5})
        assert code == 400 and "error" in j
        for bid in list(state.rolling_buffers._buffers):
            state.rolling_buffers._buffers.pop(bid)  # clean up after ourselves

    def test_session_start_stop_status_download(self, api):
        base, _ = api
        code, j = post(base, "/session/start", {"safe": True})
        assert code == 200 and j["session_id"]
        session_id = j["session_id"]

        code, j = get(base, f"/session/{session_id}/status")
        assert code == 200 and j["status"] == "running" and j["ready"] is False

        code, j = post(base, f"/session/{session_id}/stop")
        assert code == 200 and j["ok"] is True

        code, j = get(base, f"/session/{session_id}/status")
        assert code == 200 and j["status"] == "completed" and j["ready"] is True

        code, headers, data = get_raw(base, f"/session/{session_id}/download")
        assert code == 200
        assert headers["Content-Disposition"].endswith(f'{session_id}.cttc-record"')
        assert data[:2] == b"PK"

    def test_session_safe_flags_a_running_session(self, api):
        base, _ = api
        session_id = post(base, "/session/start")[1]["session_id"]
        code, j = post(base, f"/session/{session_id}/safe", {"max_keep_seconds": 3600})
        assert code == 200 and j["ok"] is True
        post(base, f"/session/{session_id}/stop")

    def test_session_download_before_completion_is_404(self, api):
        base, _ = api
        session_id = post(base, "/session/start")[1]["session_id"]
        assert get_raw(base, f"/session/{session_id}/download")[0] == 404
        post(base, f"/session/{session_id}/stop")  # avoid leaking a running session

    def test_session_unknown_id_is_404_everywhere(self, api):
        base, _ = api
        assert post(base, "/session/nope/stop")[0] == 404
        assert post(base, "/session/nope/safe", {"max_keep_seconds": 60})[0] == 404
        assert get(base, "/session/nope/status")[0] == 404
        assert get_raw(base, "/session/nope/download")[0] == 404

    def test_session_ttl(self, api):
        base, state = api
        code, j = post(base, "/session/ttl", {"seconds": 60})
        assert code == 200 and j["ok"] is True
        assert state.recording_sessions.default_ttl_seconds == 60

    def test_logs_rate_get_returns_current_flush_interval(self, api):
        base, state = api
        code, j = get(base, "/logs/rate")
        assert code == 200 and j["seconds"] == state.redis_log.flush_interval_seconds

    def test_logs_rate_post_updates_it(self, api):
        base, state = api
        code, j = post(base, "/logs/rate", {"seconds": 5.0})
        assert code == 200 and j["ok"] is True
        assert state.redis_log.flush_interval_seconds == 5.0
        code, j = get(base, "/logs/rate")
        assert code == 200 and j["seconds"] == 5.0

    def test_logs_rate_post_rejects_too_small_a_value(self, api):
        import redis_log

        base, state = api
        original = state.redis_log.flush_interval_seconds
        code, j = post(base, "/logs/rate", {"seconds": redis_log.MIN_FLUSH_INTERVAL_SECONDS / 2})
        assert code == 400 and "error" in j
        assert state.redis_log.flush_interval_seconds == original, "rejected calls must not change the rate"

    def test_logs_rate_post_broadcasts_a_rate_event(self, api):
        base, st = api
        host = base.split("//")[1]
        conn = http.client.HTTPConnection(host, timeout=5)
        conn.request("GET", "/events")
        sock = conn.sock  # getresponse() may detach conn.sock
        resp = conn.getresponse()
        deadline = time.time() + 3
        while not st.listeners and time.time() < deadline:
            time.sleep(0.02)
        code, j = post(base, "/logs/rate", {"seconds": 3.0})
        assert code == 200 and j["ok"] is True
        line = resp.readline()
        assert line.startswith(b"data:") and b'"rate"' in line and b"3.0" in line
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        resp.close()
        sock.close()
        conn.close()

    def test_scheduler_create_status_cancel_one_shot(self, api):
        base, _ = api
        code, j = post(
            base,
            "/scheduler/create",
            {"duration_minutes": 5, "start_at": (time.time() + 3600) * 1000.0},
        )
        assert code == 200 and j["schedule_id"]
        schedule_id = j["schedule_id"]

        code, j = get(base, f"/scheduler/{schedule_id}")
        assert code == 200 and j["schedule_id"] == schedule_id

        code, j = post(base, f"/scheduler/{schedule_id}/cancel")
        assert code == 200 and j["ok"] is True
        assert get(base, f"/scheduler/{schedule_id}")[0] == 404

    def test_scheduler_create_recurring_with_cron(self, api):
        base, _ = api
        code, j = post(base, "/scheduler/create", {"duration_minutes": 1, "cron": "*/5 * * * *"})
        assert code == 200 and j["schedule_id"]

    def test_scheduler_create_requires_exactly_one_of_start_at_or_cron(self, api):
        base, _ = api
        code, j = post(base, "/scheduler/create", {"duration_minutes": 1})
        assert code == 400 and "error" in j
        code, j = post(
            base,
            "/scheduler/create",
            {"duration_minutes": 1, "start_at": time.time() * 1000.0, "cron": "*/5 * * * *"},
        )
        assert code == 400

    def test_scheduler_create_invalid_cron_is_400(self, api):
        base, _ = api
        code, j = post(
            base, "/scheduler/create", {"duration_minutes": 1, "cron": "not a cron expr"}
        )
        assert code == 400 and "error" in j

    def test_scheduler_status_and_cancel_unknown_id_is_404(self, api):
        base, _ = api
        assert get(base, "/scheduler/nope")[0] == 404
        assert post(base, "/scheduler/nope/cancel")[0] == 404


class TestEventsEndpoints:
    """HTTP-level coverage for /events/* -- these previously only had
    EventManager unit tests (test_events.py), which missed a real routing
    bug: GET /events/list used to be plainly GET /events, which collides
    with the pre-existing GET /events SSE stream (see route_events above
    the /docker/ps routes) -- FastAPI matched the SSE route first, so a
    plain fetch() from the renderer never resolved .json() (an SSE
    response's body never ends). urllib.request.urlopen(timeout=5) below
    would have caught that immediately as a clear timeout instead of a
    silent hang, which is exactly why this class exists now."""

    def test_create_list_and_status(self, api):
        base, _ = api
        code, j = post(
            base,
            "/events/create",
            {
                "name": "cpu high",
                "source_ids": [],
                "conditions": [{"type": "metric", "metric": "cpu", "op": ">", "threshold": 80}],
                "action": {"kind": "snapshot", "minutes": 5},
            },
        )
        assert code == 200 and j["event_id"]
        event_id = j["event_id"]

        code, j = get(base, "/events/list")
        assert code == 200 and event_id in j["event_ids"]

        code, j = get(base, f"/events/{event_id}")
        assert code == 200
        assert j["name"] == "cpu high"
        assert j["conditions"] == [{"type": "metric", "metric": "cpu", "op": ">", "threshold": 80}]
        assert j["status"] == "armed"

    def test_events_list_is_not_shadowed_by_the_sse_stream(self, api):
        """The actual regression: GET /events (the SSE stream) must keep
        working, and GET /events/list must be its own, independent route."""
        base, _ = api
        code, j = get(base, "/events/list")
        assert code == 200 and j["event_ids"] == []

    def test_enable_disable_reset_cancel(self, api):
        base, _ = api
        _code, j = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "log", "pattern": "ERROR"}],
                "action": {"kind": "recording", "duration_minutes": 1},
            },
        )
        event_id = j["event_id"]

        code, _ = post(base, f"/events/{event_id}/disable")
        assert code == 200
        assert get(base, f"/events/{event_id}")[1]["enabled"] is False

        code, _ = post(base, f"/events/{event_id}/enable")
        assert code == 200
        assert get(base, f"/events/{event_id}")[1]["enabled"] is True

        code, _ = post(base, f"/events/{event_id}/reset")
        assert code == 200

        code, _ = post(base, f"/events/{event_id}/cancel")
        assert code == 200
        assert get(base, f"/events/{event_id}")[0] == 404

    def test_create_with_invalid_condition_is_a_400(self, api):
        base, _ = api
        code, j = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "bogus"}],
                "action": {"kind": "snapshot", "minutes": 5},
            },
        )
        assert code == 400 and "error" in j

    def test_unknown_event_operations_are_404(self, api):
        base, _ = api
        assert get(base, "/events/nope")[0] == 404
        assert post(base, "/events/nope/enable")[0] == 404
        assert post(base, "/events/nope/disable")[0] == 404
        assert post(base, "/events/nope/reset")[0] == 404
        assert post(base, "/events/nope/cancel")[0] == 404
        assert post(base, "/events/nope/update", {"name": "x"})[0] == 404

    def test_update_changes_only_given_fields(self, api):
        base, _ = api
        _code, j = post(
            base,
            "/events/create",
            {
                "name": "old",
                "conditions": [{"type": "metric", "metric": "cpu", "op": ">", "threshold": 80}],
                "action": {"kind": "recording", "duration_minutes": 5},
            },
        )
        event_id = j["event_id"]

        code, j = post(base, f"/events/{event_id}/update", {"name": "new"})
        assert code == 200 and j["ok"] is True

        code, st = get(base, f"/events/{event_id}")
        assert code == 200
        assert st["name"] == "new"
        assert st["action"]["duration_minutes"] == 5  # unchanged

    def test_update_with_invalid_conditions_is_a_400(self, api):
        base, _ = api
        _code, j = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "log", "pattern": "ERROR"}],
                "action": {"kind": "recording", "duration_minutes": 5},
            },
        )
        event_id = j["event_id"]
        code, j = post(base, f"/events/{event_id}/update", {"conditions": [{"type": "bogus"}]})
        assert code == 400 and "error" in j

    def test_create_with_semantically_invalid_condition_is_a_400(self, api):
        """Unlike test_create_with_invalid_condition_is_a_400 (a bad
        condition *type*, rejected by _parse_condition itself), this one
        parses fine but fails EventManager._validate()'s own semantic check
        (unknown metric name) -- a different exception type (InvalidEvent)
        taking a different except branch in route_events_create."""
        base, _ = api
        code, j = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "metric", "metric": "disk", "op": ">", "threshold": 1}],
                "action": {"kind": "snapshot", "minutes": 5},
            },
        )
        assert code == 400 and "unknown metric" in j["error"]

    def test_update_with_semantically_invalid_condition_is_a_400(self, api):
        base, _ = api
        event_id = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "log", "pattern": "ERROR"}],
                "action": {"kind": "recording", "duration_minutes": 5},
            },
        )[1]["event_id"]
        code, j = post(
            base,
            f"/events/{event_id}/update",
            {"conditions": [{"type": "metric", "metric": "disk", "op": ">", "threshold": 1}]},
        )
        assert code == 400 and "unknown metric" in j["error"]

    def test_create_with_missing_condition_fields_is_a_400(self, api):
        """A metric condition missing its required keys (metric/op/threshold)
        raises a KeyError inside _parse_condition -- route_events_create
        must map that to a 400, not let it become an unhandled 500."""
        base, _ = api
        code, j = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "metric"}],  # missing metric/op/threshold
                "action": {"kind": "snapshot", "minutes": 5},
            },
        )
        assert code == 400 and "malformed event request" in j["error"]

    def test_create_with_invalid_action_kind_is_a_400(self, api):
        base, _ = api
        code, j = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "log", "pattern": "ERROR"}],
                "action": {"kind": "bogus"},
            },
        )
        assert code == 400 and "action.kind" in j["error"]

    def test_update_with_missing_condition_fields_is_a_400(self, api):
        base, _ = api
        event_id = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "log", "pattern": "ERROR"}],
                "action": {"kind": "recording", "duration_minutes": 5},
            },
        )[1]["event_id"]
        code, j = post(base, f"/events/{event_id}/update", {"conditions": [{"type": "metric"}]})
        assert code == 400 and "malformed event request" in j["error"]

    def test_update_with_invalid_action_kind_is_a_400(self, api):
        base, _ = api
        event_id = post(
            base,
            "/events/create",
            {
                "name": "x",
                "conditions": [{"type": "log", "pattern": "ERROR"}],
                "action": {"kind": "recording", "duration_minutes": 5},
            },
        )[1]["event_id"]
        code, j = post(base, f"/events/{event_id}/update", {"action": {"kind": "bogus"}})
        assert code == 400 and "action.kind" in j["error"]


# ── /files/* (phase 3: upload/download, docs/architecture/remote-server.md) ──


class TestApiTokenAuth:
    """br-NET-004: every route is gated behind X-CTTC-Token once a token is
    configured (app.state.api_token, set from --api-token/CTTC_API_TOKEN --
    see TestMain for the CLI/env-var wiring itself). Left unset, behavior is
    byte-for-byte what it always was -- this only ever tightens a
    deployment that opted into one."""

    @pytest.fixture(autouse=True)
    def _clear_token_after(self):
        # server.app is a module-level singleton shared by every test in
        # this file (see boot_server) -- leaving a token set here would
        # otherwise 401 every other test's requests too.
        yield
        server.app.state.api_token = None

    def test_no_token_configured_is_unauthenticated_as_before(self, api):
        base, _ = api
        assert getattr(server.app.state, "api_token", None) is None
        code, _ = get(base, "/sources")
        assert code == 200

    def test_missing_token_is_rejected_once_one_is_configured(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        code, j = get(base, "/sources")
        assert code == 401
        assert "X-CTTC-Token" in j["error"]

    def test_wrong_token_is_rejected(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        code, _ = get(base, "/sources", headers={"X-CTTC-Token": "wrong"})
        assert code == 401

    def test_correct_token_is_accepted_on_get_routes(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        code, j = get(base, "/sources", headers={"X-CTTC-Token": "s3cr3t"})
        assert code == 200 and len(j["sources"]) == 2

    def test_correct_token_is_accepted_on_post_routes_too(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        code, j = post(base, "/close", {"id": "nonexistent"}, headers={"X-CTTC-Token": "s3cr3t"})
        assert code == 200 and j == {"ok": True}  # reached the real route, not a 401

    def test_options_preflight_is_exempt_even_with_a_token_configured(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        req = urllib.request.Request(base + "/sources", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=5) as r:
            assert r.status == 204
            assert "X-CTTC-Token" in r.headers.get("Access-Control-Allow-Headers", "")

    def test_rejected_requests_are_logged(self, api, caplog):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        with caplog.at_level("WARNING", logger="cttc"):
            code, _ = get(base, "/sources")
        assert code == 401
        assert any(
            "X-CTTC-Token" in r.message for r in caplog.records if r.name == "cttc"
        ), caplog.text

    def test_correct_token_via_query_param_is_accepted(self, api):
        # EventSource (app.js's /events SSE stream) can't attach a custom
        # header at all -- the query param is its only channel, so it must
        # work as a fallback alongside (not instead of) the header.
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        code, j = get(base, "/sources?token=s3cr3t")
        assert code == 200 and len(j["sources"]) == 2

    def test_wrong_token_via_query_param_is_still_rejected(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        code, _ = get(base, "/sources?token=wrong")
        assert code == 401


class TestGatewayOwnershipClaim:
    """br-OWNER-001 (REQ-0069): the deploying client becomes owner, once,
    at install -- POST /gateway/ownership/claim is idempotent (first claim
    wins, SET NX under the hood) so a later reconnect can never rewrite an
    already-established ownership record."""

    def test_claim_writes_the_ownership_record(self, api):
        base, _ = api
        code, j = post(
            base,
            "/gateway/ownership/claim",
            {"ownerLabel": "alice-laptop", "ownerPublicKey": "ssh-ed25519 AAAAC3abc"},
        )
        assert code == 200
        assert j["ownerLabel"] == "alice-laptop"
        assert j["ownerPublicKey"] == "ssh-ed25519 AAAAC3abc"
        assert j["ownerKeyFingerprint"] == hashlib.sha256(b"ssh-ed25519 AAAAC3abc").hexdigest()
        assert j["installedAt"] == j["updatedAt"]
        assert j["installedAt"].endswith("Z")  # now_iso()'s UTC ISO-8601 shape

    def test_reclaiming_an_already_owned_gateway_is_a_no_op(self, api):
        # A second client (or the same one, reconnecting) must never
        # rewrite who owns the gateway -- REQ-0069's Requirement 1
        # acceptance criterion.
        base, _ = api
        _code, first = post(
            base,
            "/gateway/ownership/claim",
            {"ownerLabel": "alice-laptop", "ownerPublicKey": "ssh-ed25519 AAAAC3abc"},
        )
        code, second = post(
            base,
            "/gateway/ownership/claim",
            {"ownerLabel": "mallory-vps", "ownerPublicKey": "ssh-ed25519 AAAAC3evil"},
        )
        assert code == 200
        assert second == first  # untouched -- still alice, not mallory

    def test_missing_fields_are_rejected(self, api):
        base, _ = api
        code, j = post(base, "/gateway/ownership/claim", {"ownerLabel": "alice-laptop"})
        assert code == 400
        assert "ownerPublicKey" in j["error"]

    def test_concurrent_claims_never_both_win(self, api):
        # write_ownership's SET NX makes the write itself atomic -- two
        # requests racing to claim the same fresh gateway must converge on
        # exactly one owner, not whichever happened to be read last.
        base, _ = api

        def claim(label):
            return post(
                base,
                "/gateway/ownership/claim",
                {"ownerLabel": label, "ownerPublicKey": f"ssh-ed25519 {label}"},
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim, ["first-client", "second-client"]))
        assert all(code == 200 for code, _ in results)
        winners = {j["ownerLabel"] for _, j in results}
        assert len(winners) == 1, f"both claims report a different winner: {results}"


def _generate_admin_keypair(tmp_path, name):
    """A real ed25519 keypair for admin-auth tests -- exercises the actual
    `ssh-keygen -Y sign`/`-Y verify` contract _verify_owner_signature shells
    out to, not a faked signature (openssh-client is a hard requirement
    elsewhere in this project already -- see the Dockerfile)."""
    key_path = tmp_path / name
    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(key_path)],
        check=True,
        capture_output=True,
    )
    pub = (tmp_path / f"{name}.pub").read_text().strip()
    return key_path, pub


def _sign(nonce, key_path, namespace="cttc-admin-auth"):
    """Mirrors ssh-key-file.js's signChallenge, in Python, for tests."""
    nonce_file = key_path.parent / f"{key_path.name}.nonce"
    nonce_file.write_text(nonce)
    subprocess.run(
        ["ssh-keygen", "-Y", "sign", "-f", str(key_path), "-n", namespace, str(nonce_file)],
        check=True,
        capture_output=True,
    )
    return Path(f"{nonce_file}.sig").read_text()


class TestGatewayAdminAuth:
    """br-OWNER-002/003/005 (REQ-0069): challenge-response gates
    POST /gateway/ownership/rotate -- the only admin route added so far
    (upgrade/delete aren't added yet, see REQ-0069's Requirement 2 scope
    note)."""

    @pytest.fixture(autouse=True)
    def _clear_token_after(self):
        yield
        server.app.state.api_token = None

    def test_no_owner_claimed_yet_is_rejected(self, api):
        base, _ = api
        code, j = post(
            base,
            "/gateway/ownership/rotate",
            {"newOwnerLabel": "bob", "newOwnerPublicKey": "ssh-ed25519 AAA"},
        )
        assert code == 403
        assert "no owner" in j["detail"].lower()

    def test_full_rotation_round_trip(self, api, tmp_path):
        base, _ = api
        owner_key, owner_pub = _generate_admin_keypair(tmp_path, "owner")
        _new_key, new_pub = _generate_admin_keypair(tmp_path, "newowner")

        _code, claimed = post(
            base, "/gateway/ownership/claim", {"ownerLabel": "alice", "ownerPublicKey": owner_pub}
        )

        code, challenge = get(base, "/gateway/admin/challenge")
        assert code == 200 and challenge["nonce"] and challenge["expiresInSeconds"] > 0

        signature = _sign(challenge["nonce"], owner_key)
        code, rotated = post(
            base,
            "/gateway/ownership/rotate",
            {
                "nonce": challenge["nonce"],
                "signature": signature,
                "newOwnerLabel": "bob",
                "newOwnerPublicKey": new_pub,
            },
        )
        assert code == 200
        assert rotated["ownerLabel"] == "bob"
        assert rotated["ownerPublicKey"] == new_pub
        assert rotated["ownerKeyFingerprint"] == hashlib.sha256(new_pub.encode()).hexdigest()
        assert rotated["installedAt"] == claimed["installedAt"]  # carried over, not reset
        assert rotated["updatedAt"] != claimed["updatedAt"]

        # And the record actually stuck -- a fresh read agrees.
        _code, current = post(
            base, "/gateway/ownership/claim", {"ownerLabel": "someone-else", "ownerPublicKey": "x"}
        )
        assert current == rotated  # claim on an owned gateway just echoes it back, unchanged

    def test_missing_nonce_or_signature_is_rejected(self, api):
        base, _ = api
        post(
            base,
            "/gateway/ownership/claim",
            {"ownerLabel": "alice", "ownerPublicKey": "ssh-ed25519 AAA"},
        )
        code, j = post(
            base,
            "/gateway/ownership/rotate",
            {"newOwnerLabel": "bob", "newOwnerPublicKey": "ssh-ed25519 BBB"},
        )
        assert code == 403
        assert "nonce" in j["detail"].lower()

    def test_wrong_key_signature_is_rejected(self, api, tmp_path):
        base, _ = api
        _owner_key, owner_pub = _generate_admin_keypair(tmp_path, "owner")
        attacker_key, _attacker_pub = _generate_admin_keypair(tmp_path, "attacker")
        post(base, "/gateway/ownership/claim", {"ownerLabel": "alice", "ownerPublicKey": owner_pub})
        _code, challenge = get(base, "/gateway/admin/challenge")
        signature = _sign(challenge["nonce"], attacker_key)  # signed by the wrong key
        code, j = post(
            base,
            "/gateway/ownership/rotate",
            {
                "nonce": challenge["nonce"],
                "signature": signature,
                "newOwnerLabel": "mallory",
                "newOwnerPublicKey": "ssh-ed25519 CCC",
            },
        )
        assert code == 403
        assert "signature" in j["detail"].lower()

    def test_reused_nonce_is_rejected(self, api, tmp_path):
        base, _ = api
        owner_key, owner_pub = _generate_admin_keypair(tmp_path, "owner")
        post(base, "/gateway/ownership/claim", {"ownerLabel": "alice", "ownerPublicKey": owner_pub})
        _code, challenge = get(base, "/gateway/admin/challenge")
        signature = _sign(challenge["nonce"], owner_key)
        body = {
            "nonce": challenge["nonce"],
            "signature": signature,
            "newOwnerLabel": "bob",
            "newOwnerPublicKey": "ssh-ed25519 DDD",
        }
        code1, _ = post(base, "/gateway/ownership/rotate", body)
        assert code1 == 200
        code2, j2 = post(base, "/gateway/ownership/rotate", body)  # same nonce again
        assert code2 == 403
        assert "nonce" in j2["detail"].lower()

    def test_expired_nonce_is_rejected(self, api, tmp_path, monkeypatch):
        base, _ = api
        owner_key, owner_pub = _generate_admin_keypair(tmp_path, "owner")
        post(base, "/gateway/ownership/claim", {"ownerLabel": "alice", "ownerPublicKey": owner_pub})
        monkeypatch.setattr(server, "ADMIN_NONCE_TTL_SECONDS", 1)
        _code, challenge = get(base, "/gateway/admin/challenge")
        signature = _sign(challenge["nonce"], owner_key)
        time.sleep(1.5)
        code, j = post(
            base,
            "/gateway/ownership/rotate",
            {
                "nonce": challenge["nonce"],
                "signature": signature,
                "newOwnerLabel": "bob",
                "newOwnerPublicKey": "ssh-ed25519 EEE",
            },
        )
        assert code == 403
        assert "nonce" in j["detail"].lower()

    def test_correct_network_token_but_no_signature_is_still_rejected(self, api, tmp_path):
        # STORY-0002: "the network token alone is never sufficient for
        # admin actions" -- a valid X-CTTC-Token gets past br-NET-004's
        # blanket gate but must not get anywhere near ownership/rotate.
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        headers = {"X-CTTC-Token": "s3cr3t"}
        _owner_key, owner_pub = _generate_admin_keypair(tmp_path, "owner")
        post(
            base,
            "/gateway/ownership/claim",
            {"ownerLabel": "alice", "ownerPublicKey": owner_pub},
            headers=headers,
        )
        code, j = post(
            base,
            "/gateway/ownership/rotate",
            {"newOwnerLabel": "bob", "newOwnerPublicKey": "ssh-ed25519 FFF"},
            headers=headers,
        )
        assert code == 403
        assert "nonce" in j["detail"].lower()

    def test_successful_rotation_is_audit_logged(self, api, tmp_path, caplog):
        base, _ = api
        owner_key, owner_pub = _generate_admin_keypair(tmp_path, "owner")
        post(base, "/gateway/ownership/claim", {"ownerLabel": "alice", "ownerPublicKey": owner_pub})
        _code, challenge = get(base, "/gateway/admin/challenge")
        signature = _sign(challenge["nonce"], owner_key)
        with caplog.at_level("INFO", logger="cttc"):
            code, _ = post(
                base,
                "/gateway/ownership/rotate",
                {
                    "nonce": challenge["nonce"],
                    "signature": signature,
                    "newOwnerLabel": "bob",
                    "newOwnerPublicKey": "ssh-ed25519 GGG",
                },
            )
        assert code == 200
        assert any(
            "ownership.rotate" in r.message and "alice" in r.message
            for r in caplog.records
            if r.name == "cttc"
        ), caplog.text

    def test_rejected_admin_action_is_audit_logged(self, api, caplog):
        base, _ = api
        with caplog.at_level("WARNING", logger="cttc"):
            code, _ = post(
                base,
                "/gateway/ownership/rotate",
                {"newOwnerLabel": "bob", "newOwnerPublicKey": "ssh-ed25519 HHH"},
            )
        assert code == 403
        assert any(
            "ownership.rotate" in r.message and "rejected" in r.message
            for r in caplog.records
            if r.name == "cttc"
        ), caplog.text


class TestGatewayPing:
    """br-MESH-006 (REQ-0070): GET /ping identifies this as a gateway and
    is the one deliberate, narrow exemption from br-NET-004's blanket
    token requirement -- /health stays exactly as gated as before."""

    @pytest.fixture(autouse=True)
    def _clear_token_after(self):
        yield
        server.app.state.api_token = None

    def test_ping_shape(self, api):
        base, _ = api
        code, j = get(base, "/ping")
        assert code == 200
        assert j == {"service": "gateway", "version": server.GATEWAY_VERSION}

    def test_ping_is_unauthenticated_even_with_a_token_configured(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        code, _ = get(base, "/ping")
        assert code == 200

    def test_health_still_requires_the_token_ping_is_not_a_blanket_exemption(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        code, _ = get(base, "/health")
        assert code == 401


class TestGatewaysSync:
    """br-MESH-001..005 (REQ-0070): the gateway list, its self-entry, and
    the /gateways/sync merge rules."""

    def test_new_key_is_added_with_existence_forced_to_unknown(self, api):
        base, _ = api
        code, j = post(
            base,
            "/gateways/sync",
            {
                "entries": [
                    {
                        "host": "10.0.0.5",
                        "port": 8765,
                        "lastContactAt": "2026-08-01T00:00:00.000Z",
                        "lastContactResult": "ok",
                        "existence": "existing",
                    }
                ]
            },
        )
        assert code == 200
        entry = next(e for e in j["entries"] if e["host"] == "10.0.0.5")
        assert entry["existence"] == "unknown"  # relayed existence is never trusted for a new key

    def test_self_entry_always_present_and_existing(self, api):
        base, _ = api
        code, j = post(base, "/gateways/sync", {"entries": []})
        assert code == 200
        host, _, port_str = base.partition("://")[2].partition("/")[0].rpartition(":")
        self_entries = [e for e in j["entries"] if e["host"] == host and str(e["port"]) == port_str]
        assert len(self_entries) == 1
        self_entry = self_entries[0]
        assert self_entry["existence"] == "existing"
        assert self_entry["lastContactResult"] == "ok"
        assert self_entry["lastContactAt"].endswith("Z")

    def test_self_entry_never_flaps_from_a_relayed_entry_for_the_same_address(self, api):
        base, _ = api
        host, _, port_str = base.partition("://")[2].partition("/")[0].rpartition(":")
        code, j = post(
            base,
            "/gateways/sync",
            {
                "entries": [
                    {
                        "host": host,
                        "port": int(port_str),
                        "lastContactAt": "2099-01-01T00:00:00.000Z",
                        "lastContactResult": "failed",
                        "existence": "absent",
                    }
                ]
            },
        )
        assert code == 200
        self_entry = next(
            e for e in j["entries"] if e["host"] == host and str(e["port"]) == port_str
        )
        assert self_entry["existence"] == "existing"
        assert self_entry["lastContactResult"] == "ok"

    def test_most_recent_lastContactAt_wins(self, api):
        base, _ = api
        post(
            base,
            "/gateways/sync",
            {
                "entries": [
                    {
                        "host": "10.0.0.9",
                        "port": 8765,
                        "lastContactAt": "2026-08-01T00:00:00.000Z",
                        "lastContactResult": "ok",
                        "existence": "unknown",
                    }
                ]
            },
        )
        code, j = post(
            base,
            "/gateways/sync",
            {
                "entries": [
                    {
                        "host": "10.0.0.9",
                        "port": 8765,
                        "lastContactAt": "2026-08-02T00:00:00.000Z",
                        "lastContactResult": "failed",
                        "existence": "absent",
                    }
                ]
            },
        )
        assert code == 200
        entry = next(e for e in j["entries"] if e["host"] == "10.0.0.9")
        assert entry["lastContactAt"] == "2026-08-02T00:00:00.000Z"
        assert entry["lastContactResult"] == "failed"
        assert entry["existence"] == "absent"

    # The next three exercise _merge_gateway_entry() directly rather than
    # through the full /gateways/sync HTTP round trip: given the v1 design
    # (client-mediated only, no gateway-to-gateway relay -- see REQ-0070's
    # Open questions), there is currently no way for a *non-self* entry to
    # legitimately become "existing"/"absent" via a sync payload at all
    # (br-MESH-003/004 force every relayed claim to unknown on first
    # insert, and the self-entry never goes through this function -- it's
    # written directly by _self_gateway_entry, unconditionally, after the
    # merge loop). Testing the merge function's own tie-break/never-
    # downgrade rules in isolation is the accurate way to verify them
    # without first having to fabricate a scenario the real system can't
    # actually reach yet.

    def test_merge_tie_prefers_verified_existence_over_unknown(self):
        current = {
            "host": "10.0.0.10",
            "port": 8765,
            "lastContactAt": "2026-08-01T00:00:00.000Z",
            "lastContactResult": "ok",
            "existence": "existing",
        }
        incoming = {
            "host": "10.0.0.10",
            "port": 8765,
            "lastContactAt": "2026-08-01T00:00:00.000Z",
            "lastContactResult": "ok",
            "existence": "unknown",
        }
        merged = server._merge_gateway_entry(current, incoming)
        assert merged["existence"] == "existing"

    def test_merge_tie_the_other_direction_incoming_verified_beats_current_unknown(self):
        current = {
            "host": "10.0.0.10",
            "port": 8765,
            "lastContactAt": "2026-08-01T00:00:00.000Z",
            "lastContactResult": "failed",
            "existence": "unknown",
        }
        incoming = {
            "host": "10.0.0.10",
            "port": 8765,
            "lastContactAt": "2026-08-01T00:00:00.000Z",
            "lastContactResult": "ok",
            "existence": "existing",
        }
        merged = server._merge_gateway_entry(current, incoming)
        assert merged["existence"] == "existing"

    def test_merge_never_downgrades_a_verified_entry_even_if_incoming_is_newer(self):
        current = {
            "host": "10.0.0.11",
            "port": 8765,
            "lastContactAt": "2026-08-01T00:00:00.000Z",
            "lastContactResult": "ok",
            "existence": "existing",
        }
        incoming = {
            "host": "10.0.0.11",
            "port": 8765,
            "lastContactAt": "2026-08-02T00:00:00.000Z",
            "lastContactResult": "failed",
            "existence": "unknown",
        }
        merged = server._merge_gateway_entry(current, incoming)
        assert merged["existence"] == "existing"

    def test_oversized_payload_is_trimmed_not_persisted_whole(self, api, monkeypatch):
        base, _ = api
        monkeypatch.setattr(server, "GATEWAY_LIST_MAX_ENTRIES", 5)
        entries = [
            {
                "host": f"10.0.1.{i}",
                "port": 8765,
                "lastContactAt": "2026-08-01T00:00:00.000Z",
                "lastContactResult": "ok",
                "existence": "unknown",
            }
            for i in range(20)
        ]
        code, j = post(base, "/gateways/sync", {"entries": entries})
        assert code == 200
        assert len(j["entries"]) <= 5

    def test_entries_must_be_a_list(self, api):
        base, _ = api
        code, j = post(base, "/gateways/sync", {"entries": "not-a-list"})
        assert code == 400
        assert "list" in j["error"].lower()

    def test_list_persists_across_multiple_sync_calls_within_the_same_process(self, api):
        # The durable-store guarantee that's actually testable without a
        # real redis-server process restart (this codebase's Redis is
        # started fresh, non-persistent, per gateway process -- see
        # redis_log.py's `--save ""`; the *same* limitation already
        # applies to cttc:gateway:ownership). What's genuinely true and
        # tested here: an entry written by one request is still present
        # on a later, unrelated request -- it's in the durable store, not
        # just that request's own response.
        base, _ = api
        post(
            base,
            "/gateways/sync",
            {
                "entries": [
                    {
                        "host": "10.0.0.20",
                        "port": 8765,
                        "lastContactAt": "2026-08-01T00:00:00.000Z",
                        "lastContactResult": "ok",
                        "existence": "existing",
                    }
                ]
            },
        )
        code, j = post(base, "/gateways/sync", {"entries": []})
        assert code == 200
        assert any(e["host"] == "10.0.0.20" for e in j["entries"])

    def test_sync_still_requires_the_network_token(self, api):
        base, _ = api
        server.app.state.api_token = "s3cr3t"
        try:
            code, _ = post(base, "/gateways/sync", {"entries": []})
            assert code == 401
        finally:
            server.app.state.api_token = None


class TestMlogEndpoint:
    async def test_returns_logs_with_name_header(self, api, monkeypatch):
        base, _ = api

        async def fake_gather(timeout=15.0):
            return "my-gateway", b"hello from the gateway\n"

        monkeypatch.setattr(server, "gather_own_container_logs", fake_gather)
        code, headers, data = get_raw(base, "/mlog")
        assert code == 200
        assert data == b"hello from the gateway\n"
        assert headers["X-CTTC-Gateway-Name"] == "my-gateway"
        assert 'filename="my-gateway.log"' in headers["Content-Disposition"]


class TestFilesEndpoints:
    def test_download_returns_binary_cttc(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        code, headers, data = get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}")
        assert code == 200
        assert headers["Content-Type"] == "application/octet-stream"
        assert 'filename="sample-' in headers["Content-Disposition"]
        assert headers["Content-Disposition"].endswith('.cttc-metric"')
        z = zipfile.ZipFile(io.BytesIO(data))
        assert "manifest.json" in z.namelist()

    def test_download_exposes_source_count_header(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _code, headers, _data = get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}")
        assert (
            headers["X-CTTC-Source-Count"] == "2"
        )  # the log + stats sources the api fixture opens
        exposed = headers["Access-Control-Expose-Headers"]
        assert "X-CTTC-Source-Count" in exposed and "Content-Disposition" in exposed

    def test_download_requires_from_and_to(self, api):
        base, _ = api
        assert get_raw(base, "/files/download")[0] == 400
        assert get_raw(base, "/files/download?from=0")[0] == 400

    def test_download_include_host_false(self, api):
        base, st = api
        for s in st.sources.values():
            if s.kind == "stats":
                s.is_host = True
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _code, _h, data = get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}&include_host=0")
        z = zipfile.ZipFile(io.BytesIO(data))
        sources = json.loads(z.read("manifest.json"))["segments"][0]["sources"]
        assert all(
            s["type"] != "stats" for s in sources
        )  # the host-marked stats source is excluded
        assert any(s["type"] == "log" for s in sources)  # the unrelated log source is unaffected

    def test_download_host_param_scopes_by_docker_host(self, api, monkeypatch):
        """br-DHOST-030: /files/download's `host` param resolves to the
        right source_ids subset (State.build_sample_bytes' pre-existing
        source_ids param, used today by the rolling-buffer feature) --
        sources tagged for a different host are excluded, sources with no
        `host` attribute at all (never docker-collected -- api's own
        log/stats file sources) are untouched either way. Spies on
        build_sample_bytes rather than inspecting a real exported archive:
        _entity_for host-qualifies its Redis key once a source has a real
        `host` (br-DEDUP-006), so retrofitting `.host` onto an
        already-ingested test source would silently orphan its data from
        a different key -- irrelevant to what's under test here, which is
        purely the route's host-param-to-source_ids resolution."""
        base, st = api
        real_ids = set(st.sources.keys())  # the fixture's own sources, no .host attr at all

        class _FakeHostSource:
            def __init__(self, sid, host):
                self.id = sid
                self.host = host

        fake_local = _FakeHostSource("fake-local", None)
        fake_remote = _FakeHostSource("fake-remote", "ssh://u@remotehost")
        st.sources[fake_local.id] = fake_local
        st.sources[fake_remote.id] = fake_remote
        captured = {}

        async def spy(t0, t1, include_host=True, source_ids=None):
            captured["source_ids"] = source_ids
            return b"", []

        monkeypatch.setattr(st, "build_sample_bytes", spy)
        t0 = ms(2026, 1, 2, 3, 0, 0)
        try:
            get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}&host=local")
            ids = captured["source_ids"]
            assert real_ids <= ids
            assert fake_local.id in ids and fake_remote.id not in ids

            get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}&host=ssh://u@remotehost")
            ids = captured["source_ids"]
            assert real_ids <= ids
            assert fake_remote.id in ids and fake_local.id not in ids

            get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}")
            assert captured["source_ids"] is None  # no host param -> unfiltered, as before
        finally:
            del st.sources[fake_local.id]
            del st.sources[fake_remote.id]

    def test_download_without_host_param_is_unfiltered(self, api):
        """Backward compatible: omitting `host` (every pre-existing caller)
        keeps the old "every open source" behavior -- source_ids stays
        None, not an empty/host-derived set."""
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _code, headers, _data = get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}")
        assert headers["X-CTTC-Source-Count"] == "2"

    def test_upload_plain_log(self, api):
        # Checks total() over HTTP (/logs), not by awaiting src.total()
        # directly -- src's redis_log client is bound to the server's own
        # event loop (see the `api` fixture's docstring), a different loop
        # than this (sync) test runs on.
        base, st = api
        data = b"2026-01-02T03:00:00Z hello\n2026-01-02T03:00:01Z world\n"
        code, j = post_raw(base, "/files/upload", data, {"X-CTTC-Filename": "up.log"})
        assert code == 200
        assert len(j["opened"]) == 1 and j["errors"] == []
        sid = j["opened"][0]
        src = st.sources[sid]
        assert src.path == "upload://up.log"
        # open_file's initial ingest goes through the same buffered
        # record() path as live tailing (sRate) -- poll rather than assert
        # on the very next request.
        deadline = time.time() + 3
        logs_j = {"total": 0}
        while logs_j["total"] < 2 and time.time() < deadline:
            _, logs_j = get(base, f"/logs?source={sid}")
            if logs_j["total"] < 2:
                time.sleep(0.02)
        assert logs_j["total"] == 2

    def test_upload_multi_segment_cttc_returns_needs_selection(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        _code, _h, first = post_raw_binary(
            base, "/sample/record", b"", {"X-CTTC-From": str(t0), "X-CTTC-To": str(t0 + 5000)}
        )
        _code, _h, second = post_raw_binary(
            base,
            "/sample/record",
            first,
            {"X-CTTC-From": str(t0 + 5000), "X-CTTC-To": str(t0 + 10000)},
        )
        code, j = post_raw(base, "/files/upload", second, {"X-CTTC-Filename": "rec.cttc-record"})
        assert code == 200
        assert j["opened"] == [] and j["errors"] == []
        assert len(j["needs_selection"]) == 1
        assert [s["index"] for s in j["needs_selection"][0]["segments"]] == [0, 1]

        code, j = post_raw(
            base,
            "/files/upload",
            second,
            {"X-CTTC-Filename": "rec.cttc-record", "X-CTTC-Segment": "0"},
        )
        assert code == 200
        assert len(j["opened"]) >= 1
        assert j["needs_selection"] == []

    def test_upload_no_filename_header_still_works(self, api):
        base, _ = api
        code, j = post_raw(base, "/files/upload", b"2026-01-02T03:00:00Z a\n")
        assert code == 200 and len(j["opened"]) == 1

    def test_upload_applies_transforms_header(self, api):
        base, _st = api
        code, j = post_raw(
            base,
            "/files/upload",
            b"2026-01-02T03:00:00Z hi\n",
            {"X-CTTC-Filename": "t.log", "X-CTTC-Transforms": "upper"},
        )
        assert code == 200
        sid = j["opened"][0]
        # Same buffered-write settle reasoning as test_upload_plain_log above.
        deadline = time.time() + 3
        logs_j = {"rows": []}
        while not logs_j["rows"] and time.time() < deadline:
            _, logs_j = get(base, f"/logs?source={sid}&start=0&count=1")
            if not logs_j["rows"]:
                time.sleep(0.02)
        assert logs_j["rows"][0]["text"] == "HI"

    def test_upload_bad_data_reports_error_not_500(self, api):
        base, _ = api
        code, j = post_raw(
            base, "/files/upload", b"not a zip", {"X-CTTC-Filename": "bad.cttc-metric"}
        )
        assert code == 200  # request itself succeeded; the failure is reported in errors
        assert j["opened"] == [] and len(j["errors"]) == 1
        assert "bad.cttc-metric" == j["errors"][0]["path"]

    def test_upload_broadcasts_sources_event_only_on_success(self, api):
        base, st = api
        seen = []
        st.broadcast = lambda ev: seen.append(ev)
        post_raw(base, "/files/upload", b"not a zip", {"X-CTTC-Filename": "bad.cttc-metric"})
        assert seen == []  # nothing opened -> no broadcast
        post_raw(base, "/files/upload", b"2026-01-02T03:00:00Z a\n", {"X-CTTC-Filename": "ok.log"})
        assert seen == [{"type": "sources"}]

    def test_upload_broken_pipe_swallowed(self, api, monkeypatch):
        # see TestHttpApi.test_get_broken_pipe_swallowed: any exception from
        # business logic, including BrokenPipeError, now just gets the
        # normal catch-all 500 treatment.
        base, st = api

        def explode():
            raise BrokenPipeError()

        monkeypatch.setattr(st, "describe", explode)
        code, j = post_raw(
            base, "/files/upload", b"2026-01-02T03:00:00Z a\n", headers={"X-CTTC-Filename": "x.log"}
        )
        assert code == 500 and "error" in j

    def test_options_preflight_allows_upload_headers(self, api):
        base, _ = api
        conn = http.client.HTTPConnection(base.split("//")[1], timeout=5)
        conn.request("OPTIONS", "/files/upload")
        resp = conn.getresponse()
        allowed = resp.getheader("Access-Control-Allow-Headers")
        assert "X-CTTC-Filename" in allowed
        assert "X-CTTC-Private-Key" in allowed
        assert "X-CTTC-Transforms" in allowed
        conn.close()


# ── main() ───────────────────────────────────────────────────────────────────


class TestMain:
    def test_main_serves_and_shuts_down(self, tmp_path, monkeypatch, capsys, caplog):
        good = tmp_path / "ok.log"
        good.write_text("2026-01-02T03:00:00Z hi\n")
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "server.py",
                "--port",
                "0",
                # a real redis-server gets spawned here (this test goes
                # through the actual CLI/lifespan path, unlike the state/api
                # fixtures) -- a unique port avoids colliding with another
                # test's redis-server that hasn't fully released the true
                # default (56379) yet.
                "--redis-port",
                str(unique_redis_tcp_port()),
                # Default sRate (1.0s) would make this test race the
                # buffered flush of the CLI-opened file's own initial
                # ingest against the /range check below -- a short interval
                # keeps this test fast without weakening what it's actually
                # regression-testing (CLI files opening after redis_log.
                # start(), not the flush cadence itself).
                "--redis-flush-interval-seconds",
                "0.05",
                "--naive-tz",
                "local",
                "--transforms-dir",
                str(tmp_path),
                "--static",
                str(good),
                "/no/such/file.log",
            ],
        )
        old_tz = server.NAIVE_TZ
        t = threading.Thread(target=server.main, daemon=True)
        t.start()

        # main() prints exactly one {"port": N} json line to stdout once
        # listening (see _run()) -- poll capsys for it instead of reaching
        # into server internals for the bound port.
        out_accum = ""
        port = None
        deadline = time.time() + 5
        while port is None and time.time() < deadline:
            out_accum += capsys.readouterr().out
            m = re.search(r'"port":\s*(\d+)', out_accum)
            if m:
                port = int(m.group(1))
            else:
                time.sleep(0.02)
        assert port is not None, f"no port line seen: {out_accum!r}"

        _, j = get(f"http://127.0.0.1:{port}", "/sources")
        assert len(j["sources"]) == 1  # the bad file only warned

        # Regression: CLI-supplied files used to be opened in _run(),
        # *before* redis_log.start() ever ran (that only happens inside
        # lifespan(), triggered later by uvicorn's own serve()) -- record()
        # silently no-ops while disabled, so every sample from a CLI file
        # was queued and dropped before Redis was even up, permanently
        # leaving /range at {min_ts: null, max_ts: null} with nothing left
        # to ever trigger a client re-check (an e2e-only symptom: the
        # renderer hung forever on "server data loaded"). Opening CLI files
        # now happens inside lifespan() itself, after redis_log.start().
        # The file's initial ingest still has to clear its own flush cycle
        # (sRate, --redis-flush-interval-seconds above) before /range
        # reflects it -- poll rather than assert on the very first request.
        deadline = time.time() + 3
        j = {"min_ts": None, "max_ts": None}
        while j["min_ts"] is None and time.time() < deadline:
            _, j = get(f"http://127.0.0.1:{port}", "/range")
            if j["min_ts"] is None:
                time.sleep(0.02)
        assert j["min_ts"] is not None and j["max_ts"] is not None

        post(f"http://127.0.0.1:{port}", "/shutdown")
        t.join(timeout=5)
        assert not t.is_alive()
        assert "could not open" in caplog.text
        assert server.NAIVE_TZ is not None and server.NAIVE_TZ != UTC or old_tz != UTC
        server.NAIVE_TZ = UTC  # restore module global for other tests

    def test_api_token_flows_from_cli_through_to_the_real_server(self, tmp_path, monkeypatch, capsys):
        # br-NET-004 end-to-end: --api-token (or CTTC_API_TOKEN, which it
        # defaults from) actually gates the real server booted via main(),
        # not just app.state poked directly (see TestApiTokenAuth).
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "server.py",
                "--port",
                "0",
                "--redis-port",
                str(unique_redis_tcp_port()),
                "--transforms-dir",
                str(tmp_path),
                "--api-token",
                "e2e-cli-secret",
            ],
        )
        t = threading.Thread(target=server.main, daemon=True)
        t.start()
        out_accum = ""
        port = None
        deadline = time.time() + 5
        while port is None and time.time() < deadline:
            out_accum += capsys.readouterr().out
            m = re.search(r'"port":\s*(\d+)', out_accum)
            if m:
                port = int(m.group(1))
            else:
                time.sleep(0.02)
        assert port is not None, f"no port line seen: {out_accum!r}"
        base = f"http://127.0.0.1:{port}"

        code, _ = get(base, "/sources")
        assert code == 401
        code, _ = get(base, "/sources", headers={"X-CTTC-Token": "e2e-cli-secret"})
        assert code == 200

        post(base, "/shutdown", headers={"X-CTTC-Token": "e2e-cli-secret"})
        t.join(timeout=5)
        assert not t.is_alive()

    def test_main_keyboard_interrupt_exits_cleanly(self, tmp_path, monkeypatch):
        async def raise_interrupt(self):
            raise KeyboardInterrupt

        monkeypatch.setattr(server.uvicorn.Server, "serve", raise_interrupt)
        monkeypatch.setattr(
            sys, "argv", ["server.py", "--port", "0", "--transforms-dir", str(tmp_path)]
        )
        server.main()  # KeyboardInterrupt swallowed

    def test_dunder_main_via_runpy(self, tmp_path, monkeypatch, capsys):
        import runpy

        monkeypatch.setattr(sys, "argv", ["server.py", "--help"])
        with pytest.raises(SystemExit) as exc:
            runpy.run_path(str(Path(server.__file__)), run_name="__main__")
        assert exc.value.code == 0
        assert "--naive-tz" in capsys.readouterr().out
