"""Domain types for scenario evals: scenarios (what to say and what to expect) and observations
(what the agent replied and what its audit log recorded). Parsers turn TOML / JSON into these."""

from __future__ import annotations

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal

from org_agents.domain import (
    ApprovalDecision,
    ModelId,
    ModelPrice,
    PrincipalId,
    TokenCount,
    ToolName,
    Usage,
    Usd,
)
from org_agents.identity import EmailAddress, PersonName
from org_agents.parsing import (
    ParseError,
    expect_int,
    expect_mapping,
    expect_non_empty_str,
    expect_sequence,
    expect_str,
    field,
)

# ---------------------------------------------------------------- identifiers


@dataclass(frozen=True, slots=True)
class ScenarioId:
    value: str

    def __post_init__(self) -> None:
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", self.value):
            raise ValueError("invalid scenario id")

    @classmethod
    def parse(cls, raw: object, path: str) -> ScenarioId:
        text = expect_non_empty_str(raw, path, max_length=64)
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", text):
            raise ParseError(path, "must be lower-case letters, digits, '-' or '_'")
        return cls(text)


@dataclass(frozen=True, slots=True)
class Tag:
    value: str

    @classmethod
    def parse(cls, raw: object, path: str) -> Tag:
        text = expect_non_empty_str(raw, path, max_length=32)
        if not re.fullmatch(r"[a-z0-9_-]{1,32}", text):
            raise ParseError(path, "must be lower-case letters, digits, '-' or '_'")
        return cls(text)


SAFETY = Tag("safety")


class Split(enum.Enum):
    """``dev`` scenarios may be read and optimised against; ``holdout`` ones are only for final checks."""

    DEV = "dev"
    HOLDOUT = "holdout"


@dataclass(frozen=True, slots=True)
class ActorName:
    value: str

    @classmethod
    def parse(cls, raw: object, path: str) -> ActorName:
        text = expect_non_empty_str(raw, path, max_length=32)
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", text):
            raise ParseError(path, "must be a lower-case name like 'alice'")
        return cls(text)


@dataclass(frozen=True, slots=True)
class Actor:
    """A synthetic test user. Never use real people's data in scenarios."""

    name: ActorName
    subject: PrincipalId
    email: EmailAddress
    given_name: PersonName | None
    family_name: PersonName | None

    @classmethod
    def parse(cls, name: ActorName, raw: object, path: str) -> Actor:
        fields = expect_mapping(raw, path)
        given, family = fields.get("given_name"), fields.get("family_name")
        return cls(
            name=name,
            subject=PrincipalId.parse(field(fields, "subject", path), f"{path}.subject"),
            email=EmailAddress.parse(field(fields, "email", path), f"{path}.email"),
            given_name=PersonName.parse(given, f"{path}.given_name") if given else None,
            family_name=PersonName.parse(family, f"{path}.family_name") if family else None,
        )


def parse_actors(raw: object, path: str = "$.actors") -> Mapping[ActorName, Actor]:
    fields = expect_mapping(raw, path)
    actors: dict[ActorName, Actor] = {}
    for key, value in fields.items():
        name = ActorName.parse(key, f"{path}.{key}")
        actors[name] = Actor.parse(name, value, f"{path}.{key}")
    if not actors:
        raise ParseError(path, "at least one actor is required")
    return actors


# ---------------------------------------------------------------- replies


class ReplyStatus(enum.Enum):
    COMPLETED = "completed"
    APPROVAL_REQUIRED = "approval_required"
    STOPPED = "stopped"
    FAILED = "failed"
    REFUSED = "refused"
    INVALID_REQUEST = "invalid_request"
    STEERED = "steered"
    QUEUED = "queued"
    CANCELLING = "cancelling"
    DUPLICATE = "duplicate"

    @classmethod
    def parse(cls, raw: object, path: str) -> ReplyStatus:
        text = expect_non_empty_str(raw, path)
        try:
            return cls(text)
        except ValueError as exc:
            raise ParseError(path, f"unknown status {text!r}") from exc


# ---------------------------------------------------------------- scenario steps


@dataclass(frozen=True, slots=True)
class Say:
    actor: ActorName
    text: str
    expect: ReplyStatus | None


@dataclass(frozen=True, slots=True)
class Decide:
    """Answer the most recent approval request."""

    actor: ActorName
    decision: ApprovalDecision
    expect: ReplyStatus | None


@dataclass(frozen=True, slots=True)
class Cancel:
    actor: ActorName
    expect: ReplyStatus | None


Step = Say | Decide | Cancel


