import base64
import json
from datetime import timedelta
from decimal import Decimal

import pytest

from org_agents.core.guard import StopReason, StopRun
from org_agents.core.messages import ApprovalResponse, CancelRequest, ChatMessage
from org_agents.domain import SessionId, TokenCount, ToolName, Usage
from org_agents.parsing import ParseError
from org_agents.shell.audit import MemoryAuditSink, RunStoppedEvent, render
from org_agents.shell.clock import FakeClock
from org_agents.shell.config import parse_agent_config
from org_agents.shell.invocation import LOCAL_PRINCIPAL, parse_incoming, principal_from_headers
from org_agents.shell.run_guard import BlockTool, Proceed, RequireApproval, RunGuard

CONFIG = {
    "agent": {"name": "demo", "busy_policy": "steer"},
    "model": {
        "id": "global.anthropic.claude-sonnet-4-6",
        "region": "eu-west-1",
        "price": {
            "input_per_mtok": 3,
            "output_per_mtok": 15,
            "cache_read_per_mtok": "0.3",
            "cache_write_per_mtok": "3.75",
        },
    },
    "limits": {
        "max_turns": 10,
        "max_total_tokens": 100000,
        "max_usd": "1.00",
        "max_wall_seconds": 300,
        "max_tool_calls": 3,
        "repeat_threshold": 3,
    },
    "tools": {"allowed": ["calculate", "create_ticket"], "approval_required": ["create_ticket"]},
}


def test_config_env_override() -> None:
    cfg = parse_agent_config(CONFIG, {"AGENT_MAX_USD": "0.25", "AWS_REGION": "us-east-1"})
    assert cfg.limits.max_usd.amount == Decimal("0.25")
    assert cfg.region.value == "us-east-1"


def test_config_error_path() -> None:
    bad = {**CONFIG, "model": {**CONFIG["model"], "region": "moon-1"}}  # type: ignore[dict-item]
    with pytest.raises(ParseError) as err:
        parse_agent_config(bad, {})
    assert err.value.path == "$.model.region"


def test_run_guard_flow() -> None:
    cfg = parse_agent_config(CONFIG, {})
    clock, audit = FakeClock(), MemoryAuditSink()
    guard = RunGuard(SessionId("s1"), cfg.limits, cfg.price, cfg.tools, clock, audit)
    guard.before_model_call()
    assert guard.before_tool_call(ToolName("calculate"), {"expression": "1+1"}) == Proceed()
    assert isinstance(guard.before_tool_call(ToolName("create_ticket"), {"title": "x"}), RequireApproval)
    assert isinstance(guard.before_tool_call(ToolName("rm_rf"), {}), BlockTool)
    guard.after_model_call(Usage(TokenCount(100), TokenCount(10)))
    clock.advance(timedelta(minutes=10))
    decision = guard.before_model_call()
    assert isinstance(decision, StopRun) and decision.reason is StopReason.WALL_CLOCK
    stops = [e for e in audit.events if isinstance(e, RunStoppedEvent)]
    assert len(stops) == 1
    assert render(stops[0])["reason"] == "wall_clock"


def _jwt(claims: dict[str, object]) -> str:
    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{body}.sig"


def test_principal_and_incoming() -> None:
    assert principal_from_headers({}) == LOCAL_PRINCIPAL
    user = principal_from_headers({"Authorization": f"Bearer {_jwt({'sub': 'auth0|123'})}"})
    assert user.value == "auth0|123"
    m2m = principal_from_headers({"authorization": f"Bearer {_jwt({'sub': 'abc@clients'})}"})
    assert m2m.value == "abc@clients"
    with pytest.raises(ParseError):
        principal_from_headers({"Authorization": "Bearer not-a-jwt"})


def test_parse_incoming_variants() -> None:
    who = LOCAL_PRINCIPAL
    assert isinstance(parse_incoming({"prompt": "hi"}, who), ChatMessage)
    assert isinstance(parse_incoming({"cancel": True, "message_id": "m1"}, who), CancelRequest)
    assert isinstance(
        parse_incoming({"approval": {"id": "ap1", "decision": "approve"}}, who), ApprovalResponse
    )
    with pytest.raises(ParseError):
        parse_incoming({"prompt": 3}, who)
