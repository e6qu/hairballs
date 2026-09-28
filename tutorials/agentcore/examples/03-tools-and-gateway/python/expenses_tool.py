"""Lambda function behind the gateway, implementing the tool check_claim (the shell).

Deploy domain.py, core.py and this file with handler "expenses_tool.handler" (Python 3.13). No dependencies.
"""

from __future__ import annotations

from core import check_claim
from domain import (
    OverLimit,
    ParseError,
    Verdict,
    WithinPolicy,
    parse_claim,
    parse_invoked_tool,
)


def handler(event: object, context: object) -> dict[str, object]:
    # The gateway passes the tool arguments as the event, and the tool name
    # as "<target>___<tool>" in the client context.
    tool = parse_invoked_tool(context)
    if tool.tool != "check_claim":
        raise ParseError(f"unknown tool: {tool}")
    return to_json(check_claim(parse_claim(event)))


def to_json(verdict: Verdict) -> dict[str, object]:
    """The tool result the model reads."""
    match verdict:
        case WithinPolicy(limit=limit):
            return {"within_policy": True, "limit_eur": limit.to_json()}
        case OverLimit(limit=limit, excess=excess):
            return {
                "within_policy": False,
                "limit_eur": limit.to_json(),
                "excess_eur": excess.to_json(),
            }
