"""A conversation thread in AgentCore Memory: one event per message (the shell's Memory I/O)."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Literal

import boto3

from domain import (
    ActorId,
    BranchName,
    EventId,
    MemoryId,
    Message,
    OnBranch,
    OnMain,
    Placement,
    Role,
    SessionId,
    StartBranch,
    ThreadEvent,
    parse_event,
)

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore.type_defs import (
        BranchTypeDef,
        CreateEventInputTypeDef,
        ListEventsInputTypeDef,
    )

client = boto3.client("bedrock-agentcore", region_name="eu-west-1")


def _role(role: Role) -> Literal["USER", "ASSISTANT"]:
    match role:
        case Role.USER:
            return "USER"
        case Role.ASSISTANT:
            return "ASSISTANT"


def _branch(placement: Placement) -> BranchTypeDef | None:
    match placement:
        case OnMain():
            return None
        case StartBranch(branch=branch, fork_after=root):
            return {"name": branch.value, "rootEventId": root.value}  # first event of a branch
        case OnBranch(branch=branch):
            return {"name": branch.value}  # later events on the branch


def add_message(
    memory: MemoryId,
    actor: ActorId,
    session: SessionId,
    message: Message,
    placement: Placement,
    at: datetime,
) -> EventId:
    """Store one message; return its event id."""
    request: CreateEventInputTypeDef = {
        "memoryId": memory.value,
        "actorId": actor.value,
        "sessionId": session.value,
        "eventTimestamp": at,
        "payload": [
            {"conversational": {"role": _role(message.role), "content": {"text": message.text}}}
        ],
    }
    branch = _branch(placement)
    if branch:
        request["branch"] = branch
    response = client.create_event(**request)
    return EventId.parse(response["event"]["eventId"])


def read_events(
    memory: MemoryId, actor: ActorId, session: SessionId, branch: BranchName | None
) -> list[ThreadEvent]:
    """The session's events, or one branch's with the history it grew from."""
    request: ListEventsInputTypeDef = {
        "memoryId": memory.value,
        "actorId": actor.value,
        "sessionId": session.value,
        "includePayloads": True,
        "maxResults": 100,
    }
    if branch:
        request["filter"] = {"branch": {"name": branch.value, "includeParentBranches": True}}
    response = client.list_events(**request)
    return [parse_event(raw) for raw in response["events"]]  # outside data -> domain types
