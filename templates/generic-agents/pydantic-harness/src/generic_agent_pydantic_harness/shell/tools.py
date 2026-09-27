"""Pydantic AI tool adapters over the shared generic tools (shell).

The function signatures are the schema Pydantic AI shows the model (framework-required, so they
live here). Each adapter passes the raw values straight to ``GenericTools``, which parses them into
domain types. Principal and session come from ``RunContext[HarnessDeps]`` as domain types.
A ``ToolFailure`` becomes ``ToolFailed``: a failed tool result the model sees, without a retry.

Limits, the allowlist, loop detection and the four-eyes approval for ``create_ticket`` are not
here: the org harness applies them to every tool.
"""

from __future__ import annotations

from generic_tools.shell.service import TOOL_DESCRIPTIONS, GenericTools, ToolResult, ToolSuccess
from org_agents.core.idempotency import idempotency_key
from org_agents.domain import ToolName
from org_agents.shell.fingerprint import fingerprint_arguments
from org_pydantic_harness.shell import HarnessDeps
from pydantic_ai import RunContext, Tool
from pydantic_ai.exceptions import ToolFailed


def _out(result: ToolResult) -> str:
    if isinstance(result, ToolSuccess):
        return result.text
    raise ToolFailed(result.text)


def build_tools(service: GenericTools) -> list[Tool[HarnessDeps]]:
    def calculate(expression: str) -> str:
        return _out(service.calculate({"expression": expression}))

    def search_knowledge(query: str, max_results: int = 3) -> str:
        return _out(service.search_knowledge({"query": query, "max_results": max_results}))

    def create_ticket(
        ctx: RunContext[HarnessDeps], title: str, description: str, priority: str = "normal"
    ) -> str:
        args = {"title": title, "description": description, "priority": priority}
        key = idempotency_key(ctx.deps.session, ToolName("create_ticket"), fingerprint_arguments(args))
        return _out(service.create_ticket(args, ctx.deps.principal.value, key.value))

    def get_ticket(ticket_id: str) -> str:
        return _out(service.get_ticket({"ticket_id": ticket_id}))

    return [
        Tool(calculate, name="calculate", description=TOOL_DESCRIPTIONS["calculate"]),
        Tool(search_knowledge, name="search_knowledge", description=TOOL_DESCRIPTIONS["search_knowledge"]),
        Tool(create_ticket, name="create_ticket", description=TOOL_DESCRIPTIONS["create_ticket"]),
        Tool(get_ticket, name="get_ticket", description=TOOL_DESCRIPTIONS["get_ticket"]),
    ]
