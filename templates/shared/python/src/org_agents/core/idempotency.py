"""Idempotency keys for side-effecting tools (pure).

A retried or looping agent must not create the same ticket, payment or message twice. The key
depends only on the session, the tool and the canonical arguments, so a replay yields the same key.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from org_agents.domain import Fingerprint, SessionId, ToolName


@dataclass(frozen=True, slots=True)
class IdempotencyKey:
    value: str


def idempotency_key(session: SessionId, tool: ToolName, arguments: Fingerprint) -> IdempotencyKey:
    digest = hashlib.sha256(f"{session.value}\x1f{tool.value}\x1f{arguments.value}".encode()).hexdigest()
    return IdempotencyKey(f"idem-{digest[:32]}")
