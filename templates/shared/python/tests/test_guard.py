from datetime import UTC, datetime, timedelta
from decimal import Decimal

from org_agents.core.guard import (
    Continue,
    GuardState,
    KillSwitchObserved,
    ModelCallCompleted,
    StopReason,
    StopRun,
    ToolRequested,
    TurnStarted,
    step,
)
from org_agents.domain import (
    Fingerprint,
    Instant,
    Limits,
    ModelPrice,
    PositiveInt,
    TokenCount,
    ToolName,
    Usage,
    Usd,
)

T0 = Instant(datetime(2026, 1, 1, tzinfo=UTC))
PRICE = ModelPrice(Usd(Decimal(3)), Usd(Decimal(15)), Usd(Decimal("0.3")), Usd(Decimal("3.75")))
LIMITS = Limits(
    max_turns=PositiveInt(3),
    max_total_tokens=PositiveInt(100_000),
    max_usd=Usd(Decimal("0.10")),
    max_wall_time=timedelta(minutes=5),
    max_tool_calls=PositiveInt(5),
    repeat_threshold=PositiveInt(3),
)
FP = Fingerprint("a" * 64)


def at(seconds: int) -> Instant:
    return Instant(T0.at + timedelta(seconds=seconds))


def test_turn_limit() -> None:
    state = GuardState.start(T0)
    for i in range(3):
        state, decision = step(state, TurnStarted(at(i)), LIMITS, PRICE)
        assert decision == Continue()
    state, decision = step(state, TurnStarted(at(4)), LIMITS, PRICE)
    assert isinstance(decision, StopRun) and decision.reason is StopReason.TURN_LIMIT


def test_budget_stop_uses_decimal_cost() -> None:
    state = GuardState.start(T0)
    usage = Usage(TokenCount(10_000), TokenCount(5_000))  # 0.03 + 0.075 = 0.105 USD
    state, decision = step(state, ModelCallCompleted(usage, at(1)), LIMITS, PRICE)
    assert isinstance(decision, StopRun) and decision.reason is StopReason.BUDGET
    assert state.spent == Usd(Decimal("0.105"))


def test_loop_detection_on_identical_calls() -> None:
    state = GuardState.start(T0)
    tool = ToolName("search")
    decisions = []
    for i in range(3):
        state, decision = step(state, ToolRequested(tool, FP, at(i)), LIMITS, PRICE)
        decisions.append(decision)
    assert decisions[:2] == [Continue(), Continue()]
    assert isinstance(decisions[2], StopRun) and decisions[2].reason is StopReason.LOOP_DETECTED


def test_wall_clock() -> None:
    state = GuardState.start(T0)
    _, decision = step(state, TurnStarted(at(301)), LIMITS, PRICE)
    assert isinstance(decision, StopRun) and decision.reason is StopReason.WALL_CLOCK


def test_stopped_is_sticky_and_kill_switch() -> None:
    state, decision = step(GuardState.start(T0), KillSwitchObserved(at(0)), LIMITS, PRICE)
    assert isinstance(decision, StopRun)
    _, again = step(state, TurnStarted(at(1)), LIMITS, PRICE)
    assert again == decision
