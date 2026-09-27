"""End-to-end tests of the Pydantic AI agent with a scripted FunctionModel (offline, no AWS)."""

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
from org_agents.shell.audit import (
    MemoryAuditSink,
    RunFailedEvent,
    RunFinishedEvent,
    RunStoppedEvent,
    ToolDecisionEvent,
)
from org_agents.shell.clock import FakeClock
from org_agents.shell.replies import render
from org_agents.shell.settings import Settings, load_settings
from pydantic_ai.messages import ModelMessage, ModelRequest, ToolReturnPart, UserPromptPart

from generic_agent_pydantic.shell.runner import STEER_PREFIX, SessionRunner

ROOT = Path(__file__).resolve().parents[1]
ALICE = PrincipalId("auth0|alice")
BOB = PrincipalId("auth0|bob")
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
        SessionId("thread-1"), settings(**(env or {})), model.model, tools, FakeClock(), audit, lambda: kill
    )
    return r, model, audit, tools


def person(subject: PrincipalId, user: str, email: str, given: str | None = None) -> HumanUser:
    name = PersonName(given) if given else None
    return HumanUser(UserId(user), subject, EmailAddress(email), name, None)


CALLERS: dict[PrincipalId, Caller] = {
    ALICE: person(ALICE, "usr_alice", "alice@example.com", "Alice"),
    BOB: person(BOB, "usr_bob", "bob@example.com"),
    LEAD: person(LEAD, "usr_lead", "lead@example.com"),
}
HI_ALICE = "[Context: you are assisting Alice.]\n\n"


def send(r: SessionRunner, message: Incoming) -> Reply:
    return r.handle(message, CALLERS[message.sender])


def chat(text: str, mid: str = "m1", who: PrincipalId = ALICE) -> ChatMessage:
    return ChatMessage(MessageId(mid), who, Prompt(text))


def tool_returns(messages: list[ModelMessage]) -> list[ToolReturnPart]:
    last = messages[-1]
    assert isinstance(last, ModelRequest)
    return [p for p in last.parts if isinstance(p, ToolReturnPart)]


def user_texts(message: ModelMessage) -> list[str]:
    assert isinstance(message, ModelRequest)
    return [p.content for p in message.parts if isinstance(p, UserPromptPart) and isinstance(p.content, str)]


def test_tool_use_and_answer() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "0.1 + 0.2"}),)),
            Turn(text="The result is 0.3."),
        ]
    )
    reply = send(r, chat("what is 0.1 + 0.2?"))
    assert reply == Answer(("The result is 0.3.",))
    (result,) = tool_returns(model.seen_messages[1])
    assert "0.1 + 0.2 = 0.3" in str(result.content)


def test_history_is_kept_per_thread() -> None:
    r, model, _, _ = runner([Turn(text="first"), Turn(text="second")])
    send(r, chat("one", mid="m1"))
    send(r, chat("two", mid="m2"))
    assert len(model.seen_messages[1]) == 3  # request, response, new request
    assert user_texts(model.seen_messages[1][0]) == [f"{HI_ALICE}one"]


def test_ticket_requires_four_eyes_approval_then_is_created_once() -> None:
    call = ToolCall(
        "create_ticket", {"title": "VPN broken", "description": "Cannot connect", "priority": "high"}
    )
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="Ticket TCK-000001 created.")])
    reply = send(r, chat("please open a ticket, VPN is broken"))
    assert isinstance(reply, ApprovalRequested)
    assert reply.approval_id.value == "tool-1-0"  # the Pydantic AI tool_call_id
    assert reply.approvers == frozenset({LEAD})  # requester cannot self-approve
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")  # deferred, not run

    self_approval = ApprovalResponse(MessageId("a1"), ALICE, reply.approval_id, ApprovalDecision.APPROVE)
    assert isinstance(send(r, self_approval), Refused)

    ok = ApprovalResponse(MessageId("a2"), LEAD, reply.approval_id, ApprovalDecision.APPROVE)
    assert send(r, ok) == Answer(("Ticket TCK-000001 created.",))
    assert "TCK-000001" in tools.get_ticket({"ticket_id": "TCK-000001"}).text
    assert tools.get_ticket({"ticket_id": "TCK-000002"}).text.endswith("not found")  # exactly once
    (result,) = tool_returns(model.seen_messages[-1])
    # acts for the thread owner
    assert "requested by Alice <alice@example.com> (usr_alice)" in str(result.content)


