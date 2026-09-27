"""A scripted fake model on Pydantic AI's ``FunctionModel`` (offline; no AWS, no real model)."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ModelResponsePart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RequestUsage


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
    before: Callable[[], None] | None = None  # runs inside the model call (e.g. a mid-run message)


@dataclass
class ScriptedModel:
    turns: Sequence[Turn]
    calls: int = 0
    seen: list[list[ModelMessage]] = field(default_factory=list)

    @property
    def model(self) -> FunctionModel:
        return FunctionModel(self._respond, model_name="scripted")

    def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        self.seen.append(list(messages))
        turn = self.turns[self.calls] if self.calls < len(self.turns) else Turn(text="(script exhausted)")
        index = self.calls
        self.calls += 1
        if turn.before is not None:
            turn.before()
        parts: list[ModelResponsePart] = [TextPart(turn.text)] if turn.text else []
        parts += [
            ToolCallPart(c.name, c.args, tool_call_id=f"call-{index}-{i}")
            for i, c in enumerate(turn.tool_calls)
        ]
        usage = RequestUsage(input_tokens=turn.input_tokens, output_tokens=turn.output_tokens)
        return ModelResponse(parts=parts, usage=usage)


def tool_returns(messages: Sequence[ModelMessage]) -> list[ToolReturnPart]:
    return [
        p for m in messages if isinstance(m, ModelRequest) for p in m.parts if isinstance(p, ToolReturnPart)
    ]


def user_texts(messages: Sequence[ModelMessage]) -> list[str]:
    return [
        p.content
        for m in messages
        if isinstance(m, ModelRequest)
        for p in m.parts
        if isinstance(p, UserPromptPart) and isinstance(p.content, str)
    ]
