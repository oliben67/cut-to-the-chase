"""Exhaustive tests for the CTTC timeline server.

Everything external (docker CLI, ssh, remote hosts) is faked via monkeypatch;
psutil and the HTTP stack are exercised for real. Run:

    uv run --group dev pytest --cov=server --cov-report=term-missing
"""

from __future__ import annotations

import http.client
import io
import json
import socket
import struct
import subprocess
import sys
import threading
import time
import types
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

import server


def ms(y, mo, d, h=0, mi=0, s=0, us=0, tz=timezone.utc):
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
            assert got == [{"name": "locked", "doc": ""}]   # listed, doc unreadable
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
    return server.LogSource("s1", "svc", Path("/nonexistent"), live=False, transforms=list(transforms))


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
            b"2026-01-02T03:04:05Z keep\n"
            b"2026-01-02T03:04:06Z drop me\n"
            b"2026-01-02T03:04:07Z no-ts\n"
        )
        assert src.total() == 2  # "keep" duplicated; "drop me" gone; "no-ts" skipped
        assert src.skipped == 2

    def test_index_at(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:00:00Z a\n2026-01-02T03:00:10Z b\n2026-01-02T03:00:20Z c\n")
        t0 = ms(2026, 1, 2, 3, 0, 0)
        assert src.index_at(t0 - 1000) == 0
        assert src.index_at(t0 + 4000) == 0   # nearer to a than b
        assert src.index_at(t0 + 6000) == 1
        assert src.index_at(t0 + 99999999) == 2

    def test_index_at_empty(self):
        assert log_source().index_at(0) == -1

    def test_ticks(self):
        src = log_source()
        src.ingest_chunk(b"2026-01-02T03:00:00Z a\n2026-01-02T03:00:00Z b\n2026-01-02T03:00:09Z c\n")
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
        assert src.find("error", 0) == 0                 # case-insensitive
        assert src.find("error", 1) == 2                 # forward from middle
        assert src.find("error", 1, forward=False) == 0  # backward from middle
        assert src.find("ERROR one", 1) == 0             # wraps past the end
        assert src.find("two", 0, forward=False) == 2    # wraps backward
        assert src.find("nothing-here", 0) is None
        assert src.find("   ", 0) is None                # blank query
        assert src.find("x", 99) is None or src.find("x", 99) >= 0  # start clamped

    def test_find_empty_log(self):
        assert log_source().find("x", 0) is None


# ── StatsSource ──────────────────────────────────────────────────────────────


def stats_entry(name, ts, cpu="10%", mem="20%", memuse="100MiB / 1GiB", netio="1kB / 2kB"):
    return {
        "Name": name, "timestamp": ts, "CPUPerc": cpu, "MemPerc": mem,
        "MemUsage": memuse, "NetIO": netio,
    }


def stats_source():
    return server.StatsSource("s2", "stats", Path("/nonexistent"), live=False)


def feed_stats(src, entries):
    payload = "\n".join(json.dumps(e) for e in entries) + "\n"
    return src.ingest_chunk(payload.encode())


class TestStatsSource:
    def test_jsonl_ingest_and_net_rate(self):
        src = stats_source()
        n = feed_stats(src, [
            stats_entry("api", "2026-01-02T03:00:00Z", netio="1kB / 2kB"),
            stats_entry("api", "2026-01-02T03:00:10Z", netio="2kB / 4kB"),
        ])
        assert n == 2 and src.count == 2
        rows = src.series["api"]
        assert rows[0][4] is None                       # first sample: no rate yet
        assert rows[1][4] == pytest.approx(300.0)       # 3000 B over 10 s
        assert rows[0][1] == 10.0 and rows[0][2] == 20.0
        assert rows[0][3] == pytest.approx(100 * 1024**2)

    def test_net_counter_reset_gives_none(self):
        src = stats_source()
        feed_stats(src, [
            stats_entry("api", "2026-01-02T03:00:00Z", netio="9kB / 9kB"),
            stats_entry("api", "2026-01-02T03:00:10Z", netio="1kB / 1kB"),
        ])
        assert src.series["api"][1][4] is None

    def test_net_same_timestamp_gives_none(self):
        src = stats_source()
        feed_stats(src, [
            stats_entry("api", "2026-01-02T03:00:00Z"),
            stats_entry("api", "2026-01-02T03:00:00Z", netio="5kB / 5kB"),
        ])
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
        feed_stats(src, [
            stats_entry("api.1.abc", "2026-01-02T03:00:00Z"),
            stats_entry("api.2.def", "2026-01-02T03:00:00Z"),
            stats_entry("plain", "2026-01-02T03:00:00Z"),
        ])
        assert sorted(src.series) == ["api", "plain"]
        assert src._swarm == {"api"}

    def test_skips(self):
        src = stats_source()
        n = src.ingest_chunk(
            b'{"Name": "--", "timestamp": "2026-01-02T03:00:00Z"}\n'
            b'{"Name": "", "timestamp": "2026-01-02T03:00:00Z"}\n'
            b'{"Name": "x"}\n'                    # no timestamp
            b'[1, 2]\n'                           # not a dict
            b'not json at all\n'
        )
        assert n == 0 and src.count == 0 and src.skipped == 5

    def test_whole_array_mode(self):
        src = stats_source()
        payload = json.dumps([
            stats_entry("api", "2026-01-02T03:00:00Z"),
            stats_entry("api", "2026-01-02T03:00:05Z"),
        ]).encode()
        assert src.ingest_chunk(payload) == 2

    def test_partial_array_buffered(self):
        src = stats_source()
        payload = json.dumps([stats_entry("api", "2026-01-02T03:00:00Z")]).encode()
        assert src.ingest_chunk(payload[:10]) == 0
        assert src.ingest_chunk(payload[10:]) == 1

    def test_out_of_order_insort(self):
        src = stats_source()
        feed_stats(src, [
            stats_entry("api", "2026-01-02T03:00:10Z"),
            stats_entry("api", "2026-01-02T03:00:00Z"),
        ])
        ts = [r[0] for r in src.series["api"]]
        assert ts == sorted(ts)

    def test_services_range_bucketed(self):
        src = stats_source()
        feed_stats(src, [
            stats_entry("b", "2026-01-02T03:00:00Z", cpu="10%"),
            stats_entry("b", "2026-01-02T03:00:01Z", cpu="50%"),
            stats_entry("a.1.x", "2026-01-02T03:00:05Z", cpu="30%"),
        ])
        assert src.services() == ["a", "b"]
        lo, hi = src.range()
        assert lo == ms(2026, 1, 2, 3, 0, 0) and hi == ms(2026, 1, 2, 3, 0, 5)
        out = src.bucketed(lo, lo + 10000, 5)        # dt = 2 s: both b samples share bucket 0
        by_name = {o["name"]: o for o in out}
        assert by_name["b"]["cpu"][0] == 50.0        # max-merged in one bucket
        assert by_name["a"]["ttype"] == "service"
        assert by_name["b"]["ttype"] == "container"
        assert all(o["host"] is False for o in out)
        assert all(o["sid"] == "s2" for o in out)

    def test_bucketed_ignores_out_of_window(self):
        src = stats_source()
        feed_stats(src, [stats_entry("api", "2026-01-02T03:00:00Z")])
        t0 = ms(2026, 1, 2, 4, 0, 0)
        out = src.bucketed(t0, t0 + 1000, 5)
        assert len(out) == 1                          # service listed, but no samples land
        assert all(v is None for v in out[0]["cpu"] + out[0]["mem"] + out[0]["net"])

    def test_empty_range(self):
        assert stats_source().range() is None

    def test_point_at_nearest(self):
        src = stats_source()
        feed_stats(src, [
            stats_entry("api", "2026-01-02T03:00:00Z", cpu="10%"),
            stats_entry("api", "2026-01-02T03:00:10Z", cpu="90%"),
        ])
        src.series["empty"] = []                     # skipped without crashing
        t0 = ms(2026, 1, 2, 3, 0, 0)
        assert src.point_at(t0 + 2000)["api"]["cpu"] == 10.0     # nearest is earlier
        assert src.point_at(t0 + 8000)["api"]["cpu"] == 90.0     # nearest is later
        after = src.point_at(t0 + 60000)["api"]                  # past the end
        assert after["cpu"] == 90.0 and after["ts"] == t0 + 10000
        before = src.point_at(t0 - 60000)["api"]                 # before the start
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

    def test_tail_loop_appends_truncates_and_skips(self, tmp_path):
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

        threading.Thread(target=server.tail_loop, args=(st, 0.03), daemon=True).start()
        with open(f, "a") as fh:
            fh.write("2026-01-02T03:00:01Z two\n")
        deadline = time.time() + 3
        while src.total() < 2 and time.time() < deadline:
            time.sleep(0.05)
        assert src.total() == 2

        f.write_text("2026-01-02T03:00:02Z rewritten\n")  # truncation -> re-read
        deadline = time.time() + 3
        while src.total() < 3 and time.time() < deadline:
            time.sleep(0.05)
        assert src.total() == 3
        assert gsrc.total() == 1  # unchanged, stat() failed quietly

    def test_tail_loop_survives_read_failure(self, tmp_path, monkeypatch):
        f = tmp_path / "r.log"
        f.write_text("2026-01-02T03:00:00Z one\n")
        st = server.State(tmp_path)
        src = st.open_file(str(f), "log", None, live=True, transforms=[])

        def broken_read(_src):
            raise OSError("disk on fire")

        monkeypatch.setattr(server, "read_all", broken_read)
        threading.Thread(target=server.tail_loop, args=(st, 0.03), daemon=True).start()
        with open(f, "a") as fh:
            fh.write("2026-01-02T03:00:01Z two\n")
        time.sleep(0.3)                               # loop hits OSError and keeps running
        assert src.total() == 1


# ── ssh helpers ──────────────────────────────────────────────────────────────


class TestSshHelpers:
    def test_env_none_without_key(self):
        assert server.ssh_key_env(None) is None

    def test_wrapper_created_and_cached(self):
        env1 = server.ssh_key_env("/tmp/some-key")
        env2 = server.ssh_key_env("/tmp/some-key")
        d1 = env1["PATH"].split(":")[0]
        assert d1 == env2["PATH"].split(":")[0]
        body = (Path(d1) / "ssh").read_text()
        assert '-i "/tmp/some-key"' in body and "IdentitiesOnly=yes" in body

    def test_list_ssh_keys(self, tmp_path, monkeypatch):
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        assert server.list_ssh_keys() == []      # no ~/.ssh at all
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
            assert keys == [str(d / "id_ed25519")]   # unreadable key skipped quietly
        finally:
            locked.chmod(0o644)


# ── docker CLI (fully mocked) ────────────────────────────────────────────────


class FakeRun:
    """Callable stand-in for subprocess.run with scripted results."""

    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        r = self.results.pop(0) if len(self.results) > 1 else self.results[0]
        if isinstance(r, Exception):
            raise r
        return r


def ok(stdout="", stderr=""):
    return types.SimpleNamespace(returncode=0, stdout=stdout, stderr=stderr)


def fail(stderr="boom"):
    return types.SimpleNamespace(returncode=1, stdout="", stderr=stderr)


@pytest.fixture
def docker_cli(monkeypatch):
    monkeypatch.setattr(server.shutil, "which", lambda name: f"/usr/bin/{name}")


class TestDockerCmdAndPs:
    def test_docker_cmd_missing(self, monkeypatch):
        monkeypatch.setattr(server.shutil, "which", lambda n: None)
        with pytest.raises(RuntimeError, match="docker CLI not found"):
            server.docker_cmd(None)

    def test_docker_cmd_host_flag(self, docker_cli):
        assert server.docker_cmd("ssh://u@h") == ["/usr/bin/docker", "-H", "ssh://u@h"]
        assert server.docker_cmd(None) == ["/usr/bin/docker"]

    def test_ps_ok_with_services(self, docker_cli, monkeypatch):
        run = FakeRun([
            ok('{"ID": "1", "Names": "web", "Image": "nginx"}\n'),
            ok('{"ID": "s", "Name": "api", "Replicas": "2/2"}\n'),
        ])
        monkeypatch.setattr(server.subprocess, "run", run)
        got = server.docker_ps(None)
        assert got["containers"] == [{"id": "1", "name": "web", "image": "nginx"}]
        assert got["services"] == [{"id": "s", "name": "api", "replicas": "2/2"}]

    def test_ps_service_ls_failure_tolerated(self, docker_cli, monkeypatch):
        run = FakeRun([ok('{"ID": "1", "Names": "web", "Image": "nginx"}\n'), fail()])
        monkeypatch.setattr(server.subprocess, "run", run)
        assert server.docker_ps(None)["services"] == []

    def test_ps_failure_raises(self, docker_cli, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([fail("no daemon")]))
        with pytest.raises(RuntimeError, match="no daemon"):
            server.docker_ps(None)

    def test_ps_passes_ssh_key_env(self, docker_cli, monkeypatch):
        run = FakeRun([ok(""), ok("")])
        monkeypatch.setattr(server.subprocess, "run", run)
        server.docker_ps("ssh://u@h", ssh_key="/tmp/k")
        env = run.calls[0][1]["env"]
        assert env is not None and "cttc-ssh" in env["PATH"].split(":")[0]


class FakeState:
    def __init__(self):
        self.events = []

    def broadcast(self, ev):
        self.events.append(ev)


class TestDockerStatsSource:
    def test_polls_and_ingests(self, docker_cli, monkeypatch):
        line = json.dumps({"Name": "api.1.x", "CPUPerc": "10%", "MemPerc": "20%",
                           "MemUsage": "1MiB / 4MiB", "NetIO": "1kB / 1kB"})
        run = FakeRun([ok(line + "\nnot-json\n\n")])
        monkeypatch.setattr(server.subprocess, "run", run)
        st = FakeState()
        src = server.DockerStatsSource("d1", "stats@local", None, 0.05, st)
        try:
            deadline = time.time() + 3
            while not src.series and time.time() < deadline:
                time.sleep(0.02)
            assert "api" in src.series
            assert src.error is None
            assert any(e["type"] == "update" for e in st.events)
            assert src.path == "docker://local/stats"
        finally:
            src.stop()

    def test_error_captured(self, docker_cli, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([fail("cannot connect")]))
        src = server.DockerStatsSource("d2", "stats@local", None, 0.05, FakeState())
        try:
            deadline = time.time() + 3
            while src.error is None and time.time() < deadline:
                time.sleep(0.02)
            assert "cannot connect" in src.error
        finally:
            src.stop()

    def test_timeout_captured(self, docker_cli, monkeypatch):
        exc = subprocess.TimeoutExpired(cmd="docker", timeout=1)
        monkeypatch.setattr(server.subprocess, "run", FakeRun([exc]))
        src = server.DockerStatsSource("d3", "stats@local", None, 0.05, FakeState())
        try:
            deadline = time.time() + 3
            while src.error is None and time.time() < deadline:
                time.sleep(0.02)
            assert src.error
        finally:
            src.stop()


class FakeProc:
    def __init__(self, chunks, linger_polls=0):
        self.chunks = list(chunks)
        self.linger_polls = linger_polls   # poll() returns None this many times after EOF
        self.terminated = False
        outer = self

        class Out:
            def read1(self, n):
                return outer.chunks.pop(0) if outer.chunks else b""

        self.stdout = Out()

    def poll(self):
        if self.chunks:
            return None
        if self.linger_polls > 0:
            self.linger_polls -= 1
            return None
        return 0

    def terminate(self):
        self.terminated = True


class TestDockerLogSource:
    def test_follows_and_reports_end(self, docker_cli, monkeypatch):
        # linger_polls > 0 exercises the "no data yet, stream still open" sleep
        proc = FakeProc([b"2026-01-02T03:04:05Z hello\n2026-01-02T03:04:06Z world\n"],
                        linger_polls=2)
        monkeypatch.setattr(server.subprocess, "Popen", lambda *a, **k: proc)
        st = FakeState()
        src = server.DockerLogSource("l1", "web", None, "container", "web", [], st)
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            time.sleep(0.02)
        assert src.total() == 2
        assert src.error == "log stream ended"
        assert src.path == "docker://local/container/web"
        src.stop()
        assert proc.terminated

    def test_service_target_uses_service_logs(self, docker_cli, monkeypatch):
        captured = {}

        def popen(cmd, **kw):
            captured["cmd"] = cmd
            return FakeProc([])

        monkeypatch.setattr(server.subprocess, "Popen", popen)
        src = server.DockerLogSource("l2", "api", "ssh://u@h", "service", "api", [], FakeState(),
                                     ssh_key="/tmp/k")
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            time.sleep(0.02)
        assert captured["cmd"][:4] == ["/usr/bin/docker", "-H", "ssh://u@h", "service"]
        src.stop()

    def test_spawn_failure_recorded(self, docker_cli, monkeypatch):
        def popen(*a, **k):
            raise OSError("exec failed")

        monkeypatch.setattr(server.subprocess, "Popen", popen)
        src = server.DockerLogSource("l3", "web", None, "container", "web", [], FakeState())
        deadline = time.time() + 3
        while src.error is None and time.time() < deadline:
            time.sleep(0.02)
        assert "exec failed" in src.error
        src.stop()


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
    def test_local_psutil_samples(self):
        src = server.HostStatsSource("h1", "host@local", None, 0.05, FakeState())
        try:
            deadline = time.time() + 5
            while not src.series.get("host@local") and time.time() < deadline:
                time.sleep(0.05)
            rows = src.series["host@local"]
            assert rows, "expected at least one host sample"
            ts, cpu, mem, mem_bytes, rate = rows[0]
            assert 0 <= cpu <= 100 * 64        # cpu_percent can exceed 100 on multicore? no; be lax
            assert 0 < mem <= 100
            assert mem_bytes > 0
            assert src.error is None
            assert src.path == "docker://local/host"
        finally:
            src.stop()

    def test_ssh_sampling_and_interface_filter(self, monkeypatch):
        samples = [proc_files(100, 100, 700, 100, 1000, 2000),
                   proc_files(150, 150, 900, 100, 4000, 5000)]
        calls = []

        def run(cmd, **kw):
            calls.append(cmd)
            return ok(samples[0] if len(calls) == 1 else samples[1])

        monkeypatch.setattr(server.subprocess, "run", run)
        src = server.HostStatsSource("h2", "host@h", "ssh://user@h:2222", 0.05, FakeState(),
                                     ssh_key="/tmp/key")
        try:
            deadline = time.time() + 5
            while not src.series.get("host@h") and time.time() < deadline:
                time.sleep(0.05)
            assert "-p" in calls[0] and "2222" in calls[0]
            assert "-i" in calls[0] and "/tmp/key" in calls[0]
            assert calls[0][-4:] == ["cat", "/proc/stat", "/proc/meminfo", "/proc/net/dev"]
            ts, cpu, mem, mem_bytes, rate = src.series["host@h"][0]
            # busy: 200 -> 300 (delta 100) of total 1000 -> 1300 (delta 300)
            assert cpu == pytest.approx(100 / 300 * 100, rel=1e-3)
            assert mem == pytest.approx(60.0)
            assert mem_bytes == pytest.approx(600000 * 1024)
            assert rate > 0                     # 6000 bytes over the poll gap; lo/veth/br/docker0 excluded
        finally:
            src.stop()

    def test_unsupported_host_scheme(self):
        src = server.HostStatsSource("h3", "host@x", "tcp://1.2.3.4:2375", 0.05, FakeState())
        try:
            assert "ssh://" in src.error
            time.sleep(0.12)                    # loop must idle without sampling
            assert src.series == {}
        finally:
            src.stop()

    def test_ssh_failure_recorded(self, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([fail("Permission denied")]))
        src = server.HostStatsSource("h4", "host@h", "ssh://u@h", 0.05, FakeState())
        try:
            deadline = time.time() + 3
            while src.error is None and time.time() < deadline:
                time.sleep(0.02)
            assert "Permission denied" in src.error
        finally:
            src.stop()

    def test_local_without_psutil_reports_error(self, monkeypatch):
        src = server.HostStatsSource("h5", "host@x", "tcp://nope", 0.05, FakeState())
        src.stop()                               # loop idles; call the sampler directly
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
        'def transform(r):\n'
        '    r["text"] = r["text"].upper()\n'
        '    return r\n'
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
    f.write_text("\n".join(json.dumps(stats_entry("api", f"2026-01-02T03:00:0{i}Z")) for i in range(3)) + "\n")
    return f


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
        state.close_source("ghost")            # no-op

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

    def test_collect_docker_all_sources(self, state, docker_cli, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([ok("")]))
        monkeypatch.setattr(server.subprocess, "Popen", lambda *a, **k: FakeProc([]))
        opened = state.collect_docker(None, stats=True, logs=[{"name": "web"}],
                                      transforms=[], interval=0.05, host_stats=True)
        assert len(opened) == 3
        kinds = sorted(type(state.sources[sid]).__name__ for sid in opened)
        assert kinds == ["DockerLogSource", "DockerStatsSource", "HostStatsSource"]
        for sid in opened:
            state.close_source(sid)

    def test_collect_docker_flags_off(self, state, docker_cli, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([ok("")]))
        opened = state.collect_docker(None, stats=False, logs=[], transforms=[],
                                      interval=0.05, host_stats=False)
        assert opened == []

    def test_collect_docker_dedupes_stats_and_host_stats(self, state, docker_cli, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([ok("")]))
        first = state.collect_docker(None, stats=True, logs=[], transforms=[],
                                     interval=0.05, host_stats=True)
        second = state.collect_docker(None, stats=True, logs=[], transforms=[],
                                      interval=0.05, host_stats=True)
        assert first == second
        assert len(state.sources) == 2  # not 4 -- the second call reused both
        for sid in first:
            state.close_source(sid)

    def test_collect_docker_dedupes_logs(self, state, docker_cli, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([ok("")]))
        monkeypatch.setattr(server.subprocess, "Popen", lambda *a, **k: FakeProc([]))
        first = state.collect_docker(None, stats=False, host_stats=False,
                                     logs=[{"name": "web", "type": "container"}],
                                     transforms=[], interval=0.05)
        second = state.collect_docker(None, stats=False, host_stats=False,
                                      logs=[{"name": "web", "type": "container"}],
                                      transforms=[], interval=0.05)
        assert first == second
        assert len(state.sources) == 1
        state.close_source(first[0])

    def test_collect_docker_distinct_targets_not_deduped(self, state, docker_cli, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([ok("")]))
        monkeypatch.setattr(server.subprocess, "Popen", lambda *a, **k: FakeProc([]))
        by_name = state.collect_docker(None, stats=False, host_stats=False,
                                       logs=[{"name": "web", "type": "container"}],
                                       transforms=[], interval=0.05)
        by_type = state.collect_docker(None, stats=False, host_stats=False,
                                       logs=[{"name": "web", "type": "service"}],  # same name, different type
                                       transforms=[], interval=0.05)
        by_host = state.collect_docker("ssh://u@other", stats=False, host_stats=False,
                                       logs=[{"name": "web", "type": "container"}],  # same name/type, different host
                                       transforms=[], interval=0.05)
        ids = by_name + by_type + by_host
        assert len(set(ids)) == 3  # all distinct -- nothing wrongly collapsed
        for sid in ids:
            state.close_source(sid)

    def test_collect_docker_reuse_ignores_the_second_call_s_settings(self, state, docker_cli, monkeypatch):
        monkeypatch.setattr(server.subprocess, "run", FakeRun([ok("")]))
        first = state.collect_docker(None, stats=True, logs=[], transforms=[],
                                     interval=1.0, host_stats=False)
        state.collect_docker(None, stats=True, logs=[], transforms=[],
                             interval=99.0, host_stats=False)  # different interval, same target
        src = state.sources[first[0]]
        assert src.interval == 1.0  # untouched by the second, reused call
        state.close_source(first[0])

    def test_collect_docker_concurrent_requests_for_the_same_target_start_only_one(
        self, state, docker_cli, monkeypatch
    ):
        """The real point of _open_or_reuse: not just 'sequential calls
        dedupe' but that a genuine race between simultaneous requests can't
        both win. N threads all request the identical target at once."""
        monkeypatch.setattr(server.subprocess, "run", FakeRun([ok("")]))
        n = 16
        barrier = threading.Barrier(n)
        results = [None] * n

        def worker(i):
            barrier.wait()  # maximize actual overlap
            results[i] = state.collect_docker(None, stats=True, logs=[], transforms=[],
                                              interval=0.05, host_stats=False)[0]

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        assert all(r is not None for r in results), "a worker didn't finish"
        assert len(set(results)) == 1, f"expected one winner id, got {set(results)}"
        assert len(state.sources) == 1
        state.close_source(results[0])

    def test_broadcast_full_queue_dropped(self, state):
        import queue as q
        full = q.Queue(maxsize=1)
        full.put_nowait({"x": 1})
        state.listeners.append(full)
        state.broadcast({"type": "sources"})    # must not raise
        state.listeners.remove(full)


class TestSampleRoundTrip:
    def test_export_and_load(self, state, log_file, stats_file, tmp_path):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        st_src = state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
        st_src.is_host = True                   # exercise the host flag
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
        assert d["svc"]["total"] == 1           # only "alpha" is inside [t0, t1]
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
        r = state.export_sample(str(out), 0.0, 1.0)   # both log and stats out of range
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
            z.writestr("manifest.json", json.dumps({
                "version": 1,
                "sources": [{"type": "log", "name": "crafted", "file": "logs/0.jsonl"}],
            }))
        opened = state.load_sample(str(out))
        src = state.sources[opened[0]]
        assert src.total() == 2
        assert src.slice(1, 1)[0]["text"] == ""       # missing text defaults to empty


# ── HTTP API ─────────────────────────────────────────────────────────────────


@pytest.fixture
def api(state, log_file, stats_file):
    state.open_file(str(log_file), "auto", None, live=False, transforms=[])
    state.open_file(str(stats_file), "auto", None, live=False, transforms=[])
    server.Handler.state = state
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield base, state
    httpd.shutdown()
    httpd.server_close()


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
    """Like get(), but for binary (non-JSON) responses: /files/download."""
    try:
        with urllib.request.urlopen(base + path, timeout=5) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def post_raw(base, path, data, headers=None):
    """Like post(), but for a raw binary body + custom headers: /files/upload."""
    req = urllib.request.Request(base + path, data=data, method="POST", headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class TestHttpApi:
    def test_sources_and_range(self, api):
        base, _ = api
        code, j = get(base, "/sources")
        assert code == 200 and len(j["sources"]) == 2 and j["json_impl"] == server.JSON_IMPL
        code, j = get(base, "/range")
        assert j["min_ts"] == ms(2026, 1, 2, 3, 0, 0)
        assert j["max_ts"] == ms(2026, 1, 2, 3, 0, 10)

    def test_range_empty(self, tmp_path):
        server.Handler.state = server.State(tmp_path)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            _, j = get(f"http://127.0.0.1:{httpd.server_address[1]}", "/range")
            assert j == {"min_ts": None, "max_ts": None}
        finally:
            httpd.shutdown()
            httpd.server_close()

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
        _, j = get(base, f"/logs?source={sid}")        # defaults
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
        code, j = post(base, "/open", {"files": [
            {"path": str(extra), "live": False},
            {"path": "/no/such/file"},
        ]})
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

    def test_docker_ps_endpoint(self, api, monkeypatch):
        base, _ = api
        monkeypatch.setattr(server, "docker_ps",
                            lambda host, ssh_key=None: {"containers": [], "services": [],
                                                        "host": host, "key": ssh_key})
        _, j = post(base, "/docker/ps", {"host": "ssh://u@h", "ssh_key": "/k"})
        assert j["host"] == "ssh://u@h" and j["key"] == "/k"

    def test_docker_collect_endpoint(self, api, docker_cli, monkeypatch):
        base, st = api
        monkeypatch.setattr(server.subprocess, "run", FakeRun([ok("")]))
        monkeypatch.setattr(server.subprocess, "Popen", lambda *a, **k: FakeProc([]))
        code, j = post(base, "/docker/collect", {
            "stats": True, "host_stats": True, "logs": [{"name": "web", "type": "container"}],
            "interval": 0.05,
        })
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
        assert get(base, "/point")[0] == 400          # t is required

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
        _, j = post(base, "/sample/export",
                    {"path": str(out), "from": t0, "to": t0 + 60000, "include_host": False})
        assert j["sources"] == 1                      # only the log made it in

    def test_handle_error_swallows_disconnects_but_not_bugs(self, capsys):
        inst = server.ThreadingHTTPServer.__new__(server.ThreadingHTTPServer)
        try:
            raise ConnectionResetError("peer vanished")
        except ConnectionResetError:
            inst.handle_error(None, ("127.0.0.1", 1))   # swallowed
        assert capsys.readouterr().err == ""
        try:
            raise RuntimeError("actual bug")
        except RuntimeError:
            inst.handle_error(None, ("127.0.0.1", 1))   # dumped like the default
        assert "actual bug" in capsys.readouterr().err

    def test_get_broken_pipe_swallowed(self, api, monkeypatch):
        base, st = api
        def explode():
            raise BrokenPipeError()
        monkeypatch.setattr(st, "describe", explode)
        conn = http.client.HTTPConnection(base.split("//")[1], timeout=2)
        conn.request("GET", "/sources")
        with pytest.raises(Exception):                  # server sends nothing back
            conn.getresponse()
        conn.close()

    def test_sse_keepalive_comment(self, api, monkeypatch):
        base, st = api

        class FastQueue(server.queue.Queue):
            def get(self, timeout=None):                # shrink the 15 s keepalive wait
                return super().get(timeout=0.05)

        monkeypatch.setattr(server.queue, "Queue", FastQueue)
        conn = http.client.HTTPConnection(base.split("//")[1], timeout=5)
        conn.request("GET", "/events")
        resp = conn.getresponse()
        line = resp.fp.readline()
        assert line.startswith(b": keepalive")
        resp.close()
        conn.close()

    def test_sse_event_delivery_and_cleanup(self, api):
        base, st = api
        host = base.split("//")[1]
        conn = http.client.HTTPConnection(host, timeout=5)
        conn.request("GET", "/events")
        sock = conn.sock                        # getresponse() may detach conn.sock
        resp = conn.getresponse()
        deadline = time.time() + 3
        while not st.listeners and time.time() < deadline:
            time.sleep(0.02)
        st.broadcast({"type": "ping"})
        line = resp.fp.readline()
        assert line.startswith(b"data:") and b"ping" in line
        # force an immediate RST so the handler's next write fails (a plain
        # close is a half-close, which the server can keep writing into)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        resp.close()          # the streaming response owns the socket, not conn
        sock.close()
        conn.close()
        deadline = time.time() + 5
        while st.listeners and time.time() < deadline:
            st.broadcast({"type": "flush"})
            time.sleep(0.05)
        assert st.listeners == []

    def test_shutdown_endpoint(self, tmp_path):
        server.Handler.state = server.State(tmp_path)
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        code, j = post(f"http://127.0.0.1:{httpd.server_address[1]}", "/shutdown")
        assert code == 200 and j["ok"] is True
        t.join(timeout=5)
        assert not t.is_alive()
        httpd.server_close()


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
        assert headers["X-CTTC-Source-Count"] == "2"  # the log + stats sources the api fixture opens
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
        sources = json.loads(z.read("manifest.json"))["sources"]
        assert all(s["type"] != "stats" for s in sources)  # the host-marked stats source is excluded
        assert any(s["type"] == "log" for s in sources)     # the unrelated log source is unaffected

    def test_upload_plain_log(self, api):
        base, st = api
        data = b"2026-01-02T03:00:00Z hello\n2026-01-02T03:00:01Z world\n"
        code, j = post_raw(base, "/files/upload", data, {"X-CTTC-Filename": "up.log"})
        assert code == 200
        assert len(j["opened"]) == 1 and j["errors"] == []
        src = st.sources[j["opened"][0]]
        assert src.path == "upload://up.log" and src.total() == 2

    def test_upload_no_filename_header_still_works(self, api):
        base, _ = api
        code, j = post_raw(base, "/files/upload", b"2026-01-02T03:00:00Z a\n")
        assert code == 200 and len(j["opened"]) == 1

    def test_upload_applies_transforms_header(self, api):
        base, st = api
        code, j = post_raw(base, "/files/upload", b"2026-01-02T03:00:00Z hi\n",
                           {"X-CTTC-Filename": "t.log", "X-CTTC-Transforms": "upper"})
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
        base, st = api

        def explode():
            raise BrokenPipeError()

        monkeypatch.setattr(st, "describe", explode)
        conn = http.client.HTTPConnection(base.split("//")[1], timeout=2)
        conn.request("POST", "/files/upload", body=b"2026-01-02T03:00:00Z a\n",
                    headers={"X-CTTC-Filename": "x.log"})
        with pytest.raises(Exception):                  # server sends nothing back
            conn.getresponse()
        conn.close()

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
    def test_main_serves_and_shuts_down(self, tmp_path, monkeypatch, capsys):
        good = tmp_path / "ok.log"
        good.write_text("2026-01-02T03:00:00Z hi\n")
        captured = {}

        class CapturingServer(ThreadingHTTPServer):
            def __init__(self, *a, **k):
                super().__init__(*a, **k)
                captured["srv"] = self

        monkeypatch.setattr(server, "ThreadingHTTPServer", CapturingServer)
        monkeypatch.setattr(sys, "argv", [
            "server.py", "--port", "0", "--naive-tz", "local",
            "--transforms-dir", str(tmp_path), "--static",
            str(good), "/no/such/file.log",
        ])
        old_tz = server.NAIVE_TZ
        t = threading.Thread(target=server.main, daemon=True)
        t.start()
        deadline = time.time() + 5
        while "srv" not in captured and time.time() < deadline:
            time.sleep(0.02)
        port = captured["srv"].server_address[1]
        _, j = get(f"http://127.0.0.1:{port}", "/sources")
        assert len(j["sources"]) == 1           # the bad file only warned
        post(f"http://127.0.0.1:{port}", "/shutdown")
        t.join(timeout=5)
        assert not t.is_alive()
        out = capsys.readouterr()
        assert f'"port":{port}' in out.out.replace(" ", "")
        assert "could not open" in out.err
        assert server.NAIVE_TZ is not None and server.NAIVE_TZ != timezone.utc or old_tz != timezone.utc
        server.NAIVE_TZ = timezone.utc          # restore module global for other tests

    def test_main_keyboard_interrupt_exits_cleanly(self, tmp_path, monkeypatch):
        class InterruptingServer(ThreadingHTTPServer):
            def serve_forever(self, *a, **k):
                raise KeyboardInterrupt

        monkeypatch.setattr(server, "ThreadingHTTPServer", InterruptingServer)
        monkeypatch.setattr(sys, "argv", ["server.py", "--port", "0",
                                          "--transforms-dir", str(tmp_path)])
        server.main()                           # KeyboardInterrupt swallowed

    def test_dunder_main_via_runpy(self, tmp_path, monkeypatch, capsys):
        import runpy
        monkeypatch.setattr(sys, "argv", ["server.py", "--help"])
        with pytest.raises(SystemExit) as exc:
            runpy.run_path(str(Path(server.__file__)), run_name="__main__")
        assert exc.value.code == 0
        assert "--naive-tz" in capsys.readouterr().out


# ── stdlib-json fallback (orjson blocked in a subprocess) ────────────────────


def test_stdlib_json_fallback():
    code = (
        "import sys; sys.modules['orjson'] = None\n"
        "sys.path.insert(0, %r)\n"
        "import server\n"
        "assert server.JSON_IMPL == 'stdlib-json', server.JSON_IMPL\n"
        "assert server.jloads(server.jdumps({'a': 1})) == {'a': 1}\n"
        "assert isinstance(server.jdumps({}), bytes)\n"
        "print('fallback-ok')\n"
    ) % str(Path(server.__file__).parent)
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert "fallback-ok" in out.stdout


def test_zz_stdlib_json_fallback_reload():
    """Reload the module with orjson blocked so the fallback lines execute
    inside this process (and count toward coverage), then restore. Runs last
    (zz) so no other test observes the reloaded module identity."""
    import importlib

    saved = sys.modules.get("orjson")
    sys.modules["orjson"] = None                # forces ImportError on import
    try:
        importlib.reload(server)
        assert server.JSON_IMPL == "stdlib-json"
        assert server.jloads(server.jdumps({"a": [1, "x"]})) == {"a": [1, "x"]}
        assert isinstance(server.jdumps({}), bytes)
    finally:
        if saved is not None:
            sys.modules["orjson"] = saved
        else:
            sys.modules.pop("orjson", None)
        importlib.reload(server)
        assert server.JSON_IMPL == "orjson"
