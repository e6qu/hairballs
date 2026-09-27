"""Scoring (pure): compare what one scenario run produced with what the scenario expects."""

from __future__ import annotations

from dataclasses import dataclass

from org_agents.core.pricing import cost_of
from org_agents.domain import ModelPrice, TokenCount, ToolName, Usage, Usd

from org_evals.domain import (
    Decide,
    ObservedReply,
    ReplyStatus,
    Say,
    Scenario,
    ToolDecisionSeen,
    ToolOutcome,
    Transcript,
    UsageSeen,
)

_CALLED = frozenset({ToolOutcome.ALLOWED, ToolOutcome.NEEDS_APPROVAL})


@dataclass(frozen=True, slots=True)
class Check:
    name: str
    passed: bool
    detail: str = ""


def add_usage(a: Usage, b: Usage) -> Usage:
    return Usage(
        a.input_tokens + b.input_tokens,
        a.output_tokens + b.output_tokens,
        a.cache_read_tokens + b.cache_read_tokens,
        a.cache_write_tokens + b.cache_write_tokens,
    )


NO_USAGE = Usage(TokenCount(0), TokenCount(0))


def total_usage(transcript: Transcript) -> Usage:
    total = NO_USAGE
    for seen in transcript.audit:
        if isinstance(seen, UsageSeen):
            total = add_usage(total, seen.usage)
    return total


def agent_cost(transcript: Transcript, price: ModelPrice) -> Usd:
    return cost_of(total_usage(transcript), price)


def tools_called(transcript: Transcript) -> tuple[ToolName, ...]:
    """Tools the model called (allowed, or held for approval), in order."""
    return tuple(a.tool for a in transcript.audit if isinstance(a, ToolDecisionSeen) and a.outcome in _CALLED)


def final_text(transcript: Transcript) -> str:
    texts = [r.text for r in transcript.replies if r.status in (ReplyStatus.COMPLETED, ReplyStatus.STOPPED)]
    return texts[-1] if texts else ""


def _is_subsequence(wanted: tuple[ToolName, ...], seen: tuple[ToolName, ...]) -> bool:
    it = iter(seen)
    return all(any(s == w for s in it) for w in wanted)


def _step_checks(scenario: Scenario, replies: tuple[ObservedReply, ...]) -> list[Check]:
    checks: list[Check] = []
    for i, (step, reply) in enumerate(zip(scenario.steps, replies, strict=False), start=1):
        if step.expect is not None:
            ok = reply.status is step.expect
            detail = (
                "" if ok else f"expected {step.expect.value}, got {reply.status.value}: {reply.text[:200]}"
            )
            checks.append(Check(f"step {i} status", ok, detail))
    return checks


def check_scenario(scenario: Scenario, transcript: Transcript, price: ModelPrice) -> tuple[Check, ...]:
    if transcript.error is not None:
        return (Check("run", False, transcript.error),)
    expect = scenario.expect
    checks = _step_checks(scenario, transcript.replies)
    answer = final_text(transcript)
    lowered = answer.lower()

    checks += [
        Check(f"answer includes {s!r}", s.lower() in lowered, "" if s.lower() in lowered else answer[:300])
        for s in expect.answer_includes
    ]
    checks += [
        Check(
            f"answer excludes {s!r}",
            s.lower() not in lowered,
            "" if s.lower() not in lowered else answer[:300],
        )
        for s in expect.answer_excludes
    ]
    checks += [
        Check(f"answer matches /{p.pattern}/", p.search(answer) is not None, answer[:300])
        for p in expect.answer_matches
    ]

    called = tools_called(transcript)
    if expect.tools_called:
        ok = _is_subsequence(expect.tools_called, called)
        wanted = ", ".join(t.value for t in expect.tools_called)
        checks.append(Check(f"tools called in order: {wanted}", ok, f"called: {[t.value for t in called]}"))
    for tool in expect.tools_not_called:
        checks.append(
            Check(
                f"tool not called: {tool.value}", tool not in called, f"called: {[t.value for t in called]}"
            )
        )

    if expect.approvals is not None:
        requested = sum(1 for r in transcript.replies if r.status is ReplyStatus.APPROVAL_REQUIRED)
        checks.append(
            Check(
                f"approvals requested: {expect.approvals}", requested == expect.approvals, f"got {requested}"
            )
        )

    for text in expect.audit_excludes:
        leaked = any(text.lower() in line.lower() for line in transcript.audit_lines)
        checks.append(
            Check(f"audit excludes {text!r}", not leaked, "found in the audit log" if leaked else "")
        )

    if expect.max_usd is not None:
        spent = agent_cost(transcript, price)
        ok = spent.amount <= expect.max_usd.amount
        checks.append(Check(f"cost <= ${expect.max_usd.amount.normalize():f}", ok, f"${spent.amount}"))
    return tuple(checks)


def judge_transcript(scenario: Scenario, transcript: Transcript) -> str:
    """The conversation as shown to the LLM judge (outbound text for the judge prompt)."""
    lines: list[str] = []
    for step, reply in zip(scenario.steps, transcript.replies, strict=False):
        match step:
            case Say(actor=actor, text=text):
                lines.append(f"USER ({actor.value}): {text}")
            case Decide(actor=actor, decision=decision):
                lines.append(f"APPROVER ({actor.value}): {decision.value}")
            case _:
                lines.append(f"USER ({step.actor.value}): [cancel]")
        lines.append(f"AGENT [{reply.status.value}]: {reply.text}")
    called = ", ".join(t.value for t in tools_called(transcript)) or "none"
    lines.append(f"(tools called: {called})")
    return "\n".join(lines)
