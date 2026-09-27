"""Pure tests of the thread state machine (no framework, no fakes)."""

from org_agents.conversation import (
    Answer,
    ApprovalNeeded,
    ApprovalPolicy,
    ApprovalRequested,
    Completed,
)
from org_agents.core.messages import AwaitingApproval, BusyPolicy, ChatMessage, Idle, QueueFollowUp, Running
from org_agents.core.thread import ThreadState, finish, next_follow_up, receive
from org_agents.domain import ApprovalId, MessageId, PrincipalId, Prompt, ToolName

ALICE, BOB, LEAD = PrincipalId("alice"), PrincipalId("bob"), PrincipalId("lead")
POLICY = ApprovalPolicy(self_approval=False, approvers=frozenset({LEAD, ALICE}))


def test_start_queue_finish_follow_up() -> None:
    s = ThreadState.initial()
    s, _ = receive(s, ChatMessage(MessageId("1"), ALICE, Prompt("a")), BusyPolicy.STEER)
    assert s.status == Running(ALICE)
    s, action = receive(s, ChatMessage(MessageId("2"), BOB, Prompt("b")), BusyPolicy.STEER)
    assert isinstance(action, QueueFollowUp)
    s, reply = finish(s, Completed("done"), ALICE, POLICY)
    assert reply == Answer(("done",)) and s.status == Idle()
    s, queued = next_follow_up(s)
    assert queued is not None and queued.sender == BOB and s.status == Running(BOB)


def test_approval_excludes_requester_under_four_eyes() -> None:
    s = ThreadState.initial()
    s, _ = receive(s, ChatMessage(MessageId("1"), ALICE, Prompt("a")), BusyPolicy.STEER)
    s, reply = finish(s, ApprovalNeeded(ApprovalId("ap"), ToolName("create_ticket"), "x"), ALICE, POLICY)
    assert isinstance(reply, ApprovalRequested) and reply.approvers == frozenset({LEAD})
    assert isinstance(s.status, AwaitingApproval)


def test_failed_run_returns_thread_to_idle() -> None:
    from org_agents.conversation import Failed, RunFailed

    s = ThreadState.initial()
    s, _ = receive(s, ChatMessage(MessageId("1"), ALICE, Prompt("a")), BusyPolicy.STEER)
    s, reply = finish(s, Failed("ThrottlingException"), ALICE, POLICY)
    assert reply == RunFailed("ThrottlingException") and s.status == Idle()
    s, _ = receive(s, ChatMessage(MessageId("2"), ALICE, Prompt("b")), BusyPolicy.STEER)
    assert s.status == Running(ALICE)  # later messages start a new run instead of being steered forever


def test_cancel_while_awaiting_approval_goes_idle() -> None:
    from org_agents.core.messages import CancelRequest, CancelRun

    s = ThreadState.initial()
    s, _ = receive(s, ChatMessage(MessageId("1"), ALICE, Prompt("a")), BusyPolicy.STEER)
    s, _ = finish(s, ApprovalNeeded(ApprovalId("ap"), ToolName("create_ticket"), "x"), ALICE, POLICY)
    s, action = receive(s, CancelRequest(MessageId("2"), ALICE), BusyPolicy.STEER)
    assert action == CancelRun() and s.status == Idle()
