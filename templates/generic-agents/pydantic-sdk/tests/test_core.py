"""Unit tests of the pure helpers (no framework, no fakes)."""

from __future__ import annotations

import pytest
from org_agents.core.guard import StopReason
from org_agents.domain import TokenCount

from generic_agent_pydantic.core.usage import disjoint_usage, stop_for_usage_limit


def test_inclusive_input_is_split_into_disjoint_buckets() -> None:
    usage = disjoint_usage(1000, 50, cache_read=600, cache_write=300)
    assert usage.input_tokens == TokenCount(100)
    assert usage.cache_read_tokens == TokenCount(600)
    assert usage.cache_write_tokens == TokenCount(300)
    assert usage.total == TokenCount(1050)


def test_inconsistent_counts_clamp_to_zero() -> None:
    assert disjoint_usage(10, -1, cache_read=20, cache_write=0).input_tokens == TokenCount(0)


@pytest.mark.parametrize(
    ("message", "reason"),
    [
        ("The next request would exceed the request_limit of 12", StopReason.TURN_LIMIT),
        (
            "The next tool call(s) would exceed the tool_calls_limit of 2 (tool_calls=3).",
            StopReason.TOOL_CALL_LIMIT,
        ),
        ("Exceeded the total_tokens_limit of 200000 (total_tokens=210000)", StopReason.TOKEN_LIMIT),
        ("Exceeded the `cost_limit` of 1", StopReason.BUDGET),
        ("something new", StopReason.TOKEN_LIMIT),
    ],
)
def test_usage_limit_messages_map_to_stop_reasons(message: str, reason: StopReason) -> None:
    stop = stop_for_usage_limit(f"{message}. Consider raising the limit")
    assert stop.reason is reason
    assert "Consider" not in stop.detail
