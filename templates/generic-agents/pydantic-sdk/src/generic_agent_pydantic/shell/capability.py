"""A Pydantic AI capability that connects the agent loop to the org RunGuard (shell).

Every decision is taken by ``org_agents`` (``RunGuard`` → pure core); this module only translates
them into Pydantic AI control flow:

* ``before_model_request``: turns, budget, wall clock, kill switch. A stop becomes
  ``SkipModelRequest`` with a final text response, so the model is not called and the run ends
  cleanly (history stays well-formed).
* ``after_model_request``: report token usage (converted to disjoint buckets) to the guard.
* ``before_tool_execute``: tool policy, loop detection, tool-call limit and the human-approval
  deferral (``ApprovalRequired`` → the run ends with ``DeferredToolRequests``). On resume, Pydantic AI
  sets ``ctx.tool_call_approved`` for the approved call and the tool runs.

``UsageLimits`` (see :func:`usage_limits_for`) mirror the org limits as a second line of defence.
"""

from __future__ import annotations

from typing import Any

from org_agents.core.guard import StopRun
from org_agents.domain import Limits, ToolName, Usage
from org_agents.parsing import ParseError
from org_agents.shell.run_guard import BlockTool, Proceed, RequireApproval
from pydantic_ai import RunContext
from pydantic_ai.capabilities import AbstractCapability
from pydantic_ai.exceptions import ApprovalRequired, SkipModelRequest, ToolFailed
from pydantic_ai.messages import ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models import ModelRequestContext
from pydantic_ai.tools import ToolDefinition
from pydantic_ai.usage import RequestUsage, UsageLimits

from generic_agent_pydantic.core.usage import disjoint_usage
from generic_agent_pydantic.shell.deps import RunDeps

APPROVAL_REASON_KEY = "reason"


def stopped_text(stop: StopRun) -> str:
    return f"Run stopped by guard ({stop.reason.value}): {stop.detail}"


def usage_limits_for(limits: Limits) -> UsageLimits:
    """Framework-side limits equal to the org limits. The guard normally stops first (it runs in
    ``before_model_request``); these only fire if a step slips past it (e.g. one response carrying
    more tool calls than the remaining budget, which Pydantic AI checks before any tool hook runs)."""
    return UsageLimits(
        request_limit=limits.max_turns.value,
        tool_calls_limit=limits.max_tool_calls.value,
        total_tokens_limit=limits.max_total_tokens.value,
    )


def _usage(raw: RequestUsage) -> Usage:
    return disjoint_usage(raw.input_tokens, raw.output_tokens, raw.cache_read_tokens, raw.cache_write_tokens)


class GuardCapability(AbstractCapability[RunDeps]):
    async def before_model_request(
        self, ctx: RunContext[RunDeps], request_context: ModelRequestContext
    ) -> ModelRequestContext:
        decision = ctx.deps.guard.before_model_call()
        if isinstance(decision, StopRun):
            raise SkipModelRequest(ModelResponse(parts=[TextPart(stopped_text(decision))]))
        return request_context

    async def after_model_request(
        self,
        ctx: RunContext[RunDeps],
        *,
        request_context: ModelRequestContext,
        response: ModelResponse,
    ) -> ModelResponse:
        guard = ctx.deps.guard
        if guard.stopped is None:  # a skipped (guard-stopped) request has no usage to report
            guard.after_model_call(_usage(response.usage))
        return response

    async def before_tool_execute(
        self,
        ctx: RunContext[RunDeps],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            tool = ToolName.parse(call.tool_name, "$.tool_call.tool_name")
        except ParseError as exc:
            raise ToolFailed(f"blocked: {exc}") from exc
        # Fingerprint the raw model arguments (as in every variant), not the validated ones.
        verdict = ctx.deps.guard.before_tool_call(tool, call.args_as_dict())
        match verdict:
            case Proceed():
                return args
            case BlockTool(reason=reason):
                raise ToolFailed(f"blocked: {reason}")
            case StopRun(reason=reason, detail=detail):
                raise ToolFailed(f"run stopped ({reason.value}): {detail}")
            case RequireApproval(reason=reason):
                if ctx.tool_call_approved:
                    return args  # resumed with an approver's ToolApproved for this tool_call_id
                raise ApprovalRequired(metadata={APPROVAL_REASON_KEY: reason})
