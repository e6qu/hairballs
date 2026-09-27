"""LangChain ``usage_metadata`` → org ``Usage`` (pure parser).

LangChain's convention differs from Bedrock's: ``input_tokens`` is the *total* prompt size and
already includes cache reads and cache writes (``langchain_aws`` adds ``cacheReadInputTokens`` and
``cacheWriteInputTokens`` to ``inputTokens``). The org ``Usage`` prices uncached input, cache reads
and cache writes separately, so cached tokens are subtracted here to avoid double counting.

When Bedrock reports per-TTL cache details, ``langchain_aws`` moves the write tokens from
``cache_creation`` to ``ephemeral_5m_input_tokens`` / ``ephemeral_1h_input_tokens``; all three
count as cache writes.
"""

from __future__ import annotations

from collections.abc import Mapping

from org_agents.domain import TokenCount, Usage
from org_agents.parsing import ParseError, expect_int, expect_mapping

_CACHE_WRITE_KEYS = ("cache_creation", "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens")


def _count(fields: Mapping[str, object], name: str, path: str) -> int:
    return expect_int(fields.get(name, 0), f"{path}.{name}", minimum=0)


def parse_usage_metadata(raw: object, path: str = "$.usage_metadata") -> Usage:
    fields = expect_mapping(raw, path)
    details_raw = fields.get("input_token_details", {})
    details = expect_mapping(details_raw if details_raw is not None else {}, f"{path}.input_token_details")
    details_path = f"{path}.input_token_details"

    total_input = _count(fields, "input_tokens", path)
    cache_read = _count(details, "cache_read", details_path)
    cache_write = sum(_count(details, key, details_path) for key in _CACHE_WRITE_KEYS)
    uncached = total_input - cache_read - cache_write
    if uncached < 0:
        raise ParseError(f"{path}.input_tokens", "is smaller than the cached tokens it includes")
    return Usage(
        input_tokens=TokenCount(uncached),
        output_tokens=TokenCount(_count(fields, "output_tokens", path)),
        cache_read_tokens=TokenCount(cache_read),
        cache_write_tokens=TokenCount(cache_write),
    )
