"""Context management as a Pydantic AI history processor (shell).

Projects the framework's ``ModelMessage`` history onto the pure ``MessageShape`` view, lets the
core decide (``truncate_output``, ``window_start``) and applies the result. Registered through the
``ProcessHistory`` capability (``pydantic_ai/capabilities/process_history.py``); in pydantic-ai 2.x
the processed history *replaces* the stored history (``_agent_graph.py``: ``message_history[:] =
messages``), so compaction is persistent and sessions stay bounded.

The system prompt is passed as ``instructions`` (sent with every request, not stored in the
history), so trimming old turns never drops it.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import replace

from pydantic_ai.capabilities import ProcessHistory
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelRequestPart,
    ModelResponse,
    RetryPromptPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

from org_pydantic_harness.core.context import (
    ContextPolicy,
    MessageKind,
    MessageShape,
    Truncated,
    Unchanged,
    truncate_output,
    window_start,
)
from org_pydantic_harness.shell.deps import HarnessDeps


def shape_of(message: ModelMessage) -> MessageShape:
    if isinstance(message, ModelResponse):
        calls = frozenset(p.tool_call_id for p in message.parts if isinstance(p, ToolCallPart))
        return MessageShape(MessageKind.RESPONSE, False, calls, frozenset())
    answered = frozenset(
        p.tool_call_id
        for p in message.parts
        if isinstance(p, ToolReturnPart) or (isinstance(p, RetryPromptPart) and p.tool_name is not None)
    )
    has_prompt = any(isinstance(p, UserPromptPart) for p in message.parts)
    return MessageShape(MessageKind.REQUEST, has_prompt, frozenset(), answered)


def _truncate_part(part: ModelRequestPart, policy: ContextPolicy) -> ModelRequestPart:
    if not isinstance(part, ToolReturnPart):
        return part
    text = part.content if isinstance(part.content, str) else part.model_response_str()
    match truncate_output(text, policy):
        case Unchanged():
            return part
        case Truncated(text=short):
            return replace(part, content=short)


def truncate_tool_outputs(messages: Sequence[ModelMessage], policy: ContextPolicy) -> list[ModelMessage]:
    out: list[ModelMessage] = []
    for message in messages:
        if isinstance(message, ModelRequest):
            parts = [_truncate_part(p, policy) for p in message.parts]
            changed = any(new is not old for new, old in zip(parts, message.parts, strict=True))
            out.append(replace(message, parts=parts) if changed else message)
        else:
            out.append(message)
    return out


def compact_history(messages: Sequence[ModelMessage], policy: ContextPolicy) -> list[ModelMessage]:
    """Truncate oversized tool outputs, then keep a sliding window of recent turns."""
    truncated = truncate_tool_outputs(messages, policy)
    start = window_start([shape_of(m) for m in truncated], policy)
    return truncated[start:]


def context_capability(
    policy: ContextPolicy, on_compacted: Callable[[int, int], None] | None = None
) -> ProcessHistory[HarnessDeps]:
    """``on_compacted(before, after)`` is called when the window drops messages (for the audit log)."""

    def processor(messages: list[ModelMessage]) -> list[ModelMessage]:
        compacted = compact_history(messages, policy)
        if on_compacted is not None and len(compacted) < len(messages):
            on_compacted(len(messages), len(compacted))
        return compacted

    return ProcessHistory(processor)
