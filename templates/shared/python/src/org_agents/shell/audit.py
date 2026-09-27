"""Audit events: domain types, and a sink that renders them as JSON lines for CloudWatch."""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from typing import Protocol, TextIO

from org_agents.core.guard import StopRun
from org_agents.domain import Instant, SessionId, ToolName, Usage, Usd


@dataclass(frozen=True, slots=True)
class RunStartedEvent:
    session: SessionId
    at: Instant


@dataclass(frozen=True, slots=True)
class ToolDecisionEvent:
    session: SessionId
    tool: ToolName
    outcome: str  # allowed | denied | needs_approval | stopped
    reason: str
    at: Instant


@dataclass(frozen=True, slots=True)
class UsageEvent:
    session: SessionId
    usage: Usage
    run_total: Usd
    at: Instant


@dataclass(frozen=True, slots=True)
class RunStoppedEvent:
    session: SessionId
    stop: StopRun
    at: Instant


@dataclass(frozen=True, slots=True)
class RunFinishedEvent:
    session: SessionId
    turns: int
    spent: Usd
    at: Instant


@dataclass(frozen=True, slots=True)
class RunFailedEvent:
    session: SessionId
    error: str
    at: Instant


@dataclass(frozen=True, slots=True)
class ContextCompactedEvent:
    """History was trimmed or summarized (the pre-compaction transcript should be kept elsewhere)."""

    session: SessionId
    messages_before: int
    messages_after: int
    at: Instant


AuditEvent = (
    RunStartedEvent
    | ToolDecisionEvent
    | UsageEvent
    | RunStoppedEvent
    | RunFinishedEvent
    | RunFailedEvent
    | ContextCompactedEvent
)


def render(event: AuditEvent) -> dict[str, object]:
    """Render an audit event as a JSON-compatible record (outbound serialization lives here)."""
    base: dict[str, object] = {"audit": True, "session": event.session.value, "at": event.at.at.isoformat()}
    match event:
        case RunStartedEvent():
            return {**base, "type": "run_started"}
        case ToolDecisionEvent(tool=tool, outcome=outcome, reason=reason):
            return {**base, "type": "tool_decision", "tool": tool.value, "outcome": outcome, "reason": reason}
        case UsageEvent(usage=usage, run_total=total):
            return {
                **base,
                "type": "usage",
                "input_tokens": usage.input_tokens.value,
                "output_tokens": usage.output_tokens.value,
                "cache_read_tokens": usage.cache_read_tokens.value,
                "cache_write_tokens": usage.cache_write_tokens.value,
                "run_usd": str(total.amount),
            }
        case RunStoppedEvent(stop=stop):
            return {**base, "type": "run_stopped", "reason": stop.reason.value, "detail": stop.detail}
        case RunFinishedEvent(turns=turns, spent=spent):
            return {**base, "type": "run_finished", "turns": turns, "run_usd": str(spent.amount)}
        case RunFailedEvent(error=error):
            return {**base, "type": "run_failed", "error": error}
        case ContextCompactedEvent(messages_before=before, messages_after=after):
            return {**base, "type": "context_compacted", "messages_before": before, "messages_after": after}


class AuditSink(Protocol):
    def emit(self, event: AuditEvent) -> None: ...


class JsonLinesAuditSink:
    """Writes one JSON object per line (stdout is shipped to CloudWatch by AgentCore Runtime)."""

    def __init__(self, stream: TextIO | None = None) -> None:
        self._stream = stream or sys.stdout

    def emit(self, event: AuditEvent) -> None:
        self._stream.write(json.dumps(render(event), separators=(",", ":")) + "\n")
        self._stream.flush()


@dataclass
class MemoryAuditSink:
    """Collects events in memory (tests)."""

    events: list[AuditEvent] = field(default_factory=list)

    def emit(self, event: AuditEvent) -> None:
        self.events.append(event)
