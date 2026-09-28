"""Write a short thread, then fork it: the user edits their second question (the shell).

Usage: MEMORY_HELPDESK_MEMORY_ID=... uv run python fork.py
"""

from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime

from core import thread
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
)
from memory import add_message, read_events

memory = MemoryId.parse(os.environ.get("MEMORY_HELPDESK_MEMORY_ID"))
user = ActorId.parse("usr_7f3a9c")  # a stable user id (tutorial 06 takes it from the token)
session = SessionId.parse(str(uuid.uuid4()))
lyon = BranchName.parse("lyon")


def say(role: Role, text: str, where: Placement = OnMain()) -> EventId:
    return add_message(memory, user, session, Message.of(role, text), where, datetime.now(UTC))


say(Role.USER, "What is the hotel limit per night?")
answer = say(Role.ASSISTANT, "Up to 180 EUR in major cities.")
say(Role.USER, "Is Paris a major city?")
say(Role.ASSISTANT, "Yes.")

# Fork after the first answer: the second question becomes "Is Lyon a major city?".
say(Role.USER, "Is Lyon a major city?", StartBranch(lyon, fork_after=answer))
say(Role.ASSISTANT, "Yes.", OnBranch(lyon))

print("main:", thread(read_events(memory, user, session, None), on_branch=False))
print("lyon:", thread(read_events(memory, user, session, lyon), on_branch=True))
