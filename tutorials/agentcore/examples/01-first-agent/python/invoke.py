"""Ask the deployed helpdesk harness a question and stream the answer (the imperative shell).

Usage: HARNESS_ARN=arn:... uv run python invoke.py "question" [session-id]
"""

from __future__ import annotations

import os
import sys
import uuid

import boto3

from core import exit_code, render
from domain import HarnessArn, ParseError, Question, SessionId, StreamEvent, parse_stream_event


def ask(harness: HarnessArn, session: SessionId, question: Question) -> int:
    client = boto3.client("bedrock-agentcore", region_name="eu-west-1")
    response = client.invoke_harness(
        harnessArn=harness.value,
        runtimeSessionId=session.value,  # same id = same VM and conversation
        messages=[{"role": "user", "content": [{"text": question.text}]}],
    )
    events: list[StreamEvent] = []
    for raw in response["stream"]:
        event = parse_stream_event(raw)  # outside data -> domain type, right here
        if event is not None:
            events.append(event)
            print(render(event), end="", flush=True)
    return exit_code(events)


def main(argv: list[str]) -> int:
    try:
        harness = HarnessArn.parse(os.environ.get("HARNESS_ARN", ""))
        question = Question.parse(argv[1] if len(argv) > 1 else "")
        session = SessionId.parse(argv[2] if len(argv) > 2 else str(uuid.uuid4()))
    except ParseError as exc:
        print(
            f"error: {exc}\nusage: HARNESS_ARN=arn:... invoke.py QUESTION [SESSION_ID]",
            file=sys.stderr,
        )
        return 2
    print(f"session: {session.value}")
    return ask(harness, session, question)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
