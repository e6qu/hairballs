"""Thread state machine (pure): what a conversation thread is doing, and how messages and run
outcomes move it along. The shell stores the state and performs the actions this module returns."""

from __future__ import annotations

from dataclasses import dataclass, replace

from org_agents.conversation import (
    Answer,
    ApprovalNeeded,
    ApprovalPolicy,
    ApprovalRequested,
    Completed,
    Reply,
    RunHalted,
    RunOutcome,
    Stopped,
)
from org_agents.core.messages import (
    AwaitingApproval,
    BusyPolicy,
    DeliverApproval,
    Idle,
    Incoming,
    MessageAction,
    QueueFollowUp,
    Running,
    StartRun,
    ThreadStatus,
    on_message,
)
from org_agents.domain import MessageId, PrincipalId, Prompt


@dataclass(frozen=True, slots=True)
class QueuedPrompt:
    sender: PrincipalId
    prompt: Prompt


@dataclass(frozen=True, slots=True)
class ThreadState:
    status: ThreadStatus
    seen: frozenset[MessageId]
    follow_ups: tuple[QueuedPrompt, ...]

    @classmethod
    def initial(cls) -> ThreadState:
        return cls(Idle(), frozenset(), ())


def receive(state: ThreadState, message: Incoming, busy: BusyPolicy) -> tuple[ThreadState, MessageAction]:
    action = on_message(state.status, message, state.seen, busy)
    state = replace(state, seen=state.seen | {message.message_id})
    match action:
        case StartRun():
            return replace(state, status=Running(owner=message.sender)), action
        case QueueFollowUp(prompt=prompt):
            queued = QueuedPrompt(message.sender, prompt)
            return replace(state, follow_ups=(*state.follow_ups, queued)), action
        case DeliverApproval():
            match state.status:
                case AwaitingApproval(owner=owner):
                    return replace(state, status=Running(owner=owner)), action
                case _:
                    return state, action
        case _:
            return state, action


def finish(
    state: ThreadState, outcome: RunOutcome, owner: PrincipalId, approvals: ApprovalPolicy
) -> tuple[ThreadState, Reply]:
    match outcome:
        case Completed(text=text):
            return replace(state, status=Idle()), Answer((text,))
        case ApprovalNeeded(approval_id=aid, tool=tool, reason=reason):
            approvers = approvals.approvers_for(owner)
            status = AwaitingApproval(owner=owner, approval_id=aid, approvers=approvers)
            return replace(state, status=status), ApprovalRequested(aid, tool, reason, approvers)
        case Stopped(stop=stop, text=text):
            # A stopped run also drops queued follow-ups: limits apply to the thread's work, not one prompt.
            return replace(state, status=Idle(), follow_ups=()), RunHalted(stop, text)


def next_follow_up(state: ThreadState) -> tuple[ThreadState, QueuedPrompt | None]:
    """Pop the next queued prompt when the thread is idle; the thread runs on behalf of its sender."""
    if not isinstance(state.status, Idle) or not state.follow_ups:
        return state, None
    queued, *rest = state.follow_ups
    return replace(state, status=Running(owner=queued.sender), follow_ups=tuple(rest)), queued


def merge_answers(first: Reply, later: Reply) -> Reply:
    if isinstance(first, Answer) and isinstance(later, Answer):
        return Answer(first.texts + later.texts)
    return later
