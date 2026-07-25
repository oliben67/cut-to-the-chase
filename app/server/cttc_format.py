"""The two .cttc archive extensions (zip w/ manifest.json -- see
State._read_segments in server.py) a filename can carry, and what each means
client- and gateway-side alike:

    .cttc-metric -- a single-segment static export (Capture Metrics /
                    /sample/export).
    .cttc-record -- a recording: one or more segments, produced by
                    Record/Pause/Stop (/sample/record) or by a
                    recording_session.RecordingSessionManager session
                    (on-demand or scheduler-triggered).

Both are the same on-disk zip format and load identically via
State.load_sample -- the extension only distinguishes the two features for
the client's file pickers and save-dialog defaults (see
app/renderer/app.js and app/main.js). Kept in this standalone module (no
State/FastAPI dependencies) so both server.py and files.py can import it
without a circular import.
"""

from __future__ import annotations

METRIC_EXT = ".cttc-metric"
RECORD_EXT = ".cttc-record"


def is_cttc_archive(name: str) -> bool:
    return name.endswith(METRIC_EXT) or name.endswith(RECORD_EXT)
