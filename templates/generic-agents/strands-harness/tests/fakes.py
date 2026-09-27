"""A scripted fake Strands model: returns pre-defined assistant turns, with optional usage."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from strands.models import Model


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
    error: Exception | None = None  # raised instead of streaming (a provider/framework failure)


@dataclass
class ScriptedModel(Model):
    turns: Sequence[Turn]
    calls: int = 0
    seen_messages: list[list[dict[str, Any]]] = field(default_factory=list)
    on_call: Callable[[int], object] | None = None  # runs before call N streams (e.g. to cancel mid-run)

    def update_config(self, **model_config: Any) -> None:
        pass

    def get_config(self) -> Any:
        return {}

    async def structured_output(self, *args: Any, **kwargs: Any) -> AsyncGenerator[Any, None]:
        raise NotImplementedError
        yield

    async def stream(self, messages: Any, *args: Any, **kwargs: Any) -> AsyncGenerator[Any, None]:
        self.seen_messages.append([dict(m) for m in messages])
        exhausted = self.calls >= len(self.turns)
        turn = Turn(text="(script exhausted)") if exhausted else self.turns[self.calls]
        self.calls += 1
        if self.on_call is not None:
            self.on_call(self.calls - 1)
        if turn.error is not None:
            raise turn.error
        for event in _events(turn):
            yield event


def _events(turn: Turn) -> Iterator[dict[str, Any]]:
    import json

    yield {"messageStart": {"role": "assistant"}}
    if turn.text:
        yield {"contentBlockStart": {"start": {}}}
        yield {"contentBlockDelta": {"delta": {"text": turn.text}}}
        yield {"contentBlockStop": {}}
    for call in turn.tool_calls:
        yield {"contentBlockStart": {"start": {"toolUse": {"name": call.name, "toolUseId": call.id}}}}
        yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(call.args)}}}}
        yield {"contentBlockStop": {}}
    yield {"messageStop": {"stopReason": "tool_use" if turn.tool_calls else "end_turn"}}
    yield {
        "metadata": {
            "usage": {
                "inputTokens": turn.input_tokens,
                "outputTokens": turn.output_tokens,
                "totalTokens": turn.input_tokens + turn.output_tokens,
            },
            "metrics": {"latencyMs": 1},
        }
    }
