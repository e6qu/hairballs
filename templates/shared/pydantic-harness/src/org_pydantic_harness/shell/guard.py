"""The org RunGuard as a Pydantic AI capability (shell).

Pydantic AI hooks used (verified against pydantic-ai-slim 2.46, ``pydantic_ai/capabilities/abstract.py``):

* ``before_model_request``: ask the guard (turns, tokens, USD, wall clock, kill switch). On stop,
  raise ``SkipModelRequest`` with a text response: the model is not called and the run ends
  normally with that text, so the history stays well-formed.
* ``after_model_request``: report the response's token usage to the guard (budget).
* ``before_tool_execute``: tool policy, loop detection and four-eyes approval. A blocked or
  stopped call raises ``SkipToolExecution`` (the model sees the reason as the tool result); a call
  needing approval raises ``ApprovalRequired`` unless this execution is the approved resume
  (``ctx.tool_call_approved``), which makes the run end with ``DeferredToolRequests``.
"""

from __future__ import annotations

from dataclasses import dataclass

from org_agents.core.guard import StopRun
from org_agents.domain import TokenCount, ToolName, Usage
from org_agents.parsing import ParseError
from org_agents.shell.run_guard import BlockTool, Proceed, RequireApproval, RunGuard
from pydantic_ai import RunContext
from pydantic_ai.capabilities import AbstractCapability, ValidatedToolArgs
from pydantic_ai.exceptions import ApprovalRequired, SkipModelRequest, SkipToolExecution
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.usage import RequestUsage

from org_pydantic_harness.shell.deps import HarnessDeps


def stop_text(stop: StopRun) -> str:
    return f"Run stopped by guard ({stop.reason.value}): {stop.detail}"


def usage_from(usage: RequestUsage) -> Usage:
    """Pydantic AI counts cache reads/writes *inside* ``input_tokens``; the org ``Usage`` keeps them apart."""
    cached = usage.cache_read_tokens + usage.cache_write_tokens
    return Usage(
        input_tokens=TokenCount(max(usage.input_tokens - cached, 0)),
        output_tokens=TokenCount(usage.output_tokens),
        cache_read_tokens=TokenCount(usage.cache_read_tokens),
        cache_write_tokens=TokenCount(usage.cache_write_tokens),
    )


@dataclass
class GuardCapability(AbstractCapability[HarnessDeps]):
    """One instance per run segment (passed to ``agent.iter(capabilities=...)``)."""

    guard: RunGuard

    async def before_model_request(
        self, ctx: RunContext[HarnessDeps], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        decision = self.guard.before_model_call()
        if isinstance(decision, StopRun):
            raise SkipModelRequest(ModelResponse(parts=[TextPart(stop_text(decision))]))
        return request_context

    async def after_model_request(
        self,
        ctx: RunContext[HarnessDeps],
        *,
        request_context: ModelRequestContext,
        response: ModelResponse,
    ) -> ModelResponse:
        # A stop here is remembered by the guard: pending tool calls are skipped and the next
        # model request is replaced by the stop text.
        self.guard.after_model_call(usage_from(response.usage))
        return response

    async def before_tool_execute(
        self,
        ctx: RunContext[HarnessDeps],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: ValidatedToolArgs,
    ) -> ValidatedToolArgs:
        try:
            tool = ToolName.parse(call.tool_name, "$.tool_call.name")
        except ParseError as exc:
            raise SkipToolExecution(f"blocked: {exc}") from exc
        match self.guard.before_tool_call(tool, args):
            case Proceed():
                return args
            case BlockTool(reason=reason):
                raise SkipToolExecution(f"blocked: {reason}")
            case StopRun(reason=reason, detail=detail):
                raise SkipToolExecution(f"run stopped ({reason.value}): {detail}")
            case RequireApproval(reason=reason):
                if ctx.tool_call_approved:
                    return args
                raise ApprovalRequired(metadata={"reason": reason})
