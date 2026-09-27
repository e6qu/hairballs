"""SessionRunner (shell): one conversation thread = one AgentCore session = one Pydantic AI history.

It keeps the thread state and the message history, applies the pure thread state machine to each
incoming message, drives the Pydantic AI agent (``agent.iter``) when asked to, and turns the run's
result back into a domain ``RunOutcome``.

* Approval: a guarded tool raises ``ApprovalRequired``; the run ends with ``DeferredToolRequests``.
  The ``tool_call_id`` is the ``ApprovalId``. On an approver's answer the run resumes from the
  stored history with ``DeferredToolResults`` (``True`` or ``ToolDenied``).
* Steering: ``AgentRun.enqueue(..., priority="asap")`` injects the owner's message before the next
  model request (or redirects the run into one more request if it would otherwise end).
* Cancel: ``AgentRun.cancel()``; the partial history is kept (``RunCancelled.all_messages()``).
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable

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
from org_agents.domain import ApprovalDecision, ApprovalId, PrincipalId, SessionId, ToolName
from org_agents.shell.audit import AuditSink, RunStoppedEvent
from org_agents.shell.clock import Clock
from org_agents.shell.run_guard import RunGuard
from org_agents.shell.settings import Settings
from pydantic_ai import Agent, AgentRun, DeferredToolRequests, DeferredToolResults, ToolDenied
from pydantic_ai.exceptions import RunCancelled, UsageLimitExceeded
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models import Model

from generic_agent_pydantic.core.usage import stop_for_usage_limit
from generic_agent_pydantic.shell.capability import (
    APPROVAL_REASON_KEY,
    GuardCapability,
    stopped_text,
    usage_limits_for,
)
from generic_agent_pydantic.shell.deps import RunDeps
from generic_agent_pydantic.shell.tools import build_tools

STEER_PREFIX = "[Message from the user while you were working]"
REJECTED = "rejected by approver"
NOT_REVIEWED = "not executed: only one approval can be pending at a time; request it again"

Output = str | DeferredToolRequests


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
        # `instructions` (not `system_prompt`) are sent on every request but never stored in the
        # history: the cached prefix stays identical across runs and the history stays append-only.
        self._agent: Agent[RunDeps, Output] = Agent(
            model,
            deps_type=RunDeps,
            output_type=[str, DeferredToolRequests],
            instructions=settings.system_prompt,
            tools=build_tools(tools),
            capabilities=[GuardCapability()],
        )
        self._state = ThreadState.initial()
        self._lock = threading.Lock()
        self._history: list[ModelMessage] = []
        self._pending: DeferredToolRequests | None = None
        self._active: AgentRun[RunDeps, Output] | None = None
        self._steering: list[str] = []

    @property
    def state(self) -> ThreadState:
        return self._state

    @property
    def history(self) -> list[ModelMessage]:
        return list(self._history)

    def handle(self, message: Incoming) -> Reply:
        with self._lock:
            self._state, action = receive(self._state, message, self._settings.agent.busy_policy)
        match action:
            case StartRun(prompt=prompt):
                return self._run_with_follow_ups(prompt.text, None, message.sender)
            case Steer(prompt=prompt):
                self._steer(prompt.text)
                return Acknowledged(Ack.STEERED)
            case QueueFollowUp():
                return Acknowledged(Ack.QUEUED)
            case CancelRun():
                with self._lock:
                    if self._active is not None:
                        self._active.cancel()
                return Acknowledged(Ack.CANCELLING)
            case DeliverApproval(approval_id=aid, decision=decision):
                return self._run_with_follow_ups(None, self._results(aid, decision), self._owner())
            case IgnoreDuplicate():
                return Acknowledged(Ack.DUPLICATE)
            case Reject(reason=reason):
                return Refused(reason)

    # --------------------------------------------------------------- steering

    def _steer(self, text: str) -> None:
        item = f"{STEER_PREFIX} {text}"
        with self._lock:
            if self._active is not None:
                self._active.enqueue(item, priority="asap")  # thread-safe by contract
            else:  # accepted between `receive` and the run starting: delivered when it starts
                self._steering.append(item)

    def _attach(self, run: AgentRun[RunDeps, Output] | None) -> None:
        with self._lock:
            self._active = run
            if run is not None:
                for item in self._steering:
                    run.enqueue(item, priority="asap")
                self._steering.clear()

    # --------------------------------------------------------------- runs

    def _owner(self) -> PrincipalId:
        status = self._state.status
        if isinstance(status, (Running, AwaitingApproval)):
            return status.owner
        raise RuntimeError("no active owner")

    def _results(self, aid: ApprovalId, decision: ApprovalDecision) -> DeferredToolResults:
        """Answer every deferred call: the approved/rejected one, and deny any others the model made."""
        pending, self._pending = self._pending, None
        if pending is None:
            raise RuntimeError("approval delivered without pending tool calls")
        answer: bool | ToolDenied = decision is ApprovalDecision.APPROVE or ToolDenied(REJECTED)
        approvals: dict[str, bool | ToolDenied] = {
            call.tool_call_id: answer if call.tool_call_id == aid.value else ToolDenied(NOT_REVIEWED)
            for call in pending.approvals
        }
        return DeferredToolResults(approvals=dict(approvals))

    def _run_with_follow_ups(
        self, prompt: str | None, deferred: DeferredToolResults | None, owner: PrincipalId
    ) -> Reply:
        reply = self._run_once(prompt, deferred, owner)
        while True:
            with self._lock:
                self._state, queued = next_follow_up(self._state)
            if queued is None:
                return reply
            reply = merge_answers(reply, self._run_once(queued.prompt.text, None, queued.sender))

    def _run_once(
        self, prompt: str | None, deferred: DeferredToolResults | None, owner: PrincipalId
    ) -> Reply:
        cfg = self._settings.agent
        guard = RunGuard(
            self._session, cfg.limits, cfg.price, cfg.tools, self._clock, self._audit, self._kill_switch
        )
        outcome = asyncio.run(self._drive(prompt, deferred, RunDeps(self._session, owner, guard)))
        guard.finish()
        with self._lock:
            self._state, reply = finish(self._state, outcome, owner, self._settings.approvals)
        return reply

    async def _drive(
        self, prompt: str | None, deferred: DeferredToolResults | None, deps: RunDeps
    ) -> RunOutcome:
        run: AgentRun[RunDeps, Output] | None = None
        try:
            async with self._agent.iter(
                prompt,
                message_history=self._history,
                deferred_tool_results=deferred,
                deps=deps,
                usage_limits=usage_limits_for(self._settings.agent.limits),
            ) as run:
                self._attach(run)
                async for _node in run:
                    pass
                result = run.result
            if result is None:
                raise RuntimeError("agent run ended without a result")
            self._history = result.all_messages()
            return self._outcome(result.output, deps.guard)
        except UsageLimitExceeded as exc:
            # Second line of defence fired before the guard: surface it as an org stop, audited.
            if run is not None:
                self._history = run.all_messages()
            stop = deps.guard.stopped or stop_for_usage_limit(str(exc))
            if deps.guard.stopped is None:
                self._audit.emit(RunStoppedEvent(self._session, stop, self._clock.now()))
            return Stopped(stop, stopped_text(stop))
        except RunCancelled as exc:
            self._history = exc.all_messages()
            return Completed("Run cancelled.")
        finally:
            self._attach(None)

    def _outcome(self, output: Output, guard: RunGuard) -> RunOutcome:
        if isinstance(output, DeferredToolRequests):
            if guard.stopped is None and output.approvals:
                self._pending = output
                call = output.approvals[0]
                reason = output.metadata.get(call.tool_call_id, {}).get(APPROVAL_REASON_KEY)
                return ApprovalNeeded(
                    ApprovalId.parse(call.tool_call_id, "$.tool_call.tool_call_id"),
                    ToolName.parse(call.tool_name, "$.tool_call.tool_name"),
                    reason if isinstance(reason, str) else "approval required",
                )
            text = ""
        else:
            text = output.strip()
        if guard.stopped is not None:
            return Stopped(guard.stopped, text or stopped_text(guard.stopped))
        return Completed(text)
