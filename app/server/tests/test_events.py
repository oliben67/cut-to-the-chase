"""Tests for events.py."""

from __future__ import annotations

from pathlib import Path

import pytest

import events
import server


@pytest.fixture
def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    return server.State(tdir)


def stats_source(sid="s1"):
    return server.StatsSource(sid, "stats", Path("/nonexistent"), live=False)


def log_source(sid="s2"):
    return server.LogSource(sid, "log", Path("/nonexistent"), live=False, transforms=[])


class TestEventValidation:
    def test_unknown_metric_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            state.events.create(
                "x",
                set(),
                [events.MetricCondition(metric="disk", op=">", threshold=1)],
                events.Action(kind="snapshot", minutes=5),
            )

    def test_unknown_op_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            state.events.create(
                "x",
                set(),
                [events.MetricCondition(metric="cpu", op="!=", threshold=1)],
                events.Action(kind="snapshot", minutes=5),
            )

    def test_invalid_regex_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            state.events.create(
                "x",
                set(),
                [events.LogCondition(pattern="[")],
                events.Action(kind="snapshot", minutes=5),
            )

    def test_snapshot_action_requires_minutes(self, state):
        with pytest.raises(events.InvalidEvent):
            state.events.create(
                "x", set(), [events.LogCondition(pattern="ERROR")], events.Action(kind="snapshot")
            )

    def test_recording_action_requires_duration(self, state):
        with pytest.raises(events.InvalidEvent):
            state.events.create(
                "x", set(), [events.LogCondition(pattern="ERROR")], events.Action(kind="recording")
            )

    def test_unknown_action_kind_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            state.events.create(
                "x", set(), [events.LogCondition(pattern="ERROR")], events.Action(kind="bogus")
            )

    def test_unknown_event_operations_raise(self, state):
        with pytest.raises(events.UnknownEvent):
            state.events.status_of("nope")
        with pytest.raises(events.UnknownEvent):
            state.events.enable("nope")
        with pytest.raises(events.UnknownEvent):
            state.events.disable("nope")
        with pytest.raises(events.UnknownEvent):
            state.events.reset("nope")
        with pytest.raises(events.UnknownEvent):
            state.events.cancel("nope")


