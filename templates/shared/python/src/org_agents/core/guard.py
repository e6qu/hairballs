"""The run guard: a pure state machine that enforces limits, budgets and loop detection.

The shell feeds it events (run started, turn started, model usage, tool requested) with the
current time, and carries out the decision it returns. No I/O, no clock, no framework types.
"""

from __future__ import annotations

import enum
from collections.abc import Mapping
from dataclasses import dataclass, replace
from types import MappingProxyType

from org_agents.core.pricing import cost_of
from org_agents.domain import (
    Fingerprint,
    Instant,
    Limits,
    ModelPrice,
    TokenCount,
    ToolName,
    Usage,
    Usd,
)


class StopReason(enum.Enum):
    TURN_LIMIT = "turn_limit"
    TOKEN_LIMIT = "token_limit"
    BUDGET = "budget"
    WALL_CLOCK = "wall_clock"
    TOOL_CALL_LIMIT = "tool_call_limit"
    LOOP_DETECTED = "loop_detected"
    KILL_SWITCH = "kill_switch"


# ---------------------------------------------------------------- events


@dataclass(frozen=True, slots=True)
class TurnStarted:
    at: Instant


@dataclass(frozen=True, slots=True)
class ModelCallCompleted:
    usage: Usage
    at: Instant


@dataclass(frozen=True, slots=True)
class ToolRequested:
    tool: ToolName
    fingerprint: Fingerprint
    at: Instant


@dataclass(frozen=True, slots=True)
class KillSwitchObserved:
    at: Instant


GuardEvent = TurnStarted | ModelCallCompleted | ToolRequested | KillSwitchObserved


# ---------------------------------------------------------------- decisions


@dataclass(frozen=True, slots=True)
class Continue:
    pass


@dataclass(frozen=True, slots=True)
class StopRun:
    reason: StopReason
    detail: str


Decision = Continue | StopRun


# ---------------------------------------------------------------- state


@dataclass(frozen=True, slots=True)
class GuardState:
    started_at: Instant
    turns: int
    tokens: TokenCount
    spent: Usd
    tool_calls: int
    repeats: Mapping[tuple[ToolName, Fingerprint], int]
    stopped: StopRun | None

    @classmethod
    def start(cls, at: Instant) -> GuardState:
        return cls(
            started_at=at,
            turns=0,
            tokens=TokenCount(0),
            spent=Usd.zero(),
            tool_calls=0,
            repeats=MappingProxyType({}),
            stopped=None,
        )


# ---------------------------------------------------------------- transitions


def _stop(state: GuardState, reason: StopReason, detail: str) -> tuple[GuardState, Decision]:
    decision = StopRun(reason, detail)
    return replace(state, stopped=decision), decision


def _check_totals(state: GuardState, at: Instant, limits: Limits) -> StopRun | None:
    if at - state.started_at > limits.max_wall_time:
        return StopRun(StopReason.WALL_CLOCK, f"exceeded {limits.max_wall_time}")
    if state.tokens.value >= limits.max_total_tokens.value:
        return StopRun(StopReason.TOKEN_LIMIT, f"used {state.tokens.value} tokens")
    if state.spent >= limits.max_usd:
        return StopRun(StopReason.BUDGET, f"spent {state.spent} of {limits.max_usd}")
    return None


def step(
    state: GuardState, event: GuardEvent, limits: Limits, price: ModelPrice
) -> tuple[GuardState, Decision]:
    """Apply one event. Once stopped, the guard stays stopped."""
    if state.stopped is not None:
        return state, state.stopped

    match event:
        case KillSwitchObserved():
            return _stop(state, StopReason.KILL_SWITCH, "kill switch is on")

        case TurnStarted(at=at):
            turns = state.turns + 1
            state = replace(state, turns=turns)
            if turns > limits.max_turns.value:
                return _stop(state, StopReason.TURN_LIMIT, f"turn {turns} > {limits.max_turns.value}")
            over = _check_totals(state, at, limits)
            return _stop(state, over.reason, over.detail) if over else (state, Continue())

        case ModelCallCompleted(usage=usage, at=at):
            state = replace(
                state, tokens=state.tokens + usage.total, spent=state.spent + cost_of(usage, price)
            )
            over = _check_totals(state, at, limits)
            return _stop(state, over.reason, over.detail) if over else (state, Continue())

        case ToolRequested(tool=tool, fingerprint=fingerprint, at=at):
            calls = state.tool_calls + 1
            key = (tool, fingerprint)
            seen = state.repeats.get(key, 0) + 1
            repeats = MappingProxyType({**state.repeats, key: seen})
            state = replace(state, tool_calls=calls, repeats=repeats)
            if calls > limits.max_tool_calls.value:
                return _stop(
                    state, StopReason.TOOL_CALL_LIMIT, f"tool call {calls} > {limits.max_tool_calls.value}"
                )
            if seen >= limits.repeat_threshold.value:
                return _stop(
                    state,
                    StopReason.LOOP_DETECTED,
                    f"{tool.value} called {seen} times with identical arguments",
                )
            over = _check_totals(state, at, limits)
            return _stop(state, over.reason, over.detail) if over else (state, Continue())
