"""Pure logic: no AWS, no I/O."""

from __future__ import annotations

from collections.abc import Iterable
from decimal import Decimal

from domain import (
    ZERO_USAGE,
    Evaluation,
    NotScored,
    Prices,
    Scored,
    Stopped,
    StreamEvent,
    TextDelta,
    TokenUsage,
    UsageReported,
)

MILLION = Decimal(1_000_000)


def add(a: TokenUsage, b: TokenUsage) -> TokenUsage:
    return TokenUsage(
        a.input + b.input,
        a.output + b.output,
        a.cache_read + b.cache_read,
        a.cache_write + b.cache_write,
    )


def total(events: Iterable[StreamEvent]) -> TokenUsage:
    """All usage reported in a stream, added up (one report per call or per invocation)."""
    usage = ZERO_USAGE
    for event in events:
        if isinstance(event, UsageReported):
            usage = add(usage, event.usage)
    return usage


def cost_usd(usage: TokenUsage, prices: Prices) -> Decimal:
    return (
        usage.input * prices.input
        + usage.output * prices.output
        + usage.cache_read * prices.cache_read
        + usage.cache_write * prices.cache_write
    ) / MILLION


def cache_hit_ratio(usage: TokenUsage) -> Decimal:
    """Share of input tokens served from the prompt cache."""
    all_input = usage.input + usage.cache_read + usage.cache_write
    return Decimal(usage.cache_read) / all_input if all_input else Decimal(0)


def render(event: StreamEvent) -> str:
    match event:
        case TextDelta(text=text):
            return text
        case UsageReported():
            return ""
        case Stopped(reason=reason):
            return f"\n[stop: {reason.value}]\n"


def render_evaluation(evaluation: Evaluation) -> str:
    match evaluation:
        case Scored(evaluator=evaluator, value=value, label=label, explanation=explanation):
            return f"{evaluator}: {value:.2f} {label}\n   {explanation[:200]}"
        case NotScored(evaluator=evaluator, reason=reason):
            return f"{evaluator}: not scored ({reason})"
