"""Lambda function behind the gateway. It implements one tool: check_claim.

Deploy with handler "expenses_tool.handler" (Python 3.13). No dependencies.
"""

from typing import Protocol, TypedDict

LIMITS_EUR = {
    "hotel": {"major": 180, "standard": 120},
    "meals": {"major": 60, "standard": 60},
}


class ClaimResult(TypedDict):
    within_policy: bool
    limit_eur: int


class ClientContext(Protocol):
    custom: dict[str, str]


class GatewayContext(Protocol):
    client_context: ClientContext


def check_claim(category: str, amount_eur: float, city_class: str = "standard") -> ClaimResult:
    limit = LIMITS_EUR[category][city_class]
    return {"within_policy": amount_eur <= limit, "limit_eur": limit}


def handler(event: dict[str, str | float], context: GatewayContext) -> ClaimResult:
    # The gateway passes the tool arguments as the event, and the tool name
    # as "<target>___<tool>" in the client context.
    tool = context.client_context.custom["bedrockAgentCoreToolName"].split("___")[-1]
    if tool != "check_claim":
        raise ValueError(f"unknown tool: {tool}")
    return check_claim(
        category=str(event["category"]),
        amount_eur=float(event["amount_eur"]),
        city_class=str(event.get("city_class", "standard")),
    )
