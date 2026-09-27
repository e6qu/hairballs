"""Domain types shared by every agent template.

Values with meaning get their own type. Constructors enforce invariants; outside data
enters only through the ``parse`` classmethods or the parsers in :mod:`org_agents.parsing`.
"""

from __future__ import annotations

import enum
import fnmatch
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal

from org_agents.parsing import (
    ParseError,
    expect_decimal,
    expect_int,
    expect_mapping,
    expect_non_empty_str,
    expect_sequence,
    field,
)

_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:@/-]{1,256}$")
# Auth0 subjects look like "auth0|123", "google-oauth2|123" or "<client_id>@clients".
_PRINCIPAL_PATTERN = re.compile(r"^[A-Za-z0-9._:@/|-]{1,256}$")
_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,127}$")
_TOOL_PATTERN_PATTERN = re.compile(r"^[A-Za-z0-9_.*?-]{1,128}$")
_MICRO = Decimal("0.000001")


# ---------------------------------------------------------------- identifiers


@dataclass(frozen=True, slots=True)
class SessionId:
    """An AgentCore runtime session / conversation thread identifier."""

    value: str

    def __post_init__(self) -> None:
        if not _ID_PATTERN.match(self.value):
            raise ValueError("invalid session id")

    @classmethod
    def parse(cls, raw: object, path: str = "$.session_id") -> SessionId:
        text = expect_non_empty_str(raw, path, max_length=256)
        if not _ID_PATTERN.match(text):
            raise ParseError(path, "contains characters outside [A-Za-z0-9._:@/-]")
        return cls(text)


@dataclass(frozen=True, slots=True)
class PrincipalId:
    """Who the agent acts for: an Auth0 ``sub`` (user or ``<client>@clients``) or an IAM principal."""

    value: str

    def __post_init__(self) -> None:
        if not _PRINCIPAL_PATTERN.match(self.value):
            raise ValueError("invalid principal id")

    @classmethod
    def parse(cls, raw: object, path: str = "$.principal") -> PrincipalId:
        text = expect_non_empty_str(raw, path, max_length=256)
        if not _PRINCIPAL_PATTERN.match(text):
            raise ParseError(path, "contains unsupported characters")
        return cls(text)


@dataclass(frozen=True, slots=True)
class MessageId:
    value: str

    def __post_init__(self) -> None:
        if not _ID_PATTERN.match(self.value):
            raise ValueError("invalid message id")

    @classmethod
    def parse(cls, raw: object, path: str = "$.message_id") -> MessageId:
        text = expect_non_empty_str(raw, path, max_length=256)
        if not _ID_PATTERN.match(text):
            raise ParseError(path, "contains unsupported characters")
        return cls(text)


@dataclass(frozen=True, slots=True)
class ToolName:
    value: str

    def __post_init__(self) -> None:
        if not _TOOL_NAME_PATTERN.match(self.value):
            raise ValueError(f"invalid tool name: {self.value!r}")

    @classmethod
    def parse(cls, raw: object, path: str = "$.tool") -> ToolName:
        text = expect_non_empty_str(raw, path, max_length=128)
        if not _TOOL_NAME_PATTERN.match(text):
            raise ParseError(path, "is not a valid tool name")
        return cls(text)


@dataclass(frozen=True, slots=True)
class ToolPattern:
    """A glob over tool names, e.g. ``gw_*`` or ``create_ticket``."""

    value: str

    def __post_init__(self) -> None:
        if not _TOOL_PATTERN_PATTERN.match(self.value):
            raise ValueError(f"invalid tool pattern: {self.value!r}")

    def matches(self, tool: ToolName) -> bool:
        return fnmatch.fnmatchcase(tool.value, self.value)

    @classmethod
    def parse(cls, raw: object, path: str) -> ToolPattern:
        text = expect_non_empty_str(raw, path, max_length=128)
        if not _TOOL_PATTERN_PATTERN.match(text):
            raise ParseError(path, "is not a valid tool pattern")
        return cls(text)


@dataclass(frozen=True, slots=True)
class Fingerprint:
    """A stable hash of canonical tool arguments (computed in the shell from raw arguments)."""

    value: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[0-9a-f]{64}", self.value):
            raise ValueError("fingerprint must be a sha256 hex digest")


