"""Per-run dependencies handed to Pydantic AI (``deps_type``): domain types, not raw strings."""

from __future__ import annotations

from dataclasses import dataclass

from org_agents.domain import PrincipalId, SessionId
from org_agents.shell.run_guard import RunGuard


@dataclass(frozen=True, slots=True)
class RunDeps:
    session: SessionId
    principal: PrincipalId  # who the run acts for (the thread owner)
    guard: RunGuard  # the org controls for this run; the capability reports every step to it
