"""LangGraph recursion limit derived from the org limits (pure).

LangGraph's default ``recursion_limit`` is 10 007 supersteps (``langgraph/_internal/_config.py``),
which is effectively unbounded. The org ``RunGuard`` is the primary control (turns, tokens, USD,
wall clock, tool calls, loops); the recursion limit is a second line of defence in case a hook is
bypassed or misconfigured.

One agent turn in ``create_agent`` with our middleware is at most four supersteps:
``GuardMiddleware.before_model`` → ``model`` → ``GuardMiddleware.after_model`` → ``tools``
(parallel tool calls are ``Send`` tasks inside one superstep). The guard stops the run on the
``before_model`` of turn ``max_turns + 1``, so the graph never needs more than
``STEPS_PER_TURN * (max_turns + 1)`` steps; one extra step of slack covers the entry edge.
"""

from __future__ import annotations

from org_agents.domain import Limits

STEPS_PER_TURN = 4


def recursion_limit(limits: Limits) -> int:
    return STEPS_PER_TURN * (limits.max_turns.value + 1) + 1
