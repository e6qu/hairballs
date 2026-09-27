"""Ask the helpdesk with an extra skill for this one call, and show the tools it uses (the shell).

Usage: HARNESS_ARN=arn:... uv run python invoke_with_skill.py "question" [skill-s3-uri]
"""

from __future__ import annotations

import os
import sys
import uuid

import boto3

from core import exit_code, render
from domain import (
    HarnessArn,
    ParseError,
    Question,
    SessionId,
    SkillUri,
    StreamEvent,
    parse_stream_event,
)

DRAFT_SKILL = "s3://fintech-agent-skills/drafts/expense-policy/"


def ask(harness: HarnessArn, session: SessionId, question: Question, skill: SkillUri) -> int:
    client = boto3.client("bedrock-agentcore", region_name="eu-west-1")
    response = client.invoke_harness(
        harnessArn=harness.value,
        runtimeSessionId=session.value,
        skills=[{"s3": {"uri": skill.value}}],  # this call only; same name wins
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
        skill = SkillUri.parse(argv[2] if len(argv) > 2 else DRAFT_SKILL)
        session = SessionId.parse(str(uuid.uuid4()))
    except ParseError as exc:
        print(
            f"error: {exc}\nusage: HARNESS_ARN=arn:... invoke_with_skill.py QUESTION [SKILL_S3_URI]",
            file=sys.stderr,
        )
        return 2
    return ask(harness, session, question, skill)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
