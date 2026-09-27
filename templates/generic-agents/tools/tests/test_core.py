from decimal import Decimal

from org_agents.identity import EmailAddress

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
    Requester,
    TicketDescription,
    TicketPriority,
    TicketRequest,
    TicketTitle,
)

ALICE = Requester("usr_1", "Alice Doe", EmailAddress("alice@x.io"))


def test_calculator_is_exact() -> None:
    assert calculate(Expression("0.1 + 0.2")) == Calculated(Decimal("0.3"))
    assert calculate(Expression("2 * (3 + 4) - -1")) == Calculated(Decimal(15))
    assert calculate(Expression("10 / 4")) == Calculated(Decimal("2.5"))
    assert str(calculate(Expression("180 * 3"))) == "Calculated(value=Decimal('540'))"  # not 5.4E+2
    assert str(calculate(Expression("100.50 * 2"))) == "Calculated(value=Decimal('201'))"
    assert str(calculate(Expression("1.20 + 0.10"))) == "Calculated(value=Decimal('1.3'))"
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
    first = plan_ticket(request, ALICE, None, 1)
    assert isinstance(first, CreateTicket) and first.ticket.id.value == "TCK-000001"
    again = plan_ticket(request, ALICE, first.ticket, 2)
    assert again == AlreadyCreated(first.ticket)
