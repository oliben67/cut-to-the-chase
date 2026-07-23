"""Exhaustive tests for the CTTC timeline server.

Everything external (docker CLI, ssh, remote hosts) is faked via monkeypatch;
psutil and the HTTP stack are exercised for real. Run:

    uv run --group dev pytest --cov=server --cov-report=term-missing
"""

from __future__ import annotations

import asyncio
import http.client
import io
import json
import re
import socket
import struct
import sys
import threading
import time
import types
import urllib.error
import urllib.request
import zipfile
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pytest
import uvicorn

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


def log_source(transforms=()):
    return server.LogSource(
        "s1", "svc", Path("/nonexistent"), live=False, transforms=list(transforms)
    )


class TestLogSource:
    def test_docker_t_line(self):
        src = log_source()
        n = src.ingest_chunk(b"2026-01-02T03:04:05.000000000Z hello world\n")
        assert n == 1
        row = src.slice(0, 10)[0]
        assert row["text"] == "hello world"
        assert row["ts"] == ms(2026, 1, 2, 3, 4, 5)
        assert row["i"] == 0 and len(row["uid"]) == 16

    def test_swarm_service_prefix_stripped(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:04:05Z api.1.abc123@node1    | msg here\n")
        assert src.slice(0, 1)[0]["text"] == "msg here"

    def test_json_line_ts_from_fields(self):
        src = log_source()
        src.ingest_chunk(b'{"time": "2026-01-02T03:04:05Z", "msg": "x"}\n')
        assert src.slice(0, 1)[0]["ts"] == ms(2026, 1, 2, 3, 4, 5)

    def test_json_numeric_ts_seconds_and_ms(self):
        src = log_source()
        src.ingest_chunk(b'{"ts": 1700000000}\n{"ts": 1700000000500}\n')
        rows = src.slice(0, 2)
        assert rows[0]["ts"] == 1700000000000.0
        assert rows[1]["ts"] == 1700000000500.0

    def test_bad_json_body_ignored(self):
        src = log_source()
        # looks like JSON but is not parseable, and has a leading timestamp
        src.ingest_chunk(b"2026-01-02T03:04:05Z {broken json}\n")
        assert src.total() == 1

    def test_continuation_within_batch(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:04:05Z line one\n  at Some.stack(Frame.java:1)\n")
        assert src.total() == 1
        assert "Frame.java" in src.slice(0, 1)[0]["text"]

    def test_continuation_across_chunks(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:04:05Z line one\n")
        src.ingest_chunk(b"continued\n")
        assert src.total() == 1
        assert src.slice(0, 1)[0]["text"] == "line one\ncontinued"

    def test_continuation_with_no_previous_is_skipped(self):
        src = log_source()
        src.ingest_chunk(b"no timestamp at all\n")
        assert src.total() == 0
        assert src.skipped == 1

    def test_blank_lines_ignored(self):
        src = log_source()
        src.ingest_chunk(b"\n   \n2026-01-02T03:04:05Z x\n")
        assert src.total() == 1

    def test_partial_trailing_line_buffered(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:04:05Z first\n2026-01-02T03:04:06Z par")
        assert src.total() == 1
        src.ingest_chunk(b"tial\n")
        assert src.total() == 2
        assert src.slice(1, 1)[0]["text"] == "partial"

    def test_out_of_order_chunks_sorted(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:04:10Z late\n")
        src.ingest_chunk(b"2026-01-02T03:04:05Z early\n")
        texts = [r["text"] for r in src.slice(0, 10)]
        assert texts == ["early", "late"]

    def test_unsorted_within_chunk_sorted(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:04:10Z b\n2026-01-02T03:04:05Z a\n")
        assert [r["text"] for r in src.slice(0, 10)] == ["a", "b"]

    def test_transform_drop_and_fanout_and_missing_ts(self):
        drop = ("drop", lambda r: None if "drop" in r["text"] else r)
        dup = ("dup", lambda r: [r, dict(r)])
        nots = ("nots", lambda r: {**r, "ts": None} if "no-ts" in r["text"] else r)
        src = log_source([drop, dup, nots])
        src.ingest_chunk(
            b"2026-01-02T03:04:05Z keep\n2026-01-02T03:04:06Z drop me\n2026-01-02T03:04:07Z no-ts\n"
        )
        assert src.total() == 2  # "keep" duplicated; "drop me" gone; "no-ts" skipped
        assert src.skipped == 2

    def test_index_at(self):
        src = log_source()
        src.ingest_chunk(
            b"2026-01-02T03:00:00Z a\n2026-01-02T03:00:10Z b\n2026-01-02T03:00:20Z c\n"
        )
        t0 = ms(2026, 1, 2, 3, 0, 0)
        assert src.index_at(t0 - 1000) == 0
        assert src.index_at(t0 + 4000) == 0  # nearer to a than b
        assert src.index_at(t0 + 6000) == 1
        assert src.index_at(t0 + 99999999) == 2

    def test_index_at_empty(self):
        assert log_source().index_at(0) == -1

    def test_ticks(self):
        src = log_source()
        src.ingest_chunk(
            b"2026-01-02T03:00:00Z a\n2026-01-02T03:00:00Z b\n2026-01-02T03:00:09Z c\n"
        )
        t0 = ms(2026, 1, 2, 3, 0, 0)
        counts = src.ticks(t0, t0 + 10000, 10)
        assert counts[0] == 2 and counts[9] == 1 and sum(counts) == 3
        assert src.ticks(t0, t0 + 10000, 0) != []  # px clamped to >= 1

    def test_range(self):
        src = log_source()
        assert src.range() is None
        src.ingest_chunk(b"2026-01-02T03:00:00Z a\n2026-01-02T03:00:10Z b\n")
        assert src.range() == (ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 10))

    def test_slice_clamps_negative_start(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:00:00Z a\n")
        assert src.slice(-5, 10)[0]["text"] == "a"

    def test_find_forward_backward_wrap_and_case(self):
        src = log_source()
        src.ingest_chunk(
            b"2026-01-02T03:00:00Z Alpha ERROR one\n"
            b"2026-01-02T03:00:01Z beta ok\n"
            b"2026-01-02T03:00:02Z gamma ERROR two\n"
        )
        assert src.find("error", 0) == 0  # case-insensitive
        assert src.find("error", 1) == 2  # forward from middle
        assert src.find("error", 1, forward=False) == 0  # backward from middle
        assert src.find("ERROR one", 1) == 0  # wraps past the end
        assert src.find("two", 0, forward=False) == 2  # wraps backward
        assert src.find("nothing-here", 0) is None
        assert src.find("   ", 0) is None  # blank query
        assert src.find("x", 99) is None or src.find("x", 99) >= 0  # start clamped

    def test_find_empty_log(self):
        assert log_source().find("x", 0) is None


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


def stats_source():
    return server.StatsSource("s2", "stats", Path("/nonexistent"), live=False)


def feed_stats(src, entries):
    payload = "\n".join(json.dumps(e) for e in entries) + "\n"
    return src.ingest_chunk(payload.encode())


class TestStatsSource:
    def test_jsonl_ingest_and_net_rate(self):
        src = stats_source()
        n = feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:00Z", netio="1kB / 2kB"),
                stats_entry("api", "2026-01-02T03:00:10Z", netio="2kB / 4kB"),
            ],
        )
        assert n == 2 and src.count == 2
        rows = src.series["api"]
        assert rows[0][4] is None  # first sample: no rate yet
        assert rows[1][4] == pytest.approx(300.0)  # 3000 B over 10 s
        assert rows[0][1] == 10.0 and rows[0][2] == 20.0
        assert rows[0][3] == pytest.approx(100 * 1024**2)

    def test_net_counter_reset_gives_none(self):
        src = stats_source()
        feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:00Z", netio="9kB / 9kB"),
                stats_entry("api", "2026-01-02T03:00:10Z", netio="1kB / 1kB"),
            ],
        )
        assert src.series["api"][1][4] is None

    def test_net_same_timestamp_gives_none(self):
        src = stats_source()
        feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:00Z"),
                stats_entry("api", "2026-01-02T03:00:00Z", netio="5kB / 5kB"),
            ],
        )
        assert src.series["api"][1][4] is None

    def test_bad_netio_gives_none(self):
        src = stats_source()
        feed_stats(src, [stats_entry("api", "2026-01-02T03:00:00Z", netio="weird")])
        assert src.series["api"][0][4] is None

    def test_unparsable_netio_sides_give_none(self):
        src = stats_source()
        feed_stats(src, [stats_entry("api", "2026-01-02T03:00:00Z", netio="abc / def")])
        assert src.series["api"][0][4] is None

    def test_blank_lines_in_jsonl_ignored(self):
        src = stats_source()
        n = src.ingest_chunk(
            b"\n   \n" + json.dumps(stats_entry("api", "2026-01-02T03:00:00Z")).encode() + b"\n"
        )
        assert n == 1 and src.skipped == 0

    def test_swarm_grouping_and_detection(self):
        src = stats_source()
        feed_stats(
            src,
            [
                stats_entry("api.1.abc", "2026-01-02T03:00:00Z"),
                stats_entry("api.2.def", "2026-01-02T03:00:00Z"),
                stats_entry("plain", "2026-01-02T03:00:00Z"),
            ],
        )
        assert sorted(src.series) == ["api", "plain"]
        assert src._swarm == {"api"}

    def test_skips(self):
        src = stats_source()
        n = src.ingest_chunk(
            b'{"Name": "--", "timestamp": "2026-01-02T03:00:00Z"}\n'
            b'{"Name": "", "timestamp": "2026-01-02T03:00:00Z"}\n'
            b'{"Name": "x"}\n'  # no timestamp
            b"[1, 2]\n"  # not a dict
            b"not json at all\n"
        )
        assert n == 0 and src.count == 0 and src.skipped == 5

    def test_whole_array_mode(self):
        src = stats_source()
        payload = json.dumps(
            [
                stats_entry("api", "2026-01-02T03:00:00Z"),
                stats_entry("api", "2026-01-02T03:00:05Z"),
            ]
        ).encode()
        assert src.ingest_chunk(payload) == 2

    def test_partial_array_buffered(self):
        src = stats_source()
        payload = json.dumps([stats_entry("api", "2026-01-02T03:00:00Z")]).encode()
        assert src.ingest_chunk(payload[:10]) == 0
        assert src.ingest_chunk(payload[10:]) == 1

    def test_out_of_order_insort(self):
        src = stats_source()
        feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:10Z"),
                stats_entry("api", "2026-01-02T03:00:00Z"),
            ],
        )
        ts = [r[0] for r in src.series["api"]]
        assert ts == sorted(ts)

    def test_services_range_bucketed(self):
        src = stats_source()
        feed_stats(
            src,
            [
                stats_entry("b", "2026-01-02T03:00:00Z", cpu="10%"),
                stats_entry("b", "2026-01-02T03:00:01Z", cpu="50%"),
                stats_entry("a.1.x", "2026-01-02T03:00:05Z", cpu="30%"),
            ],
        )
        assert src.services() == ["a", "b"]
        lo, hi = src.range()
        assert lo == ms(2026, 1, 2, 3, 0, 0) and hi == ms(2026, 1, 2, 3, 0, 5)
        out = src.bucketed(lo, lo + 10000, 5)  # dt = 2 s: both b samples share bucket 0
        by_name = {o["name"]: o for o in out}
        assert by_name["b"]["cpu"][0] == 50.0  # max-merged in one bucket
        assert by_name["a"]["ttype"] == "service"
        assert by_name["b"]["ttype"] == "container"
        assert all(o["host"] is False for o in out)
        assert all(o["sid"] == "s2" for o in out)

    def test_bucketed_ignores_out_of_window(self):
        src = stats_source()
        feed_stats(src, [stats_entry("api", "2026-01-02T03:00:00Z")])
        t0 = ms(2026, 1, 2, 4, 0, 0)
        out = src.bucketed(t0, t0 + 1000, 5)
        assert len(out) == 1  # service listed, but no samples land
        assert all(v is None for v in out[0]["cpu"] + out[0]["mem"] + out[0]["net"])

    def test_empty_range(self):
        assert stats_source().range() is None

    def test_point_at_nearest(self):
        src = stats_source()
        feed_stats(
            src,
            [
                stats_entry("api", "2026-01-02T03:00:00Z", cpu="10%"),
                stats_entry("api", "2026-01-02T03:00:10Z", cpu="90%"),
            ],
        )
        src.series["empty"] = []  # skipped without crashing
        t0 = ms(2026, 1, 2, 3, 0, 0)
        assert src.point_at(t0 + 2000)["api"]["cpu"] == 10.0  # nearest is earlier
        assert src.point_at(t0 + 8000)["api"]["cpu"] == 90.0  # nearest is later
        after = src.point_at(t0 + 60000)["api"]  # past the end
        assert after["cpu"] == 90.0 and after["ts"] == t0 + 10000
        before = src.point_at(t0 - 60000)["api"]  # before the start
        assert before["cpu"] == 10.0
        assert src.point_at(t0)["api"]["host"] is False
        assert "empty" not in src.point_at(t0)


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
        st = server.State(tmp_path)
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
            while src.total() < 2 and time.time() < deadline:
                await asyncio.sleep(0.05)
            assert src.total() == 2

            f.write_text("2026-01-02T03:00:02Z rewritten\n")  # truncation -> re-read
            deadline = time.time() + 3
            while src.total() < 3 and time.time() < deadline:
                await asyncio.sleep(0.05)
            assert src.total() == 3
            assert gsrc.total() == 1  # unchanged, stat() failed quietly
        finally:
            task.cancel()

    async def test_tail_loop_survives_read_failure(self, tmp_path, monkeypatch):
        f = tmp_path / "r.log"
        f.write_text("2026-01-02T03:00:00Z one\n")
        st = server.State(tmp_path)
        src = st.open_file(str(f), "log", None, live=True, transforms=[])

        def broken_read(_src):
            raise OSError("disk on fire")

        monkeypatch.setattr(server, "read_all", broken_read)
        task = asyncio.ensure_future(server.tail_loop(st, 0.03))
        try:
            with open(f, "a") as fh:
                fh.write("2026-01-02T03:00:01Z two\n")
            await asyncio.sleep(0.3)  # loop hits OSError and keeps running
            assert src.total() == 1
        finally:
            task.cancel()


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
            assert keys == [str(d / "id_ed25519")]  # unreadable key skipped quietly
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


