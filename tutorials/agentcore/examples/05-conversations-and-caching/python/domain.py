"""Domain types for conversation threads in AgentCore Memory.

Outside data (the HTTP payload, the session header, the environment, Memory events, Converse usage)
is parsed into these types at the boundary. After that, a value that exists is valid.
"""

from __future__ import annotations

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime

_MEMORY_ID = re.compile(r"[a-zA-Z][a-zA-Z0-9_-]{0,99}-[a-zA-Z0-9]{10}")
_ACTOR_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_/-]*(?::[a-zA-Z0-9_/-]+)*[a-zA-Z0-9_/-]*")
_SESSION_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{32,99}")
_EVENT_ID = re.compile(r"[0-9]+#[a-fA-F0-9]+")
_BRANCH = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}")


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


@dataclass(frozen=True, slots=True)
class MemoryId:
    value: str

    @classmethod
    def parse(cls, raw: str | None) -> MemoryId:
        if raw is None or not _MEMORY_ID.fullmatch(raw):
            raise ParseError(f"not a memory id: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class ActorId:
    """Whose memory this is: a stable user id. Letters, digits, - _ / and :, never '|'."""

    value: str

    @classmethod
    def parse(cls, raw: object) -> ActorId:
        if not isinstance(raw, str) or len(raw) > 255 or not _ACTOR_ID.fullmatch(raw):
            raise ParseError(f"not an actor id: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class SessionId:
    """A Runtime session (33 to 256 characters) that is also a valid Memory session (up to 100)."""

    value: str

    @classmethod
    def parse(cls, raw: str | None) -> SessionId:
        if raw is None or not _SESSION_ID.fullmatch(raw):
            raise ParseError("a session id must be 33 to 100 letters, digits, - or _ (use a UUID)")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class EventId:
    value: str

    @classmethod
    def parse(cls, raw: object) -> EventId:
        if not isinstance(raw, str) or not _EVENT_ID.fullmatch(raw):
            raise ParseError(f"not an event id: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class BranchName:
    value: str

    @classmethod
    def parse(cls, raw: object) -> BranchName:
        if not isinstance(raw, str) or not _BRANCH.fullmatch(raw):
            raise ParseError(f"not a branch name: {raw!r}")
        return cls(raw)


class Role(enum.Enum):
    USER = "USER"
    ASSISTANT = "ASSISTANT"


@dataclass(frozen=True, slots=True)
class Message:
    role: Role
    text: str

    @classmethod
    def of(cls, role: Role, text: str) -> Message:
        if not text.strip():
            raise ParseError("a message needs text")
        return cls(role, text)


# Where a new message goes. A fork point without a branch can't be expressed.
@dataclass(frozen=True, slots=True)
class OnMain:
    pass


@dataclass(frozen=True, slots=True)
class StartBranch:
    branch: BranchName
    fork_after: EventId  # the last event the branch keeps


@dataclass(frozen=True, slots=True)
class OnBranch:
    branch: BranchName


Placement = OnMain | StartBranch | OnBranch


# The two kinds of stored event.
@dataclass(frozen=True, slots=True)
class MainEvent:
    event_id: EventId
    at: datetime
    messages: tuple[Message, ...]


@dataclass(frozen=True, slots=True)
class BranchEvent:
    event_id: EventId
    at: datetime
    branch: BranchName
    messages: tuple[Message, ...]


ThreadEvent = MainEvent | BranchEvent


def _fields(raw: object, path: str) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(f"{path} must be an object")
    return raw


def _message(raw: object) -> Message | None:
    """A conversational USER/ASSISTANT payload item; None for anything else."""
    conversational = _fields(raw, "$.payload[]").get("conversational")
    if conversational is None:
        return None
    fields = _fields(conversational, "$.payload[].conversational")
    text = _fields(fields.get("content"), "$.payload[].conversational.content").get("text")
    if fields.get("role") not in ("USER", "ASSISTANT") or not isinstance(text, str) or not text:
        return None
    return Message(Role(fields["role"]), text)


def parse_event(raw: Mapping[str, object]) -> ThreadEvent:
    """One event from ListEvents."""
    event_id = EventId.parse(raw.get("eventId"))
    at = raw.get("eventTimestamp")
    if not isinstance(at, datetime):
        raise ParseError("$.eventTimestamp must be a timestamp")
    payload = raw.get("payload", [])
    items = payload if isinstance(payload, list) else []
    messages = tuple(m for m in (_message(item) for item in items) if m is not None)
    branch = raw.get("branch")
    if branch is None:
        return MainEvent(event_id, at, messages)
    name = BranchName.parse(_fields(branch, "$.branch").get("name"))
    return BranchEvent(event_id, at, name, messages)


@dataclass(frozen=True, slots=True)
class Invocation:
    prompt: str
    actor: ActorId


def parse_invocation(raw: object) -> Invocation:
    """The /invocations body: {"prompt": "...", "user_id": "..."} (user_id optional)."""
    fields = _fields(raw, "$")
    prompt = fields.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ParseError("$.prompt must be a non-empty string")
    return Invocation(prompt.strip(), ActorId.parse(fields.get("user_id", "anonymous")))


@dataclass(frozen=True, slots=True)
class CacheUsage:
    uncached: int
    cache_write: int
    cache_read: int


def parse_usage(raw: Mapping[str, object]) -> CacheUsage:
    """The `usage` of a Converse response."""

    def count(key: str) -> int:
        value = raw.get(key, 0)
        if not isinstance(value, int) or value < 0:
            raise ParseError(f"$.usage.{key} must be a count")
        return value

    return CacheUsage(
        count("inputTokens"), count("cacheWriteInputTokens"), count("cacheReadInputTokens")
    )
