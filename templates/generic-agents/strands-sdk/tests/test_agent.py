"""End-to-end tests of the Strands agent with a scripted fake model (offline, no AWS)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import pytest
from fakes import ScriptedModel, ToolCall, Turn
from generic_tools.shell.backends import LocalCorpus, SqliteTicketStore
from generic_tools.shell.service import GenericTools
from org_agents.conversation import (
    Ack,
    Acknowledged,
    Answer,
    ApprovalRequested,
    Refused,
    Reply,
    RunFailed,
    RunHalted,
)
from org_agents.core.guard import StopReason
from org_agents.core.messages import ApprovalResponse, CancelRequest, ChatMessage, Idle, Incoming
from org_agents.domain import ApprovalDecision, MessageId, PrincipalId, Prompt, SessionId
from org_agents.identity import Caller, EmailAddress, HumanUser, PersonName, UserId
from org_agents.shell.audit import MemoryAuditSink, RunFailedEvent, RunFinishedEvent, RunStoppedEvent
from org_agents.shell.clock import FakeClock
from org_agents.shell.replies import render
from org_agents.shell.settings import Settings, load_settings

from generic_agent_strands.shell.runner import SessionRunner

ROOT = Path(__file__).resolve().parents[1]
ALICE = PrincipalId("auth0|alice")
LEAD = PrincipalId("auth0|service-desk-lead")


def settings(**env: str) -> Settings:
    return load_settings(env, ROOT)


def runner(
    turns: list[Turn], env: dict[str, str] | None = None, kill: bool = False
) -> tuple[SessionRunner, ScriptedModel, MemoryAuditSink, GenericTools]:
    model = ScriptedModel(turns)
    audit = MemoryAuditSink()
    tools = GenericTools(LocalCorpus(), SqliteTicketStore())
    r = SessionRunner(
        SessionId("thread-1"), settings(**(env or {})), model, tools, FakeClock(), audit, lambda: kill
    )
    return r, model, audit, tools


def person(subject: PrincipalId, user: str, email: str, given: str | None = None) -> HumanUser:
    name = PersonName(given) if given else None
    return HumanUser(UserId(user), subject, EmailAddress(email), name, None)


CALLERS: dict[PrincipalId, Caller] = {
    ALICE: person(ALICE, "usr_alice", "alice@example.com", "Alice"),
    LEAD: person(LEAD, "usr_lead", "lead@example.com"),
}


def send(r: SessionRunner, message: Incoming) -> Reply:
    return r.handle(message, CALLERS[message.sender])


def chat(text: str, mid: str = "m1", who: PrincipalId = ALICE) -> ChatMessage:
    return ChatMessage(MessageId(mid), who, Prompt(text))


def test_tool_use_and_answer() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "0.1 + 0.2"}),)),
            Turn(text="The result is 0.3."),
        ]
    )
    reply = send(r, chat("what is 0.1 + 0.2?"))
    assert reply == Answer(("The result is 0.3.",))
    tool_result = model.seen_messages[1][-1]["content"][0]["toolResult"]
    assert "0.1 + 0.2 = 0.3" in tool_result["content"][0]["text"]


def test_ticket_requires_four_eyes_approval_then_is_created_once() -> None:
    call = ToolCall(
        "create_ticket", {"title": "VPN broken", "description": "Cannot connect", "priority": "high"}
    )
    r, _, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="Ticket TCK-000001 created.")])
    reply = send(r, chat("please open a ticket, VPN is broken"))
    assert isinstance(reply, ApprovalRequested)
    assert reply.approvers == frozenset({LEAD})  # requester cannot self-approve

    self_approval = ApprovalResponse(MessageId("a1"), ALICE, reply.approval_id, ApprovalDecision.APPROVE)
    assert isinstance(send(r, self_approval), Refused)

    ok = ApprovalResponse(MessageId("a2"), LEAD, reply.approval_id, ApprovalDecision.APPROVE)
    assert send(r, ok) == Answer(("Ticket TCK-000001 created.",))
    assert "TCK-000001" in tools.get_ticket({"ticket_id": "TCK-000001"}).text


def test_rejected_approval_cancels_tool() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="The ticket was not created.")])
    reply = send(r, chat("open a ticket"))
    assert isinstance(reply, ApprovalRequested)
    send(r, ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.REJECT))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    result = model.seen_messages[-1][-1]["content"][0]["toolResult"]
    assert result["status"] == "error" and "rejected by approver" in result["content"][0]["text"]


def test_loop_detection_stops_the_run() -> None:
    same = ToolCall("search_knowledge", {"query": "vpn"})
    r, _, audit, _ = runner([Turn(tool_calls=(same,))] * 5 + [Turn(text="done")])
    reply = send(r, chat("find vpn docs"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.LOOP_DETECTED
    assert any(isinstance(e, RunStoppedEvent) for e in audit.events)


def test_budget_stops_the_run() -> None:
    expensive = Turn(
        tool_calls=(ToolCall("calculate", {"expression": "1+1"}),), input_tokens=100_000, output_tokens=0
    )  # $0.30 > $0.10, under the token limit
    r, _, _, _ = runner([expensive, Turn(text="never reached")], env={"AGENT_MAX_USD": "0.10"})
    reply = send(r, chat("add"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.BUDGET
    assert render(reply)["status"] == "stopped"


def test_kill_switch() -> None:
    r, model, _, _ = runner([Turn(text="hi")], kill=True)
    reply = send(r, chat("hello"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.KILL_SWITCH
    assert model.calls == 0


def test_denied_tool_is_blocked() -> None:
    r, _, _, _ = runner(
        [Turn(tool_calls=(ToolCall("delete_everything", {}),)), Turn(text="I cannot do that.")]
    )
    assert send(r, chat("delete everything")) == Answer(("I cannot do that.",))


def test_duplicate_and_cancel_idle() -> None:
    r, _, _, _ = runner([Turn(text="hello")])
    send(r, chat("hi", mid="m1"))
    assert send(r, chat("hi", mid="m1")) == Acknowledged(Ack.DUPLICATE)
    assert isinstance(send(r, CancelRequest(MessageId("c1"), ALICE)), Refused)


def test_steering_is_injected_before_next_model_call() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "2*3"}),)),
            Turn(text="6, and noted."),
        ]
    )
    # Simulate a message arriving mid-run: queue steering before the second model call.
    r._hooks.steer("also mention the unit")
    send(r, chat("what is 2*3?"))
    first_user = model.seen_messages[0][-1]["content"]
    assert any("also mention the unit" in block.get("text", "") for block in first_user)


def test_model_error_fails_the_run_and_the_thread_recovers() -> None:
    boom = RuntimeError("ThrottlingException: rate exceeded for key AKIAABCDEFGHIJKLMNOP")
    r, model, audit, _ = runner([Turn(error=boom), Turn(text="recovered")])
    reply = send(r, chat("hello", mid="m1"))
    assert isinstance(reply, RunFailed)
    rendered = render(reply)
    assert rendered["status"] == "failed" and "AKIA" not in str(rendered)
    assert isinstance(r.state.status, Idle)
    failed = [e for e in audit.events if isinstance(e, RunFailedEvent)]
    assert len(failed) == 1 and "AKIA" not in failed[0].error and "ThrottlingException" in failed[0].error
    assert isinstance(audit.events[-1], RunFinishedEvent)
    assert send(r, chat("again", mid="m2")) == Answer(("recovered",))
    # the failed prompt was rolled back, so the history alternates user/assistant cleanly
    assert [m["role"] for m in model.seen_messages[-1]] == ["user"]


def test_cancel_during_a_run_stops_it_as_cancelled() -> None:
    r, model, audit, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "1+1"}),)),
            Turn(text="never delivered"),
            Turn(text="fresh start"),
        ]
    )
    model.on_call = lambda n: send(r, CancelRequest(MessageId("c1"), ALICE)) if n == 1 else None
    reply = send(r, chat("add", mid="m1"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.CANCELLED
    assert render(reply)["reason"] == "cancelled"
    assert any(isinstance(e, RunStoppedEvent) for e in audit.events)
    assert send(r, chat("next", mid="m2")) == Answer(("fresh start",))


def test_cancel_while_awaiting_approval_returns_thread_to_idle() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, _, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="hello again")])
    assert isinstance(send(r, chat("open a ticket", mid="m1")), ApprovalRequested)
    assert send(r, CancelRequest(MessageId("c1"), ALICE)) == Acknowledged(Ack.CANCELLING)
    assert isinstance(r.state.status, Idle)
    assert send(r, chat("hi", mid="m2")) == Answer(("hello again",))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")


@pytest.mark.parametrize("payload", [{"prompt": ""}, {"nope": 1}, "text"])
def test_invalid_payloads_are_rejected_at_boundary(payload: object) -> None:
    from bedrock_agentcore.runtime.context import RequestContext

    from generic_agent_strands.shell.app import invoke

    ctx = RequestContext(session_id="thread-1-00000000000000000000000000", request_headers={}, request=None)
    assert invoke(payload, ctx)["status"] == "invalid_request"


def test_sliding_window_trim_is_audited() -> None:
    from strands import Agent

    from generic_agent_strands.shell.context import AuditedSlidingWindow

    trims: list[tuple[int, int]] = []
    model = ScriptedModel([Turn(text="one"), Turn(text="two")])
    agent = Agent(
        model=model,
        conversation_manager=AuditedSlidingWindow(2, lambda b, a: trims.append((b, a))),
        callback_handler=None,
    )
    agent("first")
    agent("second")
    assert trims and all(after < before for before, after in trims)


def test_ticket_records_the_requester_and_approvers_see_who_asked() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "Cannot connect"})
    r, _, audit, tools = runner([Turn(tool_calls=(call,)), Turn(text="Created.")])
    reply = send(r, chat("open a ticket"))
    assert isinstance(reply, ApprovalRequested)
    assert reply.requester == CALLERS[ALICE]
    rendered = render(reply)["requester"]
    assert rendered == {"kind": "user", "user_id": "usr_alice", "name": "Alice", "email": "alice@example.com"}

    send(r, ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.APPROVE))
    ticket = tools.get_ticket({"ticket_id": "TCK-000001"})
    assert "Alice <alice@example.com> (usr_alice)" in ticket.text
    assert "alice@example.com" not in repr(audit.events)  # PII stays out of the audit log


def test_model_is_told_the_first_name_once_per_speaker() -> None:
    r, model, _, _ = runner([Turn(text="Hi Alice."), Turn(text="Sure."), Turn(text="Hello.")])
    send(r, chat("hello", mid="m1"))
    send(r, chat("and again", mid="m2"))
    send(r, chat("lead here", mid="m3", who=LEAD))
    first = model.seen_messages[0][0]["content"][0]["text"]
    assert first == "[Context: you are assisting Alice.]\n\nhello"
    assert model.seen_messages[1][-1]["content"][0]["text"] == "and again"
    assert model.seen_messages[2][-1]["content"][0]["text"] == "lead here"  # no given name: no preamble
    assert "Alice" not in (r._agent.system_prompt or "")


def _jwt(claims: Mapping[str, object]) -> dict[str, str]:
    import base64
    import json

    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return {"Authorization": f"Bearer e30.{body}.sig"}


def test_callers_come_from_token_claims_and_keep_their_user_id() -> None:
    from bedrock_agentcore.runtime.context import RequestContext

    from generic_agent_strands.shell.app import invoke, registry

    ns = "https://fintech.example/"
    old = {"sub": "auth0|bob", f"{ns}email": "bob@old.example", f"{ns}given_name": "Bob"}
    first = registry().identity.resolve(_jwt(old))
    second = registry().identity.resolve(_jwt({**old, f"{ns}email": "bob@new.example"}))
    assert isinstance(first, HumanUser) and isinstance(second, HumanUser)
    assert first.user_id == second.user_id and second.email.value == "bob@new.example"

    ctx = RequestContext(
        session_id="thread-2-00000000000000000000000000",
        request_headers=_jwt({"sub": "auth0|carol"}),  # no email claim
        request=None,
    )
    reply = invoke({"prompt": "hi"}, ctx)
    assert reply["status"] == "invalid_request" and "email" in str(reply["path"])