class TestNormalizeDockerHost:
    def test_none_and_empty(self):
        assert server.normalize_docker_host(None) is None
        assert server.normalize_docker_host("") is None

    def test_bare_user_at_host_gets_ssh_scheme(self):
        assert server.normalize_docker_host("user@other-server") == "ssh://user@other-server"

    def test_already_schemed_left_alone(self):
        assert server.normalize_docker_host("ssh://user@other-server") == "ssh://user@other-server"
        assert server.normalize_docker_host("tcp://1.2.3.4:2375") == "tcp://1.2.3.4:2375"


class TestDockerPs:
    """docker_ps shells out to the real `docker` CLI as an asyncio subprocess
    (not docker-py's use_ssh_client transport, whose SSHSocket.recv() ignores
    its own configured timeout and can hang a worker thread forever on a bad
    ssh host) -- so it can genuinely kill a hung invocation on timeout."""

    async def test_normalizes_bare_user_at_host(self, monkeypatch):
        captured = []

        async def fake_exec(*args, **k):
            captured.append(args)
            if args[-1] == "{{.Server.Version}}":
                return FakeAsyncProc(communicate_result=(b"27.0.0\n", b""))
            return FakeAsyncProc(communicate_result=(b"", b""))

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        await server.docker_ps("u@h")
        assert list(captured[0][:3]) == ["docker", "-H", "ssh://u@h"]

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
        async def fake_exec(*args, **k):
            return FakeAsyncProc(
                returncode=1, communicate_result=(b"", b"command not found: docker")
            )

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        with pytest.raises(server.DockerPsError, match="not installed"):
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


