"""Assemble the deepagents graph for one thread (shell).

``create_deep_agent`` (``deepagents/graph.py``, 0.7.15) always installs ``FilesystemMiddleware``
and ``SubAgentMiddleware``, plus summarization, dangling-tool-call patching and provider prompt
caching; ``HumanInTheLoopMiddleware`` is added when ``interrupt_on`` is given. Built-ins are
narrowed for a non-coding assistant:

* **Filesystem**: the backend is ``StateBackend`` (virtual files kept in the graph state, never
  the disk), and a ``FilesystemMiddleware(tools=["read_file"])`` replaces the default one by
  name. ``read_file`` cannot be removed (the middleware requires it); it only reads the
  per-thread virtual files, which hold oversized tool results that deepagents evicts from the
  context. No ``ls``/``write_file``/``edit_file``/``delete``/``glob``/``grep``/``execute``.
  No sandbox or ``LocalShellBackend`` is configured, so there is no shell.
* **Sub-agent** (``task``): a single ``general-purpose`` spec replaces the default one. It has
  only the read-only tools (no ``create_ticket``), no HITL, the same restricted filesystem, and
  a ``GuardMiddleware`` over the same ``RunControl``, so its turns, tokens, USD and tool calls
  count against the parent's run budget.
* **Summarization**: replaced by ``NoCompaction`` (its model calls would bypass the guard).
* **Planning** (``write_todos``): not part of the deepagents 0.7 default stack; not added.
* **Skills / memory / async sub-agents**: not configured.
"""

from __future__ import annotations

from typing import Any

from deepagents import create_deep_agent
from deepagents.backends import StateBackend
from deepagents.middleware.filesystem import FilesystemMiddleware
from deepagents.middleware.subagents import SubAgent
from langchain.agents.middleware import AgentMiddleware, InterruptOnConfig
from langchain_core.language_models import BaseChatModel
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph.state import CompiledStateGraph
from org_agents.core.tool_policy import NeedsApproval, decide_tool
from org_agents.domain import ToolName, ToolPolicy

from generic_agent_deepagents.shell.middleware import (
    GuardMiddleware,
    NoCompaction,
    RunControl,
    SteeringMiddleware,
)
from generic_agent_deepagents.shell.tools import AgentTools, RunContext

SUBAGENT_PROMPT = (
    "You are a read-only research helper for an internal assistant. Use the tools to look up "
    "information or calculate, then reply with a short, factual summary. You cannot create tickets."
)
SUBAGENT_DESCRIPTION = (
    "Read-only helper for multi-step lookups (knowledge search, calculations, ticket lookups). "
    "Cannot change anything."
)


def approval_gated(tools: AgentTools, policy: ToolPolicy) -> dict[str, str]:
    """Tool name → approval reason, for every tool the org policy says needs approval."""
    gated: dict[str, str] = {}
    for item in tools.main:
        decision = decide_tool(ToolName(item.name), policy)
        if isinstance(decision, NeedsApproval):
            gated[item.name] = decision.reason
    return gated


def build_agent(
    model: BaseChatModel,
    tools: AgentTools,
    system_prompt: str,
    policy: ToolPolicy,
    control: RunControl,
    checkpointer: BaseCheckpointSaver[Any],
) -> CompiledStateGraph[Any, Any, Any, Any]:
    backend = StateBackend()
    gated = approval_gated(tools, policy)
    guard = GuardMiddleware(control, frozenset(gated))
    interrupt_on: dict[str, bool | InterruptOnConfig] = {
        name: InterruptOnConfig(
            allowed_decisions=["approve", "reject"], description=reason, when=guard.approval_allowed
        )
        for name, reason in gated.items()
    }
    # Framework generics differ per middleware class; the stacks are typed at the framework boundary.
    sub_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        FilesystemMiddleware(backend=backend, tools=["read_file"]),
        NoCompaction(),
        GuardMiddleware(control, frozenset()),
    ]
    main_middleware: list[AgentMiddleware[Any, Any, Any]] = [
        FilesystemMiddleware(backend=backend, tools=["read_file"]),
        NoCompaction(),
        guard,
        SteeringMiddleware(control),
    ]
    researcher: SubAgent = {
        "name": "general-purpose",
        "description": SUBAGENT_DESCRIPTION,
        "system_prompt": SUBAGENT_PROMPT,
        "tools": list(tools.read_only),
        "interrupt_on": {},
        "middleware": sub_middleware,
    }
    return create_deep_agent(
        model=model,
        tools=list(tools.main),
        system_prompt=system_prompt,
        middleware=main_middleware,
        subagents=[researcher],
        backend=backend,
        interrupt_on=interrupt_on,
        context_schema=RunContext,
        checkpointer=checkpointer,
    )
