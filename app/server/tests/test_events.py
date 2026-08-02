"""Tests for events.py."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

import events
import server


@pytest.fixture
async def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    st = server.State(tdir)
    await st.redis_log.start()
    yield st
    await st.redis_log.stop()


async def _flush():
    # record() enqueues via call_soon_threadsafe and is pumped
    # asynchronously; give the pump a beat before reads that expect it.
    await asyncio.sleep(0.15)


def stats_source(state, sid="s1"):
    src = server.StatsSource(sid, "stats", Path("/nonexistent"), live=False)
    src._state = state
    return src


def log_source(state, sid="s2"):
    src = server.LogSource(sid, "log", Path("/nonexistent"), live=False, transforms=[])
    src._state = state
    return src


async def append_log_row(state, src, ts, uid, text):
    """Test stand-in for what LogSource.ingest_chunk normally does --
    Redis is the store now (see redis_log.py), there's no src.rows list to
    append to directly. Records under src._entity (not the bare src.name)
    to match ingest_chunk's own real write path -- for every existing
    caller (src.host is None) the two are identical, but a host-qualified
    source needs this to actually land under the same key _check_log reads
    from (see br-EVTO-016)."""
    state.redis_log.record(src._entity, ts, {"uid": uid, "text": text})
    src._last_row = (ts, 0, uid, text)
    await _flush()


class TestEventValidation:
    async def test_unknown_metric_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            await state.events.create(
                "x",
                set(),
                [events.MetricCondition(metric="disk", op=">", threshold=1)],
                events.Action(kind="snapshot", minutes=5),
            )

    async def test_unknown_op_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            await state.events.create(
                "x",
                set(),
                [events.MetricCondition(metric="cpu", op="!=", threshold=1)],
                events.Action(kind="snapshot", minutes=5),
            )

    async def test_invalid_regex_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            await state.events.create(
                "x",
                set(),
                [events.LogCondition(pattern="[")],
                events.Action(kind="snapshot", minutes=5),
            )

    async def test_snapshot_action_requires_minutes(self, state):
        with pytest.raises(events.InvalidEvent):
            await state.events.create(
                "x", set(), [events.LogCondition(pattern="ERROR")], events.Action(kind="snapshot")
            )

    async def test_recording_action_requires_duration(self, state):
        with pytest.raises(events.InvalidEvent):
            await state.events.create(
                "x", set(), [events.LogCondition(pattern="ERROR")], events.Action(kind="recording")
            )

    async def test_unknown_action_kind_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            await state.events.create(
                "x", set(), [events.LogCondition(pattern="ERROR")], events.Action(kind="bogus")
            )

    async def test_unknown_condition_type_raises(self, state):
        # not reachable through the HTTP API (server.py's _parse_condition
        # only ever builds a MetricCondition/LogCondition), but _validate()
        # itself is defensive against any other object reaching it directly.
        with pytest.raises(events.InvalidEvent, match="unknown condition type"):
            await state.events.create(
                "x", set(), ["not a condition"], events.Action(kind="snapshot", minutes=5)
            )

    async def test_unknown_event_operations_raise(self, state):
        with pytest.raises(events.UnknownEvent):
            state.events.status_of("nope")
        with pytest.raises(events.UnknownEvent):
            state.events.enable("nope")
        with pytest.raises(events.UnknownEvent):
            state.events.disable("nope")
        with pytest.raises(events.UnknownEvent):
            state.events.reset("nope")
        with pytest.raises(events.UnknownEvent):
            await state.events.cancel("nope")


class TestEventTickResilience:
    async def test_one_failing_event_does_not_raise_or_block_others(self, state, monkeypatch):
        # br-ORCH-004: an exception checking/firing one event must not kill
        # the tick (and, transitively, all future orchestration ticks).
        src = stats_source(state)
        state.sources[src.id] = src
        bad_id = await state.events.create(
            "bad",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        good_id = await state.events.create(
            "good",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )

        orig_check = events.EventManager._check

        async def flaky_check(self, ev):
            if ev.id == bad_id:
                raise RuntimeError("boom")
            return await orig_check(self, ev)

        monkeypatch.setattr(events.EventManager, "_check", flaky_check)

        await state.events.tick()  # must not raise

        assert state.events.status_of(good_id)["status"] == "armed"


class TestMetricEvents:
    async def test_snapshot_action_starts_a_rolling_buffer_for_its_sources(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        ev = state.events._events[event_id]
        assert ev.buffer_id is not None
        assert ev.buffer_id in state.rolling_buffers._buffers

    async def test_tick_fires_snapshot_when_threshold_crossed(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 50.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

        src.ingest_row("api", 3000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=4000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert st["artifact_id"] is not None
        assert "cpu=90.0" in st["trigger_detail"]

        data = state.recording_sessions.download(st["artifact_id"])
        assert data[:2] == b"PK"  # zip magic

    async def test_does_not_refire_while_condition_stays_true(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        first_artifact = state.events.status_of(event_id)["artifact_id"]
        assert state.events.status_of(event_id)["trigger_count"] == 1

        await state.events.tick(now=3000.0)  # still 90 -- edge-trigger latch stays closed
        st = state.events.status_of(event_id)
        assert st["artifact_id"] == first_artifact
        assert st["trigger_count"] == 1

    async def test_reset_forces_an_immediate_refire_without_the_condition_clearing(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        first_artifact = state.events.status_of(event_id)["artifact_id"]

        state.events.reset(event_id)
        assert state.events.status_of(event_id)["status"] == "armed"
        await state.events.tick(now=4000.0)  # still 90, but reset() re-armed the latch
        st = state.events.status_of(event_id)
        assert st["artifact_id"] != first_artifact
        assert st["trigger_count"] == 2

    async def test_keeps_watching_and_refires_once_condition_clears_and_returns(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["trigger_count"] == 1

        src.ingest_row("api", 3000.0, 50.0, 10.0, 1000.0, 100.0)  # condition clears
        await _flush()
        await state.events.tick(now=4000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "armed"
        assert st["trigger_count"] == 1  # unchanged -- no re-trigger merely from clearing

        src.ingest_row("api", 5000.0, 95.0, 10.0, 1000.0, 100.0)  # condition met again
        await _flush()
        await state.events.tick(now=6000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert st["trigger_count"] == 2  # keeps watching -- no reset() needed

    async def test_disabling_is_the_only_thing_that_stops_watching(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        state.events.disable(event_id)
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["trigger_count"] == 0

    async def test_disabled_event_is_not_evaluated(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        state.events.disable(event_id)
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

        state.events.enable(event_id)
        await state.events.tick(now=3000.0)
        assert state.events.status_of(event_id)["status"] == "triggered"

    async def test_only_the_latest_sample_is_checked(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 95.0, 10.0, 1000.0, 100.0)  # breach, but stale
        src.ingest_row("api", 2000.0, 50.0, 10.0, 1000.0, 100.0)  # latest: no breach
        await _flush()
        await state.events.tick(now=3000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

    async def test_service_known_but_not_yet_sampled_is_skipped_not_crashed(self, state):
        """A service can appear in StatsSource._services (added the moment
        ingest_row is first called) slightly before its very first sample
        has actually been pumped into Redis (record() is queued, not
        synchronous) -- redis_log.latest() returns None for it during that
        window. _check_metric must skip it, not raise."""
        src = stats_source(state)
        state.sources[src.id] = src
        src._services.add("ghost")  # known, but never actually recorded
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        await state.events.tick(now=1000.0)  # must not raise
        assert state.events.status_of(event_id)["status"] == "armed"

    async def test_empty_source_ids_monitors_every_open_source(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            set(),
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "triggered"

    async def test_recording_action_starts_a_forward_recording_session(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">=", threshold=80)],
            events.Action(kind="recording", duration_minutes=5),
        )
        src.ingest_row("api", 1000.0, 80.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert state.recording_sessions.status_of(st["artifact_id"])["status"] == "running"


class TestLogEvents:
    async def test_tick_fires_on_regex_match_in_new_rows(self, state):
        src = log_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "errors",
            {src.id},
            [events.LogCondition(pattern=r"ERROR")],
            events.Action(kind="snapshot", minutes=5),
        )
        await append_log_row(state, src, 1000.0, "u1", "all good")
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

        await append_log_row(state, src, 3000.0, "u2", "ERROR: disk full")
        await state.events.tick(now=4000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert "ERROR: disk full" in st["trigger_detail"]

    async def test_only_new_rows_since_last_check_are_scanned(self, state):
        src = log_source(state)
        state.sources[src.id] = src
        await append_log_row(state, src, 1000.0, "u1", "ERROR: boom")
        event_id = await state.events.create(
            "errors",
            {src.id},
            [events.LogCondition(pattern=r"ERROR")],
            events.Action(kind="snapshot", minutes=5),
        )
        # the matching row was already there *before* the event was created --
        # only rows appended after creation should ever be scanned
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"


class TestHostQualifiedEntities:
    """br-EVTO-016: _check_metric/_check_log used to read Redis via the
    bare service/source name while StatsSource.ingest_row/LogSource.
    ingest_chunk (the real write paths) write under the host-qualified
    entity id (server.py's _entity_id/_entity_for, see br-DEDUP-006) --
    for any remote host source (src.host set) the read key never matched
    the write key, so a condition could never fire for anything but a
    local target. Every other test in this file uses src.host=None, where
    the bare name and the qualified entity id are identical, which is
    exactly why this went unnoticed."""

    async def test_metric_condition_fires_for_a_remote_host_source(self, state):
        src = stats_source(state)
        src.host = "ssh://user@remote-host"
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "triggered"

    async def test_log_condition_matches_for_a_remote_host_source(self, state):
        src = log_source(state)
        src.host = "ssh://user@remote-host"
        state.sources[src.id] = src
        event_id = await state.events.create(
            "errors",
            {src.id},
            [events.LogCondition(pattern=r"ERROR")],
            events.Action(kind="snapshot", minutes=5),
        )
        await append_log_row(state, src, 1000.0, "u1", "ERROR: disk full")
        await state.events.tick(now=2000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert "ERROR: disk full" in st["trigger_detail"]


class TestUpdate:
    async def test_update_unknown_event_raises(self, state):
        with pytest.raises(events.UnknownEvent):
            await state.events.update("nope", name="x")

    async def test_update_name_only_leaves_everything_else(self, state):
        event_id = await state.events.create(
            "old name",
            set(),
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="recording", duration_minutes=5),
        )
        await state.events.update(event_id, name="new name")
        st = state.events.status_of(event_id)
        assert st["name"] == "new name"
        assert st["conditions"] == [{"type": "metric", "metric": "cpu", "op": ">", "threshold": 80}]
        assert st["action"]["duration_minutes"] == 5

    async def test_update_rejects_invalid_conditions(self, state):
        event_id = await state.events.create(
            "x",
            set(),
            [events.LogCondition(pattern="ERROR")],
            events.Action(kind="recording", duration_minutes=1),
        )
        with pytest.raises(events.InvalidEvent):
            await state.events.update(event_id, conditions=[events.LogCondition(pattern="[")])
        # unchanged after the rejected update
        assert state.events.status_of(event_id)["conditions"] == [
            {"type": "log", "pattern": "ERROR"}
        ]

    async def test_update_conditions_reseeds_log_cursors(self, state):
        log = log_source(state)
        state.sources[log.id] = log
        await append_log_row(state, log, 1000.0, "u1", "old backlog")
        event_id = await state.events.create(
            "x",
            {log.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=999)],
            events.Action(kind="recording", duration_minutes=1),
        )
        # switching to a log condition now -- the pre-existing backlog line
        # must not count as a fresh match once the condition becomes log-based
        await state.events.update(event_id, conditions=[events.LogCondition(pattern="backlog")])
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["trigger_count"] == 0

    async def test_update_action_from_snapshot_to_recording_stops_the_buffer(self, state):
        event_id = await state.events.create(
            "x",
            set(),
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        buffer_id = state.events._events[event_id].buffer_id
        assert buffer_id in state.rolling_buffers._buffers
        await state.events.update(
            event_id, action=events.Action(kind="recording", duration_minutes=5)
        )
        assert buffer_id not in state.rolling_buffers._buffers
        assert state.events._events[event_id].buffer_id is None

    async def test_update_action_from_recording_to_snapshot_starts_a_buffer(self, state):
        event_id = await state.events.create(
            "x",
            set(),
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="recording", duration_minutes=5),
        )
        assert state.events._events[event_id].buffer_id is None
        await state.events.update(event_id, action=events.Action(kind="snapshot", minutes=10))
        new_buffer_id = state.events._events[event_id].buffer_id
        assert new_buffer_id is not None
        assert new_buffer_id in state.rolling_buffers._buffers

    async def test_update_source_ids_restarts_the_snapshot_buffer(self, state):
        src1 = stats_source(state, "s1")
        src2 = stats_source(state, "s2")
        state.sources[src1.id] = src1
        state.sources[src2.id] = src2
        event_id = await state.events.create(
            "x",
            {"s1"},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        old_buffer_id = state.events._events[event_id].buffer_id
        await state.events.update(event_id, source_ids={"s2"})
        new_buffer_id = state.events._events[event_id].buffer_id
        assert new_buffer_id != old_buffer_id
        assert old_buffer_id not in state.rolling_buffers._buffers
        assert state.rolling_buffers._buffers[new_buffer_id]["source_ids"] == {"s2"}

    async def test_update_unrelated_field_does_not_restart_snapshot_buffer(self, state):
        event_id = await state.events.create(
            "x",
            {"s1"},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        old_buffer_id = state.events._events[event_id].buffer_id
        await state.events.update(event_id, name="renamed")
        assert state.events._events[event_id].buffer_id == old_buffer_id

    async def test_update_tolerates_a_buffer_already_stopped_out_from_under_it(self, state):
        """The buffer backing a snapshot event can be stopped independently
        (e.g. a direct POST /buffer/{id}/stop) before update() gets around
        to swapping it out -- rolling_buffers.stop() then raises
        UnknownBuffer for an id update() still thinks is live. update() must
        swallow that (log, don't crash) and still install the new buffer."""
        event_id = await state.events.create(
            "x",
            set(),
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        stale_buffer_id = state.events._events[event_id].buffer_id
        await state.rolling_buffers.stop(stale_buffer_id)  # out-of-band stop
        assert stale_buffer_id not in state.rolling_buffers._buffers

        await state.events.update(
            event_id, action=events.Action(kind="recording", duration_minutes=5)
        )
        assert state.events._events[event_id].buffer_id is None
        assert state.events.status_of(event_id)["action"]["kind"] == "recording"


class TestCancel:
    async def test_cancel_removes_event_and_its_buffer(self, state):
        src = stats_source(state)
        state.sources[src.id] = src
        event_id = await state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        buffer_id = state.events._events[event_id].buffer_id
        await state.events.cancel(event_id)
        assert buffer_id not in state.rolling_buffers._buffers
        with pytest.raises(events.UnknownEvent):
            state.events.status_of(event_id)

    async def test_cancel_of_a_recording_event_has_no_buffer_to_stop(self, state):
        event_id = await state.events.create(
            "errors",
            set(),
            [events.LogCondition(pattern="ERROR")],
            events.Action(kind="recording", duration_minutes=5),
        )
        await state.events.cancel(event_id)  # must not raise despite buffer_id being None
        with pytest.raises(events.UnknownEvent):
            state.events.status_of(event_id)

    async def test_cancel_tolerates_a_buffer_already_stopped_out_from_under_it(self, state):
        """Same race as update()'s matching test -- cancel() must swallow
        UnknownBuffer from a buffer that's already gone, not crash while
        trying to tear down an event."""
        event_id = await state.events.create(
            "x",
            set(),
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        stale_buffer_id = state.events._events[event_id].buffer_id
        await state.rolling_buffers.stop(stale_buffer_id)  # out-of-band stop

        await state.events.cancel(event_id)  # must not raise
        with pytest.raises(events.UnknownEvent):
            state.events.status_of(event_id)


class TestMultipleConditions:
    async def test_requires_at_least_one_condition(self, state):
        with pytest.raises(events.InvalidEvent):
            await state.events.create("x", set(), [], events.Action(kind="snapshot", minutes=5))

    async def test_invalid_match_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            await state.events.create(
                "x",
                set(),
                [events.MetricCondition(metric="cpu", op=">", threshold=1)],
                events.Action(kind="snapshot", minutes=5),
                match="whatever",
            )

    async def test_default_match_any_fires_on_first_condition_met(self, state):
        src = stats_source(state)
        log = log_source(state)
        state.sources[src.id] = src
        state.sources[log.id] = log
        event_id = await state.events.create(
            "multi",
            {src.id, log.id},
            [
                events.MetricCondition(metric="cpu", op=">", threshold=80),
                events.LogCondition(pattern="ERROR"),
            ],
            events.Action(kind="snapshot", minutes=5),
        )
        # only the metric condition is met -- "any" still fires
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "triggered"

    async def test_match_all_requires_every_condition(self, state):
        src = stats_source(state)
        log = log_source(state)
        state.sources[src.id] = src
        state.sources[log.id] = log
        event_id = await state.events.create(
            "multi",
            {src.id, log.id},
            [
                events.MetricCondition(metric="cpu", op=">", threshold=80),
                events.LogCondition(pattern="ERROR"),
            ],
            events.Action(kind="snapshot", minutes=5),
            match="all",
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)  # only metric met
        await _flush()
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

        await append_log_row(state, log, 3000.0, "u1", "ERROR: disk full")  # now both are met
        await state.events.tick(now=4000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert "cpu=90.0" in st["trigger_detail"]
        assert "ERROR: disk full" in st["trigger_detail"]

    async def test_log_cursor_advances_even_when_match_all_never_fires(self, state):
        src = stats_source(state)
        log = log_source(state)
        state.sources[src.id] = src
        state.sources[log.id] = log
        event_id = await state.events.create(
            "multi",
            {src.id, log.id},
            [
                events.MetricCondition(metric="cpu", op=">", threshold=999),  # never met
                events.LogCondition(pattern="ERROR"),
            ],
            events.Action(kind="snapshot", minutes=5),
            match="all",
        )
        await append_log_row(state, log, 1000.0, "u1", "ERROR: boom")
        await state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"
        # that ERROR row must not still be "new" on a later tick, now that
        # the metric condition is finally also met
        ev = state.events._events[event_id]
        src.ingest_row("api", 1000.0, 1000.0, 10.0, 1000.0, 100.0)
        await _flush()
        await state.events.tick(now=3000.0)
        assert state.events.status_of(event_id)["status"] == "armed"
        assert ev._log_cursors[1][log.id] == 1

    async def test_status_of_reports_conditions_and_match(self, state):
        event_id = await state.events.create(
            "multi",
            set(),
            [
                events.MetricCondition(metric="mem", op="<=", threshold=10),
                events.LogCondition(pattern="WARN"),
            ],
            events.Action(kind="recording", duration_minutes=1),
            match="all",
        )
        st = state.events.status_of(event_id)
        assert st["match"] == "all"
        assert st["conditions"] == [
            {"type": "metric", "metric": "mem", "op": "<=", "threshold": 10},
            {"type": "log", "pattern": "WARN"},
        ]


async def test_list_ids(state):
    a = await state.events.create(
        "a",
        set(),
        [events.LogCondition(pattern="x")],
        events.Action(kind="recording", duration_minutes=1),
    )
    b = await state.events.create(
        "b",
        set(),
        [events.LogCondition(pattern="y")],
        events.Action(kind="recording", duration_minutes=1),
    )
    assert set(state.events.list_ids()) == {a, b}