class FakeState:
    def __init__(self):
        self.events = []

    def broadcast(self, ev):
        self.events.append(ev)


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
            while not src.series and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "api" in src.series
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
            while "good" not in src.series and time.time() < deadline:
                await asyncio.sleep(0.02)
            assert "good" in src.series
            assert "bad" not in src.series
        finally:
            src.stop()


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
    async def test_follows_and_reports_end(self, docker_cli, monkeypatch):
        proc = FakeAsyncProc([b"2026-01-02T03:04:05Z hello\n2026-01-02T03:04:06Z world\n"])

        async def fake_exec(*a, **k):
            return proc

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        st = FakeState()
        src = server.DockerLogSource("l1", "web", None, "container", "web", [], st)
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert src.total() == 2
        assert src.error == "log stream ended"
        assert src.path == "docker://local/container/web"
        src.stop()

    async def test_service_target_uses_service_logs(self, docker_cli, monkeypatch):
        captured = {}

        async def fake_exec(*args, **k):
            captured["cmd"] = args
            return FakeAsyncProc([])

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        src = server.DockerLogSource(
            "l2", "api", "ssh://u@h", "service", "api", [], FakeState(), ssh_key="/tmp/k"
        )
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert list(captured["cmd"][:4]) == ["docker", "-H", "ssh://u@h", "service"]
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

    async def test_stop_terminates_the_subprocess(self, docker_cli, monkeypatch):
        # hang_after=True keeps the fake stream "live but idle" (as a real
        # tailing `docker logs -f` would be between log lines) so stop()
        # has to actually terminate it rather than finding it already ended.
        proc = FakeAsyncProc([b"2026-01-02T03:04:05Z hello\n"], hang_after=True)

        async def fake_exec(*a, **k):
            return proc

        monkeypatch.setattr(server.asyncio, "create_subprocess_exec", fake_exec)
        src = server.DockerLogSource("l4", "web", None, "container", "web", [], FakeState())
        deadline = time.time() + 3
        while src.total() < 1 and time.time() < deadline:
            await asyncio.sleep(0.02)
        assert src.total() == 1
        src.stop()
        assert proc.terminated


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
    async def test_local_psutil_samples(self):
        src = server.HostStatsSource("h1", "host@local", None, 0.05, FakeState())
        try:
            deadline = time.time() + 5
            while not src.series.get("host@local") and time.time() < deadline:
                await asyncio.sleep(0.05)
            rows = src.series["host@local"]
            assert rows, "expected at least one host sample"
            ts, cpu, mem, mem_bytes, rate = rows[0]
            assert 0 <= cpu <= 100 * 64  # cpu_percent can exceed 100 on multicore? no; be lax
            assert 0 < mem <= 100
            assert mem_bytes > 0
            assert src.error is None
            assert src.path == "docker://local/host"
        finally:
            src.stop()

    async def test_ssh_sampling_and_interface_filter(self, monkeypatch):
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
        src = server.HostStatsSource(
            "h2", "host@h", "ssh://user@h:2222", 0.05, FakeState(), ssh_key="/tmp/key"
        )
        try:
            deadline = time.time() + 5
            while not src.series.get("host@h") and time.time() < deadline:
                await asyncio.sleep(0.05)
            assert "-p" in calls[0] and "2222" in calls[0]
            assert calls[0][-4:] == ("cat", "/proc/stat", "/proc/meminfo", "/proc/net/dev")
            ts, cpu, mem, mem_bytes, rate = src.series["host@h"][0]
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
            assert src.series == {}
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
def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    (tdir / "upper.py").write_text(
        '"""Uppercase text."""\n'
        "def transform(r):\n"
        '    r["text"] = r["text"].upper()\n'
        "    return r\n"
    )
    return server.State(tdir)


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
    def test_open_file_auto_and_kinds(self, state, log_file, stats_file):
        lg = state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        stt = state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        assert lg.kind == "log" and lg.total() == 2 and lg.name == "svc"
        assert stt.kind == "stats" and stt.count == 3

    def test_open_file_with_transform_and_name(self, state, log_file):
        src = state.open_file(str(log_file), "log", "custom", live=True, transforms=["upper"])
        assert src.name == "custom"
        assert src.slice(0, 1)[0]["text"] == "ALPHA"

    def test_open_file_missing(self, state):
        with pytest.raises(FileNotFoundError):
            state.open_file("/no/such/file.log", "auto", None, live=False, transforms=[])

    def test_close_source(self, state, log_file):
        src = state.open_file(str(log_file), "log", None, live=False, transforms=[])
        stopped = []
        src.stop = lambda: stopped.append(True)
        state.close_source(src.id)
        assert stopped == [True]
        assert src.id not in state.sources
        state.close_source("ghost")  # no-op

    def test_describe(self, state, log_file, stats_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=["upper"])
        state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        d = {s["name"]: s for s in state.describe()}
        assert d["svc"]["kind"] == "log" and d["svc"]["total"] == 2
        assert d["svc"]["transforms"] == ["upper"]
        assert d["stats"]["kind"] == "stats" and d["stats"]["services"] == ["api"]
        assert d["stats"]["min_ts"] is not None
        assert d["stats"]["is_host"] is False
        assert "is_host" not in d["svc"]  # log sources don't carry the flag

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

    async def test_collect_docker_reuse_ignores_the_second_call_s_settings(
        self, state, docker_cli, monkeypatch
    ):
        _no_op_docker(monkeypatch)
        first = state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=1.0, host_stats=False
        )
        state.collect_docker(
            None, stats=True, logs=[], transforms=[], interval=99.0, host_stats=False
        )  # different interval, same target
        src = state.sources[first[0]]
        assert src.interval == 1.0  # untouched by the second, reused call
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

    def test_broadcast_full_queue_dropped(self, state):
        full = asyncio.Queue(maxsize=1)
        full.put_nowait({"x": 1})
        state.listeners.append(full)
        state.broadcast({"type": "sources"})  # must not raise
        state.listeners.remove(full)


