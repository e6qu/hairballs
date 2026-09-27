"""The tool service (shell): raw tool arguments in, text results out.

Every framework adapter (Strands ``@tool``, Pydantic AI tools, LangChain tools, the MCP server)
calls these functions with the *raw* arguments the model produced. Each function parses them
into domain types, runs the pure core, performs the effect, and renders a result for the model.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from org_agents.parsing import ParseError, expect_mapping, field

from generic_tools.core.calculator import calculate
from generic_tools.core.knowledge import search
from generic_tools.core.tickets import AlreadyCreated, CreateTicket, plan_ticket
from generic_tools.domain import (
    Calculated,
    CalculationError,
    Expression,
    HitLimit,
    KnowledgeQuery,
    Ticket,
    TicketDescription,
    TicketId,
    TicketPriority,
    TicketRequest,
    TicketTitle,
)
from generic_tools.shell.backends import KnowledgeSource, TicketStore


@dataclass(frozen=True, slots=True)
class ToolSuccess:
    text: str


@dataclass(frozen=True, slots=True)
class ToolFailure:
    text: str


ToolResult = ToolSuccess | ToolFailure

# Tool names and descriptions shared by every adapter (the schemas live in each adapter).
TOOL_DESCRIPTIONS: Mapping[str, str] = {
    "calculate": "Evaluate an arithmetic expression exactly (decimals; + - * / and parentheses).",
    "search_knowledge": "Search the internal knowledge base and return the most relevant passages.",
    "create_ticket": "Create a service-desk ticket. Changes external state; requires human approval.",
    "get_ticket": "Fetch a service-desk ticket by id (e.g. TCK-000001).",
}


def _render_ticket(ticket: Ticket) -> str:
    return (
        f"{ticket.id.value} [{ticket.priority.value}] {ticket.title.text}\n"
        f"requested by {ticket.requested_by}\n{ticket.description.text}"
    )


class GenericTools:
    def __init__(self, knowledge: KnowledgeSource, tickets: TicketStore) -> None:
        self._knowledge = knowledge
        self._tickets = tickets

    def calculate(self, raw_args: object) -> ToolResult:
        try:
            args = expect_mapping(raw_args, "$")
            expression = Expression.parse(field(args, "expression", "$"))
        except ParseError as exc:
            return ToolFailure(f"invalid arguments: {exc}")
        match calculate(expression):
            case Calculated(value=value):
                return ToolSuccess(f"{expression.text} = {value}")
            case CalculationError(reason=reason):
                return ToolFailure(f"cannot calculate: {reason}")

    def search_knowledge(self, raw_args: object) -> ToolResult:
        try:
            args = expect_mapping(raw_args, "$")
            query = KnowledgeQuery.parse(field(args, "query", "$"))
            limit = HitLimit.parse(args.get("max_results", 3))
        except ParseError as exc:
            return ToolFailure(f"invalid arguments: {exc}")
        hits = search(query, self._knowledge.documents(), limit)
        if not hits:
            return ToolSuccess("No matching documents.")
        return ToolSuccess("\n".join(f"[{h.document.value}] {h.title}: {h.snippet}" for h in hits))

    def create_ticket(self, raw_args: object, requested_by: str, idempotency_key: str) -> ToolResult:
        """Only call after the guard has obtained approval. Safe to retry: same key → same ticket."""
        try:
            args = expect_mapping(raw_args, "$")
            request = TicketRequest(
                title=TicketTitle.parse(field(args, "title", "$")),
                description=TicketDescription.parse(field(args, "description", "$")),
                priority=TicketPriority.parse(args.get("priority", "normal")),
            )
        except ParseError as exc:
            return ToolFailure(f"invalid arguments: {exc}")
        plan = plan_ticket(
            request, requested_by, self._tickets.by_key(idempotency_key), self._tickets.next_number()
        )
        match plan:
            case AlreadyCreated(ticket=ticket):
                return ToolSuccess(f"Ticket already exists (idempotent retry):\n{_render_ticket(ticket)}")
            case CreateTicket(ticket=ticket):
                self._tickets.save(ticket, idempotency_key)
                return ToolSuccess(f"Created ticket:\n{_render_ticket(ticket)}")

    def get_ticket(self, raw_args: object) -> ToolResult:
        try:
            ticket_id = TicketId.parse(field(expect_mapping(raw_args, "$"), "ticket_id", "$"))
        except ParseError as exc:
            return ToolFailure(f"invalid arguments: {exc}")
        ticket = self._tickets.get(ticket_id)
        return ToolSuccess(_render_ticket(ticket)) if ticket else ToolFailure(f"{ticket_id.value} not found")
