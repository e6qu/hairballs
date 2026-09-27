"""Clocks: the core never reads time itself; the shell passes ``Instant`` values in."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Protocol

from org_agents.domain import Instant


class Clock(Protocol):
    def now(self) -> Instant: ...


class SystemClock:
    def now(self) -> Instant:
        return Instant(datetime.now(UTC))


class FakeClock:
    """A controllable clock for tests."""

    def __init__(self, start: datetime | None = None) -> None:
        self._now = start or datetime(2026, 1, 1, tzinfo=UTC)

    def now(self) -> Instant:
        return Instant(self._now)

    def advance(self, delta: timedelta) -> None:
        self._now += delta
