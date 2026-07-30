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
        # two more minute boundaries (3:02, 3:03) should have fired
        assert len(state.scheduler.status_of(schedule_id)["session_ids"]) == 3

    def test_recurring_schedule_never_marks_done(self, state, monkeypatch):
        monkeypatch.setattr(
            scheduler_mod.time, "time", lambda: ms(2026, 1, 2, 3, 0, 0) / 1000.0
        )
        schedule_id = state.scheduler.create(duration_minutes=1, cron="* * * * *")
        state.scheduler.tick(now=ms(2026, 1, 2, 3, 5, 0))
        assert state.scheduler.status_of(schedule_id)["done"] is False
