"""File-transfer endpoints -- phase 3 of docs/architecture/remote-server.md.

Two of CTTC's flows assume the Electron client and server.py share a
filesystem (true when the server runs on the same machine, false once it
runs on a remote docker-enabled host): loading a picked .cttc/log file, and
saving an exported .cttc sample. This module gives both a byte-oriented
alternative -- upload a file's bytes so it can be opened, download an
exported sample's bytes directly -- with a deliberately narrow interface
into State (hand it bytes, get back opened source ids / a zip blob) and its
own route prefix, so it can be split into its own service later (larger
files, many concurrent uploads) without the collector code ever noticing.
"""

from __future__ import annotations

import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path


def download_sample(state, t0: float, t1: float, include_host: bool):
    """-> (data, filename, source_count) for the .cttc sample covering
    [t0, t1] -- the byte-returning counterpart to State.export_sample()."""
    data, meta = state.build_sample_bytes(t0, t1, include_host)
    ts = datetime.fromtimestamp(t0 / 1000, tz=UTC).strftime("%Y-%m-%d-%H-%M-%S")
    filename = f"sample-{ts}.cttc"
    return data, filename, len(meta)


def upload_and_open(
    state, filename: str, data: bytes, transforms: list[str], segment: int | None = None
):
    """Write the uploaded bytes to a scratch file, open it exactly like a
    local file would be (.cttc -> load_sample, anything else -> open_file,
    always static/non-live since the server has no way to get new bytes
    without another upload), then point the resulting source(s) at a
    synthetic upload://<filename> display path.

    The scratch file only needs to survive the open/load call: both fully
    read their input into memory (LogSource.ingest_chunk /
    StatsSource.ingest_chunk, or the whole zip for load_sample) and a
    non-live source's .path is never read again afterward (tail_loop skips
    anything with live=False; export reads s.rows/s.series, not s.path) --
    safe to delete it immediately after.

    Returns the list of opened source ids. Any exception open_file/
    load_sample themselves raise propagates -- callers should catch and
    report these the same way /open's per-file loop already does (including
    MultiSegmentSample, for a multi-segment .cttc with no `segment` chosen
    yet -- see server.py's route_files_upload).
    """
    suffix = Path(filename).suffix or ".log"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="cttc-upload-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        if filename.endswith(".cttc"):
            opened = state.load_sample(tmp_path, segment=segment)
        else:
            src = state.open_file(tmp_path, "auto", filename, live=False, transforms=transforms)
            opened = [src.id]
        display_path = f"upload://{filename}"
        for sid in opened:
            s = state.sources.get(sid)
            if s is not None:
                s.path = display_path
        return opened
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
