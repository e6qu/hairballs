"""SessionRunner (shell): one conversation thread = one AgentCore session = one harness Agent.

It keeps the thread state, applies the pure thread state machine to each incoming message, runs
the agent built by ``create_harness`` when asked to, and turns the agent's result back into a
domain ``RunOutcome``.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from typing import Any

from generic_tools.shell.service import GenericTools
from org_agents.conversation import (
    Ack,
    Acknowledged,
    ApprovalNeeded,
    Completed,
    Refused,
    Reply,
    RunOutcome,
    Stopped,
)
from org_agents.core.messages import (
    AwaitingApproval,
    CancelRun,
    DeliverApproval,
    IgnoreDuplicate,
    Incoming,
    QueueFollowUp,
    Reject,
    Running,
    StartRun,
    Steer,
)
from org_agents.core.thread import ThreadState, finish, merge_answers, next_follow_up, receive
from org_agents.domain import ApprovalId, PrincipalId, SessionId, ToolName
from org_agents.parsing import ParseError, expect_mapping
from org_agents.shell.audit import AuditSink
from org_agents.shell.clock import Clock
from org_agents.shell.run_guard import RunGuard
from org_agents.shell.settings import Settings
from strands.models import Model

from generic_agent_strands_harness.shell.harness import build_agent
from generic_agent_strands_harness.shell.hooks import GuardHooks
from generic_agent_strands_harness.shell.tools import build_tools


class SessionRunner:
    def __init__(
        self,
        session: SessionId,
        settings: Settings,
        model: Model,
        tools: GenericTools,
        clock: Clock,
        audit: AuditSink,
        kill_switch: Callable[[], bool],
    ) -> None:
        self._session = session
        self._settings = settings
        self._clock = clock
        self._audit = audit
        self._kill_switch = kill_switch
        self._hooks = GuardHooks()
        self._agent = build_agent(model, build_tools(tools), settings.system_prompt, [self._hooks])
        self._state = ThreadState.initial()
        self._lock = threading.Lock()

    @property
    def state(self) -> ThreadState:
        return self._state

    @property
    def tool_names(self) -> frozenset[str]:
        return frozenset(self._agent.tool_names)

    def handle(self, message: Incoming) -> Reply:
        with self._lock:
            self._state, action = receive(self._state, message, self._settings.agent.busy_policy)
        match action:
            case StartRun(prompt=prompt):
                return self._run_with_follow_ups(prompt.text, message.sender)
            case Steer(prompt=prompt):
                self._hooks.steer(prompt.text)
                return Acknowledged(Ack.STEERED)
            case QueueFollowUp():
                return Acknowledged(Ack.QUEUED)
            case CancelRun():
                self._agent.cancel()
                return Acknowledged(Ack.CANCELLING)
            case DeliverApproval(approval_id=aid, decision=decision):
                owner = self._owner()
                responses: list[Any] = [
                    {"interruptResponse": {"interruptId": aid.value, "response": decision.value}}
                ]
                return self._run_with_follow_ups(responses, owner)
            case IgnoreDuplicate():
                return Acknowledged(Ack.DUPLICATE)
            case Reject(reason=reason):
                return Refused(reason)

    def _owner(self) -> PrincipalId:
        status = self._state.status
        if isinstance(status, (Running, AwaitingApproval)):
            return status.owner
        raise RuntimeError("no active owner")

    def _run_with_follow_ups(self, first_input: str | list[Any], owner: PrincipalId) -> Reply:
        reply = self._run_once(first_input, owner)
        while True:
            with self._lock:
                self._state, queued = next_follow_up(self._state)
            if queued is None:
                return reply
            reply = merge_answers(reply, self._run_once(queued.prompt.text, queued.sender))

    def _run_once(self, agent_input: str | list[Any], owner: PrincipalId) -> Reply:
        cfg = self._settings.agent
        guard = RunGuard(
            self._session, cfg.limits, cfg.price, cfg.tools, self._clock, self._audit, self._kill_switch
        )
        self._hooks.begin(guard)
        result = self._agent(
            agent_input, invocation_state={"principal": owner.value, "session": self._session.value}
        )
        outcome = self._outcome(result, guard)
        guard.finish()
        with self._lock:
            self._state, reply = finish(self._state, outcome, owner, self._settings.approvals)
        return reply

    @staticmethod
    def _outcome(result: Any, guard: RunGuard) -> RunOutcome:
        text = str(result).strip()
        if guard.stopped is not None:
            return Stopped(guard.stopped, text)
        if result.stop_reason == "interrupt" and result.interrupts:
            interrupt = result.interrupts[0]
            try:
                reason: Mapping[str, object] = expect_mapping(interrupt.reason, "$.interrupt.reason")
                tool = ToolName.parse(reason.get("tool"), "$.interrupt.reason.tool")
                why = str(reason.get("reason", "approval required"))
            except ParseError:
                tool, why = ToolName("unknown"), "approval required"
            return ApprovalNeeded(ApprovalId(interrupt.id), tool, why)
        return Completed(text)
