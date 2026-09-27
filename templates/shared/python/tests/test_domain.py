from decimal import Decimal

import pytest

from org_agents.domain import Limits, ModelId, Prompt, ToolName, ToolPattern, ToolPolicy, Usd
from org_agents.parsing import ParseError

LIMITS_RAW = {
    "max_turns": 5,
    "max_total_tokens": 1000,
    "max_usd": "0.50",
    "max_wall_seconds": 60,
    "max_tool_calls": 10,
    "repeat_threshold": 3,
}


def test_usd_is_decimal_and_rejects_negative() -> None:
    assert Usd.parse("0.1", "$").amount == Decimal("0.100000")
    assert Usd.parse(0.1, "$").amount == Decimal("0.100000")  # float via repr, not binary expansion
    with pytest.raises(ParseError):
        Usd.parse("-1", "$")


def test_limits_parse_reports_path() -> None:
    bad = {**LIMITS_RAW, "max_turns": 0}
    with pytest.raises(ParseError) as err:
        Limits.parse(bad)
    assert err.value.path == "$.limits.max_turns"


def test_limits_parse_accepts_env_strings() -> None:
    limits = Limits.parse({**LIMITS_RAW, "max_turns": "7"})
    assert limits.max_turns.value == 7


def test_bool_is_not_a_count() -> None:
    with pytest.raises(ParseError):
        Limits.parse({**LIMITS_RAW, "max_turns": True})


def test_prompt_rejects_blank() -> None:
    with pytest.raises(ParseError):
        Prompt.parse("   ")


def test_tool_policy_parse_and_glob() -> None:
    policy = ToolPolicy.parse({"allowed": ["gw_*", "calculate"], "approval_required": ["gw_pay*"]})
    assert policy.allowed[0].matches(ToolName("gw_search"))
    assert not ToolPattern("calculate").matches(ToolName("calculator"))


def test_model_id_accepts_arn() -> None:
    arn = "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/abc123"
    assert ModelId.parse(arn).value == arn
