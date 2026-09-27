from decimal import Decimal

from generic_tools.core.calculator import calculate
from generic_tools.core.knowledge import search
from generic_tools.core.tickets import AlreadyCreated, CreateTicket, plan_ticket
from generic_tools.domain import (
    Calculated,
    CalculationError,
    Document,
    DocumentId,
    Expression,
    HitLimit,
    KnowledgeQuery,
    TicketDescription,
    TicketPriority,
    TicketRequest,
    TicketTitle,
)


def test_calculator_is_exact() -> None:
    assert calculate(Expression("0.1 + 0.2")) == Calculated(Decimal("0.3"))
    assert calculate(Expression("2 * (3 + 4) - -1")) == Calculated(Decimal(15))
    assert calculate(Expression("10 / 4")) == Calculated(Decimal("2.5"))
    assert isinstance(calculate(Expression("1 / 0")), CalculationError)
    assert isinstance(calculate(Expression("(1 + 2")), CalculationError)
    assert isinstance(calculate(Expression("1..2")), CalculationError)


def test_search_ranks_and_snippets() -> None:
    corpus = [
        Document(DocumentId("a"), "Expenses", "Meals are reimbursed up to 60 EUR per day."),
        Document(DocumentId("b"), "Access", "Production access needs a ticket."),
    ]
    hits = search(KnowledgeQuery("meal reimbursement per day"), corpus, HitLimit(3))
    assert [h.document.value for h in hits] == ["a"]
    assert "60 EUR" in hits[0].snippet
    assert search(KnowledgeQuery("the and of"), corpus, HitLimit(3)) == []


def test_ticket_plan_is_idempotent() -> None:
    request = TicketRequest(
        TicketTitle("VPN broken"), TicketDescription("Cannot connect"), TicketPriority.HIGH
    )
    first = plan_ticket(request, "alice", None, 1)
    assert isinstance(first, CreateTicket) and first.ticket.id.value == "TCK-000001"
    again = plan_ticket(request, "alice", first.ticket, 2)
    assert again == AlreadyCreated(first.ticket)
