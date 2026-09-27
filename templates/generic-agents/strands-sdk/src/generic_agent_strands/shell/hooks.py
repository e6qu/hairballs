"""Strands hooks that connect the agent loop to the org RunGuard (shell).

* BeforeModelCall: inject steering messages; ask the guard (turns, budget, time, kill switch).
* AfterModelCall: report token usage to the guard.
* BeforeToolCall: tool policy, loop detection, and the human-approval interrupt.
"""

from __future__ import annotations

import threading
from collections import deque
from collections.abc import Mapping
from typing import Any

from org_agents.core.guard import StopRun
from org_agents.domain import ApprovalDecision, TokenCount, ToolName, Usage
from org_agents.parsing import ParseError, expect_int, expect_mapping
from org_agents.shell.run_guard import BlockTool, Proceed, RequireApproval, RunGuard
from strands.hooks import (
    AfterModelCallEvent,
    BeforeModelCallEvent,
    BeforeToolCallEvent,
    HookProvider,
    HookRegistry,
)

STEER_PREFIX = "[Message from the user while you were working]"


def parse_strands_usage(raw: object) -> Usage:
    """Strands attaches Bedrock-style usage (camelCase keys) to each assistant message."""
    fields = expect_mapping(raw, "$.usage")

    def count(name: str) -> TokenCount:
        return TokenCount(expect_int(fields.get(name, 0), f"$.usage.{name}", minimum=0))

    return Usage(
        input_tokens=count("inputTokens"),
        output_tokens=count("outputTokens"),
        cache_read_tokens=count("cacheReadInputTokens"),
        cache_write_tokens=count("cacheWriteInputTokens"),
    )


class GuardHooks(HookProvider):
    def __init__(self) -> None:
        self._guard: RunGuard | None = None
        self._steering: deque[str] = deque()
        self._lock = threading.Lock()

    # --------------------------------------------------------------- lifecycle (called by the runner)

    def begin(self, guard: RunGuard) -> None:
        self._guard = guard

    def steer(self, text: str) -> None:
        with self._lock:
            self._steering.append(text)

    @property
    def guard(self) -> RunGuard:
        if self._guard is None:
            raise RuntimeError("GuardHooks used outside of a run")
        return self._guard

    # --------------------------------------------------------------- Strands hook registration

    def register_hooks(self, registry: HookRegistry, **_: Any) -> None:
        registry.add_callback(BeforeModelCallEvent, self._before_model)
        registry.add_callback(AfterModelCallEvent, self._after_model)
        registry.add_callback(BeforeToolCallEvent, self._before_tool)

    def _before_model(self, event: BeforeModelCallEvent) -> None:
        self._inject_steering(event)
        decision = self.guard.before_model_call()
        if isinstance(decision, StopRun):
            event.cancel = f"Run stopped by guard ({decision.reason.value}): {decision.detail}"

    def _inject_steering(self, event: BeforeModelCallEvent) -> None:
        # Steering text is appended to the latest user message (usually the tool results), so the
        # conversation keeps alternating user/assistant turns and the cached prefix is unchanged.
        with self._lock:
            pending = list(self._steering)
            self._steering.clear()
        if not pending:
            return
        messages = event.agent.messages
        text = "\n".join(f"{STEER_PREFIX} {item}" for item in pending)
        if messages and messages[-1]["role"] == "user":
            messages[-1]["content"].append({"text": text})
        else:
            messages.append({"role": "user", "content": [{"text": text}]})

    def _after_model(self, event: AfterModelCallEvent) -> None:
        if event.stop_response is None:
            return
        message: Mapping[str, object] = event.stop_response.message
        metadata = message.get("metadata")
        if isinstance(metadata, Mapping) and "usage" in metadata:
            try:
                self.guard.after_model_call(parse_strands_usage(metadata["usage"]))
            except ParseError:
                # Unparseable usage is treated as "no usage"; the wall-clock and turn limits still apply.
                return

    def _before_tool(self, event: BeforeToolCallEvent) -> None:
        tool_use = event.tool_use
        try:
            tool = ToolName.parse(tool_use["name"], "$.tool_use.name")
        except ParseError as exc:
            event.cancel_tool = f"blocked: {exc}"
            return
        verdict = self.guard.before_tool_call(tool, tool_use["input"])
        match verdict:
            case Proceed():
                return
            case BlockTool(reason=reason):
                event.cancel_tool = f"blocked: {reason}"
            case StopRun(reason=reason, detail=detail):
                event.cancel_tool = f"run stopped ({reason.value}): {detail}"
            case RequireApproval(reason=reason):
                # Raises InterruptException the first time; returns the approver's answer on resume.
                response = event.interrupt("approval", reason={"tool": tool.value, "reason": reason})
                try:
                    decision = ApprovalDecision.parse(response, "$.approval")
                except ParseError:
                    decision = ApprovalDecision.REJECT
                if decision is ApprovalDecision.REJECT:
                    event.cancel_tool = "rejected by approver"
