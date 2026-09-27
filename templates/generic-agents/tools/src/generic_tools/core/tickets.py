"""Ticket rules (pure): idempotent creation decided from what the store already holds."""

from __future__ import annotations

from dataclasses import dataclass

from generic_tools.domain import Ticket, TicketId, TicketRequest


@dataclass(frozen=True, slots=True)
class CreateTicket:
    ticket: Ticket


@dataclass(frozen=True, slots=True)
class AlreadyCreated:
    ticket: Ticket


TicketPlan = CreateTicket | AlreadyCreated


def plan_ticket(
    request: TicketRequest, requested_by: str, existing: Ticket | None, next_number: int
) -> TicketPlan:
    """``existing`` is the ticket already stored under this request's idempotency key, if any."""
    if existing is not None:
        return AlreadyCreated(existing)
    return CreateTicket(
        Ticket(
            id=TicketId.from_sequence(next_number),
            title=request.title,
            description=request.description,
            priority=request.priority,
            requested_by=requested_by,
        )
    )
