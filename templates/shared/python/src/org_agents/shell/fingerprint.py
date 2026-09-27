"""Fingerprints of raw tool arguments (shell: the only place raw arguments are serialized)."""

from __future__ import annotations

import hashlib
import json

from org_agents.domain import Fingerprint


def fingerprint_arguments(raw_arguments: object) -> Fingerprint:
    """Hash raw tool arguments canonically, so the same call always yields the same fingerprint."""
    canonical = json.dumps(raw_arguments, sort_keys=True, separators=(",", ":"), default=str)
    return Fingerprint(hashlib.sha256(canonical.encode()).hexdigest())
