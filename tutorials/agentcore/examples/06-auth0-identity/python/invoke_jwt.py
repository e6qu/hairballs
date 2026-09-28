"""Call the agent over HTTPS with an Auth0 bearer token (boto3 can't send bearer tokens).

Usage: AGENT_ARN=arn:... TOKEN=... uv run python invoke_jwt.py "prompt" [session-id]
"""

from __future__ import annotations

import os
import sys
import uuid

import httpx

from core import invocation_url, render
from domain import AccessToken, AgentRuntimeArn, ParseError, Prompt, SessionId, parse_sse_line


def ask(agent: AgentRuntimeArn, token: AccessToken, session: SessionId, prompt: Prompt) -> None:
    headers = {
        "Authorization": f"Bearer {token.value}",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session.value,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    url = invocation_url(agent, "eu-west-1")
    with httpx.stream("POST", url, headers=headers, json={"prompt": prompt.text}, timeout=300) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            event = parse_sse_line(line)  # outside data -> domain type, right here
            if event is not None:
                print(render(event), end="", flush=True)
    print()


def main(argv: list[str]) -> int:
    try:
        agent = AgentRuntimeArn.parse(os.environ.get("AGENT_ARN", ""))
        token = AccessToken.parse(os.environ.get("TOKEN"))
        prompt = Prompt.parse(argv[1] if len(argv) > 1 else "")
        session = SessionId.parse(argv[2] if len(argv) > 2 else str(uuid.uuid4()))
    except ParseError as exc:
        print(
            f"error: {exc}\nusage: AGENT_ARN=arn:... TOKEN=... invoke_jwt.py PROMPT [SESSION_ID]",
            file=sys.stderr,
        )
        return 2
    print(f"session: {session.value}")
    ask(agent, token, session, prompt)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
