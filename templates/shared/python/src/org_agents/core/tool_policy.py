"""Tool authorization decisions (pure). Unlisted tools are denied; approval rules win over allow."""

from __future__ import annotations

from dataclasses import dataclass

from org_agents.domain import ToolName, ToolPolicy


@dataclass(frozen=True, slots=True)
class Allowed:
    pass


@dataclass(frozen=True, slots=True)
class NeedsApproval:
    reason: str


@dataclass(frozen=True, slots=True)
class Denied:
    reason: str


ToolDecision = Allowed | NeedsApproval | Denied


def decide_tool(tool: ToolName, policy: ToolPolicy) -> ToolDecision:
    if not any(pattern.matches(tool) for pattern in policy.allowed):
        return Denied(f"tool {tool.value!r} is not in the allowlist")
    if any(pattern.matches(tool) for pattern in policy.approval_required):
        return NeedsApproval(f"tool {tool.value!r} changes external state and needs approval")
    return Allowed()
