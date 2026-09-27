"""The harness ``"auto"`` context manager, rebuilt so the org guard and audit see what it does (shell).

``context_manager="auto"`` truncates large tool results and, at 85% of the context window,
summarizes old messages with a model call made *outside* the agent loop (the guard's model hooks
never see it). This module builds the same two strategies explicitly, with two additions:

* the summarizer gets a ``MeteredModel`` (``SummarizeConfig(model=...)``), which reports each
  call's usage, so it is counted by ``RunGuard.record_external_usage`` (tokens and USD);
* every strategy is wrapped in ``AuditedStrategy``, which reports when the message count shrinks
  (a ``context_compacted`` audit event).

The thresholds mirror ``strands._context_manager.context_manager`` (``_AUTO_*``) at the locked
version; re-check them when upgrading ``strands-agents``.
"""

from __future__ import annotations

import contextlib
from collections.abc import AsyncGenerator, AsyncIterable, Callable
from typing import Any

from org_agents.domain import Usage
from org_agents.parsing import ParseError
from strands import Agent
from strands.experimental.context_manager import (
    ContextManager,
    ContextState,
    ContextStrategy,
    Offload,
)
from strands.models import Model

from generic_agent_strands_harness.shell.hooks import parse_strands_usage

AUTO_TRUNCATE_THRESHOLD = 1_500
AUTO_TRUNCATE_PREVIEW_TOKENS = 750
AUTO_SUMMARIZE_UTILIZATION = 0.85
AUTO_SUMMARIZE_PRESERVE_RECENT = 4


class MeteredModel(Model):
    """Delegates to ``inner`` and reports the usage of every call it makes."""

    def __init__(self, inner: Model, on_usage: Callable[[Usage], None]) -> None:
        self._inner = inner
        self._on_usage = on_usage

    def update_config(self, **model_config: Any) -> None:
        self._inner.update_config(**model_config)

    def get_config(self) -> Any:
        return self._inner.get_config()

    def structured_output(self, *args: Any, **kwargs: Any) -> AsyncGenerator[Any, None]:
        return self._inner.structured_output(*args, **kwargs)

    async def stream(self, *args: Any, **kwargs: Any) -> AsyncIterable[Any]:
        async for event in self._inner.stream(*args, **kwargs):
            metadata = event.get("metadata") if isinstance(event, dict) else None
            if isinstance(metadata, dict) and "usage" in metadata:
                # unparseable usage counts as none; the wall-clock and turn limits still apply
                with contextlib.suppress(ParseError):
                    self._on_usage(parse_strands_usage(metadata["usage"]))
            yield event


class AuditedStrategy:
    """A context strategy that reports when it removed messages (``before``, ``after``)."""

    def __init__(self, inner: ContextStrategy, on_compacted: Callable[[int, int], None]) -> None:
        self._inner = inner
        self._on_compacted = on_compacted

    @property
    def name(self) -> str:
        return self._inner.name

    def init(self, agent: Agent, **kwargs: Any) -> None:
        init = getattr(self._inner, "init", None)
        if init is not None:
            init(agent, **kwargs)

    async def apply(self, context: ContextState) -> bool:
        before = len(context.messages)
        acted = await self._inner.apply(context)
        after = len(context.messages)
        if after < before:
            self._on_compacted(before, after)
        return acted


def build_context_manager(
    model: Model, on_usage: Callable[[Usage], None], on_compacted: Callable[[int, int], None]
) -> ContextManager:
    strategies: list[ContextStrategy] = [
        Offload.truncate("tool_results", {"preview_tokens": AUTO_TRUNCATE_PREVIEW_TOKENS}).when(
            threshold=AUTO_TRUNCATE_THRESHOLD
        ),
        Offload.summarize("*", {"model": MeteredModel(model, on_usage)}).when(
            utilization=AUTO_SUMMARIZE_UTILIZATION, preserve_recent=AUTO_SUMMARIZE_PRESERVE_RECENT
        ),
    ]
    audited: list[ContextStrategy | str] = [AuditedStrategy(s, on_compacted) for s in strategies]
    return ContextManager(strategies=audited)
