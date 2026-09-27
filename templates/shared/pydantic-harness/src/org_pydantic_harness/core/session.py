"""Session recovery decisions (pure)."""

from __future__ import annotations

from dataclasses import replace

from org_agents.core.messages import Idle, Running
from org_agents.core.thread import ThreadState


def recover(state: ThreadState) -> ThreadState:
    """A thread loaded from storage cannot still be running: the process that ran it is gone.

    ``Running`` becomes ``Idle`` (its partial history was saved; the next prompt starts a new run).
    ``AwaitingApproval`` is kept, so an approval can resume the run after a restart. Seen message
    ids and queued follow-ups are kept too.
    """
    if isinstance(state.status, Running):
        return replace(state, status=Idle())
    return state
