"""The org harness runner (shell): one conversation thread = one session = one ``Harness``.

What it adds over plain Pydantic AI usage:

* every run goes through the org ``RunGuard`` (limits, USD budget, loop detection, tool policy)
  via :class:`GuardCapability`;
* four-eyes approval on the pure thread state machine (``org_agents.core.thread``), resumed with
  Pydantic AI deferred tools (``DeferredToolRequests`` / ``DeferredToolResults``);
* session persistence (thread state + message history) through a :class:`SessionStore`;
* context management (tool-output truncation + sliding window) as a history processor;
* steering mid-run messages into the running agent; follow-ups queued for other senders;
* caller identity: each message comes with its sender's ``Caller`` (from the token). The run
  owner's caller reaches tools (``HarnessDeps.caller``) and approval requests (``requester``), and
  the model is told the speaker's first name at the start of a thread and whenever the speaker
  changes, in the user message (never the system prompt, so the prompt cache is shared);
* cancellation (``AgentRun.cancel``): the reply is ``stopped`` / ``cancelled``; a cancel while
  awaiting approval returns the thread to idle and answers the pending calls as not executed;
* failures: an exception from the model or framework ends the run as ``Failed`` (thread idle,
  partial history kept with unanswered tool calls closed, follow-ups kept); Pydantic
  AI's own ``UsageLimitExceeded`` becomes a ``framework_limit`` stop.

The runner is synchronous (``handle(Incoming, Caller) -> Reply``); each run segment is driven with
``agent.iter`` on a private event loop.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable, Coroutine, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import pydantic_ai
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
from org_agents.domain import ApprovalDecision, ApprovalId, PrincipalId, SessionId, ToolName
from org_agents.identity import Caller, first_prompt_preamble
from org_agents.parsing import ParseError
from org_agents.shell.audit import AuditSink, ContextCompactedEvent
from org_agents.shell.clock import Clock
from org_agents.shell.run_guard import RunGuard
from org_agents.shell.settings import Settings
from pydantic_ai import Agent, DeferredToolRequests, DeferredToolResults, Tool, ToolApproved, ToolDenied
from pydantic_ai.exceptions import RunCancelled, UsageLimitExceeded
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.models import Model
from pydantic_ai.run import AgentRun
from pydantic_ai.settings import ModelSettings

from org_pydantic_harness.core.context import ContextPolicy
from org_pydantic_harness.core.session import recover
from org_pydantic_harness.shell.context import context_capability, shape_of
from org_pydantic_harness.shell.deps import HarnessDeps
from org_pydantic_harness.shell.guard import GuardCapability, stop_text
from org_pydantic_harness.shell.sessions import InMemorySessionStore, SessionStore, snapshot
from org_pydantic_harness.shell.steering import Steering

# The first-run console banner is for interactive use; agents log JSON lines to stdout/stderr.
pydantic_ai.BANNER_ENABLED = False

REJECTED = "rejected by approver"
ONE_APPROVAL_PER_TURN = "not executed: only one approval-gated call is handled per turn; ask again"
NOT_RUN_FAILED = "not executed: the run failed"
NOT_RUN_CANCELLED = "not executed: the approval was cancelled"
CANCEL_DETAIL = "cancelled by request"

HarnessAgent = Agent[HarnessDeps, str | DeferredToolRequests]


@dataclass(frozen=True, slots=True)
class _NewPrompt:
    text: str


@dataclass(frozen=True, slots=True)
class _Resume:
    approval_id: ApprovalId
    decision: ApprovalDecision


_Start = _NewPrompt | _Resume


def _run_coroutine[T](coro: Coroutine[Any, Any, T]) -> T:
    """Run on a private loop; from inside a running loop (e.g. an async host), use a worker thread."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _unanswered_calls(messages: Sequence[ModelMessage]) -> list[str]:
    """Tool call ids of the last model response that have no result yet (the deferred ones)."""
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, ModelResponse):
            answered = frozenset().union(*(shape_of(m).tool_results for m in messages[index + 1 :]))
            return [
                p.tool_call_id
                for p in message.parts
                if isinstance(p, ToolCallPart) and p.tool_call_id not in answered
            ]
    return []


def describe_failure(exc: Exception) -> tuple[str, str]:
    """(reply text, audit detail). The reply names only the error class: no message, no stack trace.
    The audit detail keeps the message, redacted and truncated."""
    kind = type(exc).__name__
    return f"the agent run failed ({kind}); please try again", redact(f"{kind}: {exc}").text[:500]


def close_unanswered_calls(messages: Sequence[ModelMessage], text: str) -> list[ModelMessage]:
    """Answer the last response's unanswered tool calls with ``text``, so the history is valid for
    the next prompt (every tool call paired with a result)."""
    missing = _unanswered_calls(messages)
    if not missing:
        return list(messages)
    names = {
        p.tool_call_id: p.tool_name
        for m in messages
        if isinstance(m, ModelResponse)
        for p in m.parts
        if isinstance(p, ToolCallPart)
    }
    parts = [ToolReturnPart(names.get(cid, "unknown"), text, tool_call_id=cid) for cid in missing]
    return [*messages, ModelRequest(parts=parts)]


