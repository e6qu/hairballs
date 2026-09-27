"""LangChain v1 agent middleware that connects the ``create_agent`` loop to the org RunGuard (shell).

* ``before_model`` (graph node): inject queued steering messages; honour cancellation; ask the
  guard (turns, budget, wall clock, kill switch). A stop appends a final ``AIMessage`` and jumps
  to ``end``, so the checkpointed history stays well formed.
* ``after_model`` (graph node): parse ``AIMessage.usage_metadata`` into org ``Usage`` and report it.
* ``wrap_tool_call`` (inside the ``tools`` node, once per tool call): tool policy, loop detection
  and the human-approval ``interrupt()``. A blocked call becomes an error ``ToolMessage``.

Hook signatures: ``langchain/agents/middleware/types.py`` (``AgentMiddleware``, ``hook_config``).
"""

from __future__ import annotations

import threading
from collections import deque
from collections.abc import Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, AgentState, ToolCallRequest, hook_config
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.runtime import Runtime
from langgraph.types import Command, interrupt
from org_agents.core.guard import StopRun
from org_agents.domain import ApprovalDecision, ToolName
from org_agents.parsing import ParseError
from org_agents.shell.run_guard import BlockTool, Proceed, RequireApproval, RunGuard

from generic_agent_langgraph.core.usage import parse_usage_metadata
from generic_agent_langgraph.shell.tools import RunContext

STEER_PREFIX = "[Message from the user while you were working]"
CANCELLED_TEXT = "Run cancelled by the user."
APPROVAL_INTERRUPT = "approval"


def stop_text(stop: StopRun) -> str:
    return f"Run stopped by guard ({stop.reason.value}): {stop.detail}"


class GuardMiddleware(AgentMiddleware[AgentState[Any], RunContext]):
    """One instance per session; the runner hands it a fresh ``RunGuard`` for every run."""

    def __init__(self) -> None:
        super().__init__()
        self._guard: RunGuard | None = None
        self._steering: deque[str] = deque()
        self._cancelled = False
        # RunGuard is not thread-safe; LangGraph runs parallel tool calls in a thread pool.
        self._lock = threading.RLock()

    @property
    def name(self) -> str:
        return "GuardMiddleware"

    # --------------------------------------------------------------- lifecycle (called by the runner)

    def begin(self, guard: RunGuard, *, fresh_prompt: bool) -> None:
        with self._lock:
            self._guard = guard
            if fresh_prompt:
                self._cancelled = False

    def steer(self, text: str) -> None:
        with self._lock:
            self._steering.append(text)

    def cancel(self) -> None:
        with self._lock:
            self._cancelled = True

    @property
    def guard(self) -> RunGuard:
        if self._guard is None:
            raise RuntimeError("GuardMiddleware used outside of a run")
        return self._guard

    # --------------------------------------------------------------- graph-node hooks

    @hook_config(can_jump_to=["end"])
    def before_model(self, state: AgentState[Any], runtime: Runtime[RunContext]) -> dict[str, Any] | None:
        with self._lock:
            pending = list(self._steering)
            self._steering.clear()
            cancelled = self._cancelled
            decision = None if cancelled else self.guard.before_model_call()
        # Steering is a HumanMessage appended to the (append-only) history. Bedrock Converse needs
        # strict user/assistant alternation; ChatBedrockConverse merges consecutive user-side
        # messages (tool results + this text) into one user turn (langchain_aws/chat_models/
        # bedrock_converse.py, _messages_to_bedrock: merge_message_runs + user-turn extension).
        messages: list[HumanMessage | AIMessage] = []
        if pending:
            messages.append(HumanMessage("\n".join(f"{STEER_PREFIX} {item}" for item in pending)))
        if cancelled:
            return {"messages": [*messages, AIMessage(CANCELLED_TEXT)], "jump_to": "end"}
        if isinstance(decision, StopRun):
            return {"messages": [*messages, AIMessage(stop_text(decision))], "jump_to": "end"}
        return {"messages": messages} if messages else None

    def after_model(self, state: AgentState[Any], runtime: Runtime[RunContext]) -> dict[str, Any] | None:
        last = state["messages"][-1] if state["messages"] else None
        if not isinstance(last, AIMessage) or last.usage_metadata is None:
            return None
        try:
            usage = parse_usage_metadata(last.usage_metadata)
        except ParseError:
            # Unparseable usage is treated as "no usage"; wall-clock and turn limits still apply.
            return None
        with self._lock:
            # A stop here is not acted on immediately: pending tool calls get error results via
            # wrap_tool_call (the guard stays stopped), then before_model ends the run. This keeps
            # every tool_use paired with a tool_result, as Bedrock requires on the next prompt.
            self.guard.after_model_call(usage)
        return None

    # --------------------------------------------------------------- tool wrapper

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command[Any]],
    ) -> ToolMessage | Command[Any]:
        call = request.tool_call
        call_id = call.get("id") or ""
        name = call.get("name", "")

        def refuse(text: str) -> ToolMessage:
            return ToolMessage(content=text, tool_call_id=call_id, name=name, status="error")

        try:
            tool = ToolName.parse(name, "$.tool_call.name")
        except ParseError as exc:
            return refuse(f"blocked: {exc}")
        with self._lock:
            if self._cancelled:
                return refuse(CANCELLED_TEXT)
            verdict = self.guard.before_tool_call(tool, call.get("args", {}))
        match verdict:
            case Proceed():
                return handler(request)
            case BlockTool(reason=reason):
                return refuse(f"blocked: {reason}")
            case StopRun(reason=reason, detail=detail):
                return refuse(f"run stopped ({reason.value}): {detail}")
            case RequireApproval(reason=reason):
                # First execution: raises GraphInterrupt; the checkpointer saves the pending task.
                # On Command(resume={interrupt_id: decision}) the tools task re-runs from the top
                # and interrupt() returns the decision instead of raising.
                response = interrupt({"kind": APPROVAL_INTERRUPT, "tool": tool.value, "reason": reason})
                try:
                    decision = ApprovalDecision.parse(response, "$.approval")
                except ParseError:
                    decision = ApprovalDecision.REJECT
                if decision is ApprovalDecision.REJECT:
                    return refuse("rejected by approver")
                with self._lock:
                    if self._cancelled:
                        return refuse(CANCELLED_TEXT)
                return handler(request)
