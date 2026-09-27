"""Pure logic: no AWS, no network, no clock, no randomness."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass

from domain import (
    CachedToken,
    DailyDigest,
    EventRef,
    SessionId,
    Task,
    TaskState,
    TicketEscalated,
    Trigger,
)

TOKEN_MARGIN_SECONDS = 60


def session_id_for(ref: EventRef) -> SessionId:
    """Same event -> same session id, so a retried delivery reaches the same agent session."""
    return SessionId.parse(hashlib.sha256(f"{ref.source}:{ref.id}".encode()).hexdigest())


def task_for(trigger: Trigger) -> Task:
    match trigger:
        case DailyDigest(ref=ref):
            prompt = "Write the daily digest of open high-priority tickets and post it as a note."
            return Task(ref.id, prompt)
        case TicketEscalated(ref=ref, ticket_id=ticket_id):
            return Task(ref.id, f"Ticket {ticket_id} was escalated. Triage it and add a note.")


def usable(token: CachedToken | None, now: float) -> CachedToken | None:
    """The cached token if it is valid for at least another minute, else None."""
    if token is not None and now < token.expires_at - TOKEN_MARGIN_SECONDS:
        return token
    return None


@dataclass(frozen=True, slots=True)
class Start:
    """A new task: start it in the background."""


@dataclass(frozen=True, slots=True)
class AlreadyKnown:
    """A retried delivery: report the state, start nothing."""

    state: TaskState


def on_task(known: Mapping[str, TaskState], task: Task) -> Start | AlreadyKnown:
    state = known.get(task.task_id)
    return Start() if state is None else AlreadyKnown(state)


def accepted(task: Task, state: TaskState) -> dict[str, str]:
    """The agent's reply body."""
    return {"status": "accepted", "taskId": task.task_id, "state": state.value}
