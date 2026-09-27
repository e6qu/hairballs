"""A scripted fake LangChain chat model: returns pre-defined assistant turns, with usage metadata.

None of the ``langchain_core`` fake chat models implement ``bind_tools`` (checked in
``langchain_core/language_models/fake_chat_models.py``), which ``create_agent`` requires, so this
is a tiny ``BaseChatModel`` subclass.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel, LanguageModelInput
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from pydantic import Field


@dataclass(frozen=True)
class ToolCall:
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class Turn:
    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    input_tokens: int = 100
    output_tokens: int = 20


class ScriptedModel(BaseChatModel):
    turns: Sequence[Turn]
    calls: int = 0
    seen_messages: list[list[BaseMessage]] = Field(default_factory=list)
    # Called with the call index before the model answers (simulates messages arriving mid-run).
    before_call: dict[int, Callable[[], object]] = Field(default_factory=dict)

    @property
    def _llm_type(self) -> str:
        return "scripted-fake"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> Runnable[LanguageModelInput, AIMessage]:
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        index = self.calls
        hook = self.before_call.get(index)
        if hook is not None:
            hook()
        self.seen_messages.append(list(messages))
        exhausted = index >= len(self.turns)
        turn = Turn(text="(script exhausted)") if exhausted else self.turns[index]
        self.calls += 1
        message = AIMessage(
            content=turn.text,
            tool_calls=[
                {"name": c.name, "args": c.args, "id": f"call-{index}-{i}", "type": "tool_call"}
                for i, c in enumerate(turn.tool_calls)
            ],
            usage_metadata={
                "input_tokens": turn.input_tokens,
                "output_tokens": turn.output_tokens,
                "total_tokens": turn.input_tokens + turn.output_tokens,
            },
        )
        return ChatResult(generations=[ChatGeneration(message=message)])
