"""Ask the helpdesk with an extra skill for this one call, and show the tools it uses.

Usage: HARNESS_ARN=arn:... uv run python invoke_with_skill.py "question" [skill-s3-uri]
"""

import os
import sys
import uuid

import boto3

DRAFT_SKILL = "s3://fintech-agent-skills/drafts/expense-policy/"


def ask(harness_arn: str, question: str, skill_uri: str) -> None:
    client = boto3.client("bedrock-agentcore", region_name="eu-west-1")
    response = client.invoke_harness(
        harnessArn=harness_arn,
        runtimeSessionId=str(uuid.uuid4()),
        skills=[{"s3": {"uri": skill_uri}}],  # this call only; same name wins
        messages=[{"role": "user", "content": [{"text": question}]}],
    )
    for event in response["stream"]:
        if "contentBlockStart" in event:
            tool_use = event["contentBlockStart"]["start"].get("toolUse")
            if tool_use:
                print(f"\n[tool {tool_use['name']}] ", end="")
        elif "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            if "toolUse" in delta:
                print(delta["toolUse"]["input"], end="")  # the tool's arguments
            elif "text" in delta:
                print(delta["text"], end="", flush=True)
        elif "runtimeClientError" in event:
            raise RuntimeError(event["runtimeClientError"].get("message"))
    print()


if __name__ == "__main__":
    skill = sys.argv[2] if len(sys.argv) > 2 else DRAFT_SKILL
    ask(os.environ["HARNESS_ARN"], sys.argv[1], skill)
