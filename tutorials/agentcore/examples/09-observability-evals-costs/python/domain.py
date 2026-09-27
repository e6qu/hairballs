"""Domain types for token usage, cost and evaluations of the helpdesk harness.

Outside data (arguments, environment, InvokeHarness stream events, GetHarness and Evaluate replies)
is parsed into these types at the boundary. After that, a value that exists is valid.
"""

from __future__ import annotations

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

_HARNESS_ARN = re.compile(r"arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:harness/[\w-]+")
_HARNESS_ID = re.compile(r"[A-Za-z][A-Za-z0-9_]*-[A-Za-z0-9]+")
_EVALUATOR_ID = re.compile(r"Builtin\.[A-Za-z]+|arn:aws[a-z-]*:bedrock-agentcore:\S+:evaluator/\S+")


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


def _fields(raw: object, path: str) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(f"{path}: expected an object")
    return raw


def _text(fields: Mapping[str, object], key: str, path: str) -> str:
    value = fields.get(key)
    if not isinstance(value, str) or not value:
        raise ParseError(f"{path}.{key}: expected a non-empty string")
    return value


@dataclass(frozen=True, slots=True)
class HarnessArn:
    value: str

    @classmethod
    def parse(cls, raw: str) -> HarnessArn:
        if not _HARNESS_ARN.fullmatch(raw):
            raise ParseError(f"not a harness ARN: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class HarnessId:
    value: str

    @classmethod
    def parse(cls, raw: str) -> HarnessId:
        if not _HARNESS_ID.fullmatch(raw):
            raise ParseError(f"not a harness id: {raw!r}")
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


# --- Tokens and money ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TokenUsage:
    """Token counts of one or more model calls. Every count is >= 0 (see parse_usage)."""

    input: int
    output: int
    cache_read: int
    cache_write: int


ZERO_USAGE = TokenUsage(0, 0, 0, 0)


def _count(fields: Mapping[str, object], key: str) -> int:
    value = fields.get(key, 0)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ParseError(f"$.usage.{key}: expected a count >= 0")
    return value


def parse_usage(raw: object) -> TokenUsage:
    usage = _fields(raw, "$.usage")
    return TokenUsage(
        input=_count(usage, "inputTokens"),  # uncached input
        output=_count(usage, "outputTokens"),
        cache_read=_count(usage, "cacheReadInputTokens"),
        cache_write=_count(usage, "cacheWriteInputTokens"),
    )


@dataclass(frozen=True, slots=True)
class Prices:
    """USD per million tokens. Money is Decimal, never float."""

    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write: Decimal


HAIKU_4_5 = Prices(  # global profile; cache read 10%, 5-minute cache write 125% of input
    input=Decimal("1.00"),
    output=Decimal("5.00"),
    cache_read=Decimal("0.10"),
    cache_write=Decimal("1.25"),
)


# --- The InvokeHarness stream ----------------------------------------------------------------


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
class UsageReported:
    usage: TokenUsage


@dataclass(frozen=True, slots=True)
class Stopped:
    reason: StopReason


StreamEvent = TextDelta | UsageReported | Stopped


def parse_stream_event(raw: Mapping[str, object]) -> StreamEvent | None:
    """One InvokeHarness stream event, or None for events this client ignores."""
    if "contentBlockDelta" in raw:
        text = _fields(_fields(raw["contentBlockDelta"], "$").get("delta", {}), "$").get("text")
        return TextDelta(text) if isinstance(text, str) and text else None
    if "metadata" in raw:
        return UsageReported(parse_usage(_fields(raw["metadata"], "$.metadata").get("usage")))
    if "messageStop" in raw:
        reason = _fields(raw["messageStop"], "$.messageStop").get("stopReason")
        try:
            return Stopped(StopReason(reason))
        except ValueError as exc:
            raise ParseError(f"unknown stop reason: {reason!r}") from exc
    return None


# --- Evaluations ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class EvaluatorId:
    value: str

    @classmethod
    def parse(cls, raw: str) -> EvaluatorId:
        if not _EVALUATOR_ID.fullmatch(raw):
            raise ParseError(f"not an evaluator id: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class RuntimeId:
    """The Runtime agent a harness runs on. Its traces are stored under this id."""

    value: str


def parse_runtime_id(get_harness_reply: object) -> RuntimeId:
    harness = _fields(_fields(get_harness_reply, "$").get("harness"), "$.harness")
    env = _fields(harness.get("environment"), "$.harness.environment")
    runtime = _fields(env.get("agentCoreRuntimeEnvironment"), "$.harness.environment.runtime")
    return RuntimeId(_text(runtime, "agentRuntimeId", "$.harness.environment.runtime"))


@dataclass(frozen=True, slots=True)
class Scored:
    evaluator: str
    value: float
    label: str
    explanation: str


@dataclass(frozen=True, slots=True)
class NotScored:
    evaluator: str
    reason: str


Evaluation = Scored | NotScored


def parse_evaluation(raw: object) -> Evaluation:
    """One entry of evaluationResults -> Scored, or NotScored with the service's reason."""
    result = _fields(raw, "$")
    evaluator = _text(result, "evaluatorId", "$")
    value = result.get("value")
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        message = result.get("errorMessage")
        return NotScored(evaluator, message if isinstance(message, str) else "no score")
    label = result.get("label")
    explanation = result.get("explanation")
    return Scored(
        evaluator,
        float(value),
        label if isinstance(label, str) else "",
        explanation if isinstance(explanation, str) else "",
    )
