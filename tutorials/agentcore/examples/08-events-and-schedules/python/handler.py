"""Lambda: EventBridge rule or Scheduler -> the helpdesk agent (the imperative shell).

Deploy handler.py with domain.py and core.py. It needs only boto3, which the Lambda runtime has.
"""

from __future__ import annotations

import json
import os
import time
import urllib.parse
import urllib.request

import boto3

from core import session_id_for, task_for, usable
from domain import (
    Accepted,
    CachedToken,
    Config,
    SessionId,
    Task,
    parse_agent_reply,
    parse_config,
    parse_token_response,
    parse_trigger,
)

AUTH0_TOKEN_URL = "https://fintech.eu.auth0.com/oauth/token"
AUDIENCE = "https://agents.fintech.example"

_cached: CachedToken | None = None  # lives as long as this Lambda instance


def m2m_token(config: Config) -> CachedToken:
    """Client-credentials token, fetched once per instance and reused until it nearly expires."""
    global _cached
    token = usable(_cached, time.time())
    if token is not None:
        return token
    secrets = boto3.client("secretsmanager")
    secret = secrets.get_secret_value(SecretId=config.secret_id)["SecretString"]
    form = {
        "grant_type": "client_credentials",
        "client_id": config.client_id,
        "client_secret": secret,
        "audience": AUDIENCE,
    }
    body = urllib.parse.urlencode(form).encode()
    with urllib.request.urlopen(AUTH0_TOKEN_URL, body, timeout=10) as response:
        _cached = parse_token_response(json.load(response), now=time.time())
    return _cached


def start(config: Config, token: CachedToken, session: SessionId, task: Task) -> Accepted:
    arn = urllib.parse.quote(config.agent.value, safe="")
    host = f"https://bedrock-agentcore.{config.region}.amazonaws.com"
    request = urllib.request.Request(
        f"{host}/runtimes/{arn}/invocations?qualifier=DEFAULT",
        data=json.dumps({"taskId": task.task_id, "prompt": task.prompt}).encode(),
        headers={
            "Authorization": f"Bearer {token.value}",
            "Content-Type": "application/json",
            "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session.value,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return parse_agent_reply(json.load(response))


def handler(event: object, context: object) -> dict[str, str]:
    config = parse_config(os.environ)
    trigger = parse_trigger(event)  # outside data -> domain type, right here
    reply = start(config, m2m_token(config), session_id_for(trigger.ref), task_for(trigger))
    print(json.dumps({"taskId": reply.task_id, "state": reply.state.value}))
    return {"taskId": reply.task_id, "state": reply.state.value}  # the agent keeps working
