"""Rolling metrics/log buffer feature.

Lets a client ask for "the last N minutes" of every source that was live
when the buffer started, without the server keeping a separate duplicate
FIFO of samples: Redis already retains bounded history for every source
(see redis_log.py), so a buffer is just bookkeeping -- {source_ids,
start_ts, minutes, paused_at} -- and the actual window is sliced lazily at
stop-time out of Redis via State.build_sample_bytes(), reusing the same
.cttc zip format the Record/Pause/Stop feature produces.

Multiple buffers can be open concurrently, each addressed by its own id.
Pausing a buffer stops it from tracking newly-opened sources (it already
only covers its start-time snapshot) and freezes its window's end at the
pause time; without a pause, stop() uses "now" as the window's end.

Retention (br-RBUF-005): an *ad-hoc* buffer (started directly via
POST /buffer/start) used to have no retention/cap of any kind -- a client
that started one and never called stop()/pause() (a bug, a crash, or just
repeated calls, since the route needs no confirmation) leaked that entry
forever, and events.py already defensively caught UnknownBuffer as though
"already stopped/expired on its own (e.g. TTL)" -- a TTL that didn't
actually exist. tick() (called periodically from server.py's sessions_loop,
same as recording_session.py's own TTL sweep) now reclaims one once it's
been open longer than MAX_AGE_SECONDS, and start() itself caps how many
ad-hoc buffers can be open at once. Neither applies to a buffer
events.py keeps alive for an enabled event's entire lifetime (see
start()'s `owned_by_event`) -- that lifetime is bounded by the event
itself (cancel()/update() always stop() it first), not by age or count.
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from server import State

MAX_AGE_SECONDS = 24 * 3600.0  # generous enough for a normal "arm, come back later" session
MAX_OPEN = 200


class UnknownBuffer(KeyError):
    """Raised for an unknown/already-stopped buffer id."""


class TooManyBuffers(ValueError):
    """Raised by start() when MAX_OPEN ad-hoc buffers are already open --
    caught by server.py's generic ValueError handler (400), same as any
    other bad request."""


class RollingBufferManager:
    def __init__(self, state: State):
        self._state = state
        self._buffers: dict[str, dict] = {}
        self._next_id = 1

    def start(
        self,
        minutes: float,
        source_ids: set[str] | None = None,
        owned_by_event: bool = False,
    ) -> str:
        """Start a new buffer covering the last `minutes` minutes of
        `source_ids` (default: every currently-open source, snapshotted
        now). Returns the new buffer's id. events.py passes an explicit
        `source_ids` *and* owned_by_event=True to cover only the systems
        an event was told to monitor, keeping the buffer alive for the
        event's whole lifetime (see snapshot(), its repeatable counterpart
        to stop()) exempt from the ad-hoc cap/TTL below.

        Raises TooManyBuffers if MAX_OPEN ad-hoc buffers are already open
        (br-RBUF-005) -- an event-owned buffer never counts against this,
        since how many of those exist is already bounded by how many
        snapshot-action events exist."""
        if not owned_by_event:
            open_ad_hoc = sum(1 for b in self._buffers.values() if not b["owned_by_event"])
            if open_ad_hoc >= MAX_OPEN:
                raise TooManyBuffers(
                    f"{MAX_OPEN} rolling buffers are already open -- stop some before starting another"
                )
        buffer_id = f"b{self._next_id}"
        self._next_id += 1
        self._buffers[buffer_id] = {
            "source_ids": set(source_ids)
            if source_ids is not None
            else set(self._state.sources.keys()),
            "start_ts": time.time() * 1000.0,
            "minutes": minutes,
            "paused_at": None,
            "owned_by_event": owned_by_event,
        }
        return buffer_id

    def tick(self, now: float | None = None) -> list[str]:
        """Sweeps ad-hoc buffers open longer than MAX_AGE_SECONDS with no
        stop() (br-RBUF-005) -- never touches an owned_by_event buffer,
        which is meant to live as long as its event stays enabled, however
        long that is. Returns the ids reclaimed."""
        now = now if now is not None else time.time() * 1000.0
        expired = [
            bid
            for bid, buf in self._buffers.items()
            if not buf["owned_by_event"] and now - buf["start_ts"] > MAX_AGE_SECONDS * 1000.0
        ]
        for bid in expired:
            del self._buffers[bid]
        return expired

    def pause(self, buffer_id: str) -> None:
        """Stop admitting new data into the buffer's window -- its end time
        is frozen at the moment of this call, rather than "now" at stop()."""
        buf = self._buffers.get(buffer_id)
        if buf is None:
            raise UnknownBuffer(buffer_id)
        if buf["paused_at"] is None:
            buf["paused_at"] = time.time() * 1000.0

    async def snapshot(self, buffer_id: str) -> tuple[bytes, list[dict]]:
        """Like stop(), but leaves the buffer running -- for repeat use by
        events.py, which keeps one rolling buffer alive for an event's
        entire lifetime and takes a snapshot of it on every trigger rather
        than starting a fresh buffer each time."""
        buf = self._buffers.get(buffer_id)
        if buf is None:
            raise UnknownBuffer(buffer_id)
        end = buf["paused_at"] if buf["paused_at"] is not None else time.time() * 1000.0
        t0 = max(buf["start_ts"], end - buf["minutes"] * 60_000.0)
        return await self._state.build_sample_bytes(t0, end, source_ids=buf["source_ids"])

    async def stop(self, buffer_id: str) -> tuple[bytes, list[dict]]:
        """Slice [max(start_ts, end - minutes*60_000), end] out of the
        buffer's snapshotted sources and return it as .cttc archive bytes,
        removing the buffer. `end` is the pause time if paused, else now."""
        result = await self.snapshot(buffer_id)
        del self._buffers[buffer_id]
        return result
