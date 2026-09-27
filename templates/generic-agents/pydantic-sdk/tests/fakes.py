"""A scripted fake model on Pydantic AI's ``FunctionModel``: pre-defined assistant turns with usage."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RequestUsage


@dataclass(frozen=True)
class ToolCall:
    name: str
    args: dict[str, Any]
    id: str = "tool-1"


@dataclass(frozen=True)
class Turn:
    text: str = ""
    tool_calls: tuple[ToolCall, ...] = ()
    input_tokens: int = 100
    output_tokens: int = 20


@dataclass
class ScriptedModel:
    """Replays ``turns``; ``during`` runs a callback while a given call (0-based) is in flight."""

    turns: Sequence[Turn]
    calls: int = 0
    seen_messages: list[list[ModelMessage]] = field(default_factory=list)
    during: dict[int, Callable[[], None]] = field(default_factory=dict)

    @property
    def model(self) -> FunctionModel:
        return FunctionModel(self._respond, model_name="scripted")

    async def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        self.seen_messages.append(list(messages))
        index = self.calls
        exhausted = index >= len(self.turns)
        turn = Turn(text="(script exhausted)") if exhausted else self.turns[index]
        self.calls += 1
        if index in self.during:
            self.during[index]()
        parts: list[TextPart | ToolCallPart] = [TextPart(turn.text)] if turn.text else []
        # Tool call ids are unique per turn, as a real model's are.
        parts += [ToolCallPart(c.name, c.args, tool_call_id=f"{c.id}-{index}") for c in turn.tool_calls]
        usage = RequestUsage(input_tokens=turn.input_tokens, output_tokens=turn.output_tokens)
        return ModelResponse(parts=list(parts), usage=usage)
