"""Builds the Strands agent with ``strands_harness.create_harness`` (shell).

``create_harness`` returns a plain ``strands.Agent`` preconfigured for a *coding* agent. This is a
non-coding assistant, so everything that reaches the host (shell, files, web, sandboxed code,
delegation, file-backed memory/sessions/skills, date-stamped environment context) is switched off.
What stays on is what helps a long-running tool-using assistant:

* the SDK context manager (``"auto"``): large tool results are truncated into an in-memory stash
  and the conversation is summarized near the context-window limit;
* the harness ``ContextOffloader``: oversized tool results go to a per-process temp directory,
  with a preview and a reference left in context (``retrieve_offloaded_content``);
* the harness behavioural contract, prepended to the org system prompt (both are static, so the
  prompt cache prefix stays stable).

Prompt caching is configured on the model instance by the caller (``app.py``), because the harness
only applies its caching sugar when it builds the model from a ``provider/name`` string.
"""

from __future__ import annotations

from collections.abc import Sequence

from strands import Agent
from strands.hooks import HookProvider
from strands.models import Model
from strands.types.tools import AgentTool
from strands_harness import create_harness

# Read-only retrieval tools that the harness context management registers. They must be in the
# ``[tools].allowed`` list of config/agent.toml, or the RunGuard blocks them like any unlisted tool.
CONTEXT_RETRIEVAL_TOOLS = ("retrieve_context", "retrieve_offloaded_content")


def build_agent(
    model: Model,
    tools: Sequence[AgentTool],
    instructions: str,
    hooks: Sequence[HookProvider],
) -> Agent:
    return create_harness(
        model=model,
        instructions=instructions,  # appended after the static HARNESS_CONTRACT
        tools=list(tools),
        builtin_tools=[],  # a list pins the set: no shell/read/write/edit/web/programmatic/subagent
        builtin_plugins=[],  # no todos; no "environment" (it injects the date and cwd every turn)
        background_tasks=False,  # tools run inline, so every call passes the guard hooks in order
        caching=False,  # configured on the model instance instead (see module docstring)
        context_manager="auto",
        session=False,  # in-memory conversation; offloaded results go to a temp dir
        skills=False,
        memory=False,  # file-backed long-term memory with its own model calls: off
        interventions=None,  # approval is the org RunGuard's job (hooks below)
        hooks=list(hooks),
        callback_handler=None,
    )
