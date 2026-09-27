"""Agent settings: the shared org config plus the approval policy and system prompt (any framework)."""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from org_agents.conversation import ApprovalPolicy
from org_agents.identity import DEFAULT_CLAIMS, ClaimNames
from org_agents.parsing import expect_mapping
from org_agents.shell.config import AgentConfig, parse_agent_config


@dataclass(frozen=True, slots=True)
class Settings:
    agent: AgentConfig
    approvals: ApprovalPolicy
    system_prompt: str
    identity: ClaimNames = DEFAULT_CLAIMS


def parse_settings(raw: object, env: Mapping[str, str], system_prompt: str) -> Settings:
    doc = expect_mapping(raw, "$")
    return Settings(
        agent=parse_agent_config(raw, env),
        approvals=ApprovalPolicy.parse(doc.get("approvals", {})),
        system_prompt=system_prompt,
        identity=ClaimNames.parse(doc.get("identity", {})),
    )


def load_settings(env: Mapping[str, str], root: Path | None = None) -> Settings:
    """Config and prompt live under ``AGENT_HOME`` (default: the working directory)."""
    root = root or Path(env.get("AGENT_HOME", Path.cwd()))
    config_path = Path(env.get("AGENT_CONFIG", root / "config" / "agent.toml"))
    prompt_path = Path(env.get("AGENT_SYSTEM_PROMPT", root / "prompts" / "system.md"))
    with config_path.open("rb") as handle:
        raw: object = tomllib.load(handle)
    return parse_settings(raw, env, prompt_path.read_text(encoding="utf-8"))
