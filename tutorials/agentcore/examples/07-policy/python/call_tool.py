"""Call a Gateway tool over MCP and tell a policy denial apart from other errors."""

import json
import os
import sys
import urllib.request
from typing import TypedDict, cast

GATEWAY_URL = os.environ.get(
    "GATEWAY_URL",
    "https://helpdesk-tools-abc123xyz.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp",
)
DENIED = "AuthorizeActionException"  # the Gateway's text for a Cedar deny


class Content(TypedDict):
    type: str
    text: str


class ToolResult(TypedDict, total=False):
    content: list[Content]
    isError: bool


class PolicyDenied(Exception):
    """The policy engine refused this tool call. Retrying will not help."""


def text_or_raise(result: ToolResult) -> str:
    text = "\n".join(
        c["text"] for c in result.get("content", []) if c["type"] == "text"
    )
    if result.get("isError"):
        if text.startswith(DENIED):
            raise PolicyDenied(text)
        raise RuntimeError(text)
    return text


def call_tool(name: str, arguments: dict[str, object], token: str) -> str:
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }
    request = urllib.request.Request(
        GATEWAY_URL,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        reply = json.load(response)
    return text_or_raise(cast(ToolResult, reply["result"]))


if __name__ == "__main__":
    token = os.environ[
        "ACCESS_TOKEN"
    ]  # Auth0 access token, audience https://agents.fintech.example
    try:
        print(
            call_tool(
                "tickets___create_ticket",
                {"title": "VPN down", "description": "..."},
                token,
            )
        )
    except PolicyDenied as denied:
        print(f"not allowed: {denied}", file=sys.stderr)
        sys.exit(2)
