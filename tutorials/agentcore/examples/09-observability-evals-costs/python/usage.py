"""Ask the helpdesk harness a question and report the tokens it used (the imperative shell).

Usage: HARNESS_ARN=arn:... uv run python usage.py "question" [session-id]
"""

from __future__ import annotations

import os
import sys
import uuid

import boto3

from core import cache_hit_ratio, cost_usd, render, total
from domain import HAIKU_4_5, HarnessArn, ParseError, SessionId, StreamEvent, parse_stream_event


def ask(harness: HarnessArn, session: SessionId, question: str) -> list[StreamEvent]:
    client = boto3.client("bedrock-agentcore", region_name="eu-west-1")
    response = client.invoke_harness(
        harnessArn=harness.value,
        runtimeSessionId=session.value,
        messages=[{"role": "user", "content": [{"text": question}]}],
    )
    events: list[StreamEvent] = []
    for raw in response["stream"]:
        event = parse_stream_event(raw)  # stream metadata -> TokenUsage, right here
        if event is not None:
            events.append(event)
            print(render(event), end="", flush=True)
    return events


def main(argv: list[str]) -> int:
    try:
        harness = HarnessArn.parse(os.environ.get("HARNESS_ARN", ""))
        session = SessionId.parse(argv[2] if len(argv) > 2 else str(uuid.uuid4()))
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    usage = total(ask(harness, session, argv[1] if len(argv) > 1 else "Can I expense a taxi?"))
    print(usage)
    print(f"cost ${cost_usd(usage, HAIKU_4_5):.5f}, cache hits {cache_hit_ratio(usage):.0%}")
    print(f"session: {session.value}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
