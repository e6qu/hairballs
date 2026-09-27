"""MCP server exposing the generic tools (shell).

Used by the TypeScript harnesses (pi, opencode) locally, and deployable to AgentCore Runtime with
``protocol: MCP`` (port 8000, path ``/mcp``) as an AgentCore Gateway target in production.

Approval is *not* decided here: the calling agent's guard obtains approval before it calls
``create_ticket``, and AgentCore Policy (Cedar) enforces it at the Gateway.

Run locally::

    uv run --extra mcp python -m generic_tools.shell.mcp_server   # streamable HTTP on 127.0.0.1:8000/mcp
"""

from __future__ import annotations

import os

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from org_agents.shell.fingerprint import fingerprint_arguments

from generic_tools.shell.backends import LocalCorpus, SqliteTicketStore
from generic_tools.shell.service import TOOL_DESCRIPTIONS, GenericTools, ToolFailure, ToolResult

_tools = GenericTools(LocalCorpus(), SqliteTicketStore(os.environ.get("TICKETS_DB", ":memory:")))
mcp: MCPServer = MCPServer("generic-tools")


def _out(result: ToolResult) -> str:
    if isinstance(result, ToolFailure):
        raise ToolError(result.text)  # surfaces as an MCP tool error (isError: true) with the reason
    return result.text


@mcp.tool(description=TOOL_DESCRIPTIONS["calculate"])
def calculate(expression: str) -> str:
    return _out(_tools.calculate({"expression": expression}))


@mcp.tool(description=TOOL_DESCRIPTIONS["search_knowledge"])
def search_knowledge(query: str, max_results: int = 3) -> str:
    return _out(_tools.search_knowledge({"query": query, "max_results": max_results}))


@mcp.tool(description=TOOL_DESCRIPTIONS["create_ticket"])
def create_ticket(
    title: str,
    description: str,
    priority: str = "normal",
    requested_by: str = "unknown",
    idempotency_key: str = "",
) -> str:
    """``requested_by`` and ``idempotency_key`` are set by the calling harness's guard, not the model."""
    args = {"title": title, "description": description, "priority": priority}
    key = idempotency_key or f"content-{fingerprint_arguments(args).value[:32]}"
    return _out(_tools.create_ticket(args, requested_by, key))


@mcp.tool(description=TOOL_DESCRIPTIONS["get_ticket"])
def get_ticket(ticket_id: str) -> str:
    return _out(_tools.get_ticket({"ticket_id": ticket_id}))


def main() -> None:
    # AgentCore Runtime MCP contract: 0.0.0.0:8000, path /mcp, stateless streamable HTTP.
    mcp.run(
        transport="streamable-http",
        host=os.environ.get("MCP_HOST", "127.0.0.1"),
        port=int(os.environ.get("MCP_PORT", "8000")),
        streamable_http_path="/mcp",
        stateless_http=True,
    )


if __name__ == "__main__":
    main()