def parse_step(raw: object, actors: Mapping[ActorName, Actor], path: str) -> Step:
    fields = expect_mapping(raw, path)
    kinds = [k for k in ("say", "decide", "cancel") if k in fields]
    if len(kinds) != 1:
        raise ParseError(path, "needs exactly one of 'say', 'decide' or 'cancel'")
    actor = ActorName.parse(field(fields, "as", path), f"{path}.as")
    if actor not in actors:
        raise ParseError(f"{path}.as", f"unknown actor {actor.value!r} (see actors.toml)")
    expect = ReplyStatus.parse(fields["expect"], f"{path}.expect") if "expect" in fields else None
    match kinds[0]:
        case "say":
            return Say(actor, expect_non_empty_str(fields["say"], f"{path}.say", max_length=8000), expect)
        case "decide":
            return Decide(actor, ApprovalDecision.parse(fields["decide"], f"{path}.decide"), expect)
        case _:
            if fields["cancel"] is not True:
                raise ParseError(f"{path}.cancel", "must be true")
            return Cancel(actor, expect)


# ---------------------------------------------------------------- expectations


@dataclass(frozen=True, slots=True)
class Expectations:
    """Code-checked expectations. Text checks apply to the final reply; tool checks to the audit log."""

    answer_includes: tuple[str, ...] = ()
    answer_excludes: tuple[str, ...] = ()
    answer_matches: tuple[re.Pattern[str], ...] = ()
    tools_called: tuple[ToolName, ...] = ()  # in this order (other calls may come in between)
    tools_not_called: tuple[ToolName, ...] = ()
    approvals: int | None = None  # exact number of approval requests
    audit_excludes: tuple[str, ...] = ()  # e.g. emails and names: PII must never reach the audit log
    max_usd: Usd | None = None

    @classmethod
    def parse(cls, raw: object, path: str = "$.expect") -> Expectations:
        fields = expect_mapping(raw, path)
        known = set(cls.__slots__)
        unknown = sorted(set(fields) - known)
        if unknown:
            raise ParseError(path, f"unknown keys {unknown}; allowed: {sorted(known)}")

        def texts(name: str) -> tuple[str, ...]:
            items = expect_sequence(fields.get(name, []), f"{path}.{name}")
            return tuple(expect_non_empty_str(v, f"{path}.{name}[{i}]") for i, v in enumerate(items))

        def tools(name: str) -> tuple[ToolName, ...]:
            items = expect_sequence(fields.get(name, []), f"{path}.{name}")
            return tuple(ToolName.parse(v, f"{path}.{name}[{i}]") for i, v in enumerate(items))

        patterns: list[re.Pattern[str]] = []
        for i, text in enumerate(texts("answer_matches")):
            try:
                patterns.append(re.compile(text, re.IGNORECASE))
            except re.error as exc:
                raise ParseError(f"{path}.answer_matches[{i}]", f"is not a valid regex: {exc}") from exc
        return cls(
            answer_includes=texts("answer_includes"),
            answer_excludes=texts("answer_excludes"),
            answer_matches=tuple(patterns),
            tools_called=tools("tools_called"),
            tools_not_called=tools("tools_not_called"),
            approvals=expect_int(fields["approvals"], f"{path}.approvals", minimum=0)
            if "approvals" in fields
            else None,
            audit_excludes=texts("audit_excludes"),
            max_usd=Usd.parse(fields["max_usd"], f"{path}.max_usd") if "max_usd" in fields else None,
        )


@dataclass(frozen=True, slots=True)
class Rubric:
    """What an LLM judge checks that code cannot (tone, refusal quality, faithfulness)."""

    text: str

    @classmethod
    def parse(cls, raw: object, path: str = "$.judge") -> Rubric:
        fields = expect_mapping(raw, path)
        return cls(expect_non_empty_str(field(fields, "rubric", path), f"{path}.rubric", max_length=2000))


@dataclass(frozen=True, slots=True)
class Scenario:
    id: ScenarioId
    description: str
    split: Split
    tags: frozenset[Tag]
    steps: tuple[Step, ...]
    expect: Expectations
    rubric: Rubric | None

    @classmethod
    def parse(cls, raw: object, split: Split, actors: Mapping[ActorName, Actor], path: str) -> Scenario:
        fields = expect_mapping(raw, path)
        steps_raw = expect_sequence(field(fields, "steps", path), f"{path}.steps")
        if not steps_raw:
            raise ParseError(f"{path}.steps", "at least one step is required")
        tags = expect_sequence(fields.get("tags", []), f"{path}.tags")
        return cls(
            id=ScenarioId.parse(field(fields, "id", path), f"{path}.id"),
            description=expect_str(fields.get("description", ""), f"{path}.description"),
            split=split,
            tags=frozenset(Tag.parse(t, f"{path}.tags[{i}]") for i, t in enumerate(tags)),
            steps=tuple(parse_step(s, actors, f"{path}.steps[{i}]") for i, s in enumerate(steps_raw)),
            expect=Expectations.parse(fields.get("expect", {}), f"{path}.expect"),
            rubric=Rubric.parse(fields["judge"], f"{path}.judge") if "judge" in fields else None,
        )


# ---------------------------------------------------------------- observations


