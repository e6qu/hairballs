"""Get an Auth0 access token for a service (client credentials), e.g. a scheduler."""

import os

import httpx

AUTH0_DOMAIN = "fintech.eu.auth0.com"
AUDIENCE = "https://agents.fintech.example"


def m2m_token() -> str:
    response = httpx.post(
        f"https://{AUTH0_DOMAIN}/oauth/token",
        json={
            "grant_type": "client_credentials",
            "client_id": os.environ["AUTH0_CLIENT_ID"],
            "client_secret": os.environ["AUTH0_CLIENT_SECRET"],
            "audience": AUDIENCE,
        },
        timeout=30,
    )
    response.raise_for_status()
    token: str = response.json()["access_token"]
    return token


if __name__ == "__main__":
    print(m2m_token())
