"""Pure logic: no AWS, no I/O. Easy to test and to read."""

from __future__ import annotations

from domain import (
    AgentFailed,
    StopReason,
    Stopped,
    StreamEvent,
    TextDelta,
    ToolCalled,
    ToolInputDelta,
)

_LIMITS = {
    StopReason.MAX_ITERATIONS_EXCEEDED,
    StopReason.MAX_TOKENS,
    StopReason.MAX_OUTPUT_TOKENS_EXCEEDED,
    StopReason.TIMEOUT_EXCEEDED,
}


def render(event: StreamEvent) -> str:
    """What to print for one event. Tool calls are shown, so you can watch the skill load."""
    match event:
        case TextDelta(text=text) | ToolInputDelta(text=text):
            return text
        case ToolCalled(name=name):
            return f"\n[tool {name}] "
        case Stopped(reason=StopReason.TOOL_USE | StopReason.TOOL_RESULT):
            return ""
        case Stopped(reason=reason) if reason in _LIMITS:
            return f"\n[stopped: a limit was hit ({reason.value})]\n"
        case Stopped(reason=reason):
            return f"\n[stop: {reason.value}]\n"
        case AgentFailed(message=message):
            return f"\n[error: {message}]\n"


def exit_code(events: list[StreamEvent]) -> int:
    """0 if the agent finished normally, 1 otherwise."""
    return 0 if any(e == Stopped(StopReason.END_TURN) for e in events) else 1
