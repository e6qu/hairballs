"""Call the tickets API with a token from the AgentCore Identity token vault."""

from typing import Any

import httpx
from bedrock_agentcore.identity.auth import requires_access_token

TICKETS_API = "https://tickets.fintech.example"


@requires_access_token(
    provider_name="auth0-tickets",  # the credential provider in the token vault
    auth_flow="M2M",  # client credentials: the agent acts as itself
    scopes=["tickets:write"],
    custom_parameters={"audience": TICKETS_API},  # Auth0 needs the API's audience
)
async def tickets_token(*, access_token: str) -> str:
    return access_token  # injected by the decorator; the agent never holds a client secret


async def open_ticket(title: str, description: str, requester_id: str) -> str:
    token = await tickets_token()
    async with httpx.AsyncClient(timeout=30) as http:
        response = await http.post(
            f"{TICKETS_API}/tickets",
            json={"title": title, "description": description, "requester_id": requester_id},
            headers={"Authorization": f"Bearer {token}"},
        )
    response.raise_for_status()
    ticket: dict[str, Any] = response.json()
    return str(ticket["id"])
