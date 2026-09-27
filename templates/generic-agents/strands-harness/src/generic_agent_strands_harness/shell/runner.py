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
    Failed,
    Refused,
    Reply,
    RunOutcome,
    Stopped,
)
from org_agents.core.guard import StopReason
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
from org_agents.core.redaction import redact
from org_agents.core.thread import ThreadState, finish, merge_answers, next_follow_up, receive
from org_agents.domain import ApprovalId, PrincipalId, SessionId, ToolName
from org_agents.identity import Caller, first_prompt_preamble
from org_agents.parsing import ParseError, expect_mapping
from org_agents.shell.audit import AuditSink, ContextCompactedEvent
from org_agents.shell.clock import Clock
from org_agents.shell.run_guard import RunGuard
from org_agents.shell.settings import Settings
from strands import Snapshot
from strands.models import Model

from generic_agent_strands_harness.shell.context import build_context_manager
from generic_agent_strands_harness.shell.harness import build_agent
from generic_agent_strands_harness.shell.hooks import GuardHooks
from generic_agent_strands_harness.shell.tools import build_tools

# Strands' own loop limits (``limits=`` on invoke). Not configured here, but mapped if a developer adds them.
FRAMEWORK_LIMIT_STOPS = frozenset({"limit_output_tokens", "limit_total_tokens", "limit_turns"})


def describe_failure(exc: Exception) -> tuple[str, str]:
    """(reply text, audit detail). The reply names only the error class: no message, no stack trace.
    The audit detail keeps the message, redacted and truncated."""
    kind = type(exc).__name__
    return f"the agent run failed ({kind}); please try again", redact(f"{kind}: {exc}").text[:500]


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
        context = build_context_manager(model, self._hooks.external_usage, self._compacted)
        self._agent = build_agent(model, build_tools(tools), settings.system_prompt, [self._hooks], context)
        self._state = ThreadState.initial()
        self._lock = threading.Lock()
        # Set by a cancel request while a run is in progress and passed to Strands as ``cancel_signal``
        # (it stops at its next cancellation point). Replaced, under the lock, when a run finishes.
        self._cancel = threading.Event()
        # Agent state before the current prompt: restored when its run fails or its approval is cancelled.
        self._rollback: Snapshot | None = None
        # Who each sender is (profile from their latest token); the run owner's caller is the requester.
        self._callers: dict[PrincipalId, Caller] = {}
        # The sender the model was last told it is assisting (the preamble goes in a user message,
        # never the system prompt, so the prompt cache stays shared across users).
        self._introduced: PrincipalId | None = None

    def _compacted(self, before: int, after: int) -> None:
        self._audit.emit(ContextCompactedEvent(self._session, before, after, self._clock.now()))

    @property
    def state(self) -> ThreadState:
        return self._state

    @property
    def tool_names(self) -> frozenset[str]:
        return frozenset(self._agent.tool_names)

    def handle(self, message: Incoming, caller: Caller) -> Reply:
        if caller.subject != message.sender:
            raise ValueError("caller does not match the message sender")
        with self._lock:
            self._callers[message.sender] = caller
            before = self._state.status
            self._state, action = receive(self._state, message, self._settings.agent.busy_policy)
            if isinstance(action, CancelRun):
                if isinstance(before, Running):
                    self._cancel.set()  # under the lock: the event belongs to the run in progress
                elif isinstance(before, AwaitingApproval):
                    self._abandon_approval()
        match action:
            case StartRun(prompt=prompt):
                return self._run_with_follow_ups(prompt.text, message.sender)
            case Steer(prompt=prompt):
                self._hooks.steer(prompt.text)
                return Acknowledged(Ack.STEERED)
            case QueueFollowUp():
                return Acknowledged(Ack.QUEUED)
            case CancelRun():
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
        caller = self._callers[owner]
        if isinstance(agent_input, str):  # a new prompt (not an approval resume)
            self._rollback = self._agent.take_snapshot(preset="session")
            agent_input = self._introduce(caller, agent_input)
        cancel = self._cancel
        try:
            result = self._agent(
                agent_input,
                invocation_state={"caller": caller, "session": self._session.value},
                cancel_signal=cancel,
            )
        except Exception as exc:  # framework / model provider error (throttling, validation, network…)
            outcome: RunOutcome = self._failed(exc, guard)
        else:
            if cancel.is_set():
                guard.record_external_stop(StopReason.CANCELLED, "cancelled by request")
            elif result.stop_reason in FRAMEWORK_LIMIT_STOPS:
                guard.record_external_stop(StopReason.FRAMEWORK_LIMIT, f"strands stop: {result.stop_reason}")
            outcome = self._outcome(result, guard)
        guard.finish()
        with self._lock:
            self._cancel = threading.Event()
            self._state, reply = finish(self._state, outcome, owner, self._settings.approvals, caller)
        return reply

    def _introduce(self, caller: Caller, prompt: str) -> str:
        """Prefix the first prompt of a thread (and of each new speaker) with who the model is assisting."""
        if self._introduced == caller.subject:
            return prompt
        self._introduced = caller.subject
        preamble = first_prompt_preamble(caller)
        return f"{preamble}\n\n{prompt}" if preamble else prompt

    def _failed(self, exc: Exception, guard: RunGuard) -> Failed:
        public, detail = describe_failure(exc)
        guard.fail(detail)
        self._restore()  # drop the failed prompt's partial turns so the next prompt starts clean
        return Failed(public)

    def _abandon_approval(self) -> None:
        # The thread is idle again. Strands still holds the pending interrupt (it only accepts
        # interrupt responses next), and the history ends with an unanswered toolUse: roll back.
        self._restore()

    def _restore(self) -> None:
        if self._rollback is not None:
            self._agent.load_snapshot(self._rollback)
            self._rollback = None
            self._introduced = None  # the introduction may have been rolled back with the prompt

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
