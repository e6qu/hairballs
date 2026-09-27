"""Call a Gateway tool as the signed-in user (the imperative shell).

Usage: ACCESS_TOKEN=<Auth0 token> GATEWAY_URL=https://.../mcp uv run python call_tool.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

from core import render, tools_call
from domain import AccessToken, Decision, GatewayUrl, ParseError, ToolName, parse_tool_reply


def call_tool(
    gateway: GatewayUrl, token: AccessToken, tool: ToolName, arguments: dict[str, object]
) -> Decision:
    request = urllib.request.Request(
        gateway.value,
        data=json.dumps(tools_call(1, tool, arguments)).encode(),
        headers={
            "Authorization": f"Bearer {token.value}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return parse_tool_reply(json.load(response))  # outside data -> Decision, right here


def main() -> int:
    try:
        gateway = GatewayUrl.parse(os.environ.get("GATEWAY_URL", ""))
        token = AccessToken.parse(os.environ.get("ACCESS_TOKEN", ""))
        tool = ToolName.parse("tickets___create_ticket")
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    decision = call_tool(gateway, token, tool, {"title": "VPN down", "description": "..."})
    text, code = render(decision)
    print(text, file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main())
