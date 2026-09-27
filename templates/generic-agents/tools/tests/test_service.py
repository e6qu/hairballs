from org_agents.identity import EmailAddress

from generic_tools.domain import Requester
from generic_tools.shell.backends import LocalCorpus, SqliteTicketStore
from generic_tools.shell.service import GenericTools, ToolFailure, ToolSuccess

ALICE = Requester("usr_1", "Alice Doe", EmailAddress("alice@x.io"))


def tools() -> GenericTools:
    return GenericTools(LocalCorpus(), SqliteTicketStore())


def test_bundled_corpus_search() -> None:
    result = tools().search_knowledge({"query": "hotel limit per night"})
    assert isinstance(result, ToolSuccess) and "expense-policy" in result.text


def test_calculation_is_rendered_in_plain_notation() -> None:
    result = tools().calculate({"expression": "180*3"})
    assert isinstance(result, ToolSuccess) and result.text == "180*3 = 540"


def test_invalid_args_are_reported_with_path() -> None:
    result = tools().calculate({"expression": "__import__('os')"})
    assert isinstance(result, ToolFailure) and "$.expression" in result.text
    assert isinstance(tools().calculate("1+1"), ToolFailure)  # not an object


def test_ticket_create_retry_and_get() -> None:
    t = tools()
    args = {"title": "VPN broken", "description": "Cannot connect since 9am", "priority": "high"}
    first = t.create_ticket(args, ALICE, "idem-1")
    assert isinstance(first, ToolSuccess) and "TCK-000001" in first.text
    retry = t.create_ticket(args, ALICE, "idem-1")
    assert isinstance(retry, ToolSuccess) and "already exists" in retry.text
    assert isinstance(t.get_ticket({"ticket_id": "tck-000001"}), ToolSuccess)
    assert isinstance(t.get_ticket({"ticket_id": "TCK-000999"}), ToolFailure)
    assert isinstance(t.create_ticket({**args, "priority": "urgent"}, ALICE, "idem-2"), ToolFailure)


def test_ticket_records_requester_profile() -> None:
    t = tools()
    t.create_ticket({"title": "VPN broken", "description": "x"}, ALICE, "idem-9")
    shown = t.get_ticket({"ticket_id": "TCK-000001"})
    assert isinstance(shown, ToolSuccess) and "Alice Doe <alice@x.io> (usr_1)" in shown.text
