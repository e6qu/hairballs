"""Domain types for the generic agent's tools."""

from __future__ import annotations

import enum
import re
from dataclasses import dataclass
from decimal import Decimal

from org_agents.identity import Caller, EmailAddress, HumanUser, ServiceClient
from org_agents.parsing import ParseError, expect_int, expect_non_empty_str

# ---------------------------------------------------------------- calculator


@dataclass(frozen=True, slots=True)
class Expression:
    """An arithmetic expression over decimals: digits, + - * / ( ) and spaces only."""

    text: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[0-9.+\-*/() \t]{1,200}", self.text):
            raise ValueError("invalid expression")

    @classmethod
    def parse(cls, raw: object, path: str = "$.expression") -> Expression:
        text = expect_non_empty_str(raw, path, max_length=200)
        if not re.fullmatch(r"[0-9.+\-*/() \t]{1,200}", text):
            raise ParseError(path, "only digits, decimal points, + - * / ( ) and spaces are allowed")
        return cls(text)


@dataclass(frozen=True, slots=True)
class Calculated:
    value: Decimal


@dataclass(frozen=True, slots=True)
class CalculationError:
    reason: str


CalculationOutcome = Calculated | CalculationError


# ---------------------------------------------------------------- knowledge


@dataclass(frozen=True, slots=True)
class KnowledgeQuery:
    text: str

    @classmethod
    def parse(cls, raw: object, path: str = "$.query") -> KnowledgeQuery:
        return cls(expect_non_empty_str(raw, path, max_length=500))


@dataclass(frozen=True, slots=True)
class DocumentId:
    value: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[a-z0-9-]{1,128}", self.value):
            raise ValueError("invalid document id")


@dataclass(frozen=True, slots=True)
class Document:
    id: DocumentId
    title: str
    body: str


@dataclass(frozen=True, slots=True)
class KnowledgeHit:
    document: DocumentId
    title: str
    snippet: str
    score: Decimal


@dataclass(frozen=True, slots=True)
class HitLimit:
    value: int

    def __post_init__(self) -> None:
        if not 1 <= self.value <= 10:
            raise ValueError("hit limit must be between 1 and 10")

    @classmethod
    def parse(cls, raw: object, path: str = "$.max_results") -> HitLimit:
        value = expect_int(raw, path, minimum=1)
        if value > 10:
            raise ParseError(path, "must be <= 10")
        return cls(value)


# ---------------------------------------------------------------- requester


@dataclass(frozen=True, slots=True)
class Requester:
    """Who asked for a ticket. ``reference`` is the org ``UserId`` for people (stable across email and
    name changes) or the Auth0 client subject for services. ``name``/``email`` are PII."""

    reference: str
    name: str
    email: EmailAddress | None

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[A-Za-z0-9._:@|-]{1,256}", self.reference):
            raise ValueError("invalid requester reference")
        if not 1 <= len(self.name) <= 201:
            raise ValueError("invalid requester name")

    @classmethod
    def from_caller(cls, caller: Caller) -> Requester:
        match caller:
            case HumanUser(user_id=user_id, email=email):
                return cls(user_id.value, caller.display_name, email)
            case ServiceClient(subject=subject):
                return cls(subject.value, caller.display_name, None)

    @classmethod
    def parse(cls, reference: object, name: object, email: object, path: str = "$.requester") -> Requester:
        """For requester fields arriving over MCP (set by the calling harness, never by the model)."""
        ref = expect_non_empty_str(reference, f"{path}.reference", max_length=256)
        if not re.fullmatch(r"[A-Za-z0-9._:@|-]{1,256}", ref):
            raise ParseError(f"{path}.reference", "is not a user id or client subject")
        return cls(
            reference=ref,
            name=expect_non_empty_str(name, f"{path}.name", max_length=201),
            email=EmailAddress.parse(email, f"{path}.email") if email not in (None, "") else None,
        )

    def render(self) -> str:
        return (
            f"{self.name} <{self.email.value}> ({self.reference})"
            if self.email
            else f"{self.name} ({self.reference})"
        )


# ---------------------------------------------------------------- tickets


class TicketPriority(enum.Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"

    @classmethod
    def parse(cls, raw: object, path: str = "$.priority") -> TicketPriority:
        text = expect_non_empty_str(raw, path).lower()
        try:
            return cls(text)
        except ValueError as exc:
            raise ParseError(path, "must be one of low, normal, high") from exc


@dataclass(frozen=True, slots=True)
class TicketTitle:
    text: str

    def __post_init__(self) -> None:
        if not 3 <= len(self.text) <= 120:
            raise ValueError("ticket title must be 3-120 characters")

    @classmethod
    def parse(cls, raw: object, path: str = "$.title") -> TicketTitle:
        text = expect_non_empty_str(raw, path, max_length=120)
        if len(text) < 3:
            raise ParseError(path, "must be at least 3 characters")
        return cls(text)


@dataclass(frozen=True, slots=True)
class TicketDescription:
    text: str

    @classmethod
    def parse(cls, raw: object, path: str = "$.description") -> TicketDescription:
        return cls(expect_non_empty_str(raw, path, max_length=4000))


@dataclass(frozen=True, slots=True)
class TicketId:
    value: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"TCK-\d{6}", self.value):
            raise ValueError("invalid ticket id")

    @classmethod
    def parse(cls, raw: object, path: str = "$.ticket_id") -> TicketId:
        text = expect_non_empty_str(raw, path, max_length=16).upper()
        if not re.fullmatch(r"TCK-\d{6}", text):
            raise ParseError(path, "must look like TCK-000123")
        return cls(text)

    @classmethod
    def from_sequence(cls, number: int) -> TicketId:
        return cls(f"TCK-{number:06d}")


@dataclass(frozen=True, slots=True)
class TicketRequest:
    title: TicketTitle
    description: TicketDescription
    priority: TicketPriority


@dataclass(frozen=True, slots=True)
class Ticket:
    id: TicketId
    title: TicketTitle
    description: TicketDescription
    priority: TicketPriority
    requested_by: Requester
