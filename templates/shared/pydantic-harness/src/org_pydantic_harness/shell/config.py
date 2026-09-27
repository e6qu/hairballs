"""Harness configuration: the optional ``[context]`` table of the agent's ``config/agent.toml``."""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from pathlib import Path

from org_agents.parsing import expect_mapping

from org_pydantic_harness.core.context import ContextPolicy


def load_context_policy(env: Mapping[str, str], root: Path | None = None) -> ContextPolicy:
    """Resolves the file like ``org_agents.shell.settings.load_settings`` (AGENT_HOME, AGENT_CONFIG)."""
    root = root or Path(env.get("AGENT_HOME", Path.cwd()))
    config_path = Path(env.get("AGENT_CONFIG", root / "config" / "agent.toml"))
    with config_path.open("rb") as handle:
        raw: object = tomllib.load(handle)
    doc = expect_mapping(raw, "$")
    return ContextPolicy.parse(doc.get("context", {}))
