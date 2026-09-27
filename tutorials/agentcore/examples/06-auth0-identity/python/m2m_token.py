"""Get an Auth0 access token for a service (client credentials), e.g. a scheduler (shell).

Usage: AUTH0_CLIENT_ID=... AUTH0_CLIENT_SECRET=... uv run python m2m_token.py
"""

from __future__ import annotations

import os

import httpx

from domain import AccessToken, parse_token_response

AUTH0_DOMAIN = "fintech.eu.auth0.com"
AUDIENCE = "https://agents.fintech.example"


def m2m_token(client_id: str, client_secret: str) -> AccessToken:
    response = httpx.post(
        f"https://{AUTH0_DOMAIN}/oauth/token",
        json={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "audience": AUDIENCE,
        },
        timeout=30,
    )
    response.raise_for_status()
    return parse_token_response(response.json())  # outside data -> domain type


if __name__ == "__main__":
    print(m2m_token(os.environ["AUTH0_CLIENT_ID"], os.environ["AUTH0_CLIENT_SECRET"]).value)
