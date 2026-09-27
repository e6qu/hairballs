"""A scripted fake LangChain chat model: returns pre-defined AIMessages (with tool calls and usage).

``GenericFakeChatModel`` does not implement ``bind_tools``, which ``create_agent`` needs, so this
is a tiny ``BaseChatModel`` subclass. It records the messages each call saw.
"""

from __future__ import annotations

import itertools
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel, LanguageModelInput
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from pydantic import ConfigDict, Field

_ids = itertools.count(1)


@dataclass(frozen=True)
class ToolCall:
    name: str
    args: dict[str, Any]
    id: str = ""


@dataclass(frozen=True)
class Turn:
    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    input_tokens: int = 100
    output_tokens: int = 20


class ScriptedModel(BaseChatModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    turns: Sequence[Turn]
    calls: int = 0
    seen_messages: list[list[BaseMessage]] = Field(default_factory=list)
    bound_tools: list[list[str]] = Field(default_factory=list)
    on_call: Callable[[int], None] | None = None  # runs during call N (e.g. a message arriving mid-run)

    @property
    def _llm_type(self) -> str:
        return "scripted-fake"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> Runnable[LanguageModelInput, AIMessage]:
        self.bound_tools.append([getattr(t, "name", "") for t in tools])
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        self.seen_messages.append(list(messages))
        if self.on_call is not None:
            self.on_call(self.calls)
        exhausted = self.calls >= len(self.turns)
        turn = Turn(text="(script exhausted)") if exhausted else self.turns[self.calls]
        self.calls += 1
        message = AIMessage(
            content=turn.text,
            tool_calls=[
                {"name": c.name, "args": c.args, "id": c.id or f"call-{next(_ids)}", "type": "tool_call"}
                for c in turn.tool_calls
            ],
            usage_metadata={
                "input_tokens": turn.input_tokens,
                "output_tokens": turn.output_tokens,
                "total_tokens": turn.input_tokens + turn.output_tokens,
            },
        )
        return ChatResult(generations=[ChatGeneration(message=message)])
