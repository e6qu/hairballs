"""Prompt caching with the raw Converse API: a cachePoint ends the part Bedrock may cache.

Usage: uv run python converse_cache.py HANDBOOK.md  (a long, fixed document: > 4,096 tokens)
"""

from __future__ import annotations

import sys
from pathlib import Path

import boto3

from core import describe
from domain import parse_usage

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
bedrock = boto3.client("bedrock-runtime", region_name="eu-west-1")


def ask(handbook: str, question: str) -> None:
    response = bedrock.converse(
        modelId=MODEL_ID,
        system=[
            {"text": "Answer from this expenses handbook:\n\n" + handbook},
            {"cachePoint": {"type": "default"}},  # cache everything above; "ttl": "1h" for longer
        ],
        messages=[{"role": "user", "content": [{"text": question}]}],
    )
    print(describe(parse_usage(response["usage"])))  # outside data -> domain type -> text


if __name__ == "__main__":
    handbook = Path(sys.argv[1]).read_text()
    ask(handbook, "What is the hotel limit per night?")  # first call writes the cache
    ask(handbook, "How long do I have to submit a claim?")  # second reads it: ~10% of the price
