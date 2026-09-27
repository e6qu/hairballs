"""The LangGraph recursion limit, derived from the org turn limit (pure).

LangGraph counts *super-steps* (graph node executions), not model turns. deepagents binds
``recursion_limit=9_999`` (``deepagents/graph.py``) and ``create_agent`` defaults to the same, so
without an explicit value a misbehaving graph could run for thousands of steps. The org
``RunGuard`` is the real turn limit; this is a backstop sized so the guard always trips first.

One agent turn in this variant is at most: the before-model middleware nodes, the model node,
the after-model middleware nodes and the tool node. ``STEPS_PER_TURN`` leaves headroom above
that count; ``OVERHEAD`` covers the before/after-agent nodes and the final stop step.
"""

from __future__ import annotations

from dataclasses import dataclass

from org_agents.domain import PositiveInt

STEPS_PER_TURN = 10
OVERHEAD = 10


@dataclass(frozen=True, slots=True)
class RecursionLimit:
    value: int

    def __post_init__(self) -> None:
        if self.value < 1:
            raise ValueError("recursion limit must be >= 1")


def recursion_limit(max_turns: PositiveInt) -> RecursionLimit:
    return RecursionLimit((max_turns.value + 1) * STEPS_PER_TURN + OVERHEAD)
