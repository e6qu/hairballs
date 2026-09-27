"""Ask the deployed helpdesk harness a question and stream the answer.

Usage: HARNESS_ARN=arn:... uv run python invoke.py "question" [session-id]
"""

import os
import sys
import uuid

import boto3


def ask(harness_arn: str, session_id: str, question: str) -> None:
    client = boto3.client("bedrock-agentcore", region_name="eu-west-1")
    response = client.invoke_harness(
        harnessArn=harness_arn,
        runtimeSessionId=session_id,  # same id = same VM and conversation
        messages=[{"role": "user", "content": [{"text": question}]}],
    )
    for event in response["stream"]:
        if "contentBlockDelta" in event:
            text = event["contentBlockDelta"]["delta"].get("text")
            if text:
                print(text, end="", flush=True)
        elif "messageStop" in event:
            print(f"\n[stop: {event['messageStop']['stopReason']}]")
        elif "runtimeClientError" in event:
            raise RuntimeError(event["runtimeClientError"].get("message"))


if __name__ == "__main__":
    session = sys.argv[2] if len(sys.argv) > 2 else str(uuid.uuid4())
    print(f"session: {session}")
    ask(os.environ["HARNESS_ARN"], session, sys.argv[1])
