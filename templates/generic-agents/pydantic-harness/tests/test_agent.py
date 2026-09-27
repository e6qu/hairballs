"""End-to-end tests of the generic agent on the org Pydantic AI harness (offline, no AWS).

The model is Pydantic AI's ``FunctionModel`` driven by a script (``tests/fakes.py``).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fakes import ScriptedModel, ToolCall, Turn, tool_returns, user_texts
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
from org_agents.core.messages import ApprovalResponse, CancelRequest, ChatMessage, Idle
from org_agents.domain import ApprovalDecision, MessageId, PrincipalId, Prompt, SessionId
from org_agents.shell.audit import MemoryAuditSink, RunFailedEvent, RunFinishedEvent, RunStoppedEvent
from org_agents.shell.clock import FakeClock
from org_agents.shell.replies import render
from org_agents.shell.settings import load_settings
from org_pydantic_harness.shell import (
    Harness,
    JsonFileSessionStore,
    SessionStore,
    create_harness,
    load_context_policy,
)
from org_pydantic_harness.shell.steering import STEER_PREFIX

from generic_agent_pydantic_harness.shell.tools import build_tools

ROOT = Path(__file__).resolve().parents[1]
ALICE = PrincipalId("auth0|alice")
LEAD = PrincipalId("auth0|service-desk-lead")


def runner(
    turns: list[Turn],
    env: dict[str, str] | None = None,
    kill: bool = False,
    store: SessionStore | None = None,
    tools: GenericTools | None = None,
) -> tuple[Harness, ScriptedModel, MemoryAuditSink, GenericTools]:
    model = ScriptedModel(turns)
    audit = MemoryAuditSink()
    service = tools or GenericTools(LocalCorpus(), SqliteTicketStore())
    harness = create_harness(
        load_settings(env or {}, ROOT),
        build_tools(service),
        model.model,
        session=SessionId("thread-1"),
        clock=FakeClock(),
        audit=audit,
        kill_switch=lambda: kill,
        store=store,
        context=load_context_policy({}, ROOT),
    )
    return harness, model, audit, service


def chat(text: str, mid: str = "m1", who: PrincipalId = ALICE) -> ChatMessage:
    return ChatMessage(MessageId(mid), who, Prompt(text))


TICKET = ToolCall(
    "create_ticket", {"title": "VPN broken", "description": "Cannot connect", "priority": "high"}
)


def test_tool_use_and_answer() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "0.1 + 0.2"}),)),
            Turn(text="The result is 0.3."),
        ]
    )
    assert r.handle(chat("what is 0.1 + 0.2?")) == Answer(("The result is 0.3.",))
    assert "0.1 + 0.2 = 0.3" in str(tool_returns(model.seen[1])[-1].content)


def test_ticket_requires_four_eyes_approval_then_is_created_once() -> None:
    r, _, _, tools = runner([Turn(tool_calls=(TICKET,)), Turn(text="Ticket TCK-000001 created.")])
    reply = r.handle(chat("please open a ticket, VPN is broken"))
    assert isinstance(reply, ApprovalRequested)
    assert reply.approvers == frozenset({LEAD})  # requester cannot self-approve

    self_approval = ApprovalResponse(MessageId("a1"), ALICE, reply.approval_id, ApprovalDecision.APPROVE)
    assert isinstance(r.handle(self_approval), Refused)

    ok = ApprovalResponse(MessageId("a2"), LEAD, reply.approval_id, ApprovalDecision.APPROVE)
    assert r.handle(ok) == Answer(("Ticket TCK-000001 created.",))
    ticket = tools.get_ticket({"ticket_id": "TCK-000001"}).text
    assert "requested by auth0|alice" in ticket
    assert tools.get_ticket({"ticket_id": "TCK-000002"}).text.endswith("not found")  # exactly once


def test_rejected_approval_cancels_tool() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="The ticket was not created.")])
    reply = r.handle(chat("open a ticket"))
    assert isinstance(reply, ApprovalRequested)
    r.handle(ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.REJECT))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    result = tool_returns(model.seen[-1])[-1]
    assert result.outcome == "denied" and result.content == "rejected by approver"


def test_approval_survives_a_restart(tmp_path: Path) -> None:
    store = JsonFileSessionStore(tmp_path)
    tickets = GenericTools(LocalCorpus(), SqliteTicketStore())
    first, _, _, _ = runner([Turn(tool_calls=(TICKET,))], store=store, tools=tickets)
    reply = first.handle(chat("open a ticket"))
    assert isinstance(reply, ApprovalRequested)
    second, _, _, _ = runner([Turn(text="Created after restart.")], store=store, tools=tickets)
    ok = ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.APPROVE)
    assert second.handle(ok) == Answer(("Created after restart.",))
    assert "TCK-000001" in tickets.get_ticket({"ticket_id": "TCK-000001"}).text


def test_loop_detection_stops_the_run() -> None:
    same = ToolCall("search_knowledge", {"query": "vpn"})
    r, _, audit, _ = runner([Turn(tool_calls=(same,))] * 5 + [Turn(text="done")])
    reply = r.handle(chat("find vpn docs"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.LOOP_DETECTED
    assert any(isinstance(e, RunStoppedEvent) for e in audit.events)


def test_budget_stops_the_run() -> None:
    expensive = Turn(
        tool_calls=(ToolCall("calculate", {"expression": "1+1"}),), input_tokens=100_000, output_tokens=0
    )  # $0.30 > $0.10, under the token limit
    r, _, _, _ = runner([expensive, Turn(text="never reached")], env={"AGENT_MAX_USD": "0.10"})
    reply = r.handle(chat("add"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.BUDGET
    assert render(reply)["status"] == "stopped"


def test_kill_switch() -> None:
    r, model, _, _ = runner([Turn(text="hi")], kill=True)
    reply = r.handle(chat("hello"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.KILL_SWITCH
    assert model.calls == 0


def test_denied_tool_is_blocked() -> None:
    r, model, _, _ = runner(
        [Turn(tool_calls=(ToolCall("delete_everything", {}),)), Turn(text="I cannot do that.")]
    )
    assert r.handle(chat("delete everything")) == Answer(("I cannot do that.",))
    assert "Unknown tool name: 'delete_everything'" in str(model.seen[1][-1])


def test_duplicate_and_cancel_idle() -> None:
    r, _, _, _ = runner([Turn(text="hello")])
    r.handle(chat("hi", mid="m1"))
    assert r.handle(chat("hi", mid="m1")) == Acknowledged(Ack.DUPLICATE)
    assert isinstance(r.handle(CancelRequest(MessageId("c1"), ALICE)), Refused)


def test_mid_run_message_from_owner_is_steered() -> None:
    acks: list[Reply] = []
    r: Harness | None = None

    def owner_writes() -> None:  # runs while the first model call is in flight
        assert r is not None
        acks.append(r.handle(chat("also mention the unit", mid="m2")))

    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "2*3"}),), before=owner_writes),
            Turn(text="6, and noted."),
        ]
    )
    assert r.handle(chat("what is 2*3?")) == Answer(("6, and noted.",))
    assert acks == [Acknowledged(Ack.STEERED)]
    assert f"{STEER_PREFIX} also mention the unit" in user_texts(model.seen[1])


def test_model_error_fails_the_run_and_the_thread_recovers() -> None:
    boom = RuntimeError("ThrottlingException: rate exceeded for key AKIAABCDEFGHIJKLMNOP")
    r, _, audit, _ = runner([Turn(error=boom), Turn(text="recovered")])
    reply = r.handle(chat("hello", mid="m1"))
    assert isinstance(reply, RunFailed)
    rendered = render(reply)
    assert rendered["status"] == "failed" and "AKIA" not in str(rendered)
    assert isinstance(r.state.status, Idle)
    failed = [e for e in audit.events if isinstance(e, RunFailedEvent)]
    assert len(failed) == 1 and "AKIA" not in failed[0].error and "ThrottlingException" in failed[0].error
    assert isinstance(audit.events[-1], RunFinishedEvent)
    assert r.handle(chat("again", mid="m2")) == Answer(("recovered",))


def test_cancel_mid_run_stops_as_cancelled() -> None:
    acks: list[Reply] = []
    r: Harness | None = None

    def owner_cancels() -> None:
        assert r is not None
        acks.append(r.handle(CancelRequest(MessageId("c1"), ALICE)))

    r, _, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "1+1"}),), before=owner_cancels),
            Turn(text="fresh start"),
        ]
    )
    reply = r.handle(chat("add"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.CANCELLED
    assert render(reply)["reason"] == "cancelled"
    assert acks == [Acknowledged(Ack.CANCELLING)]
    assert r.handle(chat("next", mid="m2")) == Answer(("fresh start",))


def test_cancel_while_awaiting_approval_returns_thread_to_idle() -> None:
    r, model, _, tools = runner([Turn(tool_calls=(TICKET,)), Turn(text="hello again")])
    assert isinstance(r.handle(chat("open a ticket", mid="m1")), ApprovalRequested)
    assert r.handle(CancelRequest(MessageId("c1"), ALICE)) == Acknowledged(Ack.CANCELLING)
    assert isinstance(r.state.status, Idle)
    assert r.handle(chat("hi", mid="m2")) == Answer(("hello again",))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    assert "approval was cancelled" in str(tool_returns(model.seen[-1])[-1].content)


@pytest.mark.parametrize("payload", [{"prompt": ""}, {"nope": 1}, "text"])
def test_invalid_payloads_are_rejected_at_boundary(payload: object) -> None:
    from bedrock_agentcore.runtime.context import RequestContext

    from generic_agent_pydantic_harness.shell.app import invoke

    ctx = RequestContext(session_id="thread-1-00000000000000000000000000", request_headers={}, request=None)
    assert invoke(payload, ctx)["status"] == "invalid_request"
