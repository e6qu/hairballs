"""Domain types for the helpdesk agent and its callers.

Outside data (the HTTP payload, the session header, tool arguments from the model, Strands stream
events, the environment, server-sent events) is parsed into these types at the boundary. After
that, a value that exists is valid: no code downstream re-checks it.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass

_RUNTIME_ARN = re.compile(
    r"arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime/[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+"
)
_TICKET_ID = re.compile(r"TCK-[0-9a-f]{8}")


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


@dataclass(frozen=True, slots=True)
class AgentRuntimeArn:
    value: str

    @classmethod
    def parse(cls, raw: str) -> AgentRuntimeArn:
        if not _RUNTIME_ARN.fullmatch(raw):
            raise ParseError(f"not an agent runtime ARN: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class SessionId:
    """Same id = same session VM and conversation. AgentCore requires 33 to 256 characters."""

    value: str

    @classmethod
    def parse(cls, raw: str | None) -> SessionId:
        if raw is None or not 33 <= len(raw) <= 256:
            raise ParseError("a session id must be 33 to 256 characters (use a UUID)")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class Prompt:
    text: str

    @classmethod
    def parse(cls, raw: object) -> Prompt:
        if not isinstance(raw, str) or not raw.strip():
            raise ParseError("$.prompt must be a non-empty string")
        return cls(raw.strip())


def parse_invocation(raw: object) -> Prompt:
    """The /invocations body: {"prompt": "..."}."""
    if not isinstance(raw, Mapping):
        raise ParseError("$ must be a JSON object")
    return Prompt.parse(raw.get("prompt"))


@dataclass(frozen=True, slots=True)
class TicketRequest:
    """What the model asked for, once both fields hold text."""

    title: str
    description: str

    @classmethod
    def parse(cls, title: str, description: str) -> TicketRequest:
        if not title.strip() or not description.strip():
            raise ParseError("a ticket needs a title and a description")
        return cls(title.strip(), description.strip())


@dataclass(frozen=True, slots=True)
class TicketId:
    value: str

    @classmethod
    def parse(cls, raw: str) -> TicketId:
        if not _TICKET_ID.fullmatch(raw):
            raise ParseError(f"not a ticket id: {raw!r}")
        return cls(raw)


def parse_agent_text(raw: Mapping[str, object]) -> str | None:
    """The text in one Strands stream event, or None for the other events."""
    data = raw.get("data")
    return data if isinstance(data, str) and data else None


@dataclass(frozen=True, slots=True)
class AnswerText:
    text: str


@dataclass(frozen=True, slots=True)
class AgentFailed:
    message: str


AnswerEvent = AnswerText | AgentFailed
"""One server-sent event from the agent."""


def parse_sse_line(line: str) -> AnswerEvent | None:
    """A `data: ...` line of the /invocations stream, or None for other lines."""
    if not line.startswith("data: "):
        return None
    try:
        data: object = json.loads(line.removeprefix("data: "))
    except json.JSONDecodeError as exc:
        raise ParseError(f"not JSON: {line!r}") from exc
    if isinstance(data, str):
        return AnswerText(data)
    if isinstance(data, Mapping) and isinstance(data.get("error"), str):
        return AgentFailed(str(data["error"]))
    raise ParseError(f"unexpected event: {line!r}")