class TestSampleRoundTrip:
    def test_export_and_load(self, state, log_file, stats_file, tmp_path):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        st_src = state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        st_src.is_host = True  # exercise the host flag
        st_src._swarm.add("api")
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        out = tmp_path / "slice.cttc"
        r = state.export_sample(str(out), t0, t1)
        assert r["sources"] == 2

        names = zipfile.ZipFile(out).namelist()
        assert "manifest.json" in names

        st2 = server.State(tmp_path)
        opened = st2.load_sample(str(out))
        assert len(opened) == 2
        d = {s["name"]: s for s in st2.describe()}
        assert d["svc"]["total"] == 1  # only "alpha" is inside [t0, t1]
        lg = st2.sources[[s for s in opened if st2.sources[s].kind == "log"][0]]
        assert lg.slice(0, 1)[0]["text"] == "alpha"
        stt = st2.sources[[s for s in opened if st2.sources[s].kind == "stats"][0]]
        assert stt.is_host is True
        assert stt._swarm == {"api"}
        assert stt.live is False and lg.live is False

    def test_export_empty_range(self, state, log_file, stats_file, tmp_path):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        out = tmp_path / "empty.cttc"
        r = state.export_sample(str(out), 0.0, 1.0)  # both log and stats out of range
        assert r["sources"] == 0
        assert zipfile.ZipFile(out).namelist() == ["manifest.json"]

    def test_export_include_host_false(self, state, stats_file, tmp_path):
        src = state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        src.is_host = True
        out = tmp_path / "nohost.cttc"
        t0 = ms(2026, 1, 2, 3, 0, 0)
        r = state.export_sample(str(out), t0, t0 + 60000, include_host=False)
        assert r["sources"] == 0
        assert server.State(tmp_path).load_sample(str(out)) == []

    def test_load_sample_skips_blank_log_lines(self, state, tmp_path):
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
        opened = state.load_sample(str(out))
        src = state.sources[opened[0]]
        assert src.total() == 2
        assert src.slice(1, 1)[0]["text"] == ""  # missing text defaults to empty


