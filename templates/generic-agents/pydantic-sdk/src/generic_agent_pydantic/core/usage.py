"""Pure helpers specific to Pydantic AI's accounting conventions (no framework imports).

* Pydantic AI reports ``input_tokens`` *inclusive* of cache reads and writes; the org ``Usage`` keeps
  the four buckets disjoint (so each is priced once). :func:`disjoint_usage` converts.
* Pydantic AI's ``UsageLimitExceeded`` carries only a message. :func:`stop_for_usage_limit` maps it to
  the org ``StopRun`` so a framework-side limit surfaces exactly like a guard stop.
"""

from __future__ import annotations

from org_agents.core.guard import StopReason, StopRun
from org_agents.domain import TokenCount, Usage

# Checked in order: the first matching limit name decides the reason.
_LIMIT_REASONS: tuple[tuple[str, StopReason], ...] = (
    ("tool_calls_limit", StopReason.TOOL_CALL_LIMIT),
    ("request_limit", StopReason.TURN_LIMIT),
    ("cost_limit", StopReason.BUDGET),
    ("tokens_limit", StopReason.TOKEN_LIMIT),
)


def disjoint_usage(input_inclusive: int, output: int, cache_read: int, cache_write: int) -> Usage:
    """Build an org ``Usage`` from inclusive input counts (negative remainders clamp to zero)."""
    cache_read, cache_write = max(cache_read, 0), max(cache_write, 0)
    fresh_input = max(input_inclusive - cache_read - cache_write, 0)
    return Usage(
        input_tokens=TokenCount(fresh_input),
        output_tokens=TokenCount(max(output, 0)),
        cache_read_tokens=TokenCount(cache_read),
        cache_write_tokens=TokenCount(cache_write),
    )


def stop_for_usage_limit(message: str) -> StopRun:
    """Map a ``UsageLimitExceeded`` message to the org stop reason (token limit when unrecognised)."""
    reason = next((r for name, r in _LIMIT_REASONS if name in message), StopReason.TOKEN_LIMIT)
    return StopRun(reason, f"framework usage limit: {message.split('. Consider')[0]}")
