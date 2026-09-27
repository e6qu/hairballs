"""Domain types for talking to the helpdesk agent.

Data from outside the program (arguments, environment, the AgentCore stream) is parsed into these types at the
boundary. After that, a value that exists is valid: no code downstream re-checks it.
"""

from __future__ import annotations

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass

_HARNESS_ARN = re.compile(
    r"arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:harness/[A-Za-z0-9_-]+"
)


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


@dataclass(frozen=True, slots=True)
class HarnessArn:
    value: str

    @classmethod
    def parse(cls, raw: str) -> HarnessArn:
        if not _HARNESS_ARN.fullmatch(raw):
            raise ParseError(f"not a harness ARN: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class SessionId:
    """Same id = same session VM and conversation. AgentCore requires 33 to 256 characters."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> SessionId:
        if not 33 <= len(raw) <= 256:
            raise ParseError("a session id must be 33 to 256 characters (use a UUID)")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class Question:
    text: str

    @classmethod
    def parse(cls, raw: str) -> Question:
        text = raw.strip()
        if not text:
            raise ParseError("the question is empty")
        return cls(text)


class StopReason(enum.Enum):
    END_TURN = "end_turn"
    TOOL_USE = "tool_use"
    TOOL_RESULT = "tool_result"
    MAX_TOKENS = "max_tokens"
    STOP_SEQUENCE = "stop_sequence"
    CONTENT_FILTERED = "content_filtered"
    MALFORMED_MODEL_OUTPUT = "malformed_model_output"
    MALFORMED_TOOL_USE = "malformed_tool_use"
    INTERRUPTED = "interrupted"
    PARTIAL_TURN = "partial_turn"
    MODEL_CONTEXT_WINDOW_EXCEEDED = "model_context_window_exceeded"
    MAX_ITERATIONS_EXCEEDED = "max_iterations_exceeded"
    MAX_OUTPUT_TOKENS_EXCEEDED = "max_output_tokens_exceeded"
    TIMEOUT_EXCEEDED = "timeout_exceeded"
    HOOK_STOPPED = "hook_stopped"


@dataclass(frozen=True, slots=True)
class TextDelta:
    text: str


@dataclass(frozen=True, slots=True)
class Stopped:
    reason: StopReason


@dataclass(frozen=True, slots=True)
class AgentFailed:
    message: str


StreamEvent = TextDelta | Stopped | AgentFailed
"""The parts of the InvokeHarness stream this client uses."""


def _fields(raw: object) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(f"expected an object, got {type(raw).__name__}")
    return raw


def parse_stream_event(raw: Mapping[str, object]) -> StreamEvent | None:
    """One event from the InvokeHarness stream, or None for events this client ignores."""
    if "contentBlockDelta" in raw:
        text = _fields(_fields(raw["contentBlockDelta"]).get("delta", {})).get("text")
        return TextDelta(text) if isinstance(text, str) and text else None
    if "messageStop" in raw:
        reason = _fields(raw["messageStop"]).get("stopReason")
        try:
            return Stopped(StopReason(reason))
        except ValueError as exc:
            raise ParseError(f"unknown stop reason: {reason!r}") from exc
    if "runtimeClientError" in raw:
        message = _fields(raw["runtimeClientError"]).get("message")
        return AgentFailed(message if isinstance(message, str) else "the agent failed")
    return None