class Harness:
    def __init__(
        self,
        agent: HarnessAgent,
        session: SessionId,
        settings: Settings,
        clock: Clock,
        audit: AuditSink,
        kill_switch: Callable[[], bool],
        store: SessionStore,
    ) -> None:
        self._agent = agent
        self._session = session
        self._settings = settings
        self._clock = clock
        self._audit = audit
        self._kill_switch = kill_switch
        self._store = store
        self._steering = Steering()
        self._lock = threading.Lock()
        loaded = store.load(session)
        self._state = recover(loaded.thread) if loaded else ThreadState.initial()
        self._messages: list[ModelMessage] = list(loaded.messages) if loaded else []
        # Who each sender is (profile from their latest token); the run owner's caller is the requester.
        self._callers: dict[PrincipalId, Caller] = {c.subject: c for c in loaded.callers} if loaded else {}
        # The sender the model was last told it is assisting (see ``_introduce``).
        self._introduced: PrincipalId | None = loaded.introduced if loaded else None

    # ------------------------------------------------------------------ inspection

    @property
    def session(self) -> SessionId:
        return self._session

    @property
    def state(self) -> ThreadState:
        return self._state

    @property
    def messages(self) -> list[ModelMessage]:
        return list(self._messages)

    # ------------------------------------------------------------------ entry point

    def handle(self, message: Incoming, caller: Caller) -> Reply:
        """``caller`` is the resolved identity of ``message.sender`` (from the same token)."""
        if caller.subject != message.sender:
            raise ValueError("caller does not match the message sender")
        with self._lock:
            self._callers[message.sender] = caller
            before = self._state.status
            self._state, action = receive(self._state, message, self._settings.agent.busy_policy)
            if isinstance(action, CancelRun):
                if isinstance(before, Running):
                    self._steering.cancel()
                elif isinstance(before, AwaitingApproval):
                    self._messages = close_unanswered_calls(self._messages, NOT_RUN_CANCELLED)
            self._save_locked()
        match action:
            case StartRun(prompt=prompt):
                return self._run_with_follow_ups(_NewPrompt(prompt.text), message.sender)
            case Steer(prompt=prompt):
                self._steering.steer(prompt.text)
                return Acknowledged(Ack.STEERED)
            case QueueFollowUp():
                return Acknowledged(Ack.QUEUED)
            case CancelRun():
                return Acknowledged(Ack.CANCELLING)
            case DeliverApproval(approval_id=aid, decision=decision):
                return self._run_with_follow_ups(_Resume(aid, decision), self._owner())
            case IgnoreDuplicate():
                return Acknowledged(Ack.DUPLICATE)
            case Reject(reason=reason):
                return Refused(reason)

    # ------------------------------------------------------------------ runs

    def _owner(self) -> PrincipalId:
        status = self._state.status
        if isinstance(status, (Running, AwaitingApproval)):
            return status.owner
        raise RuntimeError("no active owner")

    def _run_with_follow_ups(self, start: _Start, owner: PrincipalId) -> Reply:
        reply = self._run_once(start, owner)
        while True:
            with self._lock:
                self._state, queued = next_follow_up(self._state)
            if queued is None:
                return reply
            reply = merge_answers(reply, self._run_once(_NewPrompt(queued.prompt.text), queued.sender))

    def _run_once(self, start: _Start, owner: PrincipalId) -> Reply:
        cfg = self._settings.agent
        guard = RunGuard(
            self._session, cfg.limits, cfg.price, cfg.tools, self._clock, self._audit, self._kill_switch
        )
        caller = self._callers.get(owner)
        if isinstance(start, _NewPrompt):
            start = _NewPrompt(self._introduce(owner, caller, start.text))
        outcome, messages = _run_coroutine(
            self._drive(start, guard, HarnessDeps(self._session, owner, caller))
        )
        guard.finish()
        with self._lock:
            self._steering.end_run()
            self._messages = messages
            self._state, reply = finish(self._state, outcome, owner, self._settings.approvals, caller)
            self._save_locked()
        return reply

    def _introduce(self, owner: PrincipalId, caller: Caller | None, prompt: str) -> str:
        """Prefix the first prompt of a thread (and of each new speaker) with who the model is assisting.
        Only the first name is shared, and only in the user message: the system prompt stays identical
        for every user, so the prompt cache is shared."""
        if self._introduced == owner:
            return prompt
        self._introduced = owner
        preamble = first_prompt_preamble(caller) if caller is not None else None
        return f"{preamble}\n\n{prompt}" if preamble else prompt

    async def _drive(
        self, start: _Start, guard: RunGuard, deps: HarnessDeps
    ) -> tuple[RunOutcome, list[ModelMessage]]:
        history = list(self._messages)
        match start:
            case _NewPrompt(text=text):
                prompt: str | None = text
                results: DeferredToolResults | None = None
            case _Resume(approval_id=aid, decision=decision):
                prompt, results = None, self._approval_results(history, aid, decision)
        run: AgentRun[HarnessDeps, str | DeferredToolRequests] | None = None
        try:
            async with self._agent.iter(
                prompt,
                message_history=history,
                deferred_tool_results=results,
                deps=deps,
                capabilities=[GuardCapability(guard)],
                conversation_id=self._session.value,
            ) as run:
                self._steering.attach(run)
                try:
                    async for _node in run:
                        pass
                finally:
                    self._steering.detach(run)
                result = run.result
        except RunCancelled as exc:
            stop = guard.record_external_stop(StopReason.CANCELLED, CANCEL_DETAIL)
            return Stopped(stop, stop_text(stop)), close_unanswered_calls(exc.all_messages(), stop_text(stop))
        except UsageLimitExceeded as exc:
            # Pydantic AI's default UsageLimits (e.g. request_limit=50) sit behind the org limits.
            stop = guard.record_external_stop(StopReason.FRAMEWORK_LIMIT, str(exc).split(". Consider")[0])
            partial = run.all_messages() if run is not None else history
            return Stopped(stop, stop_text(stop)), close_unanswered_calls(partial, stop_text(stop))
        except Exception as exc:  # model provider / framework error (throttling, validation, network…)
            public, detail = describe_failure(exc)
            guard.fail(detail)
            # Keep what happened (a tool that ran stays in the history), close unanswered calls.
            if run is None:  # the prompt (and any introduction) never reached the history
                self._introduced = None
            partial = run.all_messages() if run is not None else history
            return Failed(public), close_unanswered_calls(partial, NOT_RUN_FAILED)
        if result is None:  # pragma: no cover - iteration always ends with a result
            raise RuntimeError("agent run ended without a result")
        return self._outcome(result.output, guard), result.all_messages()

    @staticmethod
    def _approval_results(
        history: Sequence[ModelMessage], approval_id: ApprovalId, decision: ApprovalDecision
    ) -> DeferredToolResults:
        approvals: dict[str, bool | ToolApproved | ToolDenied] = {
            call_id: ToolDenied(ONE_APPROVAL_PER_TURN) for call_id in _unanswered_calls(history)
        }
        approvals[approval_id.value] = True if decision is ApprovalDecision.APPROVE else ToolDenied(REJECTED)
        return DeferredToolResults(approvals=approvals)

    @staticmethod
    def _outcome(output: str | DeferredToolRequests, guard: RunGuard) -> RunOutcome:
        if guard.stopped is not None:
            text = output if isinstance(output, str) else stop_text(guard.stopped)
            return Stopped(guard.stopped, text)
        if isinstance(output, DeferredToolRequests) and output.approvals:
            call = output.approvals[0]
            reason = output.metadata.get(call.tool_call_id, {}).get("reason", "approval required")
            try:
                tool = ToolName.parse(call.tool_name, "$.deferred.tool_name")
                aid = ApprovalId.parse(call.tool_call_id, "$.deferred.tool_call_id")
            except ParseError as exc:  # the guard only defers calls to parseable tool names
                raise RuntimeError(f"cannot request approval: {exc}") from exc
            return ApprovalNeeded(aid, tool, str(reason))
        if isinstance(output, DeferredToolRequests):
            return Completed("")  # external (non-approval) deferrals are not used by the harness
        return Completed(output.strip())

    def _save_locked(self) -> None:
        self._store.save(
            self._session, snapshot(self._state, self._messages, self._callers.values(), self._introduced)
        )


