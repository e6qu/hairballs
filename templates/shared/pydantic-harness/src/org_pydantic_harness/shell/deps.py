"""Run dependencies every harness tool receives through ``RunContext[HarnessDeps]``."""

from __future__ import annotations

from dataclasses import dataclass

from org_agents.domain import PrincipalId, SessionId


@dataclass(frozen=True, slots=True)
class HarnessDeps:
    """Who the run acts for, and in which session. Domain types, never raw strings."""

    session: SessionId
    principal: PrincipalId
