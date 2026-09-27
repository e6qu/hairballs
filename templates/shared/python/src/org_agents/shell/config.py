"""Agent configuration: parsed once from ``config/agent.toml`` plus environment overrides."""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from org_agents.core.messages import BusyPolicy
from org_agents.domain import AwsRegion, Limits, ModelId, ModelPrice, ToolPolicy
from org_agents.parsing import ParseError, expect_mapping, expect_non_empty_str, field

# Environment variables that may override file values (deploy-time knobs in agentcore.json envVars).
_ENV_LIMIT_OVERRIDES = {
    "AGENT_MAX_TURNS": "max_turns",
    "AGENT_MAX_TOTAL_TOKENS": "max_total_tokens",
    "AGENT_MAX_USD": "max_usd",
    "AGENT_MAX_WALL_SECONDS": "max_wall_seconds",
    "AGENT_MAX_TOOL_CALLS": "max_tool_calls",
}


@dataclass(frozen=True, slots=True)
class AgentConfig:
    name: str
    model_id: ModelId
    region: AwsRegion
    price: ModelPrice
    limits: Limits
    tools: ToolPolicy
    busy_policy: BusyPolicy


def parse_agent_config(raw: object, env: Mapping[str, str]) -> AgentConfig:
    """Parse the TOML document (already loaded as untyped data) and apply env overrides."""
    doc = expect_mapping(raw, "$")
    agent = expect_mapping(field(doc, "agent", "$"), "$.agent")
    model = expect_mapping(field(doc, "model", "$"), "$.model")

    limits_raw = dict(expect_mapping(field(doc, "limits", "$"), "$.limits"))
    for var, key in _ENV_LIMIT_OVERRIDES.items():
        if var in env:
            limits_raw[key] = env[var]

    busy_raw = expect_non_empty_str(agent.get("busy_policy", "steer"), "$.agent.busy_policy")
    try:
        busy = BusyPolicy(busy_raw)
    except ValueError as exc:
        raise ParseError("$.agent.busy_policy", "must be steer, queue or reject") from exc

    return AgentConfig(
        name=expect_non_empty_str(field(agent, "name", "$.agent"), "$.agent.name", max_length=48),
        model_id=ModelId.parse(env.get("BEDROCK_MODEL_ID", field(model, "id", "$.model")), "$.model.id"),
        region=AwsRegion.parse(env.get("AWS_REGION", field(model, "region", "$.model")), "$.model.region"),
        price=ModelPrice.parse(field(model, "price", "$.model"), "$.model.price"),
        limits=Limits.parse(limits_raw, "$.limits"),
        tools=ToolPolicy.parse(field(doc, "tools", "$"), "$.tools"),
        busy_policy=busy,
    )


def load_agent_config(path: Path, env: Mapping[str, str]) -> AgentConfig:
    with path.open("rb") as handle:
        raw: object = tomllib.load(handle)
    return parse_agent_config(raw, env)


def kill_switch_from(env: Mapping[str, str]) -> bool:
    return env.get("AGENT_KILL_SWITCH", "0").strip().lower() in {"1", "true", "on"}
