"""Conversation window with an audit trail (shell).

``SlidingWindowConversationManager`` trims the oldest messages; this subclass reports each trim so
the audit log shows when the model stopped seeing part of the conversation.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager


class AuditedSlidingWindow(SlidingWindowConversationManager):
    def __init__(self, window_size: int, on_compacted: Callable[[int, int], None]) -> None:
        super().__init__(window_size=window_size)
        self._on_compacted = on_compacted

    def reduce_context(self, agent: Agent, e: Exception | None = None, **kwargs: Any) -> None:
        before = len(agent.messages)
        super().reduce_context(agent, e, **kwargs)
        after = len(agent.messages)
        if after < before:
            self._on_compacted(before, after)
