"""Domain types for calling a Gateway tool.

Outside data (environment, the Gateway's JSON-RPC reply) is parsed into these types at the boundary.
After that, a value that exists is valid: no code downstream re-checks it.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass

_GATEWAY_URL = re.compile(r"https://[a-z0-9.-]+/mcp")
_TOOL_NAME = re.compile(r"[a-z0-9-]+___[A-Za-z0-9_]+")
DENIED_PREFIX = "AuthorizeActionException"  # how the Gateway words a Cedar deny


class ParseError(ValueError):
    """Outside data that does not fit the domain."""


@dataclass(frozen=True, slots=True)
class GatewayUrl:
    value: str

    @classmethod
    def parse(cls, raw: str) -> GatewayUrl:
        if not _GATEWAY_URL.fullmatch(raw):
            raise ParseError(f"not a Gateway MCP URL: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class AccessToken:
    """An Auth0 access token (a JWT). Never printed."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> AccessToken:
        if raw.count(".") != 2:
            raise ParseError("the access token is not a JWT")
        return cls(raw)

    def __repr__(self) -> str:
        return "AccessToken(***)"


@dataclass(frozen=True, slots=True)
class ToolName:
    """<target>___<tool>, the name Cedar sees as the action."""

    value: str

    @classmethod
    def parse(cls, raw: str) -> ToolName:
        if not _TOOL_NAME.fullmatch(raw):
            raise ParseError(f"not a Gateway tool name: {raw!r}")
        return cls(raw)


@dataclass(frozen=True, slots=True)
class Allowed:
    text: str


@dataclass(frozen=True, slots=True)
class Denied:
    """The policy engine refused the call. Retrying will not help."""

    reason: str


@dataclass(frozen=True, slots=True)
class ToolFailed:
    message: str


Decision = Allowed | Denied | ToolFailed
"""What became of one tool call."""


def _fields(raw: object, path: str) -> Mapping[str, object]:
    if not isinstance(raw, Mapping):
        raise ParseError(f"{path}: expected an object")
    return raw


def parse_tool_reply(raw: object) -> Decision:
    """A JSON-RPC reply to tools/call -> Decision."""
    reply = _fields(raw, "$")
    if "error" in reply:
        message = _fields(reply["error"], "$.error").get("message")
        return ToolFailed(message if isinstance(message, str) else "JSON-RPC error")
    result = _fields(reply.get("result"), "$.result")
    content = result.get("content", [])
    if not isinstance(content, list):
        raise ParseError("$.result.content: expected a list")
    texts = [block.get("text") for block in content if isinstance(block, Mapping)]
    text = "\n".join(t for t in texts if isinstance(t, str))
    if result.get("isError") is not True:
        return Allowed(text)
    if text.startswith(DENIED_PREFIX):
        return Denied(text)
    return ToolFailed(text)
