"""Context management decisions (pure): tool-output truncation and the sliding history window.

The shell projects the framework's message history onto :class:`MessageShape` values (what kind
of message it is, which tool calls it issues, which it answers), asks this module where the window
may start, and applies the answer. No framework types, no I/O.

Both rules are designed to keep the prompt cache useful:

* a tool output is truncated once, when it first enters the history, and never changes again
  (truncation is idempotent: a truncated text is already under the limit);
* the window is trimmed with hysteresis: nothing happens until the history exceeds
  ``max_messages``, then it is cut back to about ``keep_messages``, so the cached prefix is
  invalidated rarely rather than on every turn.
"""

from __future__ import annotations

import enum
from collections.abc import Sequence
from dataclasses import dataclass

from org_agents.domain import PositiveInt
from org_agents.parsing import ParseError, expect_mapping

TRUNCATION_MARKER = "\n[... {omitted} characters omitted by the harness ...]\n"
_MARKER_BUDGET = 80  # room reserved for the marker text itself


@dataclass(frozen=True, slots=True)
class ContextPolicy:
    """How much history and tool output the model sees."""

    max_tool_output_chars: PositiveInt
    keep_head_chars: PositiveInt
    keep_tail_chars: PositiveInt
    max_messages: PositiveInt
    keep_messages: PositiveInt

    def __post_init__(self) -> None:
        kept = self.keep_head_chars.value + self.keep_tail_chars.value + _MARKER_BUDGET
        if kept >= self.max_tool_output_chars.value:
            raise ValueError("keep_head_chars + keep_tail_chars must leave room below max_tool_output_chars")
        if not 2 <= self.keep_messages.value < self.max_messages.value:
            raise ValueError("keep_messages must be >= 2 and < max_messages")

    @classmethod
    def default(cls) -> ContextPolicy:
        return cls(PositiveInt(2000), PositiveInt(1200), PositiveInt(600), PositiveInt(60), PositiveInt(30))

    @classmethod
    def parse(cls, raw: object, path: str = "$.context") -> ContextPolicy:
        """Parse an optional ``[context]`` table; missing keys fall back to :meth:`default`."""
        fields = expect_mapping(raw, path)
        base = cls.default()

        def num(name: str, fallback: PositiveInt) -> PositiveInt:
            return PositiveInt.parse(fields[name], f"{path}.{name}") if name in fields else fallback

        try:
            return cls(
                num("max_tool_output_chars", base.max_tool_output_chars),
                num("keep_head_chars", base.keep_head_chars),
                num("keep_tail_chars", base.keep_tail_chars),
                num("max_messages", base.max_messages),
                num("keep_messages", base.keep_messages),
            )
        except ValueError as exc:
            if isinstance(exc, ParseError):
                raise
            raise ParseError(path, str(exc)) from exc


# ---------------------------------------------------------------- tool output truncation


@dataclass(frozen=True, slots=True)
class Unchanged:
    pass


@dataclass(frozen=True, slots=True)
class Truncated:
    text: str
    omitted_chars: int


Truncation = Unchanged | Truncated


def truncate_output(text: str, policy: ContextPolicy) -> Truncation:
    """Keep the head and the tail of an oversized tool output, with a marker in between."""
    if len(text) <= policy.max_tool_output_chars.value:
        return Unchanged()
    head = text[: policy.keep_head_chars.value]
    tail = text[-policy.keep_tail_chars.value :]
    omitted = len(text) - len(head) - len(tail)
    return Truncated(head + TRUNCATION_MARKER.format(omitted=omitted) + tail, omitted)


# ---------------------------------------------------------------- sliding window


class MessageKind(enum.Enum):
    REQUEST = "request"  # user prompt and/or tool results (sent to the model)
    RESPONSE = "response"  # model output, possibly with tool calls


@dataclass(frozen=True, slots=True)
class MessageShape:
    """What the window logic needs to know about one history message."""

    kind: MessageKind
    has_user_prompt: bool
    tool_calls: frozenset[str]  # tool call ids issued (responses)
    tool_results: frozenset[str]  # tool call ids answered (requests)


def _is_safe_start(shapes: Sequence[MessageShape], index: int) -> bool:
    """A window may start at a request carrying a user prompt, with every kept tool result's call kept."""
    first = shapes[index]
    if first.kind is not MessageKind.REQUEST or not first.has_user_prompt:
        return False
    kept = shapes[index:]
    issued = frozenset().union(*(s.tool_calls for s in kept))
    answered = frozenset().union(*(s.tool_results for s in kept))
    return answered <= issued


def window_start(shapes: Sequence[MessageShape], policy: ContextPolicy) -> int:
    """Index of the first message to keep (0 keeps everything).

    Only trims when the history is longer than ``max_messages``. Then it keeps roughly the last
    ``keep_messages`` messages, moving the cut forward (or, failing that, backward) to a safe start
    so a tool call is never separated from its result and the window starts with a user turn.
    """
    total = len(shapes)
    if total <= policy.max_messages.value:
        return 0
    target = total - policy.keep_messages.value
    for index in range(target, total):
        if _is_safe_start(shapes, index):
            return index
    for index in range(target - 1, 0, -1):
        if _is_safe_start(shapes, index):
            return index
    return 0
