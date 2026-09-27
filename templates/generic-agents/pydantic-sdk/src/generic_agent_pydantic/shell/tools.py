"""Pydantic AI tool adapters over the shared generic tools (shell).

The function signatures are the schema Pydantic AI shows the model (framework-required, so they live
here). Each adapter passes the raw values straight to ``GenericTools``, which parses them into domain
types. The caller (set by the runner from the verified token, never the model) and session come
from the typed ``RunDeps``.

Failures are raised as ``ToolFailed``: the model sees a failed tool result (``outcome='failed'``)
without consuming its retry budget.
"""

from __future__ import annotations

from generic_tools.domain import Requester
from generic_tools.shell.service import TOOL_DESCRIPTIONS, GenericTools, ToolResult, ToolSuccess
from org_agents.core.idempotency import idempotency_key
from org_agents.domain import ToolName
from org_agents.shell.fingerprint import fingerprint_arguments
from pydantic_ai import RunContext, Tool
from pydantic_ai.exceptions import ToolFailed

from generic_agent_pydantic.shell.deps import RunDeps


def _out(result: ToolResult) -> str:
    if isinstance(result, ToolSuccess):
        return result.text
    raise ToolFailed(result.text)


def build_tools(service: GenericTools) -> list[Tool[RunDeps]]:
    def calculate(expression: str) -> str:
        return _out(service.calculate({"expression": expression}))

    def search_knowledge(query: str, max_results: int = 3) -> str:
        return _out(service.search_knowledge({"query": query, "max_results": max_results}))

    def create_ticket(
        ctx: RunContext[RunDeps], title: str, description: str, priority: str = "normal"
    ) -> str:
        # Only reached after the guard capability saw an approval (deferred tool flow, see capability.py).
        args = {"title": title, "description": description, "priority": priority}
        key = idempotency_key(ctx.deps.session, ToolName("create_ticket"), fingerprint_arguments(args))
        return _out(service.create_ticket(args, Requester.from_caller(ctx.deps.caller), key.value))

    def get_ticket(ticket_id: str) -> str:
        return _out(service.get_ticket({"ticket_id": ticket_id}))

    return [
        Tool(calculate, takes_ctx=False, name="calculate", description=TOOL_DESCRIPTIONS["calculate"]),
        Tool(
            search_knowledge,
            takes_ctx=False,
            name="search_knowledge",
            description=TOOL_DESCRIPTIONS["search_knowledge"],
        ),
        Tool(
            create_ticket,
            takes_ctx=True,
            name="create_ticket",
            description=TOOL_DESCRIPTIONS["create_ticket"],
        ),
        Tool(get_ticket, takes_ctx=False, name="get_ticket", description=TOOL_DESCRIPTIONS["get_ticket"]),
    ]
