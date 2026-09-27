"""Token accounting for LangChain usage metadata (pure).

LangChain's ``usage_metadata.input_tokens`` is the *total* prompt size: ``ChatBedrockConverse``
adds Bedrock's ``cacheReadInputTokens`` and ``cacheWriteInputTokens`` to ``inputTokens``
(``langchain_aws/chat_models/bedrock_converse.py``). The org ``Usage`` prices those three
separately, so the cached parts are taken out of the input count here.
"""

from __future__ import annotations

from org_agents.domain import TokenCount, Usage


def usage_from_totals(
    total_input: TokenCount, output: TokenCount, cache_read: TokenCount, cache_write: TokenCount
) -> Usage:
    uncached = max(total_input.value - cache_read.value - cache_write.value, 0)
    return Usage(
        input_tokens=TokenCount(uncached),
        output_tokens=output,
        cache_read_tokens=cache_read,
        cache_write_tokens=cache_write,
    )