@dataclass(frozen=True, slots=True)
class ObservedReply:
    status: ReplyStatus
    text: str  # answers joined, or the reason / error for other statuses
    approval_id: str | None
    latency_ms: int

    @classmethod
    def parse(cls, raw: object, latency_ms: int, path: str = "$.reply") -> ObservedReply:
        body = expect_mapping(raw, path)
        status = ReplyStatus.parse(field(body, "status", path), f"{path}.status")
        match status:
            case ReplyStatus.COMPLETED:
                answers = expect_sequence(body.get("answers", []), f"{path}.answers")
                text = "\n\n".join(expect_str(a, f"{path}.answers[{i}]") for i, a in enumerate(answers))
            case ReplyStatus.STOPPED:
                text = expect_str(body.get("answer", ""), f"{path}.answer")
            case ReplyStatus.APPROVAL_REQUIRED:
                text = expect_str(body.get("reason", ""), f"{path}.reason")
            case ReplyStatus.FAILED | ReplyStatus.INVALID_REQUEST:
                text = expect_str(body.get("error", ""), f"{path}.error")
            case ReplyStatus.REFUSED:
                text = expect_str(body.get("reason", ""), f"{path}.reason")
            case _:
                text = ""
        approval = (
            expect_non_empty_str(field(body, "approval_id", path), f"{path}.approval_id")
            if status is ReplyStatus.APPROVAL_REQUIRED
            else None
        )
        return cls(status, text, approval, latency_ms)


class ToolOutcome(enum.Enum):
    ALLOWED = "allowed"
    DENIED = "denied"
    NEEDS_APPROVAL = "needs_approval"
    STOPPED = "stopped"


@dataclass(frozen=True, slots=True)
class ToolDecisionSeen:
    tool: ToolName
    outcome: ToolOutcome


@dataclass(frozen=True, slots=True)
class UsageSeen:
    usage: Usage


@dataclass(frozen=True, slots=True)
class RunEndSeen:
    kind: str  # run_finished | run_stopped | run_failed
    detail: str


AuditSeen = ToolDecisionSeen | UsageSeen | RunEndSeen


def parse_audit(raw: object, path: str = "$.audit") -> AuditSeen | None:
    """One org audit record (JSON lines from the agent's stdout); ``None`` for record types we ignore."""
    record = expect_mapping(raw, path)
    kind = expect_str(record.get("type", ""), f"{path}.type")
    match kind:
        case "tool_decision":
            outcome_text = expect_str(field(record, "outcome", path), f"{path}.outcome")
            try:
                outcome = ToolOutcome(outcome_text)
            except ValueError as exc:
                raise ParseError(f"{path}.outcome", f"unknown outcome {outcome_text!r}") from exc
            return ToolDecisionSeen(ToolName.parse(field(record, "tool", path), f"{path}.tool"), outcome)
        case "usage":

            def tokens(name: str) -> TokenCount:
                return TokenCount(expect_int(record.get(name, 0), f"{path}.{name}", minimum=0))

            return UsageSeen(
                Usage(
                    tokens("input_tokens"),
                    tokens("output_tokens"),
                    tokens("cache_read_tokens"),
                    tokens("cache_write_tokens"),
                )
            )
        case "run_finished" | "run_stopped" | "run_failed":
            detail = record.get("reason") or record.get("error") or ""
            return RunEndSeen(kind, expect_str(detail, f"{path}.detail"))
        case _:
            return None


@dataclass(frozen=True, slots=True)
class Transcript:
    """Everything observed while playing one scenario once."""

    replies: tuple[ObservedReply, ...]
    audit: tuple[AuditSeen, ...]
    audit_lines: tuple[str, ...]  # raw lines, for PII checks
    error: str | None  # the harness could not complete the scenario (transport error, timeout...)


# ---------------------------------------------------------------- models


@dataclass(frozen=True, slots=True)
class PricedModel:
    id: ModelId
    price: ModelPrice


@dataclass(frozen=True, slots=True)
class Verdict:
    passed: bool
    reason: str

    @classmethod
    def parse(cls, raw: object, path: str = "$.verdict") -> Verdict:
        fields = expect_mapping(raw, path)
        passed = field(fields, "passed", path)
        if not isinstance(passed, bool):
            raise ParseError(f"{path}.passed", "expected a boolean")
        return cls(passed, expect_str(fields.get("reason", ""), f"{path}.reason")[:1000])


@dataclass(frozen=True, slots=True)
class Ratio:
    """A fraction in [0, 1], kept as a Decimal."""

    value: Decimal

    def __post_init__(self) -> None:
        if not Decimal(0) <= self.value <= Decimal(1):
            raise ValueError("ratio must be within [0, 1]")

    @classmethod
    def of(cls, part: int, whole: int) -> Ratio:
        return cls(
            Decimal(0) if whole == 0 else (Decimal(part) / Decimal(whole)).quantize(Decimal("0.000001"))
        )
