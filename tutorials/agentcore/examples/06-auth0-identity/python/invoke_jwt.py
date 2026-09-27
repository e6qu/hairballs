"""Call the agent over HTTPS with an Auth0 bearer token (boto3 can't send bearer tokens)."""

import json
import os
import sys
import uuid
from urllib.parse import quote

import httpx

AGENT_ARN = os.environ["AGENT_ARN"]  # arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/...
URL = (
    "https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/"
    f"{quote(AGENT_ARN, safe='')}/invocations?qualifier=DEFAULT"
)


def ask(token: str, prompt: str, session_id: str) -> None:
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    with httpx.stream(
        "POST", URL, headers=headers, json={"prompt": prompt}, timeout=300
    ) as response:
        response.raise_for_status()
        for line in response.iter_lines():  # server-sent events: 'data: "..."'
            if line.startswith("data: "):
                print(json.loads(line[6:]), end="", flush=True)
    print()


if __name__ == "__main__":
    session_id = sys.argv[2] if len(sys.argv) > 2 else str(uuid.uuid4())
    ask(os.environ["TOKEN"], sys.argv[1], session_id)
    print(f"session: {session_id}")
