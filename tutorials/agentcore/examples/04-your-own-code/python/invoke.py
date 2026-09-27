"""Call the deployed helpdesk agent with boto3 and print the streamed answer (the shell).

Usage: AGENT_ARN=arn:... uv run python invoke.py "prompt" [session-id]
"""

from __future__ import annotations

import json
import os
import sys
import uuid

import boto3

from core import exit_code, render
from domain import AgentRuntimeArn, AnswerEvent, ParseError, Prompt, SessionId, parse_sse_line


def ask(agent: AgentRuntimeArn, session: SessionId, prompt: Prompt) -> int:
    client = boto3.client("bedrock-agentcore", region_name="eu-west-1")
    response = client.invoke_agent_runtime(
        agentRuntimeArn=agent.value,
        runtimeSessionId=session.value,  # same id = same VM = same conversation
        payload=json.dumps({"prompt": prompt.text}).encode(),
        contentType="application/json",
        accept="text/event-stream",
        qualifier="DEFAULT",
    )
    events: list[AnswerEvent] = []
    for line in response["response"].iter_lines():
        event = parse_sse_line(line.decode())  # outside data -> domain type, right here
        if event is not None:
            events.append(event)
            print(render(event), end="", flush=True)
    print()
    return exit_code(events)


def main(argv: list[str]) -> int:
    try:
        agent = AgentRuntimeArn.parse(os.environ.get("AGENT_ARN", ""))
        prompt = Prompt.parse(argv[1] if len(argv) > 1 else "")
        session = SessionId.parse(argv[2] if len(argv) > 2 else str(uuid.uuid4()))
    except ParseError as exc:
        print(
            f"error: {exc}\nusage: AGENT_ARN=arn:... invoke.py PROMPT [SESSION_ID]", file=sys.stderr
        )
        return 2
    print(f"session: {session.value}")
    return ask(agent, session, prompt)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
