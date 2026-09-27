"""Prompt caching with the raw Converse API: a cachePoint ends the part Bedrock may cache."""

import sys
from pathlib import Path

import boto3

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
HANDBOOK = Path(sys.argv[1]).read_text()  # a long, fixed document (> 4,096 tokens for Haiku 4.5)

bedrock = boto3.client("bedrock-runtime", region_name="eu-west-1")


def ask(question: str) -> None:
    response = bedrock.converse(
        modelId=MODEL_ID,
        system=[
            {"text": "Answer from this expenses handbook:\n\n" + HANDBOOK},
            {"cachePoint": {"type": "default"}},  # cache everything above; "ttl": "1h" for longer
        ],
        messages=[{"role": "user", "content": [{"text": question}]}],
    )
    usage = response["usage"]
    print(
        f"input={usage['inputTokens']} "
        f"cache_write={usage.get('cacheWriteInputTokens', 0)} "
        f"cache_read={usage.get('cacheReadInputTokens', 0)}"
    )


ask("What is the hotel limit per night?")  # first call writes the cache
ask("How long do I have to submit a claim?")  # second call reads it: about 10% of the price
