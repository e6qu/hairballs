"""Core unit tests (pure: no fakes, no framework)."""

from __future__ import annotations

from pathlib import Path

import pytest
from org_agents.domain import TokenCount, Usage
from org_agents.parsing import ParseError
from org_agents.shell.settings import load_settings

from generic_agent_langgraph.core.recursion import recursion_limit
from generic_agent_langgraph.core.usage import parse_usage_metadata

ROOT = Path(__file__).resolve().parents[1]


def test_usage_subtracts_cached_tokens_from_langchain_input_total() -> None:
    raw = {
        "input_tokens": 1_000,
        "output_tokens": 50,
        "total_tokens": 1_050,
        "input_token_details": {"cache_read": 600, "cache_creation": 100},
    }
    assert parse_usage_metadata(raw) == Usage(
        TokenCount(300), TokenCount(50), TokenCount(600), TokenCount(100)
    )


def test_usage_counts_per_ttl_cache_writes() -> None:
    raw = {
        "input_tokens": 500,
        "output_tokens": 1,
        "input_token_details": {"cache_read": 0, "cache_creation": 0, "ephemeral_1h_input_tokens": 200},
    }
    assert parse_usage_metadata(raw).cache_write_tokens == TokenCount(200)


def test_usage_without_details() -> None:
    assert parse_usage_metadata({"input_tokens": 7, "output_tokens": 3}) == Usage(
        TokenCount(7), TokenCount(3)
    )


@pytest.mark.parametrize(
    "raw",
    [
        "nope",
        {"input_tokens": -1, "output_tokens": 0},
        {"input_tokens": 10, "output_tokens": 0, "input_token_details": {"cache_read": 20}},
    ],
)
def test_usage_rejects_bad_metadata(raw: object) -> None:
    with pytest.raises(ParseError):
        parse_usage_metadata(raw)


def test_recursion_limit_is_derived_from_max_turns() -> None:
    limits = load_settings({}, ROOT).agent.limits  # max_turns = 12
    assert recursion_limit(limits) == 53
    assert recursion_limit(limits) < 10_007