class TestMultiSegmentSample:
    """Recording feature: Record/Pause spans get flushed into the same
    .cttc archive one segment at a time via merge_sample_bytes(), and
    load_sample() must ask (via MultiSegmentSample) which one to load once
    there's more than one."""

    def test_merge_from_scratch_is_a_single_segment(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        data, meta, seg_idx = state.merge_sample_bytes(None, t0, t1)
        assert seg_idx == 0
        assert len(meta) == 1
        man = json.loads(zipfile.ZipFile(io.BytesIO(data)).read("manifest.json"))
        assert len(man["segments"]) == 1
        assert man["segments"][0]["from"] == t0 and man["segments"][0]["to"] == t1

    def test_merge_appends_a_second_segment_without_losing_the_first(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        first, _meta1, idx1 = state.merge_sample_bytes(None, t0, t1)
        t2, t3 = ms(2026, 1, 2, 3, 0, 5), ms(2026, 1, 2, 3, 0, 10)
        second, meta2, idx2 = state.merge_sample_bytes(first, t2, t3)
        assert idx1 == 0 and idx2 == 1
        assert len(meta2) == 1
        man = json.loads(zipfile.ZipFile(io.BytesIO(second)).read("manifest.json"))
        assert len(man["segments"]) == 2
        assert man["segments"][0]["from"] == t0
        assert man["segments"][1]["from"] == t2
        # the first segment's own member bytes must be intact, unchanged
        z = zipfile.ZipFile(io.BytesIO(second))
        assert z.read(man["segments"][0]["sources"][0]["file"])

    def test_merge_onto_a_legacy_single_segment_file(self, state, log_file, tmp_path):
        # a file exported before the Recording feature (build_sample_bytes'
        # own one-segment shape) must still be a valid base to append onto
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        legacy, _meta = state.build_sample_bytes(t0, t1)
        t2, t3 = ms(2026, 1, 2, 3, 0, 5), ms(2026, 1, 2, 3, 0, 10)
        merged, meta2, idx2 = state.merge_sample_bytes(legacy, t2, t3)
        assert idx2 == 1 and len(meta2) == 1
        st2 = server.State(tmp_path)
        out = tmp_path / "merged.cttc"
        out.write_bytes(merged)
        with pytest.raises(server.MultiSegmentSample) as ei:
            st2.load_sample(str(out))
        assert [s["index"] for s in ei.value.segments] == [0, 1]

    def test_load_sample_with_explicit_segment_picks_that_one(self, state, log_file, tmp_path):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        first, _m1, _i1 = state.merge_sample_bytes(None, t0, t1)
        t2, t3 = ms(2026, 1, 2, 3, 0, 5), ms(2026, 1, 2, 3, 0, 10)
        merged, _m2, _i2 = state.merge_sample_bytes(first, t2, t3)
        out = tmp_path / "two-segments.cttc"
        out.write_bytes(merged)

        st2 = server.State(tmp_path)
        opened0 = st2.load_sample(str(out), segment=0)
        assert len(opened0) == 1
        assert st2.sources[opened0[0]].slice(0, 1)[0]["text"] == "alpha"

        st3 = server.State(tmp_path)
        opened1 = st3.load_sample(str(out), segment=1)
        assert len(opened1) == 1
        assert st3.sources[opened1[0]].slice(0, 1)[0]["text"] == "beta"

    def test_single_segment_file_loads_without_a_segment_arg(self, state, log_file, tmp_path):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 5)
        data, _meta, _idx = state.merge_sample_bytes(None, t0, t1)
        out = tmp_path / "one-segment.cttc"
        out.write_bytes(data)
        st2 = server.State(tmp_path)
        assert len(st2.load_sample(str(out))) == 1  # no MultiSegmentSample raised


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
def api(state, log_file, stats_file):
    state.open_file(str(log_file), "auto", None, live=False, transforms=[])
    state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
    base, srv, t = boot_server(state)
    yield base, state
    srv.should_exit = True
    t.join(timeout=5)


def get(base, path):
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def post(base, path, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(base + path, data=data, method="POST")
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

    def test_range_empty(self, tmp_path):
        base, srv, t = boot_server(server.State(tmp_path))
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

    def test_missing_params_400(self, api):
        base, _ = api
        code, j = get(base, "/series")
        assert code == 400 and "bad request" in j["error"]

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
        out = tmp_path / "range.cttc"
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

    def test_sample_record_include_host_false(self, api, state):
        base, _ = api
        for s in state.sources.values():
            if s.kind == "stats":
                s.is_host = True
        t0 = ms(2026, 1, 2, 3, 0, 0)
        code, headers, data = post_raw_binary(
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
        out = tmp_path / "recorded.cttc"
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
        base, st = api
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
        base, srv, t = boot_server(server.State(tmp_path))
        code, j = post(base, "/shutdown")
        assert code == 200 and j["ok"] is True
        t.join(timeout=5)
        assert not t.is_alive()


# ── /files/* (phase 3: upload/download, docs/architecture/remote-server.md) ──


class TestFilesEndpoints:
    def test_download_returns_binary_cttc(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        code, headers, data = get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}")
        assert code == 200
        assert headers["Content-Type"] == "application/octet-stream"
        assert 'filename="sample-' in headers["Content-Disposition"]
        assert headers["Content-Disposition"].endswith('.cttc"')
        z = zipfile.ZipFile(io.BytesIO(data))
        assert "manifest.json" in z.namelist()

    def test_download_exposes_source_count_header(self, api):
        base, _ = api
        t0 = ms(2026, 1, 2, 3, 0, 0)
        code, headers, _data = get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}")
        assert (
            headers["X-CTTC-Source-Count"] == "2"
        )  # the log + stats sources the api fixture opens
        exposed = headers["Access-Control-Expose-Headers"]
        assert "X-CTTC-Source-Count" in exposed and "Content-Disposition" in exposed

    def test_download_requires_from_and_to(self, api):
        base, _ = api
        assert get_raw(base, "/files/download")[0] == 400
        assert get_raw(base, "/files/download?from=0")[0] == 400

    def test_download_include_host_false(self, api, state):
        base, st = api
        for s in st.sources.values():
            if s.kind == "stats":
                s.is_host = True
        t0 = ms(2026, 1, 2, 3, 0, 0)
        code, _h, data = get_raw(base, f"/files/download?from={t0}&to={t0 + 60000}&include_host=0")
        z = zipfile.ZipFile(io.BytesIO(data))
        sources = json.loads(z.read("manifest.json"))["segments"][0]["sources"]
        assert all(
            s["type"] != "stats" for s in sources
        )  # the host-marked stats source is excluded
        assert any(s["type"] == "log" for s in sources)  # the unrelated log source is unaffected

    def test_upload_plain_log(self, api):
        base, st = api
        data = b"2026-01-02T03:00:00Z hello\n2026-01-02T03:00:01Z world\n"
        code, j = post_raw(base, "/files/upload", data, {"X-CTTC-Filename": "up.log"})
        assert code == 200
        assert len(j["opened"]) == 1 and j["errors"] == []
        src = st.sources[j["opened"][0]]
        assert src.path == "upload://up.log" and src.total() == 2

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
        code, j = post_raw(base, "/files/upload", second, {"X-CTTC-Filename": "rec.cttc"})
        assert code == 200
        assert j["opened"] == [] and j["errors"] == []
        assert len(j["needs_selection"]) == 1
        assert [s["index"] for s in j["needs_selection"][0]["segments"]] == [0, 1]

        code, j = post_raw(
            base, "/files/upload", second, {"X-CTTC-Filename": "rec.cttc", "X-CTTC-Segment": "0"}
        )
        assert code == 200
        assert len(j["opened"]) >= 1
        assert j["needs_selection"] == []

    def test_upload_no_filename_header_still_works(self, api):
        base, _ = api
        code, j = post_raw(base, "/files/upload", b"2026-01-02T03:00:00Z a\n")
        assert code == 200 and len(j["opened"]) == 1

    def test_upload_applies_transforms_header(self, api):
        base, st = api
        code, j = post_raw(
            base,
            "/files/upload",
            b"2026-01-02T03:00:00Z hi\n",
            {"X-CTTC-Filename": "t.log", "X-CTTC-Transforms": "upper"},
        )
        assert code == 200
        assert st.sources[j["opened"][0]].slice(0, 1)[0]["text"] == "HI"

    def test_upload_bad_data_reports_error_not_500(self, api):
        base, _ = api
        code, j = post_raw(base, "/files/upload", b"not a zip", {"X-CTTC-Filename": "bad.cttc"})
        assert code == 200  # request itself succeeded; the failure is reported in errors
        assert j["opened"] == [] and len(j["errors"]) == 1
        assert "bad.cttc" == j["errors"][0]["path"]

    def test_upload_broadcasts_sources_event_only_on_success(self, api):
        base, st = api
        seen = []
        st.broadcast = lambda ev: seen.append(ev)
        post_raw(base, "/files/upload", b"not a zip", {"X-CTTC-Filename": "bad.cttc"})
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
        post(f"http://127.0.0.1:{port}", "/shutdown")
        t.join(timeout=5)
        assert not t.is_alive()
        assert "could not open" in caplog.text
        assert server.NAIVE_TZ is not None and server.NAIVE_TZ != UTC or old_tz != UTC
        server.NAIVE_TZ = UTC  # restore module global for other tests

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
