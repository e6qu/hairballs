"""Suite configuration (``suite.toml``): variants to launch, helper services, models and prices."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

from org_agents.domain import AwsRegion, ModelId, ModelPrice, PositiveInt, Usd
from org_agents.identity import ClaimNames
from org_agents.parsing import (
    ParseError,
    expect_int,
    expect_mapping,
    expect_non_empty_str,
    expect_sequence,
    expect_str,
    field,
)

from org_evals.domain import PricedModel

_NAME = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")


def _name(raw: object, path: str) -> str:
    text = expect_non_empty_str(raw, path, max_length=64)
    if not _NAME.fullmatch(text):
        raise ParseError(path, "must be lower-case letters, digits, '-' or '_'")
    return text


def _command(raw: object, path: str) -> tuple[str, ...]:
    items = expect_sequence(raw, path)
    if not items:
        raise ParseError(path, "must not be empty")
    return tuple(expect_non_empty_str(v, f"{path}[{i}]") for i, v in enumerate(items))


def _env(raw: object, path: str) -> Mapping[str, str]:
    fields = expect_mapping(raw, path)
    env: dict[str, str] = {}
    for key, value in fields.items():
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
            raise ParseError(f"{path}.{key}", "must be an upper-case environment variable name")
        env[key] = expect_str(value, f"{path}.{key}")
    return env


def _port(raw: object, path: str) -> int:
    port = expect_int(raw, path, minimum=1)
    if port > 65535:
        raise ParseError(path, "must be <= 65535")
    return port


@dataclass(frozen=True, slots=True)
class ServiceSpec:
    """A helper process the variants need (e.g. the category's tools MCP server)."""

    name: str
    directory: str  # relative to the suite directory
    command: tuple[str, ...]
    env: Mapping[str, str]
    port: int

    @classmethod
    def parse(cls, name: str, raw: object, path: str) -> ServiceSpec:
        fields = expect_mapping(raw, path)
        return cls(
            name=name,
            directory=expect_non_empty_str(field(fields, "dir", path), f"{path}.dir"),
            command=_command(field(fields, "command", path), f"{path}.command"),
            env=_env(fields.get("env", {}), f"{path}.env"),
            port=_port(field(fields, "port", path), f"{path}.port"),
        )


@dataclass(frozen=True, slots=True)
class VariantSpec:
    """How to start one agent variant locally (it must serve the AgentCore contract on ``port``)."""

    name: str
    directory: str
    command: tuple[str, ...]
    env: Mapping[str, str]
    services: tuple[str, ...]
    port: int
    system_prompt: str  # relative to the variant directory; the file autoresearch may edit

    @classmethod
    def parse(cls, name: str, raw: object, known_services: frozenset[str], path: str) -> VariantSpec:
        fields = expect_mapping(raw, path)
        services = tuple(
            expect_non_empty_str(s, f"{path}.services[{i}]")
            for i, s in enumerate(expect_sequence(fields.get("services", []), f"{path}.services"))
        )
        for i, service in enumerate(services):
            if service not in known_services:
                raise ParseError(f"{path}.services[{i}]", f"unknown service {service!r}")
        return cls(
            name=name,
            directory=expect_non_empty_str(field(fields, "dir", path), f"{path}.dir"),
            command=_command(field(fields, "command", path), f"{path}.command"),
            env=_env(fields.get("env", {}), f"{path}.env"),
            services=services,
            port=_port(fields.get("port", 8080), f"{path}.port"),
            system_prompt=expect_non_empty_str(
                fields.get("system_prompt", "prompts/system.md"), f"{path}.system_prompt"
            ),
        )


@dataclass(frozen=True, slots=True)
class RunDefaults:
    repeats: PositiveInt
    concurrency: PositiveInt
    max_usd: Usd  # budget for one ``org-evals run`` (agent + judge)
    request_timeout_seconds: PositiveInt

    @classmethod
    def parse(cls, raw: object, path: str = "$.defaults") -> RunDefaults:
        fields = expect_mapping(raw, path)
        return cls(
            repeats=PositiveInt.parse(fields.get("repeats", 3), f"{path}.repeats"),
            concurrency=PositiveInt.parse(fields.get("concurrency", 4), f"{path}.concurrency"),
            max_usd=Usd.parse(fields.get("max_usd", "2.00"), f"{path}.max_usd"),
            request_timeout_seconds=PositiveInt.parse(
                fields.get("request_timeout_seconds", 300), f"{path}.request_timeout_seconds"
            ),
        )


@dataclass(frozen=True, slots=True)
class Suite:
    name: str
    region: AwsRegion
    claims: ClaimNames
    agent_model: ModelId
    judge_model: ModelId | None
    models: Mapping[str, PricedModel]  # by id and by alias
    services: Mapping[str, ServiceSpec]
    variants: Mapping[str, VariantSpec]
    defaults: RunDefaults

    def model(self, name_or_alias: str, path: str = "--model") -> PricedModel:
        """Every model used in a run needs a price, so costs are never guessed."""
        if name_or_alias not in self.models:
            raise ParseError(path, f"{name_or_alias!r} has no price in suite.toml [models]")
        return self.models[name_or_alias]

    @classmethod
    def parse(cls, raw: object, path: str = "$") -> Suite:
        doc = expect_mapping(raw, path)
        head = expect_mapping(field(doc, "suite", path), f"{path}.suite")

        models: dict[str, PricedModel] = {}
        for model_id, spec in expect_mapping(field(doc, "models", path), f"{path}.models").items():
            where = f"{path}.models.{model_id}"
            fields = expect_mapping(spec, where)
            priced = PricedModel(ModelId.parse(model_id, where), ModelPrice.parse(fields, where))
            models[model_id] = priced
            if "alias" in fields:
                models[_name(fields["alias"], f"{where}.alias")] = priced

        services = {
            name: ServiceSpec.parse(name, spec, f"{path}.services.{name}")
            for name, spec in expect_mapping(doc.get("services", {}), f"{path}.services").items()
        }
        variants = {
            _name(name, f"{path}.variants.{name}"): VariantSpec.parse(
                name, spec, frozenset(services), f"{path}.variants.{name}"
            )
            for name, spec in expect_mapping(field(doc, "variants", path), f"{path}.variants").items()
        }
        if not variants:
            raise ParseError(f"{path}.variants", "at least one variant is required")

        agent_model = ModelId.parse(field(head, "agent_model", f"{path}.suite"), f"{path}.suite.agent_model")
        judge_raw = head.get("judge_model")
        judge_model = ModelId.parse(judge_raw, f"{path}.suite.judge_model") if judge_raw else None
        suite = cls(
            name=_name(field(head, "name", f"{path}.suite"), f"{path}.suite.name"),
            region=AwsRegion.parse(field(head, "region", f"{path}.suite"), f"{path}.suite.region"),
            claims=ClaimNames.parse(head, f"{path}.suite"),
            agent_model=agent_model,
            judge_model=judge_model,
            models=models,
            services=services,
            variants=variants,
            defaults=RunDefaults.parse(doc.get("defaults", {}), f"{path}.defaults"),
        )
        suite.model(agent_model.value, f"{path}.suite.agent_model")
        if judge_model is not None:
            suite.model(judge_model.value, f"{path}.suite.judge_model")
        return suite


ZERO_USD = Usd(Decimal(0))
