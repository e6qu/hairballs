"""A conversation thread in AgentCore Memory: one event per message, read back per branch."""

from __future__ import annotations

import os
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal

import boto3

if TYPE_CHECKING:
    from mypy_boto3_bedrock_agentcore.type_defs import (
        CreateEventInputTypeDef,
        ListEventsInputTypeDef,
    )

MEMORY_ID = os.environ["MEMORY_HELPDESK_MEMORY_ID"]
memory = boto3.client("bedrock-agentcore", region_name="eu-west-1")


def add_message(
    actor_id: str,
    session_id: str,
    role: Literal["USER", "ASSISTANT"],
    text: str,
    branch: str | None = None,
    fork_from: str | None = None,
) -> str:
    """Store one message; return its event id. `branch` + `fork_from` start a new branch."""
    request: CreateEventInputTypeDef = {
        "memoryId": MEMORY_ID,
        "actorId": actor_id,
        "sessionId": session_id,
        "eventTimestamp": datetime.now(UTC),
        "payload": [{"conversational": {"role": role, "content": {"text": text}}}],
    }
    if branch and fork_from:
        request["branch"] = {"name": branch, "rootEventId": fork_from}  # first event of a branch
    elif branch:
        request["branch"] = {"name": branch}  # later events on the branch
    return memory.create_event(**request)["event"]["eventId"]


def read_thread(actor_id: str, session_id: str, branch: str | None = None) -> list[tuple[str, str]]:
    """(role, text) pairs of the main thread, or of a branch, oldest first."""
    request: ListEventsInputTypeDef = {
        "memoryId": MEMORY_ID,
        "actorId": actor_id,
        "sessionId": session_id,
        "includePayloads": True,
        "maxResults": 100,
    }
    if branch:
        request["filter"] = {"branch": {"name": branch, "includeParentBranches": True}}
    events = memory.list_events(**request)["events"]
    if not branch:
        events = [e for e in events if "branch" not in e]  # main-thread events carry no branch
    events.sort(key=lambda e: e["eventTimestamp"])  # the API returns newest first
    return [
        (p["conversational"]["role"], p["conversational"]["content"]["text"])
        for e in events
        for p in e["payload"]
        if "conversational" in p
    ]
