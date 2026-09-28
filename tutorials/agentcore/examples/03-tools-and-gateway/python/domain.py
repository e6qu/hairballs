"""Domain types for the expenses tool and its callers. Standard library only (the Lambda has no dependencies).

Data from outside the program (tool arguments, the Lambda context, environment, MCP results) is parsed into these
types at the boundary. After that, a value that exists is valid: no code downstream re-checks it.
"""

from __future__ import annotations

import enum
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

_GATEWAY_URL = re.compile(
    r"https://[a-z0-9-]+\.gateway\.bedrock-agentcore\.[a-z0-9-]+\.amazonaws\.com/mcp"
)


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


def _fields(raw: object, path: str) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(f"{path}: expected an object, got {type(raw).__name__}")
    return raw


class Category(enum.Enum):
    HOTEL = "hotel"  # per night
    MEALS = "meals"  # per day


class CityClass(enum.Enum):
    MAJOR = "major"
    STANDARD = "standard"


@dataclass(frozen=True, slots=True)
class Eur:
    """A non-negative amount of euros. Money is a Decimal, never a float."""

    amount: Decimal

    @classmethod
    def parse(cls, raw: object, path: str = "$") -> Eur:
        if isinstance(raw, bool) or not isinstance(raw, int | float | str):
            raise ParseError(f"{path}: expected an amount in EUR, got {raw!r}")
        try:
            amount = Decimal(str(raw))
        except InvalidOperation as exc:
            raise ParseError(f"{path}: not a number: {raw!r}") from exc
        if not amount.is_finite() or amount < 0:
            raise ParseError(f"{path}: must be a non-negative amount, got {raw!r}")
        return cls(amount)

    def to_json(self) -> int | float:
        """For outbound JSON only (tool arguments and results are JSON numbers)."""
        integral = self.amount == self.amount.to_integral_value()
        return int(self.amount) if integral else float(self.amount)


@dataclass(frozen=True, slots=True)
class Claim:
    category: Category
    amount: Eur
    city: CityClass


def _enum[E: enum.Enum](kind: type[E], raw: object, path: str) -> E:
    try:
        return kind(raw)
    except ValueError as exc:
        allowed = ", ".join(str(m.value) for m in kind)
        raise ParseError(f"{path}: expected one of {allowed}, got {raw!r}") from exc


def parse_claim(raw: object) -> Claim:
    """The check_claim tool's arguments, as the gateway passes them to the Lambda."""
    fields = _fields(raw, "$")
    return Claim(
        category=_enum(Category, fields.get("category"), "$.category"),
        amount=Eur.parse(fields.get("amount_eur"), "$.amount_eur"),
        city=_enum(CityClass, fields.get("city_class", "standard"), "$.city_class"),
    )


@dataclass(frozen=True, slots=True)
class GatewayToolName:
    """How a gateway names a tool: <target>___<tool>, e.g. expenses___check_claim."""

    target: str
    tool: str

    @classmethod
    def parse(cls, raw: str) -> GatewayToolName:
        target, sep, tool = raw.partition("___")
        if not (sep and target and tool):
            raise ParseError(f"not a gateway tool name (<target>___<tool>): {raw!r}")
        return cls(target, tool)

    def __str__(self) -> str:
        return f"{self.target}___{self.tool}"


def parse_invoked_tool(context: object) -> GatewayToolName:
    """The tool the gateway invoked, from the Lambda context (client_context.custom)."""
    custom = getattr(getattr(context, "client_context", None), "custom", None)
    name = _fields(custom, "context.client_context.custom").get("bedrockAgentCoreToolName")
    if not isinstance(name, str):
        raise ParseError("context.client_context.custom: no bedrockAgentCoreToolName")
    return GatewayToolName.parse(name)


@dataclass(frozen=True, slots=True)
class WithinPolicy:
    limit: Eur


@dataclass(frozen=True, slots=True)
class OverLimit:
    limit: Eur
    excess: Eur


Verdict = WithinPolicy | OverLimit


def parse_verdict(text: str) -> Verdict:
    """The check_claim result, as the MCP client receives it (JSON text)."""
    try:
        fields = _fields(json.loads(text), "$")
    except json.JSONDecodeError as exc:
        raise ParseError(f"$: not JSON: {text[:80]!r}") from exc
    limit = Eur.parse(fields.get("limit_eur"), "$.limit_eur")
    match fields.get("within_policy"):
        case True:
            return WithinPolicy(limit)
        case False:
            return OverLimit(limit, Eur.parse(fields.get("excess_eur"), "$.excess_eur"))
        case other:
            raise ParseError(f"$.within_policy: expected true or false, got {other!r}")


@dataclass(frozen=True, slots=True)
class GatewayUrl:
    """The gateway's MCP endpoint: https://<id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> GatewayUrl:
        if not _GATEWAY_URL.fullmatch(raw):
            raise ParseError(f"not a gateway MCP URL: {raw!r}")
        return cls(raw)
