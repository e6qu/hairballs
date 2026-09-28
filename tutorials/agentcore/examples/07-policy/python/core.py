"""Pure logic: no network, no I/O."""

from __future__ import annotations

from collections.abc import Mapping

from domain import Allowed, Decision, Denied, ToolFailed, ToolName


def tools_call(request_id: int, tool: ToolName, arguments: Mapping[str, object]) -> object:
    """The JSON-RPC request body for one tool call."""
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {"name": tool.value, "arguments": dict(arguments)},
    }


def may_retry(decision: Decision) -> bool:
    """A denial is final; a failed call may be retried."""
    return isinstance(decision, ToolFailed)


def render(decision: Decision) -> tuple[str, int]:
    """What to print, and the exit code."""
    match decision:
        case Allowed(text=text):
            return text, 0
        case Denied(reason=reason):
            return f"not allowed: {reason}", 2
        case ToolFailed(message=message):
            return f"tool failed: {message}", 1
