"""Rolling metrics/log buffer feature.

Lets a client ask for "the last N minutes" of every source that was live
when the buffer started, without the server keeping a separate duplicate
FIFO of samples: `Source.rows`/`Source.series` already retain unbounded
in-memory history (see docs/architecture/remote-server.md), so a buffer is
just bookkeeping -- {source_ids, start_ts, minutes, paused_at} -- and the
actual window is sliced lazily at stop-time out of that already-resident
data via State.build_sample_bytes(), reusing the same .cttc zip format the
Record/Pause/Stop feature produces.

Multiple buffers can be open concurrently, each addressed by its own id.
Pausing a buffer stops it from tracking newly-opened sources (it already
only covers its start-time snapshot) and freezes its window's end at the
pause time; without a pause, stop() uses "now" as the window's end.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from server import State


class UnknownBuffer(KeyError):
    """Raised for an unknown/already-stopped buffer id."""


class RollingBufferManager:
    def __init__(self, state: State):
        self._state = state
        self._buffers: dict[str, dict] = {}
        self._next_id = 1

    def start(self, minutes: float, source_ids: set[str] | None = None) -> str:
        """Start a new buffer covering the last `minutes` minutes of
        `source_ids` (default: every currently-open source, snapshotted
        now). Returns the new buffer's id. events.py passes an explicit
        `source_ids` to cover only the systems an event was told to
        monitor, keeping the buffer alive for the event's whole lifetime
        (see snapshot(), its repeatable counterpart to stop())."""
        buffer_id = f"b{self._next_id}"
        self._next_id += 1
        self._buffers[buffer_id] = {
            "source_ids": set(source_ids) if source_ids is not None else set(self._state.sources.keys()),
            "start_ts": time.time() * 1000.0,
            "minutes": minutes,
            "paused_at": None,
        }
        return buffer_id

    def pause(self, buffer_id: str) -> None:
        """Stop admitting new data into the buffer's window -- its end time
        is frozen at the moment of this call, rather than "now" at stop()."""
        buf = self._buffers.get(buffer_id)
        if buf is None:
            raise UnknownBuffer(buffer_id)
        if buf["paused_at"] is None:
            buf["paused_at"] = time.time() * 1000.0

    def snapshot(self, buffer_id: str) -> tuple[bytes, list[dict]]:
        """Like stop(), but leaves the buffer running -- for repeat use by
        events.py, which keeps one rolling buffer alive for an event's
        entire lifetime and takes a snapshot of it on every trigger rather
        than starting a fresh buffer each time."""
        buf = self._buffers.get(buffer_id)
        if buf is None:
            raise UnknownBuffer(buffer_id)
        end = buf["paused_at"] if buf["paused_at"] is not None else time.time() * 1000.0
        t0 = max(buf["start_ts"], end - buf["minutes"] * 60_000.0)
        return self._state.build_sample_bytes(t0, end, source_ids=buf["source_ids"])

    def stop(self, buffer_id: str) -> tuple[bytes, list[dict]]:
        """Slice [max(start_ts, end - minutes*60_000), end] out of the
        buffer's snapshotted sources and return it as .cttc archive bytes,
        removing the buffer. `end` is the pause time if paused, else now."""
        result = self.snapshot(buffer_id)
        del self._buffers[buffer_id]
        return result
