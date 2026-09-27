"""Unit tests for the variant's pure helpers and boundary parsers (no fakes, no graph)."""

from __future__ import annotations

import pytest
from langgraph.types import Interrupt
from org_agents.domain import ApprovalDecision, PositiveInt, TokenCount
from org_agents.parsing import ParseError

from generic_agent_deepagents.core.recursion import recursion_limit
from generic_agent_deepagents.core.usage import usage_from_totals
from generic_agent_deepagents.shell.middleware import parse_usage_metadata
from generic_agent_deepagents.shell.runner import hitl_resume, parse_hitl_interrupt


def test_cached_tokens_are_taken_out_of_the_input_total() -> None:
    usage = usage_from_totals(TokenCount(1_000), TokenCount(50), TokenCount(600), TokenCount(300))
    assert usage.input_tokens == TokenCount(100)
    assert usage.total == TokenCount(1_050)


def test_usage_metadata_is_parsed() -> None:
    raw = {
        "input_tokens": 1_000,
        "output_tokens": 50,
        "total_tokens": 1_050,
        "input_token_details": {"cache_read": 600, "cache_creation": 300},
    }
    usage = parse_usage_metadata(raw)
    assert (usage.input_tokens, usage.cache_read_tokens, usage.cache_write_tokens) == (
        TokenCount(100),
        TokenCount(600),
        TokenCount(300),
    )
    with pytest.raises(ParseError):
        parse_usage_metadata({"input_tokens": -1})


def test_recursion_limit_grows_with_turns_and_stays_far_below_the_default() -> None:
    assert recursion_limit(PositiveInt(12)).value == 140
    assert recursion_limit(PositiveInt(3)).value < recursion_limit(PositiveInt(4)).value


def test_hitl_interrupt_round_trip() -> None:
    value = {
        "action_requests": [{"name": "create_ticket", "args": {}, "description": "needs approval"}] * 2,
        "review_configs": [],
    }
    pending = parse_hitl_interrupt(Interrupt(value=value, id="abc123"))
    assert (pending.tool.value, pending.reason, pending.actions) == ("create_ticket", "needs approval", 2)
    resume = hitl_resume(pending, ApprovalDecision.REJECT).resume
    assert resume == {"abc123": {"decisions": [{"type": "reject", "message": "rejected by approver"}] * 2}}
    with pytest.raises(ParseError):
        parse_hitl_interrupt(Interrupt(value={"action_requests": []}, id="x"))