def create_harness(
    settings: Settings,
    tools: Sequence[Tool[HarnessDeps]],
    model: Model,
    *,
    session: SessionId,
    clock: Clock,
    audit: AuditSink,
    kill_switch: Callable[[], bool],
    store: SessionStore | None = None,
    context: ContextPolicy | None = None,
    model_settings: ModelSettings | None = None,
) -> Harness:
    """Build a guarded Pydantic AI agent for one session.

    ``tools`` are ordinary Pydantic AI tools taking ``RunContext[HarnessDeps]`` (or plain). The
    tool list is fixed for the session and the system prompt is sent as ``instructions`` (stable,
    cache-friendly, never trimmed by the context window).
    """

    def compacted(before: int, after: int) -> None:
        audit.emit(ContextCompactedEvent(session, before, after, clock.now()))

    agent: HarnessAgent = Agent(
        model,
        output_type=[str, DeferredToolRequests],
        instructions=settings.system_prompt,
        deps_type=HarnessDeps,
        name=settings.agent.name,
        tools=tools,
        model_settings=model_settings,
        capabilities=[context_capability(context or ContextPolicy.default(), compacted)],
    )
    return Harness(
        agent,
        session,
        settings,
        clock,
        audit,
        kill_switch,
        store if store is not None else InMemorySessionStore(),
    )
