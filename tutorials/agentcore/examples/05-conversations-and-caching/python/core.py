"""Pure logic: no AWS, no I/O, no clock. Easy to test and to read."""

from __future__ import annotations

from collections.abc import Sequence

from domain import CacheUsage, MainEvent, Message, ThreadEvent


def thread(events: Sequence[ThreadEvent], on_branch: bool) -> list[Message]:
    """The messages of one thread, oldest first.

    ListEvents returns every event of the session (newest first), or, when filtered by a branch,
    that branch plus the history it grew from. The main thread is the events with no branch.
    """
    kept = events if on_branch else [e for e in events if isinstance(e, MainEvent)]
    return [m for e in sorted(kept, key=lambda e: e.at) for m in e.messages]


def describe(usage: CacheUsage) -> str:
    """One line on how much of the prompt came from the cache."""
    total = usage.uncached + usage.cache_write + usage.cache_read
    share = 100 * usage.cache_read // total if total else 0
    return (
        f"input={usage.uncached} cache_write={usage.cache_write} "
        f"cache_read={usage.cache_read} ({share}% read from cache)"
    )
