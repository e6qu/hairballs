"""Cost of model usage in USD (pure)."""

from __future__ import annotations

from decimal import Decimal

from org_agents.domain import ModelPrice, TokenCount, Usage, Usd

_MILLION = Decimal(1_000_000)


def _part(tokens: TokenCount, per_mtok: Usd) -> Decimal:
    return Decimal(tokens.value) * per_mtok.amount / _MILLION


def cost_of(usage: Usage, price: ModelPrice) -> Usd:
    return Usd(
        _part(usage.input_tokens, price.input_per_mtok)
        + _part(usage.output_tokens, price.output_per_mtok)
        + _part(usage.cache_read_tokens, price.cache_read_per_mtok)
        + _part(usage.cache_write_tokens, price.cache_write_per_mtok)
    )
