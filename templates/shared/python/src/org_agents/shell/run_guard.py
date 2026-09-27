"""RunGuard: the imperative wrapper that framework adapters call.

It owns the mutable bits (current guard state, clock, audit sink, kill-switch probe) and
delegates every decision to the pure core (:mod:`org_agents.core.guard`,
:mod:`org_agents.core.tool_policy`).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from org_agents.core.guard import (
    Continue,
    GuardState,
    KillSwitchObserved,
    ModelCallCompleted,
    StopRun,
    ToolRequested,
    TurnStarted,
    step,
)
from org_agents.core.tool_policy import Allowed, Denied, NeedsApproval, decide_tool
from org_agents.domain import Limits, ModelPrice, SessionId, ToolName, ToolPolicy, Usage
from org_agents.shell.audit import (
    AuditSink,
    RunFinishedEvent,
    RunStartedEvent,
    RunStoppedEvent,
    ToolDecisionEvent,
    UsageEvent,
)
from org_agents.shell.clock import Clock
from org_agents.shell.fingerprint import fingerprint_arguments


@dataclass(frozen=True, slots=True)
class Proceed:
    pass


@dataclass(frozen=True, slots=True)
class BlockTool:
    reason: str


@dataclass(frozen=True, slots=True)
class RequireApproval:
    reason: str


ToolVerdict = Proceed | BlockTool | RequireApproval | StopRun


class RunGuard:
    def __init__(
        self,
        session: SessionId,
        limits: Limits,
        price: ModelPrice,
        tools: ToolPolicy,
        clock: Clock,
        audit: AuditSink,
        kill_switch: Callable[[], bool] = lambda: False,
    ) -> None:
        self._session = session
        self._limits = limits
        self._price = price
        self._tools = tools
        self._clock = clock
        self._audit = audit
        self._kill_switch = kill_switch
        self._state = GuardState.start(clock.now())
        audit.emit(RunStartedEvent(session, self._state.started_at))

    @property
    def state(self) -> GuardState:
        return self._state

    @property
    def stopped(self) -> StopRun | None:
        return self._state.stopped

    def _apply(self, decision: Continue | StopRun, was_stopped: bool) -> Continue | StopRun:
        if isinstance(decision, StopRun) and not was_stopped:
            self._audit.emit(RunStoppedEvent(self._session, decision, self._clock.now()))
        return decision

    def before_model_call(self) -> Continue | StopRun:
        """Call at the start of every turn (before each model call)."""
        was_stopped = self._state.stopped is not None
        now = self._clock.now()
        if self._kill_switch():
            self._state, decision = step(self._state, KillSwitchObserved(now), self._limits, self._price)
            return self._apply(decision, was_stopped)
        self._state, decision = step(self._state, TurnStarted(now), self._limits, self._price)
        return self._apply(decision, was_stopped)

    def after_model_call(self, usage: Usage) -> Continue | StopRun:
        was_stopped = self._state.stopped is not None
        now = self._clock.now()
        self._state, decision = step(self._state, ModelCallCompleted(usage, now), self._limits, self._price)
        self._audit.emit(UsageEvent(self._session, usage, self._state.spent, now))
        return self._apply(decision, was_stopped)

    def before_tool_call(self, tool: ToolName, raw_arguments: object) -> ToolVerdict:
        was_stopped = self._state.stopped is not None
        now = self._clock.now()
        policy = decide_tool(tool, self._tools)
        match policy:
            case Denied(reason=reason):
                self._audit.emit(ToolDecisionEvent(self._session, tool, "denied", reason, now))
                return BlockTool(reason)
            case NeedsApproval() | Allowed():
                pass
        event = ToolRequested(tool, fingerprint_arguments(raw_arguments), now)
        self._state, decision = step(self._state, event, self._limits, self._price)
        if isinstance(decision, StopRun):
            self._audit.emit(ToolDecisionEvent(self._session, tool, "stopped", decision.detail, now))
            self._apply(decision, was_stopped)
            return decision
        match policy:
            case NeedsApproval(reason=reason):
                self._audit.emit(ToolDecisionEvent(self._session, tool, "needs_approval", reason, now))
                return RequireApproval(reason)
            case _:
                self._audit.emit(ToolDecisionEvent(self._session, tool, "allowed", "", now))
                return Proceed()

    def finish(self) -> None:
        self._audit.emit(
            RunFinishedEvent(self._session, self._state.turns, self._state.spent, self._clock.now())
        )
