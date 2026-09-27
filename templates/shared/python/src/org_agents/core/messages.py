"""What to do with a message that arrives on a thread (pure).

Covers the cases agents in chat threads must handle: duplicates (webhook retries), messages
arriving while a run is busy (steer vs. queue), cancellation, and approval responses.
"""

from __future__ import annotations

import enum
from collections.abc import Set
from dataclasses import dataclass

from org_agents.domain import ApprovalDecision, ApprovalId, MessageId, PrincipalId, Prompt


class BusyPolicy(enum.Enum):
    """How a new message from the run's own principal is handled while the run is busy."""

    STEER = "steer"  # inject before the next model call, within the same run
    QUEUE = "queue"  # deliver as a follow-up once the run finishes
    REJECT = "reject"  # tell the sender the agent is busy


# ---------------------------------------------------------------- inputs


@dataclass(frozen=True, slots=True)
class ChatMessage:
    message_id: MessageId
    sender: PrincipalId
    prompt: Prompt


@dataclass(frozen=True, slots=True)
class CancelRequest:
    message_id: MessageId
    sender: PrincipalId


@dataclass(frozen=True, slots=True)
class ApprovalResponse:
    message_id: MessageId
    sender: PrincipalId
    approval_id: ApprovalId
    decision: ApprovalDecision


Incoming = ChatMessage | CancelRequest | ApprovalResponse


@dataclass(frozen=True, slots=True)
class Idle:
    pass


@dataclass(frozen=True, slots=True)
class Running:
    owner: PrincipalId


@dataclass(frozen=True, slots=True)
class AwaitingApproval:
    owner: PrincipalId
    approval_id: ApprovalId
    approvers: frozenset[PrincipalId]


ThreadStatus = Idle | Running | AwaitingApproval


# ---------------------------------------------------------------- actions


@dataclass(frozen=True, slots=True)
class StartRun:
    prompt: Prompt


@dataclass(frozen=True, slots=True)
class Steer:
    prompt: Prompt


@dataclass(frozen=True, slots=True)
class QueueFollowUp:
    prompt: Prompt


@dataclass(frozen=True, slots=True)
class CancelRun:
    pass


@dataclass(frozen=True, slots=True)
class DeliverApproval:
    approval_id: ApprovalId
    decision: ApprovalDecision
    approver: PrincipalId


@dataclass(frozen=True, slots=True)
class IgnoreDuplicate:
    pass


@dataclass(frozen=True, slots=True)
class Reject:
    reason: str


MessageAction = StartRun | Steer | QueueFollowUp | CancelRun | DeliverApproval | IgnoreDuplicate | Reject


def on_message(
    status: ThreadStatus,
    message: Incoming,
    seen: Set[MessageId],
    busy_policy: BusyPolicy,
) -> MessageAction:
    if message.message_id in seen:
        return IgnoreDuplicate()

    match message, status:
        case CancelRequest(sender=sender), (Running(owner=owner) | AwaitingApproval(owner=owner)):
            return CancelRun() if sender == owner else Reject("only the run owner can cancel")
        case CancelRequest(), Idle():
            return Reject("nothing to cancel")

        case ApprovalResponse(sender=sender, approval_id=aid, decision=decision), AwaitingApproval(
            approval_id=pending, approvers=approvers
        ):
            if aid != pending:
                return Reject("approval id does not match the pending request")
            if sender not in approvers:
                return Reject("sender is not an authorised approver")
            return DeliverApproval(aid, decision, sender)
        case ApprovalResponse(), _:
            return Reject("no approval is pending")

        case ChatMessage(prompt=prompt), Idle():
            return StartRun(prompt)
        case ChatMessage(sender=sender, prompt=prompt), Running(owner=owner):
            if sender != owner:
                return QueueFollowUp(prompt)
            match busy_policy:
                case BusyPolicy.STEER:
                    return Steer(prompt)
                case BusyPolicy.QUEUE:
                    return QueueFollowUp(prompt)
                case BusyPolicy.REJECT:
                    return Reject("the agent is busy with this thread")
        case ChatMessage(prompt=prompt), AwaitingApproval():
            return QueueFollowUp(prompt)

    raise AssertionError("unreachable")  # pragma: no cover
