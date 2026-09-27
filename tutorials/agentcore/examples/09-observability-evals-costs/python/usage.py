"""Ask the helpdesk harness a question and add up the tokens it used, cache reads included."""

import os
import sys
import uuid

import boto3

HARNESS_ARN = os.environ.get(
    "HARNESS_ARN",
    "arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/helpdesk-AbCdEf1234",
)
# Claude Haiku 4.5, global profile, USD per million tokens.
PRICE = {
    "inputTokens": 1.00,
    "outputTokens": 5.00,
    "cacheReadInputTokens": 0.10,  # 10% of input
    "cacheWriteInputTokens": 1.25,  # 125% of input (5-minute cache)
}

client = boto3.client("bedrock-agentcore", region_name="eu-west-1")


def ask(prompt: str, session_id: str) -> dict[str, int]:
    response = client.invoke_harness(
        harnessArn=HARNESS_ARN,
        runtimeSessionId=session_id,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
    )
    totals = dict.fromkeys(PRICE, 0)
    for event in response["stream"]:
        if "contentBlockDelta" in event:
            delta = event["contentBlockDelta"]["delta"]
            print(delta.get("text", ""), end="", flush=True)
        elif "metadata" in event:  # token usage of the model calls
            usage = event["metadata"]["usage"]
            totals["inputTokens"] += usage["inputTokens"]
            totals["outputTokens"] += usage["outputTokens"]
            totals["cacheReadInputTokens"] += usage.get("cacheReadInputTokens", 0)
            totals["cacheWriteInputTokens"] += usage.get("cacheWriteInputTokens", 0)
        elif "messageStop" in event:
            print(f"\n[stop: {event['messageStop']['stopReason']}]")
    return totals


def cost_usd(totals: dict[str, int]) -> float:
    return sum(totals[k] * PRICE[k] for k in PRICE) / 1_000_000


if __name__ == "__main__":
    session_id = sys.argv[2] if len(sys.argv) > 2 else str(uuid.uuid4())
    totals = ask(sys.argv[1], session_id)
    print(totals, f"${cost_usd(totals):.5f}", f"session: {session_id}")
