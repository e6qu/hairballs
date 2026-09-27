"""LangChain v1 agent middleware that connects the deepagents loop to the org RunGuard (shell).

deepagents is built on ``langchain.agents.create_agent``; ``create_deep_agent(middleware=...)``
inserts custom middleware after its core stack and before its tail (prompt caching, HITL).

* ``GuardMiddleware`` (main agent *and* the sub-agent, sharing one ``RunControl``, so both draw
  on the same run budget):
  - ``before_model``: kill switch, turn / token / USD / wall-clock limits → ``jump_to: end``;
  - ``wrap_model_call``: ``AIMessage.usage_metadata`` → org ``Usage`` → ``after_model_call``;
  - ``after_model``: a stopped run jumps to the end, so no tool of that turn runs;
  - ``wrap_tool_call``: allowlist, loop detection and tool-call limit. Approval itself is the
    deepagents HITL interrupt (``interrupt_on``); this only lets approval-gated tools through
    in the agent where that interrupt is installed.
* ``SteeringMiddleware`` (main agent only): queued steering text becomes a ``HumanMessage``
  appended before the next model call.
* ``NoCompaction``: replaces deepagents' ``SummarizationMiddleware`` by name (see ``agent.py``).
"""

from __future__ import annotations

import threading
from collections import deque
from collections.abc import Callable, Mapping
from typing import Any

from langchain.agents.middleware import AgentMiddleware, AgentState, ModelRequest, ModelResponse
from langchain.agents.middleware.types import ToolCallRequest, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime
from langgraph.types import Command
from org_agents.core.guard import StopRun
from org_agents.domain import TokenCount, ToolName, Usage
from org_agents.parsing import ParseError, expect_int, expect_mapping
from org_agents.shell.run_guard import BlockTool, Proceed, RequireApproval, RunGuard

from generic_agent_deepagents.core.usage import usage_from_totals

STEER_PREFIX = "[Message from the user while you were working]"

_Middleware = AgentMiddleware[AgentState[Any], Any, Any]


def parse_usage_metadata(raw: object) -> Usage:
    """``AIMessage.usage_metadata`` (LangChain ``UsageMetadata``) → org ``Usage``."""
    fields = expect_mapping(raw, "$.usage_metadata")
    details = expect_mapping(fields.get("input_token_details") or {}, "$.usage_metadata.input_token_details")

    def count(source: Mapping[str, object], name: str, path: str) -> TokenCount:
        return TokenCount(expect_int(source.get(name) or 0, f"{path}.{name}", minimum=0))

    return usage_from_totals(
        total_input=count(fields, "input_tokens", "$.usage_metadata"),
        output=count(fields, "output_tokens", "$.usage_metadata"),
        cache_read=count(details, "cache_read", "$.usage_metadata.input_token_details"),
        cache_write=count(details, "cache_creation", "$.usage_metadata.input_token_details"),
    )


class RunControl:
    """Mutable per-thread run state shared by the middleware and the runner."""

    def __init__(self) -> None:
        self._guard: RunGuard | None = None
        self._steering: deque[str] = deque()
        self._cancelled = False
        self._lock = threading.Lock()

    def begin(self, guard: RunGuard) -> None:
        with self._lock:
            self._guard = guard
            self._cancelled = False

    @property
    def guard(self) -> RunGuard:
        if self._guard is None:
            raise RuntimeError("middleware used outside of a run")
        return self._guard

    def steer(self, text: str) -> None:
        with self._lock:
            self._steering.append(text)

    def drain_steering(self) -> list[str]:
        with self._lock:
            pending = list(self._steering)
            self._steering.clear()
        return pending

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    @property
    def must_stop(self) -> bool:
        return self._cancelled or self.guard.stopped is not None


def _error(request: ToolCallRequest, text: str) -> ToolMessage:
    return ToolMessage(
        content=text, tool_call_id=request.tool_call["id"], name=request.tool_call["name"], status="error"
    )


class GuardMiddleware(_Middleware):
    def __init__(self, control: RunControl, approval_gated: frozenset[str]) -> None:
        super().__init__()
        self._control = control
        self._approval_gated = approval_gated

    def approval_allowed(self, _request: ToolCallRequest) -> bool:
        """HITL ``when`` predicate: never ask a human to approve a call in a stopped run."""
        return not self._control.must_stop

    @hook_config(can_jump_to=["end"])
    def before_model(self, state: AgentState[Any], runtime: Runtime[Any]) -> dict[str, Any] | None:
        if self._control.cancelled:
            return {"jump_to": "end"}
        if isinstance(self._control.guard.before_model_call(), StopRun):
            return {"jump_to": "end"}
        return None

    def wrap_model_call(
        self, request: ModelRequest[Any], handler: Callable[[ModelRequest[Any]], ModelResponse[Any]]
    ) -> ModelResponse[Any]:
        response = handler(request)
        for message in response.result:
            if isinstance(message, AIMessage) and message.usage_metadata is not None:
                try:
                    usage = parse_usage_metadata(message.usage_metadata)
                except ParseError:
                    # Unparseable usage counts as none; turn and wall-clock limits still apply.
                    continue
                self._control.guard.after_model_call(usage)
        return response

    @hook_config(can_jump_to=["end"])
    def after_model(self, state: AgentState[Any], runtime: Runtime[Any]) -> dict[str, Any] | None:
        return {"jump_to": "end"} if self._control.must_stop else None

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        try:
            tool = ToolName.parse(request.tool_call["name"], "$.tool_call.name")
        except ParseError as exc:
            return _error(request, f"blocked: {exc}")
        verdict = self._control.guard.before_tool_call(tool, request.tool_call["args"])
        match verdict:
            case Proceed():
                return handler(request)
            case RequireApproval() if tool.value in self._approval_gated:
                # The HITL interrupt for this tool ran in after_model; a rejected call never
                # reaches the tool node (it already has an error ToolMessage).
                return handler(request)
            case RequireApproval(reason=reason):
                return _error(request, f"blocked: {reason}; not available here")
            case BlockTool(reason=reason):
                return _error(request, f"blocked: {reason}")
            case StopRun(reason=reason, detail=detail):
                return _error(request, f"run stopped ({reason.value}): {detail}")


class SteeringMiddleware(_Middleware):
    def __init__(self, control: RunControl) -> None:
        super().__init__()
        self._control = control

    def before_model(self, state: AgentState[Any], runtime: Runtime[Any]) -> dict[str, Any] | None:
        pending = self._control.drain_steering()
        if not pending:
            return None
        # Appended (never rewritten), so the cached prefix stays stable. Bedrock Converse merges
        # it into the preceding user turn (the tool results), keeping user/assistant alternation.
        text = "\n".join(f"{STEER_PREFIX} {item}" for item in pending)
        return {"messages": [HumanMessage(content=text)]}


class NoCompaction(_Middleware):
    """Takes the place of deepagents' ``SummarizationMiddleware`` (matched by ``name``).

    Summarization calls the model directly, outside the agent loop, so those calls would not
    be metered by the RunGuard. The org token limit bounds the context instead.
    """

    @property
    def name(self) -> str:
        return "SummarizationMiddleware"
