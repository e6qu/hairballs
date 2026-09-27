"""LangChain tool adapters over the shared generic tools (shell).

The ``@tool`` signatures are the schema LangChain shows the model (framework-required, so they
live here). Each adapter passes the raw values straight to ``GenericTools``, which parses them
into domain types. The requesting principal comes from the run context (``ToolRuntime.context``),
which the runner builds from the already-parsed thread owner.
"""

from __future__ import annotations

from dataclasses import dataclass

from generic_tools.shell.service import TOOL_DESCRIPTIONS, GenericTools, ToolResult, ToolSuccess
from langchain.tools import ToolException, ToolRuntime, tool
from langchain_core.tools import BaseTool
from org_agents.core.idempotency import idempotency_key
from org_agents.domain import PrincipalId, SessionId, ToolName
from org_agents.shell.fingerprint import fingerprint_arguments


@dataclass(frozen=True, slots=True)
class RunContext:
    """LangGraph run context (``context_schema``): who the current run acts for."""

    principal: PrincipalId


def _out(result: ToolResult) -> str:
    if isinstance(result, ToolSuccess):
        return result.text
    # With handle_tool_error=True LangChain turns this into a ToolMessage with status="error".
    raise ToolException(result.text)


def _principal(runtime: ToolRuntime[RunContext]) -> PrincipalId:
    context = runtime.context
    if not isinstance(context, RunContext):
        raise ToolException("create_ticket needs the run context (principal)")
    return context.principal


@dataclass(frozen=True, slots=True)
class AgentTools:
    """The main agent's tools, and the read-only subset given to the sub-agent."""

    main: tuple[BaseTool, ...]
    read_only: tuple[BaseTool, ...]


def build_tools(service: GenericTools, session: SessionId) -> AgentTools:
    @tool("calculate", description=TOOL_DESCRIPTIONS["calculate"])
    def calculate(expression: str) -> str:
        return _out(service.calculate({"expression": expression}))

    @tool("search_knowledge", description=TOOL_DESCRIPTIONS["search_knowledge"])
    def search_knowledge(query: str, max_results: int = 3) -> str:
        return _out(service.search_knowledge({"query": query, "max_results": max_results}))

    @tool("create_ticket", description=TOOL_DESCRIPTIONS["create_ticket"])
    def create_ticket(
        title: str, description: str, runtime: ToolRuntime[RunContext], priority: str = "normal"
    ) -> str:
        principal = _principal(runtime)
        args = {"title": title, "description": description, "priority": priority}
        key = idempotency_key(session, ToolName("create_ticket"), fingerprint_arguments(args))
        return _out(service.create_ticket(args, principal.value, key.value))

    @tool("get_ticket", description=TOOL_DESCRIPTIONS["get_ticket"])
    def get_ticket(ticket_id: str) -> str:
        return _out(service.get_ticket({"ticket_id": ticket_id}))

    for item in (calculate, search_knowledge, create_ticket, get_ticket):
        item.handle_tool_error = True
    return AgentTools(
        main=(calculate, search_knowledge, create_ticket, get_ticket),
        read_only=(calculate, search_knowledge, get_ticket),
    )
