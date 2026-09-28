"""Pure logic: no AWS, no I/O, no clock, no randomness. Easy to test and to read."""

from __future__ import annotations

from domain import AgentFailed, AnswerEvent, AnswerText, TicketId, TicketRequest


def new_ticket_id(random_hex: str) -> TicketId:
    """A ticket id from 8 random hex digits, which the shell supplies."""
    return TicketId.parse(f"TCK-{random_hex[:8]}")


def ticket_log_line(ticket: TicketId, request: TicketRequest) -> str:
    return f"ticket {ticket.value}: {request.title} ({len(request.description)} chars)"


def render(event: AnswerEvent) -> str:
    """What to print for one event."""
    match event:
        case AnswerText(text=text):
            return text
        case AgentFailed(message=message):
            return f"\n[error: {message}]\n"


def exit_code(events: list[AnswerEvent]) -> int:
    """0 if the agent answered without an error, 1 otherwise."""
    return 1 if any(isinstance(e, AgentFailed) for e in events) or not events else 0
