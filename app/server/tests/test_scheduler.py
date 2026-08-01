"""Tests for scheduler.py."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

import scheduler as scheduler_mod
import server


def ms(y, mo, d, h=0, mi=0, s=0, us=0, tz=UTC):
    return datetime(y, mo, d, h, mi, s, us, tz).timestamp() * 1000.0


@pytest.fixture
def state(tmp_path):
    tdir = tmp_path / "transforms"
    tdir.mkdir()
    return server.State(tdir)


class TestSchedulerValidation:
    def test_requires_exactly_one_of_start_at_or_cron(self, state):
        with pytest.raises(scheduler_mod.InvalidSchedule):
            state.scheduler.create(duration_minutes=5)
        with pytest.raises(scheduler_mod.InvalidSchedule):
            state.scheduler.create(duration_minutes=5, start_at=1000, cron="* * * * *")

    def test_bad_cron_expression_raises(self, state):
        with pytest.raises(scheduler_mod.InvalidSchedule):
            state.scheduler.create(duration_minutes=5, cron="not a cron expression")

    def test_status_of_unknown_raises(self, state):
        with pytest.raises(scheduler_mod.UnknownSchedule):
            state.scheduler.status_of("nope")

    def test_cancel_unknown_raises(self, state):
        with pytest.raises(scheduler_mod.UnknownSchedule):
            state.scheduler.cancel("nope")


class TestSchedulerTickResilience:
    def test_one_failing_schedule_does_not_raise_or_block_others(self, state, monkeypatch):
        # br-ORCH-004: an exception firing one schedule must not kill the
        # tick (and, transitively, all future orchestration ticks).
        good_id = state.scheduler.create(duration_minutes=1, start_at=1000)
        bad_id = state.scheduler.create(duration_minutes=1, start_at=1000)

        orig_fire = scheduler_mod.Scheduler._fire

        def flaky_fire(self, sch):
            if sch.id == bad_id:
                raise RuntimeError("boom")
            return orig_fire(self, sch)

        monkeypatch.setattr(scheduler_mod.Scheduler, "_fire", flaky_fire)

        state.scheduler.tick(now=2000)  # must not raise

        assert state.scheduler.status_of(good_id)["done"] is True
        assert len(state.scheduler.status_of(good_id)["session_ids"]) == 1
        # advanced despite the failure, so it isn't retried forever every tick
        assert state.scheduler.status_of(bad_id)["done"] is True
        assert state.scheduler.status_of(bad_id)["session_ids"] == []


class TestOneShotSchedule:
    def test_fires_once_at_start_at(self, state, monkeypatch):
        monkeypatch.setattr(
            scheduler_mod.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        start_at = ms(2026, 1, 2, 3, 0, 30)
        schedule_id = state.scheduler.create(duration_minutes=1, start_at=start_at)

        state.scheduler.tick(now=ms(2026, 1, 2, 3, 0, 20))
        st = state.scheduler.status_of(schedule_id)
        assert st["done"] is False and st["session_ids"] == []

        state.scheduler.tick(now=ms(2026, 1, 2, 3, 0, 31))
        st = state.scheduler.status_of(schedule_id)
        assert st["done"] is True and len(st["session_ids"]) == 1

        session_id = st["session_ids"][0]
        assert state.recording_sessions.status_of(session_id)["status"] == "running"

    def test_does_not_refire_once_done(self, state):
        schedule_id = state.scheduler.create(duration_minutes=1, start_at=1000)
        state.scheduler.tick(now=2000)
        state.scheduler.tick(now=3000)
        assert len(state.scheduler.status_of(schedule_id)["session_ids"]) == 1

    def test_passes_safe_and_max_keep_seconds_to_session(self, state):
        schedule_id = state.scheduler.create(
            duration_minutes=1, start_at=1000, safe=True, max_keep_seconds=7200
        )
        state.scheduler.tick(now=2000)
        session_id = state.scheduler.status_of(schedule_id)["session_ids"][0]
        assert state.recording_sessions.status_of(session_id)["safe"] is True

    def test_cancel_prevents_future_firing(self, state):
        schedule_id = state.scheduler.create(duration_minutes=1, start_at=1000)
        state.scheduler.cancel(schedule_id)
        state.scheduler.tick(now=2000)
        with pytest.raises(scheduler_mod.UnknownSchedule):
            state.scheduler.status_of(schedule_id)


class TestRecurringSchedule:
    def test_fires_repeatedly_on_cron_matches(self, state, monkeypatch):
        # "* * * * *" fires every minute
        monkeypatch.setattr(
            scheduler_mod.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        schedule_id = state.scheduler.create(duration_minutes=1, cron="* * * * *")
        state.scheduler.tick(now=ms(2026, 1, 2, 3, 1, 30))
        assert len(state.scheduler.status_of(schedule_id)["session_ids"]) == 1
        state.scheduler.tick(now=ms(2026, 1, 2, 3, 3, 30))
        # br-SCHED-004: fires at most once per tick even though two minute
        # boundaries (3:02, 3:03) were missed -- one more session, not two.
        assert len(state.scheduler.status_of(schedule_id)["session_ids"]) == 2
        # next_fire was fast-forwarded past 3:03 too (not just 3:02), so the
        # very next tick, one more minute on, fires normally again rather
        # than looking like yet another catch-up.
        state.scheduler.tick(now=ms(2026, 1, 2, 3, 4, 30))
        assert len(state.scheduler.status_of(schedule_id)["session_ids"]) == 3

    def test_long_stall_fires_at_most_once_and_fast_forwards_next_fire(self, state, monkeypatch):
        # br-SCHED-004: a gateway suspended/stalled for an hour on
        # "* * * * *" used to fire ~60 back-dated sessions in one
        # synchronous tick, all recording the same "now" window (start() has
        # no notion of a historical start time). tick() must fire at most
        # once per schedule per tick and fast-forward next_fire past the
        # rest of the backlog instead of leaving it stuck in the past.
        monkeypatch.setattr(
            scheduler_mod.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        schedule_id = state.scheduler.create(duration_minutes=1, cron="* * * * *")
        state.scheduler.tick(now=ms(2026, 1, 2, 3, 0, 30))  # first boundary (3:01) hasn't hit yet
        assert len(state.scheduler.status_of(schedule_id)["session_ids"]) == 0

        # simulate an hour-long stall/suspend: ~60 missed minute boundaries
        state.scheduler.tick(now=ms(2026, 1, 2, 4, 0, 30))
        assert len(state.scheduler.status_of(schedule_id)["session_ids"]) == 1, (
            "must fire once for the whole backlog, not once per missed minute"
        )

        # a normal tick a minute later fires again as usual -- proof
        # next_fire was actually fast-forwarded to the present rather than
        # left in the past, which would otherwise make every future tick
        # look like another catch-up burst forever.
        state.scheduler.tick(now=ms(2026, 1, 2, 4, 1, 30))
        assert len(state.scheduler.status_of(schedule_id)["session_ids"]) == 2

    def test_recurring_schedule_never_marks_done(self, state, monkeypatch):
        monkeypatch.setattr(
            scheduler_mod.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        schedule_id = state.scheduler.create(duration_minutes=1, cron="* * * * *")
        state.scheduler.tick(now=ms(2026, 1, 2, 3, 5, 0))
        assert state.scheduler.status_of(schedule_id)["done"] is False
