"""Tests for files.py (phase 3 of docs/architecture/remote-server.md)."""

from __future__ import annotations

import json
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

import pytest

import files
import server


def ms(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc).timestamp() * 1000.0


@pytest.fixture
def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    (tdir / "upper.py").write_text('def transform(r):\n    r["text"] = r["text"].upper()\n    return r\n')
    return server.State(tdir)


@pytest.fixture
def log_file(tmp_path):
    f = tmp_path / "svc.log"
    f.write_text("2026-01-02T03:00:00Z alpha\n2026-01-02T03:00:10Z beta\n")
    return f


class TestDownloadSample:
    def test_download_matches_export_sample_bytes(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 20)
        data, filename, count = files.download_sample(state, t0, t1, True)
        assert count == 1
        assert filename == "sample-2026-01-02-03-00-00.cttc"
        assert filename.endswith(".cttc")
        z = zipfile.ZipFile(BytesIO(data))
        manifest = json.loads(z.read("manifest.json"))
        assert len(manifest["sources"]) == 1

    def test_download_empty_range_yields_zero_sources(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        data, filename, count = files.download_sample(state, 0.0, 1.0, True)
        assert count == 0
        z = zipfile.ZipFile(BytesIO(data))
        assert json.loads(z.read("manifest.json"))["sources"] == []


class TestUploadAndOpen:
    def test_upload_plain_log(self, state):
        data = b"2026-01-02T03:00:00Z hello\n2026-01-02T03:00:01Z world\n"
        opened = files.upload_and_open(state, "mylog.log", data, [])
        assert len(opened) == 1
        src = state.sources[opened[0]]
        assert src.kind == "log" and src.total() == 2
        assert src.path == "upload://mylog.log"
        assert src.live is False

    def test_upload_applies_transforms(self, state):
        data = b"2026-01-02T03:00:00Z hello\n"
        opened = files.upload_and_open(state, "mylog.log", data, ["upper"])
        src = state.sources[opened[0]]
        assert src.slice(0, 1)[0]["text"] == "HELLO"

    def test_upload_scratch_file_removed_after(self, state, monkeypatch):
        captured = {}
        real_mkstemp = files.tempfile.mkstemp

        def spy_mkstemp(*a, **k):
            fd, path = real_mkstemp(*a, **k)
            captured["path"] = path
            return fd, path

        monkeypatch.setattr(files.tempfile, "mkstemp", spy_mkstemp)
        files.upload_and_open(state, "x.log", b"2026-01-02T03:00:00Z a\n", [])
        assert not Path(captured["path"]).exists()

    def test_upload_cttc_sample(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 20)
        data, _filename, _count = files.download_sample(state, t0, t1, True)

        state2 = server.State(Path("/tmp"))
        opened = files.upload_and_open(state2, "reload.cttc", data, [])
        assert len(opened) == 1
        src = state2.sources[opened[0]]
        assert src.path == "upload://reload.cttc"
        assert src.slice(0, 1)[0]["text"] == "alpha"

    def test_upload_bad_data_propagates_error(self, state):
        with pytest.raises(Exception):
            files.upload_and_open(state, "broken.cttc", b"not a zip file", [])

    def test_upload_no_extension_defaults_to_log_suffix(self, state):
        # mainly asserts this doesn't blow up picking a temp-file suffix
        opened = files.upload_and_open(state, "noext", b"2026-01-02T03:00:00Z a\n", [])
        assert len(opened) == 1

    def test_upload_survives_scratch_cleanup_failure(self, state, monkeypatch):
        # a failed unlink (already gone, permissions, ...) must not surface
        # as an error on top of an otherwise-successful upload
        monkeypatch.setattr(files.os, "unlink", lambda *_: (_ for _ in ()).throw(OSError("nope")))
        opened = files.upload_and_open(state, "x.log", b"2026-01-02T03:00:00Z a\n", [])
        assert len(opened) == 1