@dataclass(frozen=True, slots=True)
class ModelId:
    """A Bedrock model id, cross-region inference profile id, or application inference profile ARN."""

    value: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[A-Za-z0-9._:/-]{3,2048}", self.value):
            raise ValueError("invalid model id")

    @classmethod
    def parse(cls, raw: object, path: str = "$.model_id") -> ModelId:
        text = expect_non_empty_str(raw, path, max_length=2048)
        if not re.fullmatch(r"[A-Za-z0-9._:/-]{3,2048}", text):
            raise ParseError(path, "is not a valid Bedrock model id or ARN")
        return cls(text)


@dataclass(frozen=True, slots=True)
class AwsRegion:
    value: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[a-z]{2}(-gov)?-[a-z]+-\d", self.value):
            raise ValueError("invalid AWS region")

    @classmethod
    def parse(cls, raw: object, path: str = "$.region") -> AwsRegion:
        text = expect_non_empty_str(raw, path, max_length=32)
        if not re.fullmatch(r"[a-z]{2}(-gov)?-[a-z]+-\d", text):
            raise ParseError(path, "is not an AWS region")
        return cls(text)


# ---------------------------------------------------------------- quantities


@dataclass(frozen=True, slots=True, order=True)
class Usd:
    """A non-negative amount of US dollars, kept at micro-dollar precision. Never a float."""

    amount: Decimal

    def __post_init__(self) -> None:
        if not self.amount.is_finite() or self.amount < 0:
            raise ValueError("Usd must be a finite, non-negative amount")
        object.__setattr__(self, "amount", self.amount.quantize(_MICRO))

    @classmethod
    def zero(cls) -> Usd:
        return cls(Decimal(0))

    def __add__(self, other: Usd) -> Usd:
        return Usd(self.amount + other.amount)

    @classmethod
    def parse(cls, raw: object, path: str) -> Usd:
        return cls(expect_decimal(raw, path, minimum=Decimal(0)))

    def __str__(self) -> str:
        return f"${self.amount.normalize():f}"


@dataclass(frozen=True, slots=True, order=True)
class TokenCount:
    value: int

    def __post_init__(self) -> None:
        if self.value < 0:
            raise ValueError("token count must be >= 0")

    def __add__(self, other: TokenCount) -> TokenCount:
        return TokenCount(self.value + other.value)

    @classmethod
    def parse(cls, raw: object, path: str) -> TokenCount:
        return cls(expect_int(raw, path, minimum=0))


@dataclass(frozen=True, slots=True, order=True)
class PositiveInt:
    value: int

    def __post_init__(self) -> None:
        if self.value < 1:
            raise ValueError("must be >= 1")

    @classmethod
    def parse(cls, raw: object, path: str) -> PositiveInt:
        return cls(expect_int(raw, path, minimum=1))


@dataclass(frozen=True, slots=True)
class Usage:
    """Token usage reported by one model call."""

    input_tokens: TokenCount
    output_tokens: TokenCount
    cache_read_tokens: TokenCount = TokenCount(0)
    cache_write_tokens: TokenCount = TokenCount(0)

    @property
    def total(self) -> TokenCount:
        return self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens


@dataclass(frozen=True, slots=True)
class ModelPrice:
    """USD price per one million tokens for a model (or application inference profile)."""

    input_per_mtok: Usd
    output_per_mtok: Usd
    cache_read_per_mtok: Usd
    cache_write_per_mtok: Usd

    @classmethod
    def parse(cls, raw: object, path: str = "$.price") -> ModelPrice:
        fields = expect_mapping(raw, path)
        return cls(
            input_per_mtok=Usd.parse(field(fields, "input_per_mtok", path), f"{path}.input_per_mtok"),
            output_per_mtok=Usd.parse(field(fields, "output_per_mtok", path), f"{path}.output_per_mtok"),
            cache_read_per_mtok=Usd.parse(
                field(fields, "cache_read_per_mtok", path), f"{path}.cache_read_per_mtok"
            ),
            cache_write_per_mtok=Usd.parse(
                field(fields, "cache_write_per_mtok", path), f"{path}.cache_write_per_mtok"
            ),
        )


# ---------------------------------------------------------------- limits and policy


