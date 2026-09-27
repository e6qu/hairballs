"""End-to-end tests of the LangGraph agent with a scripted fake model (offline, no AWS)."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import pytest
from fakes import ScriptedModel, ToolCall, Turn
from generic_tools.shell.backends import LocalCorpus, SqliteTicketStore
from generic_tools.shell.service import GenericTools, ToolResult
from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
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
from org_agents.identity import Caller, EmailAddress, HumanUser, PersonName, ServiceClient, UserId
from org_agents.shell.audit import MemoryAuditSink, RunFailedEvent, RunFinishedEvent, RunStoppedEvent
from org_agents.shell.clock import FakeClock
from org_agents.shell.replies import render
from org_agents.shell.settings import Settings, load_settings

from generic_agent_langgraph.shell.middleware import STEER_PREFIX
from generic_agent_langgraph.shell.runner import SessionRunner

ROOT = Path(__file__).resolve().parents[1]
ALICE = PrincipalId("auth0|alice")
BOB = PrincipalId("auth0|bob")
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


def person(subject: PrincipalId, user: str, email: str, given: str | None = None) -> HumanUser:
    name = PersonName(given) if given else None
    return HumanUser(UserId(user), subject, EmailAddress(email), name, None)


CALLERS: dict[PrincipalId, Caller] = {
    ALICE: person(ALICE, "usr_alice", "alice@example.com", "Alice"),
    BOB: person(BOB, "usr_bob", "bob@example.com", "Bob"),
    LEAD: person(LEAD, "usr_lead", "lead@example.com"),
}


def send(r: SessionRunner, message: Incoming) -> Reply:
    return r.handle(message, CALLERS[message.sender])


def chat(text: str, mid: str = "m1", who: PrincipalId = ALICE) -> ChatMessage:
    return ChatMessage(MessageId(mid), who, Prompt(text))


def last_tool_message(model: ScriptedModel, call: int) -> ToolMessage:
    message = model.seen_messages[call][-1]
    assert isinstance(message, ToolMessage)
    return message


def test_tool_use_and_answer() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "0.1 + 0.2"}),)),
            Turn(text="The result is 0.3."),
        ]
    )
    reply = send(r, chat("what is 0.1 + 0.2?"))
    assert reply == Answer(("The result is 0.3.",))
    result = last_tool_message(model, 1)
    assert "0.1 + 0.2 = 0.3" in str(result.content)
    assert result.status == "success"


def test_ticket_requires_four_eyes_approval_then_is_created_once() -> None:
    call = ToolCall(
        "create_ticket", {"title": "VPN broken", "description": "Cannot connect", "priority": "high"}
    )
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="Ticket TCK-000001 created.")])
    reply = send(r, chat("please open a ticket, VPN is broken"))
    assert isinstance(reply, ApprovalRequested)
    assert reply.tool.value == "create_ticket"
    assert reply.approvers == frozenset({LEAD})  # requester cannot self-approve
    assert render(reply)["status"] == "approval_required"
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")

    self_approval = ApprovalResponse(MessageId("a1"), ALICE, reply.approval_id, ApprovalDecision.APPROVE)
    assert isinstance(send(r, self_approval), Refused)

    ok = ApprovalResponse(MessageId("a2"), LEAD, reply.approval_id, ApprovalDecision.APPROVE)
    assert send(r, ok) == Answer(("Ticket TCK-000001 created.",))
    assert "TCK-000001" in tools.get_ticket({"ticket_id": "TCK-000001"}).text
    assert (
        "requested by Alice <alice@example.com> (usr_alice)"
        in tools.get_ticket({"ticket_id": "TCK-000001"}).text
    )
    assert tools.get_ticket({"ticket_id": "TCK-000002"}).text.endswith("not found")  # exactly once
    assert model.calls == 2  # the resume continued at the tools node; no extra model call


def test_rejected_approval_cancels_tool() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="The ticket was not created.")])
    reply = send(r, chat("open a ticket"))
    assert isinstance(reply, ApprovalRequested)
    answer = send(r, ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.REJECT))
    assert answer == Answer(("The ticket was not created.",))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    result = last_tool_message(model, -1)
    assert result.status == "error" and "rejected by approver" in str(result.content)


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
    r, model, _, _ = runner([expensive, Turn(text="never reached")], env={"AGENT_MAX_USD": "0.10"})
    reply = send(r, chat("add"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.BUDGET
    assert render(reply)["status"] == "stopped"
    assert model.calls == 1
    # The pending tool call still got a (refused) result, so the history stays valid for Bedrock.
    assert "run stopped (budget)" in str(r._graph.get_state(r._config()).values["messages"][-2].content)


def test_kill_switch() -> None:
    r, model, _, _ = runner([Turn(text="hi")], kill=True)
    reply = send(r, chat("hello"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.KILL_SWITCH
    assert model.calls == 0


def test_denied_tool_is_blocked() -> None:
    r, model, _, _ = runner(
        [Turn(tool_calls=(ToolCall("delete_everything", {}),)), Turn(text="I cannot do that.")]
    )
    assert send(r, chat("delete everything")) == Answer(("I cannot do that.",))
    result = last_tool_message(model, 1)
    assert result.status == "error" and str(result.content).startswith("blocked:")


def test_duplicate_and_cancel_idle() -> None:
    r, _, _, _ = runner([Turn(text="hello")])
    send(r, chat("hi", mid="m1"))
    assert send(r, chat("hi", mid="m1")) == Acknowledged(Ack.DUPLICATE)
    assert isinstance(send(r, CancelRequest(MessageId("c1"), ALICE)), Refused)


def test_mid_run_message_from_owner_is_steered_into_next_model_call() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "2*3"}),)),
            Turn(text="6, and noted."),
        ]
    )
    acks: list[Reply] = []
    # A real message arrives through handle() while model call #1 is in flight; it is injected by
    # before_model ahead of model call #2 (a call already in flight cannot be changed).
    model.before_call[0] = lambda: acks.append(send(r, chat("also mention the unit", mid="m2")))
    assert send(r, chat("what is 2*3?")) == Answer(("6, and noted.",))
    assert acks == [Acknowledged(Ack.STEERED)]
    injected = model.seen_messages[1][-1]
    assert isinstance(injected, HumanMessage)
    assert str(injected.content) == f"{STEER_PREFIX} also mention the unit"
    assert isinstance(model.seen_messages[1][-2], ToolMessage)  # merged into one user turn by Converse


def test_mid_run_message_from_other_user_is_queued_as_follow_up() -> None:
    r, model, _, _ = runner([Turn(text="first"), Turn(text="second")])
    acks: list[Reply] = []
    model.before_call[0] = lambda: acks.append(send(r, chat("my question", mid="m2", who=BOB)))
    assert send(r, chat("hello")) == Answer(("first", "second"))
    assert acks == [Acknowledged(Ack.QUEUED)]


def test_cancel_mid_run_stops_before_next_model_call() -> None:
    r, model, _, _ = runner(
        [Turn(tool_calls=(ToolCall("calculate", {"expression": "1+1"}),)), Turn(text="never")]
    )
    acks: list[Reply] = []
    model.before_call[0] = lambda: acks.append(send(r, CancelRequest(MessageId("c1"), ALICE)))
    reply = send(r, chat("add"))
    assert acks == [Acknowledged(Ack.CANCELLING)]
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.CANCELLED
    assert reply.text == "Run cancelled by the user."
    assert render(reply)["reason"] == "cancelled"
    assert model.calls == 1
    assert send(r, chat("next", mid="m2")) == Answer(("never",))  # the flag was cleared


def test_cancel_during_the_final_model_call_is_reported_as_cancelled() -> None:
    r, model, _, _ = runner([Turn(text="done anyway")])
    model.before_call[0] = lambda: send(r, CancelRequest(MessageId("c1"), ALICE))
    reply = send(r, chat("hello"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.CANCELLED
    assert reply.text == "done anyway"


def test_model_error_fails_the_run_and_the_thread_recovers() -> None:
    boom = RuntimeError("ThrottlingException: rate exceeded for key AKIAABCDEFGHIJKLMNOP")
    r, _, audit, _ = runner([Turn(error=boom), Turn(text="recovered")])
    reply = send(r, chat("hello", mid="m1"))
    assert isinstance(reply, RunFailed)
    rendered = render(reply)
    assert rendered["status"] == "failed" and "AKIA" not in str(rendered)
    assert isinstance(r.state.status, Idle)
    failed = [e for e in audit.events if isinstance(e, RunFailedEvent)]
    assert len(failed) == 1 and "AKIA" not in failed[0].error and "ThrottlingException" in failed[0].error
    assert isinstance(audit.events[-1], RunFinishedEvent)
    assert send(r, chat("again", mid="m2")) == Answer(("recovered",))


def test_tool_crash_fails_the_run_and_dangling_tool_calls_are_answered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    r, model, _, tools = runner(
        [Turn(tool_calls=(ToolCall("get_ticket", {"ticket_id": "TCK-000001"}),)), Turn(text="ok")]
    )

    def crash(_: object) -> ToolResult:
        raise OSError("disk gone")

    monkeypatch.setattr(tools, "get_ticket", crash)
    assert isinstance(send(r, chat("get it", mid="m1")), RunFailed)
    assert send(r, chat("again", mid="m2")) == Answer(("ok",))
    kinds = [type(m).__name__ for m in model.seen_messages[-1]]
    assert kinds[-3:] == ["AIMessage", "ToolMessage", "HumanMessage"]


def test_cancel_while_awaiting_approval_returns_thread_to_idle() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="hello again")])
    assert isinstance(send(r, chat("open a ticket", mid="m1")), ApprovalRequested)
    assert send(r, CancelRequest(MessageId("c1"), ALICE)) == Acknowledged(Ack.CANCELLING)
    assert isinstance(r.state.status, Idle)
    assert send(r, chat("hi", mid="m2")) == Answer(("hello again",))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    kinds = [type(m).__name__ for m in model.seen_messages[-1]]
    assert kinds[-3:] == ["AIMessage", "ToolMessage", "HumanMessage"]  # every tool call answered


def test_turn_limit_is_enforced_by_guard_before_recursion_limit() -> None:
    turns = [Turn(tool_calls=(ToolCall("calculate", {"expression": f"{i}+1"}),)) for i in range(10)]
    r, model, _, _ = runner(turns, env={"AGENT_MAX_TURNS": "3"})
    reply = send(r, chat("keep adding"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.TURN_LIMIT
    assert model.calls == 3
    assert r._config()["recursion_limit"] == 17


def test_recursion_limit_is_a_second_line_of_defence() -> None:
    turns = [Turn(tool_calls=(ToolCall("calculate", {"expression": f"{i}+1"}),)) for i in range(10)]
    r, _, _, _ = runner(turns, env={"AGENT_MAX_TURNS": "3"})
    from langchain.agents import create_agent
    from langgraph.checkpoint.memory import InMemorySaver

    from generic_agent_langgraph.shell.tools import RunContext, build_tools

    r._graph = create_agent(
        ScriptedModel(turns=turns),
        tools=build_tools(GenericTools(LocalCorpus(), SqliteTicketStore())),
        context_schema=RunContext,
        checkpointer=InMemorySaver(),
    )  # no guard middleware at all: only the recursion limit bounds the loop
    reply = send(r, chat("keep adding"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.TURN_LIMIT
    assert "recursion limit" in reply.stop.detail


@pytest.mark.parametrize("payload", [{"prompt": ""}, {"nope": 1}, "text"])
def test_invalid_payloads_are_rejected_at_boundary(payload: object) -> None:
    from bedrock_agentcore.runtime.context import RequestContext

    from generic_agent_langgraph.shell.app import invoke

    ctx = RequestContext(session_id="thread-1-00000000000000000000000000", request_headers={}, request=None)
    assert invoke(payload, ctx)["status"] == "invalid_request"


def test_ticket_records_the_requester_and_approvers_see_who_asked() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "Cannot connect"})
    r, _, audit, tools = runner([Turn(tool_calls=(call,)), Turn(text="Created.")])
    reply = send(r, chat("open a ticket"))
    assert isinstance(reply, ApprovalRequested)
    assert reply.requester == CALLERS[ALICE]
    rendered = render(reply)["requester"]
    assert rendered == {"kind": "user", "user_id": "usr_alice", "name": "Alice", "email": "alice@example.com"}
    # The caller is run context, not graph state: nothing about it is checkpointed for the model.
    state = r._graph.get_state(r._config()).values
    assert "alice@example.com" not in repr(state) and "usr_alice" not in repr(state)

    send(r, ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.APPROVE))
    ticket = tools.get_ticket({"ticket_id": "TCK-000001"})
    assert "Alice <alice@example.com> (usr_alice)" in ticket.text
    assert "alice@example.com" not in repr(audit.events)  # PII stays out of the audit log


def test_service_caller_is_the_requester_without_email() -> None:
    svc = PrincipalId("m2m-client@clients")
    call = ToolCall("create_ticket", {"title": "Disk full", "description": "Alert"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="Created.")])
    reply = r.handle(ChatMessage(MessageId("m1"), svc, Prompt("open a ticket")), ServiceClient(svc))
    assert isinstance(reply, ApprovalRequested)
    assert render(reply)["requester"] == {"kind": "service", "client": "m2m-client@clients"}
    send(r, ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.APPROVE))
    assert (
        "service m2m-client@clients (m2m-client@clients)"
        in tools.get_ticket({"ticket_id": "TCK-000001"}).text
    )
    assert str(model.seen_messages[0][-1].content) == "open a ticket"  # no profile: no preamble


def test_caller_must_match_the_sender() -> None:
    r, _, _, _ = runner([Turn(text="hi")])
    with pytest.raises(ValueError):
        r.handle(chat("hello"), CALLERS[BOB])


def test_model_is_told_the_first_name_once_per_speaker() -> None:
    r, model, _, _ = runner(
        [Turn(text="Hi Alice."), Turn(text="Sure."), Turn(text="Hi Bob."), Turn(text="Hello.")]
    )
    send(r, chat("hello", mid="m1"))
    send(r, chat("and again", mid="m2"))
    send(r, chat("bob here", mid="m3", who=BOB))
    send(r, chat("lead here", mid="m4", who=LEAD))
    assert str(model.seen_messages[0][-1].content) == "[Context: you are assisting Alice.]\n\nhello"
    assert str(model.seen_messages[1][-1].content) == "and again"
    assert str(model.seen_messages[2][-1].content) == "[Context: you are assisting Bob.]\n\nbob here"
    assert str(model.seen_messages[3][-1].content) == "lead here"  # no given name: no preamble
    assert all(
        not isinstance(m, SystemMessage) or "Alice" not in str(m.content) for m in model.seen_messages[3]
    )


def test_queued_follow_up_from_other_user_is_introduced_and_owned_by_them() -> None:
    r, model, _, _ = runner([Turn(text="first"), Turn(text="second")])
    model.before_call[0] = lambda: send(r, chat("my question", mid="m2", who=BOB))
    assert send(r, chat("hello")) == Answer(("first", "second"))
    assert str(model.seen_messages[1][-1].content) == "[Context: you are assisting Bob.]\n\nmy question"


def _jwt(claims: Mapping[str, object]) -> dict[str, str]:
    import base64
    import json

    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return {"Authorization": f"Bearer e30.{body}.sig"}


def test_callers_come_from_token_claims_and_keep_their_user_id() -> None:
    from bedrock_agentcore.runtime.context import RequestContext

    from generic_agent_langgraph.shell.app import invoke, registry

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
