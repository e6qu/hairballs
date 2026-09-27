"""SessionRunner (shell): one conversation thread = one AgentCore session = one LangGraph thread.

It keeps the thread state, applies the pure thread state machine to each incoming message, runs
the ``create_agent`` graph when asked to (``thread_id`` = session id, ``InMemorySaver``
checkpointer), and turns the graph's output back into a domain ``RunOutcome``.

When a run fails (an exception from the model or the graph), hits the recursion limit, or a
pending approval is cancelled,
the checkpoint can end with tool calls that will never run. They are answered with error
``ToolMessage``s (``update_state(..., as_node="tools")``) so the next prompt starts from a history
Bedrock accepts (every ``toolUse`` paired with a ``toolResult``).
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Mapping
from typing import Any

from generic_tools.shell.service import GenericTools
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, AgentState, InputAgentState
from langchain_aws.middleware import BedrockPromptCachingMiddleware
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.types import Command, GraphOutput, Interrupt
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
from org_agents.parsing import ParseError, expect_mapping
from org_agents.shell.audit import AuditSink
from org_agents.shell.clock import Clock
from org_agents.shell.run_guard import RunGuard
from org_agents.shell.settings import Settings

from generic_agent_langgraph.core.recursion import recursion_limit
from generic_agent_langgraph.shell.middleware import CANCEL_DETAIL, GuardMiddleware
from generic_agent_langgraph.shell.tools import RunContext, build_tools

GraphInput = InputAgentState | Command[Any]
NOT_RUN_FAILED = "not executed: the run failed"
NOT_RUN_STOPPED = "not executed: the run was stopped"
NOT_RUN_CANCELLED = "not executed: the approval was cancelled"


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
        self._guard_mw = GuardMiddleware()
        # Context type is Any: BedrockPromptCachingMiddleware does not parametrise AgentMiddleware.
        middleware: list[AgentMiddleware[AgentState[Any], Any]] = [
            self._guard_mw,
            # Adds Converse cachePoints (system, tools, history) for Anthropic/Nova on Bedrock;
            # a no-op for other models (e.g. the scripted fake in tests).
            BedrockPromptCachingMiddleware(unsupported_model_behavior="ignore"),
        ]
        self._graph = create_agent(
            model,
            tools=build_tools(tools),
            system_prompt=settings.system_prompt,
            middleware=middleware,
            context_schema=RunContext,
            checkpointer=InMemorySaver(),
            name=settings.agent.name,
        )
        self._state = ThreadState.initial()
        self._lock = threading.Lock()

    @property
    def state(self) -> ThreadState:
        return self._state

    def handle(self, message: Incoming) -> Reply:
        with self._lock:
            before = self._state.status
            self._state, action = receive(self._state, message, self._settings.agent.busy_policy)
            if isinstance(action, CancelRun):
                if isinstance(before, Running):
                    self._guard_mw.cancel()  # under the lock: it belongs to the run in progress
                elif isinstance(before, AwaitingApproval):
                    self._close_dangling_tool_calls(NOT_RUN_CANCELLED)
        match action:
            case StartRun(prompt=prompt):
                return self._run_with_follow_ups(prompt.text, message.sender)
            case Steer(prompt=prompt):
                self._guard_mw.steer(prompt.text)
                return Acknowledged(Ack.STEERED)
            case QueueFollowUp():
                return Acknowledged(Ack.QUEUED)
            case CancelRun():
                return Acknowledged(Ack.CANCELLING)
            case DeliverApproval(approval_id=aid, decision=decision):
                # The interrupt id is the approval id; resume exactly that interrupt.
                resume: Command[Any] = Command(resume={aid.value: decision.value})
                return self._run_with_follow_ups(resume, self._owner())
            case IgnoreDuplicate():
                return Acknowledged(Ack.DUPLICATE)
            case Reject(reason=reason):
                return Refused(reason)

    def _owner(self) -> PrincipalId:
        status = self._state.status
        if isinstance(status, (Running, AwaitingApproval)):
            return status.owner
        raise RuntimeError("no active owner")

    def _run_with_follow_ups(self, first: str | Command[Any], owner: PrincipalId) -> Reply:
        reply = self._run_once(first, owner)
        while True:
            with self._lock:
                self._state, queued = next_follow_up(self._state)
            if queued is None:
                return reply
            reply = merge_answers(reply, self._run_once(queued.prompt.text, queued.sender))

    def _config(self) -> RunnableConfig:
        return {
            "configurable": {"thread_id": self._session.value},
            # Second line of defence behind the RunGuard (LangGraph's default is 10 007 steps).
            "recursion_limit": recursion_limit(self._settings.agent.limits),
        }

    def _run_once(self, first: str | Command[Any], owner: PrincipalId) -> Reply:
        cfg = self._settings.agent
        guard = RunGuard(
            self._session, cfg.limits, cfg.price, cfg.tools, self._clock, self._audit, self._kill_switch
        )
        self._guard_mw.begin(guard)
        graph_input: GraphInput = (
            InputAgentState(messages=[HumanMessage(first)]) if isinstance(first, str) else first
        )
        context = RunContext(principal=owner, session=self._session)
        outcome: RunOutcome
        try:
            output = self._graph.invoke(graph_input, self._config(), context=context, version="v2")
        except GraphRecursionError:
            # The recursion limit is derived from max_turns (core/recursion.py), so the specific org
            # reason is turn_limit rather than framework_limit.
            limit = recursion_limit(cfg.limits)
            stop = guard.record_external_stop(StopReason.TURN_LIMIT, f"graph recursion limit {limit} reached")
            self._close_dangling_tool_calls(NOT_RUN_STOPPED)
            outcome = Stopped(stop, "")
        except Exception as exc:  # model provider / graph error (throttling, validation, network…)
            public, detail = describe_failure(exc)
            guard.fail(detail)
            self._close_dangling_tool_calls(NOT_RUN_FAILED)
            outcome = Failed(public)
        else:
            outcome = self._outcome(output, guard)
        with self._lock:
            if self._guard_mw.end() and isinstance(outcome, Completed):
                # Cancelled after the last before_model (during the final model call).
                stop = guard.record_external_stop(StopReason.CANCELLED, CANCEL_DETAIL)
                outcome = Stopped(stop, outcome.text)
            guard.finish()
            self._state, reply = finish(self._state, outcome, owner, self._settings.approvals)
        return reply

    def _close_dangling_tool_calls(self, text: str) -> None:
        """Answer the last AI message's unanswered tool calls with error results (see module doc)."""
        config = self._config()
        messages = self._graph.get_state(config).values.get("messages", [])
        last_ai = next((m for m in reversed(messages) if isinstance(m, AIMessage)), None)
        if last_ai is None:
            return
        answered = {m.tool_call_id for m in messages if isinstance(m, ToolMessage)}
        missing = [
            ToolMessage(content=text, tool_call_id=call["id"], name=call["name"], status="error")
            for call in last_ai.tool_calls
            if call["id"] is not None and call["id"] not in answered
        ]
        if missing:
            self._graph.update_state(config, {"messages": missing}, as_node="tools")

    @staticmethod
    def _outcome(output: GraphOutput[Any], guard: RunGuard) -> RunOutcome:
        text = _last_ai_text(output.value)
        if guard.stopped is not None:
            return Stopped(guard.stopped, text)
        if output.interrupts:
            return _approval_needed(output.interrupts[0])
        return Completed(text)


def _last_ai_text(value: object) -> str:
    if not isinstance(value, Mapping):
        return ""
    messages = value.get("messages")
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if isinstance(message, AIMessage):
            return str(message.text).strip()
    return ""


def _approval_needed(pending: Interrupt) -> ApprovalNeeded:
    approval_id = ApprovalId.parse(pending.id, "$.interrupt.id")
    try:
        payload = expect_mapping(pending.value, "$.interrupt.value")
        tool = ToolName.parse(payload.get("tool"), "$.interrupt.value.tool")
        why = str(payload.get("reason", "approval required"))
    except ParseError:
        tool, why = ToolName("unknown"), "approval required"
    return ApprovalNeeded(approval_id, tool, why)
