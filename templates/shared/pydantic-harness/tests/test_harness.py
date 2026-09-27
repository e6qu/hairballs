"""Harness tests with a scripted FunctionModel and toy tools (offline, no AWS)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fakes import ScriptedModel, ToolCall, Turn, tool_returns, user_texts
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
from org_agents.core.messages import ApprovalResponse, AwaitingApproval, CancelRequest, ChatMessage, Idle
from org_agents.domain import ApprovalDecision, MessageId, PositiveInt, PrincipalId, Prompt, SessionId
from org_agents.shell.audit import (
    ContextCompactedEvent,
    MemoryAuditSink,
    RunFailedEvent,
    RunFinishedEvent,
    RunStoppedEvent,
    ToolDecisionEvent,
)
from org_agents.shell.clock import FakeClock
from org_agents.shell.settings import load_settings
from pydantic_ai import RunContext, Tool

from org_pydantic_harness.shell import (
    ContextPolicy,
    Harness,
    HarnessDeps,
    InMemorySessionStore,
    JsonFileSessionStore,
    SessionStore,
    create_harness,
    load_context_policy,
)
from org_pydantic_harness.shell.steering import STEER_PREFIX

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SESSION = SessionId("thread-1")
ALICE = PrincipalId("auth0|alice")
BOB = PrincipalId("auth0|bob")
LEAD = PrincipalId("auth0|lead")


class Outbox:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def tools(self) -> list[Tool[HarnessDeps]]:
        def echo(text: str) -> str:
            return f"echo: {text}"

        def dump(size: int) -> str:
            if size < 0:
                raise OSError("disk gone")
            return "A" * 1500 + "B" * size + "C" * 700

        def send_email(ctx: RunContext[HarnessDeps], to: str, body: str) -> str:
            self.sent.append((to, ctx.deps.principal.value))
            return f"sent to {to}"

        def forbidden() -> str:  # registered, but not in the allowlist
            raise AssertionError("must never run")

        return [
            Tool(echo, name="echo"),
            Tool(dump, name="dump"),
            Tool(send_email, name="send_email"),
            Tool(forbidden, name="forbidden"),
        ]


def build(
    turns: list[Turn],
    *,
    env: dict[str, str] | None = None,
    kill: bool = False,
    store: SessionStore | None = None,
    context: ContextPolicy | None = None,
) -> tuple[Harness, ScriptedModel, MemoryAuditSink, Outbox]:
    scripted = ScriptedModel(turns)
    audit = MemoryAuditSink()
    outbox = Outbox()
    harness = create_harness(
        load_settings(env or {}, FIXTURES),
        outbox.tools(),
        scripted.model,
        session=SESSION,
        clock=FakeClock(),
        audit=audit,
        kill_switch=lambda: kill,
        store=store,
        context=context or load_context_policy({}, FIXTURES),
    )
    return harness, scripted, audit, outbox


def chat(text: str, mid: str = "m1", who: PrincipalId = ALICE) -> ChatMessage:
    return ChatMessage(MessageId(mid), who, Prompt(text))


def approve(reply: Reply, who: PrincipalId, mid: str, decision: ApprovalDecision) -> ApprovalResponse:
    assert isinstance(reply, ApprovalRequested)
    return ApprovalResponse(MessageId(mid), who, reply.approval_id, decision)


EMAIL = ToolCall("send_email", {"to": "it@example.com", "body": "VPN down"})


def test_tool_use_and_answer() -> None:
    h, model, _, _ = build([Turn(tool_calls=(ToolCall("echo", {"text": "hi"}),)), Turn(text="done")])
    assert h.handle(chat("say hi")) == Answer(("done",))
    assert tool_returns(model.seen[1])[-1].content == "echo: hi"


def test_approval_is_four_eyes_and_executes_once() -> None:
    h, _, audit, outbox = build([Turn(tool_calls=(EMAIL,)), Turn(text="Email sent.")])
    reply = h.handle(chat("email IT"))
    assert isinstance(reply, ApprovalRequested) and reply.approvers == frozenset({LEAD})
    assert "needs approval" in reply.reason
    assert isinstance(h.handle(approve(reply, ALICE, "a1", ApprovalDecision.APPROVE)), Refused)
    assert h.handle(approve(reply, LEAD, "a2", ApprovalDecision.APPROVE)) == Answer(("Email sent.",))
    assert outbox.sent == [("it@example.com", ALICE.value)]  # runs as the requester, once
    assert any(isinstance(e, ToolDecisionEvent) and e.outcome == "needs_approval" for e in audit.events)


def test_rejection_is_reported_to_the_model() -> None:
    h, model, _, outbox = build([Turn(tool_calls=(EMAIL,)), Turn(text="Not sent.")])
    reply = h.handle(chat("email IT"))
    assert h.handle(approve(reply, LEAD, "a1", ApprovalDecision.REJECT)) == Answer(("Not sent.",))
    assert outbox.sent == []
    assert tool_returns(model.seen[-1])[-1].content == "rejected by approver"


def test_approval_survives_a_restart(tmp_path: Path) -> None:
    store = JsonFileSessionStore(tmp_path)
    first, _, _, _ = build([Turn(tool_calls=(EMAIL,))], store=store)
    reply = first.handle(chat("email IT"))
    assert isinstance(reply, ApprovalRequested)
    # A new process (new harness, new model) picks the session up from the store.
    second, model, _, outbox = build([Turn(text="Email sent after restart.")], store=store)
    assert isinstance(second.state.status, AwaitingApproval)
    assert second.handle(approve(reply, LEAD, "a1", ApprovalDecision.APPROVE)) == Answer(
        ("Email sent after restart.",)
    )
    assert outbox.sent == [("it@example.com", ALICE.value)]
    assert "email IT" in user_texts(model.seen[0])


def test_conversation_history_is_persisted(tmp_path: Path) -> None:
    store = JsonFileSessionStore(tmp_path)
    first, _, _, _ = build([Turn(text="Hello Alice.")], store=store)
    first.handle(chat("hi, I am Alice"))
    second, model, _, _ = build([Turn(text="You are Alice.")], store=store)
    assert second.handle(chat("who am I?", mid="m2")) == Answer(("You are Alice.",))
    assert user_texts(model.seen[0]) == ["hi, I am Alice", "who am I?"]
    # Seen message ids are persisted too: a webhook retry after the restart is ignored.
    assert second.handle(chat("hi, I am Alice")) == Acknowledged(Ack.DUPLICATE)


def test_a_run_interrupted_by_a_restart_becomes_idle() -> None:
    store = InMemorySessionStore()
    holder: dict[str, Harness] = {}

    def crash() -> None:
        # While running, a second process loads the same session (as after a crash).
        restarted, _, _, _ = build([], store=store)
        holder["restarted"] = restarted

    h, _, _, _ = build([Turn(text="ok", before=crash)], store=store)
    h.handle(chat("hello"))
    assert holder["restarted"].state.status == Idle()


def test_loop_detection() -> None:
    same = ToolCall("echo", {"text": "again"})
    h, _, audit, _ = build([Turn(tool_calls=(same,))] * 5 + [Turn(text="never")])
    reply = h.handle(chat("loop"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.LOOP_DETECTED
    assert "loop_detected" in reply.text
    assert any(isinstance(e, RunStoppedEvent) for e in audit.events)


def test_budget() -> None:
    expensive = Turn(tool_calls=(ToolCall("echo", {"text": "x"}),), input_tokens=100_000, output_tokens=0)
    h, model, _, _ = build([expensive, Turn(text="never")], env={"AGENT_MAX_USD": "0.10"})
    reply = h.handle(chat("go"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.BUDGET
    assert model.calls == 1


def test_kill_switch() -> None:
    h, model, _, _ = build([Turn(text="hi")], kill=True)
    reply = h.handle(chat("hello"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.KILL_SWITCH
    assert model.calls == 0


def test_registered_but_unlisted_tool_is_blocked() -> None:
    h, model, audit, _ = build([Turn(tool_calls=(ToolCall("forbidden", {}),)), Turn(text="cannot")])
    assert h.handle(chat("do it")) == Answer(("cannot",))
    assert "not in the allowlist" in str(tool_returns(model.seen[1])[-1].content)
    assert any(isinstance(e, ToolDecisionEvent) and e.outcome == "denied" for e in audit.events)


def test_unknown_tool_is_refused_by_the_framework() -> None:
    h, model, _, _ = build([Turn(tool_calls=(ToolCall("delete_everything", {}),)), Turn(text="cannot")])
    assert h.handle(chat("delete")) == Answer(("cannot",))
    assert "Unknown tool name: 'delete_everything'" in str(model.seen[1][-1])


def test_duplicate_and_cancel_when_idle() -> None:
    h, _, _, _ = build([Turn(text="hello")])
    h.handle(chat("hi"))
    assert h.handle(chat("hi")) == Acknowledged(Ack.DUPLICATE)
    assert isinstance(h.handle(CancelRequest(MessageId("c1"), ALICE)), Refused)


def test_mid_run_message_from_owner_is_steered_into_the_run() -> None:
    acks: list[Reply] = []
    h: Harness | None = None

    def owner_writes() -> None:
        assert h is not None
        acks.append(h.handle(chat("also mention the unit", mid="m2")))

    h, model, _, _ = build(
        [Turn(tool_calls=(ToolCall("echo", {"text": "6"}),), before=owner_writes), Turn(text="6 units")]
    )
    assert h.handle(chat("what is 2*3?")) == Answer(("6 units",))
    assert acks == [Acknowledged(Ack.STEERED)]
    assert f"{STEER_PREFIX} also mention the unit" in user_texts(model.seen[1])


def test_mid_run_message_from_someone_else_is_queued_as_follow_up() -> None:
    acks: list[Reply] = []
    h: Harness | None = None

    def bob_writes() -> None:
        assert h is not None
        acks.append(h.handle(chat("and me?", mid="m2", who=BOB)))

    h, _, _, _ = build([Turn(text="for alice", before=bob_writes), Turn(text="for bob")])
    assert h.handle(chat("hi")) == Answer(("for alice", "for bob"))
    assert acks == [Acknowledged(Ack.QUEUED)]


def test_cancel_mid_run() -> None:
    h: Harness | None = None
    acks: list[Reply] = []

    def owner_cancels() -> None:
        assert h is not None
        acks.append(h.handle(CancelRequest(MessageId("c1"), ALICE)))

    h, model, _, _ = build(
        [Turn(tool_calls=(ToolCall("echo", {"text": "x"}),), before=owner_cancels), Turn(text="fresh")]
    )
    reply = h.handle(chat("long task"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.CANCELLED
    assert acks == [Acknowledged(Ack.CANCELLING)]
    assert h.state.status == Idle()
    assert h.handle(chat("next", mid="m2")) == Answer(("fresh",))
    issued = {c.tool_call_id for m in model.seen[-1] for c in getattr(m, "tool_calls", [])}
    assert issued <= {p.tool_call_id for p in tool_returns(model.seen[-1])}  # every call answered


def test_model_error_fails_the_run_and_the_thread_recovers() -> None:
    boom = RuntimeError("ThrottlingException: rate exceeded for key AKIAABCDEFGHIJKLMNOP")
    h, model, audit, _ = build([Turn(error=boom), Turn(text="recovered")])
    reply = h.handle(chat("hello", mid="m1"))
    assert isinstance(reply, RunFailed)
    assert "AKIA" not in reply.error and "RuntimeError" in reply.error
    assert h.state.status == Idle()
    failed = [e for e in audit.events if isinstance(e, RunFailedEvent)]
    assert len(failed) == 1 and "AKIA" not in failed[0].error and "ThrottlingException" in failed[0].error
    assert isinstance(audit.events[-1], RunFinishedEvent)
    assert h.handle(chat("again", mid="m2")) == Answer(("recovered",))
    assert user_texts(model.seen[-1]) == ["hello", "again"]  # the failed prompt stays in the history


def test_failure_after_approval_closes_the_pending_call() -> None:
    h, model, _, outbox = build(
        [Turn(tool_calls=(EMAIL,)), Turn(error=RuntimeError("boom")), Turn(text="ok")]
    )
    reply = h.handle(chat("email it"))
    assert isinstance(h.handle(approve(reply, LEAD, "a1", ApprovalDecision.APPROVE)), RunFailed)
    assert h.state.status == Idle()
    assert h.handle(chat("next", mid="m2")) == Answer(("ok",))
    # the approved call ran before the model failed; its result stays in the history
    assert outbox.sent == [("it@example.com", "auth0|alice")]
    assert "sent to it@example.com" in str(tool_returns(model.seen[-1])[-1].content)


def test_failure_with_unanswered_tool_calls_closes_them() -> None:
    crash = ToolCall("dump", {"size": -1})  # the toy tool raises OSError for a negative size
    h, model, audit, _ = build([Turn(tool_calls=(crash,)), Turn(text="ok")])
    assert isinstance(h.handle(chat("dump", mid="m1")), RunFailed)
    assert any("OSError" in e.error for e in audit.events if isinstance(e, RunFailedEvent))
    assert h.handle(chat("next", mid="m2")) == Answer(("ok",))
    assert "not executed: the run failed" in str(tool_returns(model.seen[-1])[-1].content)


def test_cancel_while_awaiting_approval_returns_thread_to_idle() -> None:
    h, model, _, outbox = build([Turn(tool_calls=(EMAIL,)), Turn(text="hello again")])
    assert isinstance(h.handle(chat("email it", mid="m1")), ApprovalRequested)
    assert h.handle(CancelRequest(MessageId("c1"), ALICE)) == Acknowledged(Ack.CANCELLING)
    assert h.state.status == Idle()
    assert h.handle(chat("hi", mid="m2")) == Answer(("hello again",))
    assert outbox.sent == []
    assert "approval was cancelled" in str(tool_returns(model.seen[-1])[-1].content)


def test_framework_usage_limit_is_a_framework_limit_stop() -> None:
    # Pydantic AI's default request_limit (50) sits behind the org turn limit; lift the org limits.
    turns = [Turn(tool_calls=(ToolCall("echo", {"text": f"t{i}"}),)) for i in range(60)]
    env = {"AGENT_MAX_TURNS": "100", "AGENT_MAX_TOOL_CALLS": "100", "AGENT_MAX_TOTAL_TOKENS": "1000000"}
    h, _, audit, _ = build(turns, env=env)
    reply = h.handle(chat("loop"))
    assert isinstance(reply, RunHalted) and reply.stop.reason is StopReason.FRAMEWORK_LIMIT
    assert "request_limit" in reply.stop.detail
    assert any(isinstance(e, RunStoppedEvent) for e in audit.events)


def test_large_tool_output_is_truncated_before_the_model_sees_it() -> None:
    h, model, _, _ = build([Turn(tool_calls=(ToolCall("dump", {"size": 50_000}),)), Turn(text="ok")])
    h.handle(chat("dump"))
    content = str(tool_returns(model.seen[1])[-1].content)
    assert len(content) < 2000 and "characters omitted" in content
    assert content.startswith("A" * 1200) and content.endswith("C" * 600)
    assert str(tool_returns(h.messages)[-1].content) == content  # compaction is persisted


def test_sliding_window_keeps_recent_turns_and_tool_pairs() -> None:
    small = ContextPolicy(
        PositiveInt(2000), PositiveInt(100), PositiveInt(100), PositiveInt(8), PositiveInt(4)
    )
    turns = [
        Turn(tool_calls=(ToolCall("echo", {"text": f"t{i}"}),)) if i % 2 == 0 else Turn(text=f"a{i}")
        for i in range(12)
    ]
    h, model, audit, _ = build(turns, context=small)
    for n in range(6):
        h.handle(chat(f"q{n}", mid=f"m{n}"))
    last = model.seen[-1]
    assert len(last) <= 8
    assert user_texts(last)[0] != "q0"
    returned = {p.tool_call_id for p in tool_returns(last)}
    issued = {c.tool_call_id for m in last for c in getattr(m, "tool_calls", [])}
    assert returned <= issued  # no orphaned tool result
    assert len(h.messages) <= 8
    compacted = [e for e in audit.events if isinstance(e, ContextCompactedEvent)]
    assert compacted and all(e.messages_after < e.messages_before for e in compacted)


@pytest.mark.parametrize("decision", [ApprovalDecision.APPROVE, ApprovalDecision.REJECT])
def test_only_one_approval_per_turn(decision: ApprovalDecision) -> None:
    two = Turn(tool_calls=(EMAIL, ToolCall("send_email", {"to": "hr@example.com", "body": "x"})))
    h, model, _, outbox = build([two, Turn(text="done")])
    reply = h.handle(chat("email both"))
    h.handle(approve(reply, LEAD, "a1", decision))
    contents = [str(p.content) for p in tool_returns(model.seen[-1])]
    assert any("only one approval-gated call" in c for c in contents)
    assert len(outbox.sent) == (1 if decision is ApprovalDecision.APPROVE else 0)
