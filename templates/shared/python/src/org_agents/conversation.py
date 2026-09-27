"""Conversation domain types shared by all agents: approval policy, run outcomes and replies."""

from __future__ import annotations

import enum
from dataclasses import dataclass

from org_agents.core.guard import StopRun
from org_agents.domain import ApprovalId, PrincipalId, ToolName
from org_agents.parsing import expect_bool, expect_mapping, expect_sequence


@dataclass(frozen=True, slots=True)
class ApprovalPolicy:
    """Who may approve side-effecting tool calls. Four-eyes by default (no self-approval)."""

    self_approval: bool
    approvers: frozenset[PrincipalId]

    def approvers_for(self, owner: PrincipalId) -> frozenset[PrincipalId]:
        return self.approvers | {owner} if self.self_approval else self.approvers - {owner}

    @classmethod
    def parse(cls, raw: object, path: str = "$.approvals") -> ApprovalPolicy:
        fields = expect_mapping(raw, path)
        approvers = expect_sequence(fields.get("approvers", []), f"{path}.approvers")
        return cls(
            self_approval=expect_bool(fields.get("self_approval", False), f"{path}.self_approval"),
            approvers=frozenset(
                PrincipalId.parse(item, f"{path}.approvers[{i}]") for i, item in enumerate(approvers)
            ),
        )


# ---------------------------------------------------------------- run outcomes (shell → core)


@dataclass(frozen=True, slots=True)
class Completed:
    text: str


@dataclass(frozen=True, slots=True)
class ApprovalNeeded:
    approval_id: ApprovalId
    tool: ToolName
    reason: str


@dataclass(frozen=True, slots=True)
class Stopped:
    stop: StopRun
    text: str


@dataclass(frozen=True, slots=True)
class Failed:
    """The framework or model provider raised (throttling, validation, network...).
    The thread must return to idle so later messages are answered."""

    error: str


RunOutcome = Completed | ApprovalNeeded | Stopped | Failed


# ---------------------------------------------------------------- replies (core → shell)


class Ack(enum.Enum):
    STEERED = "steered"
    QUEUED = "queued"
    CANCELLING = "cancelling"
    DUPLICATE = "duplicate"


@dataclass(frozen=True, slots=True)
class Answer:
    texts: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ApprovalRequested:
    approval_id: ApprovalId
    tool: ToolName
    reason: str
    approvers: frozenset[PrincipalId]


@dataclass(frozen=True, slots=True)
class RunHalted:
    stop: StopRun
    text: str


@dataclass(frozen=True, slots=True)
class Acknowledged:
    ack: Ack


@dataclass(frozen=True, slots=True)
class Refused:
    reason: str


@dataclass(frozen=True, slots=True)
class RunFailed:
    error: str


Reply = Answer | ApprovalRequested | RunHalted | RunFailed | Acknowledged | Refused
