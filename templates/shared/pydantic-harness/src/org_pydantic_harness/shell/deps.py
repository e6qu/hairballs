"""Run dependencies every harness tool receives through ``RunContext[HarnessDeps]``."""

from __future__ import annotations

from dataclasses import dataclass

from org_agents.domain import PrincipalId, SessionId
from org_agents.identity import Caller


@dataclass(frozen=True, slots=True)
class HarnessDeps:
    """Who the run acts for, and in which session. Domain types, never raw strings.

    ``principal`` (the Auth0 ``sub``) is the authorization key: thread ownership, approvals.
    ``caller`` is who that principal is (user id, profile; PII) for tools that record a requester.
    It is ``None`` only when the identity is unknown (a session saved before identities were kept);
    tools that need a requester must then refuse.
    """

    session: SessionId
    principal: PrincipalId
    caller: Caller | None

    def __post_init__(self) -> None:
        if self.caller is not None and self.caller.subject != self.principal:
            raise ValueError("the caller is not the run's principal")