def test_rejected_approval_cancels_tool() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="The ticket was not created.")])
    reply = send(r, chat("open a ticket"))
    assert isinstance(reply, ApprovalRequested)
    final = send(r, ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.REJECT))
    assert final == Answer(("The ticket was not created.",))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    (result,) = tool_returns(model.seen_messages[-1])
    assert result.outcome == "denied" and "rejected by approver" in str(result.content)


def test_loop_detection_stops_the_run() -> None:
    same = ToolCall("search_knowledge", {"query": "vpn"})
    r, model, audit, _ = runner([Turn(tool_calls=(same,))] * 5 + [Turn(text="done")])
    reply = send(r, chat("find vpn docs"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.LOOP_DETECTED
    assert any(isinstance(e, RunStoppedEvent) for e in audit.events)
    assert model.calls == 3  # the model is not called again once the guard has stopped


def test_budget_stops_the_run() -> None:
    expensive = Turn(
        tool_calls=(ToolCall("calculate", {"expression": "1+1"}),), input_tokens=100_000, output_tokens=0
    )  # $0.30 > $0.10, under the token limit
    r, model, _, _ = runner([expensive, Turn(text="never reached")], env={"AGENT_MAX_USD": "0.10"})
    reply = send(r, chat("add"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.BUDGET
    assert render(reply)["status"] == "stopped"
    assert model.calls == 1


def test_framework_usage_limit_maps_to_org_stop() -> None:
    # One response with 3 tool calls while only 2 are allowed: Pydantic AI's UsageLimits check runs
    # before any tool hook, so the second line of defence fires and is surfaced as an org stop.
    calls = tuple(ToolCall("calculate", {"expression": f"{i}+1"}, id=f"t{i}") for i in range(3))
    r, _, audit, _ = runner([Turn(tool_calls=calls)], env={"AGENT_MAX_TOOL_CALLS": "2"})
    reply = send(r, chat("add three times"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.TOOL_CALL_LIMIT
    assert any(isinstance(e, RunStoppedEvent) for e in audit.events)


def test_kill_switch() -> None:
    r, model, _, _ = runner([Turn(text="hi")], kill=True)
    reply = send(r, chat("hello"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.KILL_SWITCH
    assert model.calls == 0


def test_unknown_tool_is_refused() -> None:
    r, model, _, _ = runner(
        [Turn(tool_calls=(ToolCall("delete_everything", {}),)), Turn(text="I cannot do that.")]
    )
    assert send(r, chat("delete everything")) == Answer(("I cannot do that.",))
    assert "Unknown tool name" in str(model.seen_messages[1][-1])


def test_registered_but_unlisted_tool_is_blocked_by_guard(tmp_path: Path) -> None:
    config = (ROOT / "config" / "agent.toml").read_text().replace(', "get_ticket"', "")
    (tmp_path / "agent.toml").write_text(config)
    r, model, audit, _ = runner(
        [Turn(tool_calls=(ToolCall("get_ticket", {"ticket_id": "TCK-000001"}),)), Turn(text="Not allowed.")],
        env={"AGENT_CONFIG": str(tmp_path / "agent.toml")},
    )
    assert send(r, chat("get ticket 1")) == Answer(("Not allowed.",))
    (result,) = tool_returns(model.seen_messages[1])
    assert result.outcome == "failed" and "blocked" in str(result.content)
    assert any(isinstance(e, ToolDecisionEvent) and e.outcome == "denied" for e in audit.events)


def test_duplicate_and_cancel_idle() -> None:
    r, _, _, _ = runner([Turn(text="hello")])
    send(r, chat("hi", mid="m1"))
    assert send(r, chat("hi", mid="m1")) == Acknowledged(Ack.DUPLICATE)
    assert isinstance(send(r, CancelRequest(MessageId("c1"), ALICE)), Refused)


def test_owner_message_mid_run_is_steered_into_the_next_request() -> None:
    r, model, _, _ = runner(
        [
            Turn(tool_calls=(ToolCall("calculate", {"expression": "2*3"}),)),
            Turn(text="6 (no unit), and noted."),
        ]
    )
    acks: list[Reply] = []
    model.during[0] = lambda: acks.append(send(r, chat("also mention the unit", mid="m2")))
    assert send(r, chat("what is 2*3?")) == Answer(("6 (no unit), and noted.",))
    assert acks == [Acknowledged(Ack.STEERED)]
    injected = [t for m in model.seen_messages[1] if isinstance(m, ModelRequest) for t in user_texts(m)]
    assert f"{STEER_PREFIX} also mention the unit" in injected


def test_other_users_message_mid_run_is_queued_as_follow_up() -> None:
    r, model, _, _ = runner([Turn(text="first answer"), Turn(text="bob's answer")])
    acks: list[Reply] = []
    model.during[0] = lambda: acks.append(send(r, chat("my question", mid="m2", who=BOB)))
    assert send(r, chat("hi")) == Answer(("first answer", "bob's answer"))
    assert acks == [Acknowledged(Ack.QUEUED)]


def test_cancel_mid_run() -> None:
    r, model, _, _ = runner(
        [Turn(tool_calls=(ToolCall("calculate", {"expression": "1+1"}),)), Turn(text="never reached")]
    )
    acks: list[Reply] = []
    model.during[0] = lambda: acks.append(send(r, CancelRequest(MessageId("c1"), ALICE)))
    reply = send(r, chat("add"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.CANCELLED
    assert render(reply)["reason"] == "cancelled"
    assert acks == [Acknowledged(Ack.CANCELLING)]
    assert model.calls == 1
    assert isinstance(r.state.status, Idle)
    assert send(r, chat("next", mid="m2")) == Answer(("never reached",))
    (closed,) = tool_returns(model.seen_messages[-1])  # the cancelled call got a result
    assert "not executed" in str(closed.content)


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
    history = model.seen_messages[-1]
    assert [t for m in history for t in user_texts(m)] == [f"{HI_ALICE}hello", "again"]  # partial kept


def test_failed_run_keeps_queued_follow_ups() -> None:
    r, model, _, _ = runner([Turn(error=RuntimeError("boom")), Turn(text="bob's answer")])
    acks: list[Reply] = []
    model.during[0] = lambda: acks.append(send(r, chat("mine", mid="m2", who=BOB)))
    # the follow-up still runs; the shared `merge_answers` keeps only the later reply
    assert send(r, chat("hi")) == Answer(("bob's answer",))
    assert acks == [Acknowledged(Ack.QUEUED)]


def test_cancel_while_awaiting_approval_returns_thread_to_idle() -> None:
    call = ToolCall("create_ticket", {"title": "VPN broken", "description": "x"})
    r, model, _, tools = runner([Turn(tool_calls=(call,)), Turn(text="hello again")])
    assert isinstance(send(r, chat("open a ticket", mid="m1")), ApprovalRequested)
    assert send(r, CancelRequest(MessageId("c1"), ALICE)) == Acknowledged(Ack.CANCELLING)
    assert isinstance(r.state.status, Idle)
    assert send(r, chat("hi", mid="m2")) == Answer(("hello again",))
    assert tools.get_ticket({"ticket_id": "TCK-000001"}).text.endswith("not found")
    (closed,) = tool_returns(model.seen_messages[-1])
    assert "approval was cancelled" in str(closed.content)


@pytest.mark.parametrize("payload", [{"prompt": ""}, {"nope": 1}, "text"])
def test_invalid_payloads_are_rejected_at_boundary(payload: object) -> None:
    from bedrock_agentcore.runtime.context import RequestContext

    from generic_agent_pydantic.shell.app import invoke

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

    send(r, ApprovalResponse(MessageId("a1"), LEAD, reply.approval_id, ApprovalDecision.APPROVE))
    ticket = tools.get_ticket({"ticket_id": "TCK-000001"})
    assert "Alice <alice@example.com> (usr_alice)" in ticket.text
    assert "alice@example.com" not in repr(audit.events)  # PII stays out of the audit log


def test_model_is_told_the_first_name_once_per_speaker() -> None:
    r, model, _, _ = runner([Turn(text="Hi Alice."), Turn(text="Sure."), Turn(text="Hello.")])
    send(r, chat("hello", mid="m1"))
    send(r, chat("and again", mid="m2"))
    send(r, chat("lead here", mid="m3", who=LEAD))
    assert [t for m in model.seen_messages[-1] if isinstance(m, ModelRequest) for t in user_texts(m)] == [
        f"{HI_ALICE}hello",
        "and again",
        "lead here",  # no given name: no preamble
    ]
    first = model.seen_messages[0][0]
    assert isinstance(first, ModelRequest) and first.instructions
    assert "Alice" not in first.instructions  # never in the system prompt


def test_caller_must_match_the_sender() -> None:
    r, _, _, _ = runner([])
    with pytest.raises(ValueError, match="sender"):
        r.handle(chat("hi"), CALLERS[BOB])


def _jwt(claims: Mapping[str, object]) -> dict[str, str]:
    import base64
    import json

    body = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return {"Authorization": f"Bearer e30.{body}.sig"}


def test_callers_come_from_token_claims_and_keep_their_user_id() -> None:
    from bedrock_agentcore.runtime.context import RequestContext

    from generic_agent_pydantic.shell.app import invoke, registry

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