class TestMetricEvents:
    def test_snapshot_action_starts_a_rolling_buffer_for_its_sources(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        ev = state.events._events[event_id]
        assert ev.buffer_id is not None
        assert ev.buffer_id in state.rolling_buffers._buffers

    def test_tick_fires_snapshot_when_threshold_crossed(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 50.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

        src.ingest_row("api", 3000.0, 90.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=4000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert st["artifact_id"] is not None
        assert "cpu=90.0" in st["trigger_detail"]

        data = state.recording_sessions.download(st["artifact_id"])
        assert data[:2] == b"PK"  # zip magic

    def test_does_not_refire_while_condition_stays_true(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=2000.0)
        first_artifact = state.events.status_of(event_id)["artifact_id"]
        assert state.events.status_of(event_id)["trigger_count"] == 1

        state.events.tick(now=3000.0)  # still 90 -- edge-trigger latch stays closed
        st = state.events.status_of(event_id)
        assert st["artifact_id"] == first_artifact
        assert st["trigger_count"] == 1

    def test_reset_forces_an_immediate_refire_without_the_condition_clearing(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=2000.0)
        first_artifact = state.events.status_of(event_id)["artifact_id"]

        state.events.reset(event_id)
        assert state.events.status_of(event_id)["status"] == "armed"
        state.events.tick(now=4000.0)  # still 90, but reset() re-armed the latch
        st = state.events.status_of(event_id)
        assert st["artifact_id"] != first_artifact
        assert st["trigger_count"] == 2

    def test_keeps_watching_and_refires_once_condition_clears_and_returns(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["trigger_count"] == 1

        src.ingest_row("api", 3000.0, 50.0, 10.0, 1000.0, 100.0)  # condition clears
        state.events.tick(now=4000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "armed"
        assert st["trigger_count"] == 1  # unchanged -- no re-trigger merely from clearing

        src.ingest_row("api", 5000.0, 95.0, 10.0, 1000.0, 100.0)  # condition met again
        state.events.tick(now=6000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert st["trigger_count"] == 2  # keeps watching -- no reset() needed

    def test_disabling_is_the_only_thing_that_stops_watching(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        state.events.disable(event_id)
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["trigger_count"] == 0

    def test_disabled_event_is_not_evaluated(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        state.events.disable(event_id)
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

        state.events.enable(event_id)
        state.events.tick(now=3000.0)
        assert state.events.status_of(event_id)["status"] == "triggered"

    def test_only_the_latest_sample_is_checked(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 95.0, 10.0, 1000.0, 100.0)  # breach, but stale
        src.ingest_row("api", 2000.0, 50.0, 10.0, 1000.0, 100.0)  # latest: no breach
        state.events.tick(now=3000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

    def test_empty_source_ids_monitors_every_open_source(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            set(),
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        src.ingest_row("api", 1000.0, 90.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "triggered"

    def test_recording_action_starts_a_forward_recording_session(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">=", threshold=80)],
            events.Action(kind="recording", duration_minutes=5),
        )
        src.ingest_row("api", 1000.0, 80.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=2000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert state.recording_sessions.status_of(st["artifact_id"])["status"] == "running"


class TestLogEvents:
    def test_tick_fires_on_regex_match_in_new_rows(self, state):
        src = log_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "errors",
            {src.id},
            [events.LogCondition(pattern=r"ERROR")],
            events.Action(kind="snapshot", minutes=5),
        )
        src.rows.append((1000.0, 0, "u1", "all good"))
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

        src.rows.append((3000.0, 1, "u2", "ERROR: disk full"))
        state.events.tick(now=4000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert "ERROR: disk full" in st["trigger_detail"]

    def test_only_new_rows_since_last_check_are_scanned(self, state):
        src = log_source()
        state.sources[src.id] = src
        src.rows.append((1000.0, 0, "u1", "ERROR: boom"))
        event_id = state.events.create(
            "errors",
            {src.id},
            [events.LogCondition(pattern=r"ERROR")],
            events.Action(kind="snapshot", minutes=5),
        )
        # the matching row was already there *before* the event was created --
        # only rows appended after creation should ever be scanned
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"


class TestUpdate:
    def test_update_unknown_event_raises(self, state):
        with pytest.raises(events.UnknownEvent):
            state.events.update("nope", name="x")

    def test_update_name_only_leaves_everything_else(self, state):
        event_id = state.events.create(
            "old name",
            set(),
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="recording", duration_minutes=5),
        )
        state.events.update(event_id, name="new name")
        st = state.events.status_of(event_id)
        assert st["name"] == "new name"
        assert st["conditions"] == [{"type": "metric", "metric": "cpu", "op": ">", "threshold": 80}]
        assert st["action"]["duration_minutes"] == 5

    def test_update_rejects_invalid_conditions(self, state):
        event_id = state.events.create(
            "x", set(), [events.LogCondition(pattern="ERROR")], events.Action(kind="recording", duration_minutes=1)
        )
        with pytest.raises(events.InvalidEvent):
            state.events.update(event_id, conditions=[events.LogCondition(pattern="[")])
        # unchanged after the rejected update
        assert state.events.status_of(event_id)["conditions"] == [{"type": "log", "pattern": "ERROR"}]

    def test_update_conditions_reseeds_log_cursors(self, state):
        log = log_source()
        state.sources[log.id] = log
        log.rows.append((1000.0, 0, "u1", "old backlog"))
        event_id = state.events.create(
            "x", {log.id}, [events.MetricCondition(metric="cpu", op=">", threshold=999)],
            events.Action(kind="recording", duration_minutes=1),
        )
        # switching to a log condition now -- the pre-existing backlog line
        # must not count as a fresh match once the condition becomes log-based
        state.events.update(event_id, conditions=[events.LogCondition(pattern="backlog")])
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["trigger_count"] == 0

    def test_update_action_from_snapshot_to_recording_stops_the_buffer(self, state):
        event_id = state.events.create(
            "x", set(), [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        buffer_id = state.events._events[event_id].buffer_id
        assert buffer_id in state.rolling_buffers._buffers
        state.events.update(event_id, action=events.Action(kind="recording", duration_minutes=5))
        assert buffer_id not in state.rolling_buffers._buffers
        assert state.events._events[event_id].buffer_id is None

    def test_update_action_from_recording_to_snapshot_starts_a_buffer(self, state):
        event_id = state.events.create(
            "x", set(), [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="recording", duration_minutes=5),
        )
        assert state.events._events[event_id].buffer_id is None
        state.events.update(event_id, action=events.Action(kind="snapshot", minutes=10))
        new_buffer_id = state.events._events[event_id].buffer_id
        assert new_buffer_id is not None
        assert new_buffer_id in state.rolling_buffers._buffers

    def test_update_source_ids_restarts_the_snapshot_buffer(self, state):
        src1 = stats_source("s1")
        src2 = stats_source("s2")
        state.sources[src1.id] = src1
        state.sources[src2.id] = src2
        event_id = state.events.create(
            "x", {"s1"}, [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        old_buffer_id = state.events._events[event_id].buffer_id
        state.events.update(event_id, source_ids={"s2"})
        new_buffer_id = state.events._events[event_id].buffer_id
        assert new_buffer_id != old_buffer_id
        assert old_buffer_id not in state.rolling_buffers._buffers
        assert state.rolling_buffers._buffers[new_buffer_id]["source_ids"] == {"s2"}

    def test_update_unrelated_field_does_not_restart_snapshot_buffer(self, state):
        event_id = state.events.create(
            "x", {"s1"}, [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        old_buffer_id = state.events._events[event_id].buffer_id
        state.events.update(event_id, name="renamed")
        assert state.events._events[event_id].buffer_id == old_buffer_id


class TestCancel:
    def test_cancel_removes_event_and_its_buffer(self, state):
        src = stats_source()
        state.sources[src.id] = src
        event_id = state.events.create(
            "cpu high",
            {src.id},
            [events.MetricCondition(metric="cpu", op=">", threshold=80)],
            events.Action(kind="snapshot", minutes=5),
        )
        buffer_id = state.events._events[event_id].buffer_id
        state.events.cancel(event_id)
        assert buffer_id not in state.rolling_buffers._buffers
        with pytest.raises(events.UnknownEvent):
            state.events.status_of(event_id)

    def test_cancel_of_a_recording_event_has_no_buffer_to_stop(self, state):
        event_id = state.events.create(
            "errors",
            set(),
            [events.LogCondition(pattern="ERROR")],
            events.Action(kind="recording", duration_minutes=5),
        )
        state.events.cancel(event_id)  # must not raise despite buffer_id being None
        with pytest.raises(events.UnknownEvent):
            state.events.status_of(event_id)


class TestMultipleConditions:
    def test_requires_at_least_one_condition(self, state):
        with pytest.raises(events.InvalidEvent):
            state.events.create("x", set(), [], events.Action(kind="snapshot", minutes=5))

    def test_invalid_match_raises(self, state):
        with pytest.raises(events.InvalidEvent):
            state.events.create(
                "x",
                set(),
                [events.MetricCondition(metric="cpu", op=">", threshold=1)],
                events.Action(kind="snapshot", minutes=5),
                match="whatever",
            )

    def test_default_match_any_fires_on_first_condition_met(self, state):
        src = stats_source()
        log = log_source()
        state.sources[src.id] = src
        state.sources[log.id] = log
        event_id = state.events.create(
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
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "triggered"

    def test_match_all_requires_every_condition(self, state):
        src = stats_source()
        log = log_source()
        state.sources[src.id] = src
        state.sources[log.id] = log
        event_id = state.events.create(
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
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"

        log.rows.append((3000.0, 0, "u1", "ERROR: disk full"))  # now both are met
        state.events.tick(now=4000.0)
        st = state.events.status_of(event_id)
        assert st["status"] == "triggered"
        assert "cpu=90.0" in st["trigger_detail"]
        assert "ERROR: disk full" in st["trigger_detail"]

    def test_log_cursor_advances_even_when_match_all_never_fires(self, state):
        src = stats_source()
        log = log_source()
        state.sources[src.id] = src
        state.sources[log.id] = log
        event_id = state.events.create(
            "multi",
            {src.id, log.id},
            [
                events.MetricCondition(metric="cpu", op=">", threshold=999),  # never met
                events.LogCondition(pattern="ERROR"),
            ],
            events.Action(kind="snapshot", minutes=5),
            match="all",
        )
        log.rows.append((1000.0, 0, "u1", "ERROR: boom"))
        state.events.tick(now=2000.0)
        assert state.events.status_of(event_id)["status"] == "armed"
        # that ERROR row must not still be "new" on a later tick, now that
        # the metric condition is finally also met
        ev = state.events._events[event_id]
        src.ingest_row("api", 1000.0, 1000.0, 10.0, 1000.0, 100.0)
        state.events.tick(now=3000.0)
        assert state.events.status_of(event_id)["status"] == "armed"
        assert ev._log_cursors[1][log.id] == 1

    def test_status_of_reports_conditions_and_match(self, state):
        event_id = state.events.create(
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


def test_list_ids(state):
    a = state.events.create(
        "a", set(), [events.LogCondition(pattern="x")], events.Action(kind="recording", duration_minutes=1)
    )
    b = state.events.create(
        "b", set(), [events.LogCondition(pattern="y")], events.Action(kind="recording", duration_minutes=1)
    )
    assert set(state.events.list_ids()) == {a, b}
