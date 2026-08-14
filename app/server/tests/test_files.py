"""Tests for files.py (phase 3 of docs/architecture/remote-server.md)."""

from __future__ import annotations

import asyncio
import json
import zipfile
from datetime import UTC, datetime, timezone
from io import BytesIO
from pathlib import Path

import pytest

import files
import server


def ms(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=UTC).timestamp() * 1000.0


@pytest.fixture
async def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    (tdir / "upper.py").write_text(
        'def transform(r):\n    r["text"] = r["text"].upper()\n    return r\n'
    )
    # redis_flush_interval_seconds=0.05 (sRate), not the 1.0s default -- see
    # _flush() below.
    st = server.State(tdir, redis_flush_interval_seconds=0.05, redis_data_dir=str(tdir / "redis-data"))
    await st.redis_log.start()
    yield st
    await st.redis_log.stop()


async def _flush():
    # record() buffers in memory and is flushed to Redis every
    # flush_interval_seconds (sRate, 0.05s for this fixture's State); give
    # it a beat past that before reads that expect it.
    await asyncio.sleep(0.15)


@pytest.fixture
def log_file(tmp_path):
    f = tmp_path / "svc.log"
    f.write_text("2026-01-02T03:00:00Z alpha\n2026-01-02T03:00:10Z beta\n")
    return f


class TestDownloadSample:
    async def test_download_matches_export_sample_bytes(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 20)
        data, filename, count = await files.download_sample(state, t0, t1, True)
        assert count == 1
        assert filename == "sample-2026-01-02-03-00-00.cttc-metric"
        assert filename.endswith(".cttc-metric")
        z = zipfile.ZipFile(BytesIO(data))
        manifest = json.loads(z.read("manifest.json"))
        assert len(manifest["segments"][0]["sources"]) == 1

    async def test_download_empty_range_yields_zero_sources(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        data, _filename, count = await files.download_sample(state, 0.0, 1.0, True)
        assert count == 0
        z = zipfile.ZipFile(BytesIO(data))
        assert json.loads(z.read("manifest.json"))["segments"][0]["sources"] == []


class TestUploadAndOpen:
    async def test_upload_plain_log(self, state):
        data = b"2026-01-02T03:00:00Z hello\n2026-01-02T03:00:01Z world\n"
        opened = await files.upload_and_open(state, "mylog.log", data, [])
        await _flush()
        assert len(opened) == 1
        src = state.sources[opened[0]]
        assert src.kind == "log" and await src.total() == 2
        assert src.path == "upload://mylog.log"
        assert src.live is False

    async def test_upload_applies_transforms(self, state):
        data = b"2026-01-02T03:00:00Z hello\n"
        opened = await files.upload_and_open(state, "mylog.log", data, ["upper"])
        await _flush()
        src = state.sources[opened[0]]
        assert (await src.slice(0, 1))[0]["text"] == "HELLO"

    async def test_upload_scratch_file_removed_after(self, state, monkeypatch):
        captured = {}
        real_mkstemp = files.tempfile.mkstemp

        def spy_mkstemp(*a, **k):
            fd, path = real_mkstemp(*a, **k)
            captured["path"] = path
            return fd, path

        monkeypatch.setattr(files.tempfile, "mkstemp", spy_mkstemp)
        await files.upload_and_open(state, "x.log", b"2026-01-02T03:00:00Z a\n", [])
        assert not Path(captured["path"]).exists()

    async def test_upload_cttc_sample(self, state, log_file):
        state.open_file(str(log_file), "auto", None, live=False, transforms=[])
        await _flush()
        t0, t1 = ms(2026, 1, 2, 3, 0, 0), ms(2026, 1, 2, 3, 0, 20)
        data, _filename, _count = await files.download_sample(state, t0, t1, True)

        # Reuses `state`'s already-running RedisLog rather than starting a
        # second redis-server subprocess bound to the same fixed unix
        # socket (see redis_log.SOCKET_PATH) -- both States sharing one
        # physical Redis is exactly what "Redis is the sole source of
        # truth" means in practice, and is simpler than juggling a second
        # subprocess's lifecycle just for this test.
        state2 = server.State(Path("/tmp"))
        state2.redis_log = state.redis_log
        opened = await files.upload_and_open(state2, "reload.cttc-metric", data, [])
        src = state2.sources[opened[0]]
        assert len(opened) == 1
        assert src.path == "upload://reload.cttc-metric"
        assert (await src.slice(0, 1))[0]["text"] == "alpha"

    async def test_upload_bad_data_propagates_error(self, state):
        with pytest.raises(Exception):
            await files.upload_and_open(state, "broken.cttc-metric", b"not a zip file", [])

    async def test_upload_no_extension_defaults_to_log_suffix(self, state):
        # mainly asserts this doesn't blow up picking a temp-file suffix
        opened = await files.upload_and_open(state, "noext", b"2026-01-02T03:00:00Z a\n", [])
        assert len(opened) == 1

    async def test_upload_survives_scratch_cleanup_failure(self, state, monkeypatch):
        # a failed unlink (already gone, permissions, ...) must not surface
        # as an error on top of an otherwise-successful upload
        monkeypatch.setattr(files.os, "unlink", lambda *_: (_ for _ in ()).throw(OSError("nope")))
        opened = await files.upload_and_open(state, "x.log", b"2026-01-02T03:00:00Z a\n", [])
        assert len(opened) == 1
