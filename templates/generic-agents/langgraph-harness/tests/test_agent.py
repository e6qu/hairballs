"""End-to-end tests of the deepagents graph with a scripted fake model (offline, no AWS)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fakes import ScriptedModel, ToolCall, Turn
from generic_tools.shell.backends import LocalCorpus, SqliteTicketStore
from generic_tools.shell.service import GenericTools
from langchain_core.messages import BaseMessage, HumanMessage, ToolMessage
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
from org_agents.shell.settings import Settings, load_settings

from generic_agent_deepagents.shell.runner import SessionRunner

ROOT = Path(__file__).resolve().parents[1]
ALICE = PrincipalId("auth0|alice")
LEAD = PrincipalId("auth0|service-desk-lead")


def settings(**env: str) -> Settings:
    return load_settings(env, ROOT)


def runner(
    turns: list[Turn], env: dict[str, str] | None = None, kill: bool = False
) -> tuple[SessionRunner, ScriptedModel, MemoryAuditSink, GenericTools]:
    model = ScriptedModel(turns=turns)
    audit = MemoryAuditSink()
    tools = GenericTools(LocalCorpus(), SqliteTicketStore())
    r = SessionRunner(
        SessionId("thread-1"), settings(**(env or {})), model, tools, FakeClock(), audit, lambda: kill
    )
    return r, model, audit, tools


def chat(text: str, mid: str = "m1", who: PrincipalId = ALICE) -> ChatMessage:
    return ChatMessage(MessageId(mid), who, Prompt(text))


def tool_messages(messages: list[BaseMessage]) -> list[ToolMessage]:
    return [m for m in messages if isinstance(m, ToolMessage)]


def test_tool_use_and_answer() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "0.1 + 0.2"}),)),
            Turn(text="The result is 0.3."),
        ]
    )
    reply = r.handle(chat("what is 0.1 + 0.2?"))
    assert reply == Answer(("The result is 0.3.",))
    result = tool_messages(model.seen_messages[1])[-1]
    assert "0.1 + 0.2 = 0.3" in str(result.content)


def test_only_the_constrained_builtins_are_offered() -> None:
    r, model, _, _ = runner([Turn(text="hi")])
    r.handle(chat("hello"))
    offered = set(model.bound_tools[-1])
    assert offered == {"calculate", "search_knowledge", "create_ticket", "get_ticket", "read_file", "task"}


def test_ticket_requires_four_eyes_approval_then_is_created_once() -> None:
    call = ToolCall(
        "create_ticket", {"title": "VPN broken", "description": "Cannot connect", "priority": "high"}
    )
    r, _, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="Ticket TCK-000001 created.")])
    reply = r.handle(chat("please open a ticket, VPN is broken"))
    assert isinstance(reply, ApprovalRequested)
    assert reply.approvers == frozenset({LEAD})  # requester cannot self-approve
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")  # not before approval

    self_approval = ApprovalResponse(MessageId("a1"), ALICE, reply.approval_id, ApprovalDecision.APPROVE)
    assert isinstance(r.handle(self_approval), Refused)

    ok = ApprovalResponse(MessageId("a2"), LEAD, reply.approval_id, ApprovalDecision.APPROVE)
    assert r.handle(ok) == Answer(("Ticket TCK-000001 created.",))
    ticket = tools.get_ticket({"ticket_id": "TCK-000001"}).text
    assert "TCK-000001" in ticket and "requested by auth0|alice" in ticket
    assert tools.get_ticket({"ticket_id": "TCK-000002"}).text.endswith("not found")  # exactly once


def test_rejected_approval_cancels_tool() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="The ticket was not created.")])
    reply = r.handle(chat("open a ticket"))
    assert isinstance(reply, ApprovalRequested)
    final = r.handle(ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.REJECT))
    assert final == Answer(("The ticket was not created.",))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    result = tool_messages(model.seen_messages[-1])[-1]
    assert result.status == "error" and "rejected by approver" in str(result.content)


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
    r, model, _, _ = runner([expensive, Turn(text="never reached")], env={"AGENT_MAX_USD": "0.10"})
    reply = r.handle(chat("add"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.BUDGET
    assert render(reply)["status"] == "stopped"
    assert model.calls == 1


def test_subagent_spends_the_same_budget() -> None:
    delegate = ToolCall("task", {"description": "add 1+1", "subagent_type": "general-purpose"})
    expensive_sub_turn = Turn(
        tool_calls=(ToolCall("calculate", {"expression": "1+1"}),), input_tokens=100_000, output_tokens=0
    )
    r, model, _, _ = runner(
        [Turn(tool_calls=(delegate,)), expensive_sub_turn, Turn(text="never reached")],
        env={"AGENT_MAX_USD": "0.10"},
    )
    reply = r.handle(chat("delegate"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.BUDGET
    assert model.calls == 2
    assert "create_ticket" not in model.bound_tools[-1]  # the sub-agent is read-only


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
    result = tool_messages(model.seen_messages[-1])[-1]
    assert result.status == "error" and "not in the allowlist" in str(result.content)


def test_turn_limit_trips_before_the_graph_recursion_limit() -> None:
    calls = [Turn(tool_calls=(ToolCall("calculate", {"expression": f"{i}+1"}),)) for i in range(10)]
    r, _, _, _ = runner(calls, env={"AGENT_MAX_TURNS": "3"})
    reply = r.handle(chat("count"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.TURN_LIMIT
    assert "recursion" not in reply.stop.detail


def test_duplicate_and_cancel_idle() -> None:
    r, _, _, _ = runner([Turn(text="hello")])
    r.handle(chat("hi", mid="m1"))
    assert r.handle(chat("hi", mid="m1")) == Acknowledged(Ack.DUPLICATE)
    assert isinstance(r.handle(CancelRequest(MessageId("c1"), ALICE)), Refused)


def test_steering_is_injected_before_next_model_call() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "2*3"}),)),
            Turn(text="6, and noted."),
        ]
    )
    replies = []

    def owner_writes_mid_run(call: int) -> None:
        if call == 0:  # while the first model call is in flight
            replies.append(r.handle(chat("also mention the unit", mid="m2")))

    model.on_call = owner_writes_mid_run
    assert r.handle(chat("what is 2*3?")) == Answer(("6, and noted.",))
    assert replies == [Acknowledged(Ack.STEERED)]
    second = model.seen_messages[1]
    assert isinstance(second[-2], ToolMessage)  # appended after the tool result, history untouched
    assert isinstance(second[-1], HumanMessage) and "also mention the unit" in str(second[-1].content)


def test_message_from_another_user_is_queued_as_follow_up() -> None:
    r, model, _, _ = runner([Turn(text="first answer"), Turn(text="second answer")])
    bob = PrincipalId("auth0|bob")
    replies = []

    def bob_writes_mid_run(call: int) -> None:
        if call == 0:
            replies.append(r.handle(chat("my question", mid="b1", who=bob)))

    model.on_call = bob_writes_mid_run
    assert r.handle(chat("hello")) == Answer(("first answer", "second answer"))
    assert replies == [Acknowledged(Ack.QUEUED)]


def test_cancel_mid_run_stops_before_the_tool_runs() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="never reached")])
    replies = []
    model.on_call = lambda n: (
        replies.append(r.handle(CancelRequest(MessageId("c1"), ALICE))) if n == 0 else None
    )
    reply = r.handle(chat("open a ticket"))
    assert replies == [Acknowledged(Ack.CANCELLING)]
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.CANCELLED
    assert render(reply)["reason"] == "cancelled"
    assert model.calls == 1  # no approval requested, no second turn
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    assert r.handle(chat("next", mid="m2")) == Answer(("never reached",))  # flag cleared
    # the unanswered create_ticket call was patched before the next model call
    assert any(m.tool_call_id for m in tool_messages(model.seen_messages[-1]))


def test_cancel_during_the_final_model_call_is_reported_as_cancelled() -> None:
    r, model, _, _ = runner([Turn(text="done anyway")])
    acks: list[Reply] = []
    model.on_call = lambda n: acks.append(r.handle(CancelRequest(MessageId("c1"), ALICE)))
    reply = r.handle(chat("hello"))
    assert acks == [Acknowledged(Ack.CANCELLING)]
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.CANCELLED
    assert reply.text == "done anyway"


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


def test_cancel_while_awaiting_approval_returns_thread_to_idle() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="hello again")])
    assert isinstance(r.handle(chat("open a ticket", mid="m1")), ApprovalRequested)
    assert r.handle(CancelRequest(MessageId("c1"), ALICE)) == Acknowledged(Ack.CANCELLING)
    assert isinstance(r.state.status, Idle)
    assert r.handle(chat("hi", mid="m2")) == Answer(("hello again",))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    assert len(tool_messages(model.seen_messages[-1])) == 1  # the abandoned call was answered


def test_follow_up_turn_keeps_history() -> None:
    r, model, _, _ = runner([Turn(text="first"), Turn(text="second")])
    r.handle(chat("one", mid="m1"))
    assert r.handle(chat("two", mid="m2")) == Answer(("second",))
    texts = [str(m.content) for m in model.seen_messages[1] if isinstance(m, HumanMessage)]
    assert texts == ["one", "two"]


@pytest.mark.parametrize("payload", [{"prompt": ""}, {"nope": 1}, "text"])
def test_invalid_payloads_are_rejected_at_boundary(payload: object) -> None:
    from bedrock_agentcore.runtime.context import RequestContext

    from generic_agent_deepagents.shell.app import invoke

    ctx = RequestContext(session_id="thread-1-00000000000000000000000000", request_headers={}, request=None)
    assert invoke(payload, ctx)["status"] == "invalid_request"
