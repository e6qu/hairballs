"""Strands tool adapters over the shared generic tools (shell; copied from the strands-sdk variant).

The ``@tool`` signatures are the schema Strands shows the model (framework-required, so they live
here). Each adapter passes the raw values straight to ``GenericTools``, which parses them into
domain types. The caller (set by the runner, never the model) and session come from
``invocation_state``.
"""

from __future__ import annotations

from typing import Any

from generic_tools.domain import Requester
from generic_tools.shell.service import TOOL_DESCRIPTIONS, GenericTools, ToolResult, ToolSuccess
from org_agents.core.idempotency import idempotency_key
from org_agents.domain import SessionId, ToolName
from org_agents.identity import HumanUser, ServiceClient
from org_agents.shell.fingerprint import fingerprint_arguments
from strands import tool
from strands.types.tools import AgentTool, ToolContext


class ToolError(Exception):
    """Raised so Strands reports an error tool result (status: error) back to the model."""


def _out(result: ToolResult) -> str:
    if isinstance(result, ToolSuccess):
        return result.text
    raise ToolError(result.text)


def build_tools(service: GenericTools) -> list[AgentTool]:
    @tool(name="calculate", description=TOOL_DESCRIPTIONS["calculate"])
    def calculate(expression: str) -> str:
        return _out(service.calculate({"expression": expression}))

    @tool(name="search_knowledge", description=TOOL_DESCRIPTIONS["search_knowledge"])
    def search_knowledge(query: str, max_results: int = 3) -> str:
        return _out(service.search_knowledge({"query": query, "max_results": max_results}))

    @tool(name="create_ticket", description=TOOL_DESCRIPTIONS["create_ticket"], context=True)
    def create_ticket(
        title: str, description: str, tool_context: ToolContext, priority: str = "normal"
    ) -> str:
        state: dict[str, Any] = tool_context.invocation_state
        caller = state.get("caller")
        if not isinstance(caller, (HumanUser, ServiceClient)):
            raise ToolError("the requester is unknown; the ticket was not created")
        session = SessionId.parse(state.get("session"), "$.invocation_state.session")
        args = {"title": title, "description": description, "priority": priority}
        key = idempotency_key(session, ToolName("create_ticket"), fingerprint_arguments(args))
        return _out(service.create_ticket(args, Requester.from_caller(caller), key.value))

    @tool(name="get_ticket", description=TOOL_DESCRIPTIONS["get_ticket"])
    def get_ticket(ticket_id: str) -> str:
        return _out(service.get_ticket({"ticket_id": ticket_id}))

    return [calculate, search_knowledge, create_ticket, get_ticket]
