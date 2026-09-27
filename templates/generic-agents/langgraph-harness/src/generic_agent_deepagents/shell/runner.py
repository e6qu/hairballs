"""SessionRunner (shell): one conversation thread = one AgentCore session = one deepagents graph.

The graph keeps its history in a LangGraph checkpointer under ``thread_id = session``. The runner
keeps the thread state, applies the pure thread state machine to each incoming message, runs the
graph when asked to, and turns the graph's final state back into a domain ``RunOutcome``.

Approval uses the deepagents HITL interrupt: the run pauses with a ``HITLRequest``, and an
approver's decision resumes it with ``Command(resume={interrupt_id: {"decisions": [...]}})``
(payload format: ``langchain/agents/middleware/human_in_the_loop.py``).
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from generic_tools.shell.service import GenericTools
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.types import Command, Interrupt
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
from org_agents.core.guard import StopReason, StopRun
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
from org_agents.domain import ApprovalDecision, ApprovalId, PrincipalId, SessionId, ToolName
from org_agents.parsing import ParseError, expect_mapping, expect_sequence, field
from org_agents.shell.audit import AuditSink
from org_agents.shell.clock import Clock
from org_agents.shell.run_guard import RunGuard
from org_agents.shell.settings import Settings

from generic_agent_deepagents.core.recursion import recursion_limit
from generic_agent_deepagents.shell.agent import build_agent
from generic_agent_deepagents.shell.middleware import RunControl
from generic_agent_deepagents.shell.tools import RunContext, build_tools


@dataclass(frozen=True, slots=True)
class PendingApproval:
    approval_id: ApprovalId
    tool: ToolName
    reason: str
    actions: int  # tool calls in the HITL request; the one decision applies to each


def parse_hitl_interrupt(interrupt: Interrupt) -> PendingApproval:
    """A LangGraph ``Interrupt`` carrying a HITL request → the pending approval (or ParseError)."""
    value = expect_mapping(interrupt.value, "$.interrupt.value")
    actions = expect_sequence(field(value, "action_requests", "$.interrupt.value"), "$.action_requests")
    if not actions:
        raise ParseError("$.action_requests", "must not be empty")
    first = expect_mapping(actions[0], "$.action_requests[0]")
    reason = first.get("description")
    return PendingApproval(
        approval_id=ApprovalId.parse(interrupt.id, "$.interrupt.id"),
        tool=ToolName.parse(first.get("name"), "$.action_requests[0].name"),
        reason=reason if isinstance(reason, str) else "approval required",
        actions=len(actions),
    )


def hitl_resume(pending: PendingApproval, decision: ApprovalDecision) -> Command[Any]:
    """Org approval decision → HITL resume payload (one decision per interrupted tool call)."""
    match decision:
        case ApprovalDecision.APPROVE:
            one: dict[str, str] = {"type": "approve"}
        case ApprovalDecision.REJECT:
            one = {"type": "reject", "message": "rejected by approver"}
    return Command(resume={pending.approval_id.value: {"decisions": [one] * pending.actions}})


def _last_ai_text(values: object) -> str:
    state = values if isinstance(values, dict) else {}
    for message in reversed(state.get("messages", [])):
        if isinstance(message, AIMessage):
            return message.text.strip()
    return ""


class SessionRunner:
    def __init__(
        self,
        session: SessionId,
        settings: Settings,
        model: BaseChatModel,
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
        self._control = RunControl()
        self._agent = build_agent(
            model,
            build_tools(tools, session),
            settings.system_prompt,
            settings.agent.tools,
            self._control,
            InMemorySaver(),
        )
        self._config: RunnableConfig = {
            "configurable": {"thread_id": session.value},
            "recursion_limit": recursion_limit(settings.agent.limits.max_turns).value,
        }
        self._state = ThreadState.initial()
        self._lock = threading.Lock()
        self._pending: PendingApproval | None = None

    @property
    def state(self) -> ThreadState:
        return self._state

    @property
    def control(self) -> RunControl:
        return self._control

    def handle(self, message: Incoming) -> Reply:
        with self._lock:
            self._state, action = receive(self._state, message, self._settings.agent.busy_policy)
        match action:
            case StartRun(prompt=prompt):
                return self._run_with_follow_ups(self._prompt(prompt.text), message.sender)
            case Steer(prompt=prompt):
                self._control.steer(prompt.text)
                return Acknowledged(Ack.STEERED)
            case QueueFollowUp():
                return Acknowledged(Ack.QUEUED)
            case CancelRun():
                self._control.cancel()
                return Acknowledged(Ack.CANCELLING)
            case DeliverApproval(decision=decision):
                pending = self._pending
                if pending is None:
                    return Refused("no approval is pending")
                self._pending = None
                return self._run_with_follow_ups(hitl_resume(pending, decision), self._owner())
            case IgnoreDuplicate():
                return Acknowledged(Ack.DUPLICATE)
            case Reject(reason=reason):
                return Refused(reason)

    @staticmethod
    def _prompt(text: str) -> dict[str, object]:
        return {"messages": [HumanMessage(content=text)]}

    def _owner(self) -> PrincipalId:
        status = self._state.status
        if isinstance(status, (Running, AwaitingApproval)):
            return status.owner
        raise RuntimeError("no active owner")

    def _run_with_follow_ups(
        self, first_input: dict[str, object] | Command[Any], owner: PrincipalId
    ) -> Reply:
        reply = self._run_once(first_input, owner)
        while True:
            with self._lock:
                self._state, queued = next_follow_up(self._state)
            if queued is None:
                return reply
            reply = merge_answers(reply, self._run_once(self._prompt(queued.prompt.text), queued.sender))

    def _run_once(self, graph_input: dict[str, object] | Command[Any], owner: PrincipalId) -> Reply:
        cfg = self._settings.agent
        guard = RunGuard(
            self._session, cfg.limits, cfg.price, cfg.tools, self._clock, self._audit, self._kill_switch
        )
        self._control.begin(guard)
        try:
            self._agent.invoke(graph_input, self._config, context=RunContext(owner))
            outcome = self._outcome(guard)
        except GraphRecursionError:
            # Backstop only: the guard's turn limit should always trip first (core/recursion.py).
            stop = StopRun(StopReason.TURN_LIMIT, "graph recursion limit reached")
            outcome = Stopped(stop, "")
        guard.finish()
        with self._lock:
            self._state, reply = finish(self._state, outcome, owner, self._settings.approvals)
        return reply

    def _outcome(self, guard: RunGuard) -> RunOutcome:
        snapshot = self._agent.get_state(self._config)
        text = _last_ai_text(snapshot.values)
        if guard.stopped is not None:
            return Stopped(guard.stopped, text)
        if snapshot.interrupts:
            try:
                pending = parse_hitl_interrupt(snapshot.interrupts[0])
            except ParseError as exc:
                raise RuntimeError(f"unexpected interrupt from the agent graph: {exc}") from exc
            self._pending = pending
            return ApprovalNeeded(pending.approval_id, pending.tool, pending.reason)
        return Completed(text)
