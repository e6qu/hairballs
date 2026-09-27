"""Lambda: EventBridge rule or Scheduler -> the helpdesk agent, with an Auth0 M2M token.

Uses only the standard library and boto3, which the Lambda Python runtime already has.
"""

import hashlib
import json
import os
import time
import urllib.parse
import urllib.request
from typing import TypedDict, cast

import boto3

REGION = os.environ.get("AWS_REGION", "eu-west-1")
# The helpdesk Runtime agent, JWT inbound (tutorial 06)
AGENT_ARN = os.environ["AGENT_ARN"]
# The Auth0 M2M app "agent-scheduler", and the Secrets Manager secret with its client secret
AUTH0_CLIENT_ID = os.environ["AUTH0_CLIENT_ID"]
AUTH0_SECRET_ID = os.environ["AUTH0_SECRET_ID"]
AUTH0_TOKEN_URL = "https://fintech.eu.auth0.com/oauth/token"
AUDIENCE = "https://agents.fintech.example"


class Event(TypedDict):
    id: str
    source: str
    detail: dict[str, str]


class TokenReply(TypedDict):
    access_token: str
    expires_in: int


_token = ""
_token_expires = 0.0


def m2m_token() -> str:
    """Client-credentials token, cached for as long as this Lambda instance lives."""
    global _token, _token_expires
    if time.time() < _token_expires - 60:
        return _token
    secrets = boto3.client("secretsmanager")
    client_secret = secrets.get_secret_value(SecretId=AUTH0_SECRET_ID)["SecretString"]
    form = {
        "grant_type": "client_credentials",
        "client_id": AUTH0_CLIENT_ID,
        "client_secret": client_secret,
        "audience": AUDIENCE,
    }
    body = urllib.parse.urlencode(form).encode()
    with urllib.request.urlopen(AUTH0_TOKEN_URL, body, timeout=10) as response:
        reply = cast(TokenReply, json.load(response))
    _token, _token_expires = reply["access_token"], time.time() + reply["expires_in"]
    return _token


def session_id(event: Event) -> str:
    """Same event -> same session id. A retried delivery reaches the same agent session."""
    return hashlib.sha256(f"{event['source']}:{event['id']}".encode()).hexdigest()


def prompt_for(event: Event) -> str:
    if event["source"] == "fintech.tickets":
        return f"Ticket {event['detail']['ticketId']} was escalated. Triage it and add a note."
    return "Write the daily digest of open high-priority tickets and post it as a note."


def handler(event: Event, context: object) -> dict[str, str]:
    arn = urllib.parse.quote(AGENT_ARN, safe="")
    url = f"https://bedrock-agentcore.{REGION}.amazonaws.com/runtimes/{arn}/invocations?qualifier=DEFAULT"
    request = urllib.request.Request(
        url,
        data=json.dumps({"taskId": event["id"], "prompt": prompt_for(event)}).encode(),
        headers={
            "Authorization": f"Bearer {m2m_token()}",
            "Content-Type": "application/json",
            "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id(event),
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        reply: dict[str, str] = json.load(response)
    print(json.dumps({"event": event["id"], "agent": reply}))
    return reply  # {"status": "accepted", ...}: the agent keeps working on its own