@dataclass(frozen=True, slots=True)
class Limits:
    """Per-run limits enforced by the guard. Every agent run has all of them."""

    max_turns: PositiveInt
    max_total_tokens: PositiveInt
    max_usd: Usd
    max_wall_time: timedelta
    max_tool_calls: PositiveInt
    repeat_threshold: PositiveInt

    def __post_init__(self) -> None:
        if self.max_wall_time <= timedelta(0):
            raise ValueError("max_wall_time must be positive")
        if self.repeat_threshold.value < 2:
            raise ValueError("repeat_threshold must be >= 2")

    @classmethod
    def parse(cls, raw: object, path: str = "$.limits") -> Limits:
        fields = expect_mapping(raw, path)
        repeat = PositiveInt.parse(field(fields, "repeat_threshold", path), f"{path}.repeat_threshold")
        if repeat.value < 2:
            raise ParseError(f"{path}.repeat_threshold", "must be >= 2")
        return cls(
            max_turns=PositiveInt.parse(field(fields, "max_turns", path), f"{path}.max_turns"),
            max_total_tokens=PositiveInt.parse(
                field(fields, "max_total_tokens", path), f"{path}.max_total_tokens"
            ),
            max_usd=Usd.parse(field(fields, "max_usd", path), f"{path}.max_usd"),
            max_wall_time=timedelta(
                seconds=PositiveInt.parse(
                    field(fields, "max_wall_seconds", path), f"{path}.max_wall_seconds"
                ).value
            ),
            max_tool_calls=PositiveInt.parse(field(fields, "max_tool_calls", path), f"{path}.max_tool_calls"),
            repeat_threshold=repeat,
        )


@dataclass(frozen=True, slots=True)
class ToolPolicy:
    """Which tools may run, and which need human approval first. Unlisted tools are denied."""

    allowed: tuple[ToolPattern, ...]
    approval_required: tuple[ToolPattern, ...]

    @classmethod
    def parse(cls, raw: object, path: str = "$.tools") -> ToolPolicy:
        fields = expect_mapping(raw, path)
        allowed_raw = expect_sequence(field(fields, "allowed", path), f"{path}.allowed")
        approval_raw = expect_sequence(fields.get("approval_required", []), f"{path}.approval_required")
        return cls(
            allowed=tuple(
                ToolPattern.parse(item, f"{path}.allowed[{i}]") for i, item in enumerate(allowed_raw)
            ),
            approval_required=tuple(
                ToolPattern.parse(item, f"{path}.approval_required[{i}]")
                for i, item in enumerate(approval_raw)
            ),
        )


# ---------------------------------------------------------------- conversation


@dataclass(frozen=True, slots=True)
class Prompt:
    """A user prompt: non-empty text with a bounded size."""

    text: str

    MAX_CHARS = 32_000

    def __post_init__(self) -> None:
        if not self.text.strip():
            raise ValueError("prompt must not be empty")
        if len(self.text) > self.MAX_CHARS:
            raise ValueError("prompt too long")

    @classmethod
    def parse(cls, raw: object, path: str = "$.prompt") -> Prompt:
        return cls(expect_non_empty_str(raw, path, max_length=cls.MAX_CHARS))


class ApprovalDecision(enum.Enum):
    APPROVE = "approve"
    REJECT = "reject"

    @classmethod
    def parse(cls, raw: object, path: str) -> ApprovalDecision:
        text = expect_non_empty_str(raw, path).lower()
        try:
            return cls(text)
        except ValueError as exc:
            raise ParseError(path, "must be 'approve' or 'reject'") from exc


@dataclass(frozen=True, slots=True)
class ApprovalId:
    value: str

    def __post_init__(self) -> None:
        if not _ID_PATTERN.match(self.value):
            raise ValueError("invalid approval id")

    @classmethod
    def parse(cls, raw: object, path: str) -> ApprovalId:
        text = expect_non_empty_str(raw, path, max_length=256)
        if not _ID_PATTERN.match(text):
            raise ParseError(path, "contains unsupported characters")
        return cls(text)


@dataclass(frozen=True, slots=True)
class Instant:
    """A point in time, always timezone-aware (UTC). Supplied by the shell's clock."""

    at: datetime

    def __post_init__(self) -> None:
        if self.at.tzinfo is None:
            raise ValueError("Instant must be timezone-aware")

    def __sub__(self, other: Instant) -> timedelta:
        return self.at - other.at
