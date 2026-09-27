"""Domain types for running the helpdesk agent from events and schedules.

Outside data (the Lambda event, environment, Auth0's token response, the agent's reply, the agent's
payload) is parsed into these types at the boundary. After that, a value that exists is valid.
"""

from __future__ import annotations

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass

_RUNTIME_ARN = re.compile(r"arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime/[\w-]+")
_TICKET_ID = re.compile(r"TCK-[0-9A-Za-z]+")


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


def _fields(raw: object, path: str) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(f"{path}: expected an object")
    return raw


def _text(fields: Mapping[str, object], key: str, path: str) -> str:
    value = fields.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ParseError(f"{path}.{key}: expected a non-empty string")
    return value


# --- Configuration -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AgentArn:
    value: str

    @classmethod
    def parse(cls, raw: str) -> AgentArn:
        if not _RUNTIME_ARN.fullmatch(raw):
            raise ParseError(f"not an AgentCore runtime ARN: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class Config:
    region: str
    agent: AgentArn
    client_id: str  # the Auth0 M2M app "agent-scheduler"
    secret_id: str  # the Secrets Manager secret holding its client secret


def parse_config(env: Mapping[str, str]) -> Config:
    return Config(
        region=env.get("AWS_REGION", "eu-west-1"),
        agent=AgentArn.parse(env.get("AGENT_ARN", "")),
        client_id=_text(env, "AUTH0_CLIENT_ID", "$env"),
        secret_id=_text(env, "AUTH0_SECRET_ID", "$env"),
    )


# --- What triggered the run ----------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EventRef:
    """Where an event came from, and its id. Retried deliveries carry the same id."""

    source: str
    id: str


@dataclass(frozen=True, slots=True)
class DailyDigest:
    ref: EventRef


@dataclass(frozen=True, slots=True)
class TicketEscalated:
    ref: EventRef
    ticket_id: str


Trigger = DailyDigest | TicketEscalated


def parse_trigger(raw: object) -> Trigger:
    """An EventBridge event (rule or Scheduler input) -> Trigger."""
    event = _fields(raw, "$")
    ref = EventRef(_text(event, "source", "$"), _text(event, "id", "$"))
    if ref.source == "scheduler.daily-digest":
        return DailyDigest(ref)
    if ref.source == "fintech.tickets" and event.get("detail-type") == "TicketEscalated":
        ticket_id = _text(_fields(event.get("detail"), "$.detail"), "ticketId", "$.detail")
        if not _TICKET_ID.fullmatch(ticket_id):
            raise ParseError(f"$.detail.ticketId: not a ticket id: {ticket_id!r}")
        return TicketEscalated(ref, ticket_id)
    raise ParseError(f"$: no run for events from {ref.source!r}")


# --- Tokens, sessions, tasks ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CachedToken:
    """An Auth0 access token and the time (epoch seconds) it expires. Never printed."""

    value: str
    expires_at: float

    def __repr__(self) -> str:
        return f"CachedToken(***, expires_at={self.expires_at})"


def parse_token_response(raw: object, now: float) -> CachedToken:
    """Auth0's /oauth/token reply -> CachedToken. `now` is passed in: no clock here."""
    reply = _fields(raw, "$")
    expires_in = reply.get("expires_in")
    if not isinstance(expires_in, int) or expires_in <= 0:
        raise ParseError("$.expires_in: expected a positive integer")
    return CachedToken(_text(reply, "access_token", "$"), now + expires_in)


@dataclass(frozen=True, slots=True)
class SessionId:
    """Same id = same session VM. AgentCore requires 33 to 256 characters."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> SessionId:
        if not 33 <= len(raw) <= 256:
            raise ParseError("a session id must be 33 to 256 characters")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class Task:
    """One unit of work for the agent. The id makes a retried delivery recognisable."""

    task_id: str
    prompt: str


def parse_task(raw: object) -> Task:
    """The agent's /invocations payload -> Task."""
    payload = _fields(raw, "$")
    return Task(_text(payload, "taskId", "$"), _text(payload, "prompt", "$"))


class TaskState(enum.Enum):
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class Accepted:
    task_id: str
    state: TaskState


def parse_agent_reply(raw: object) -> Accepted:
    """The agent's reply -> Accepted. Anything else is an error."""
    reply = _fields(raw, "$")
    if reply.get("status") != "accepted":
        raise ParseError(f"$.status: the agent did not accept the task: {reply.get('status')!r}")
    try:
        state = TaskState(reply.get("state"))
    except ValueError as exc:
        raise ParseError(f"$.state: unknown task state {reply.get('state')!r}") from exc
    return Accepted(_text(reply, "taskId", "$"), state)
