/** Cost of model usage in USD (pure, exact integer arithmetic). */

import { type ModelPrice, type TokenCount, type Usage, Usd } from "../domain.ts";
import { divRoundHalfEven } from "../parsing.ts";

const MILLION = 1_000_000n;

function part(tokens: TokenCount, perMtok: Usd): bigint {
  return BigInt(tokens) * BigInt(Usd.micros(perMtok));
}

/**
 * Exact cost: Σ tokens × micro-USD-per-Mtok / 1e6, rounded once to micro-dollars (half-even),
 * matching Python's `Decimal` sum followed by `quantize(0.000001)`.
 */
export function costOf(usage: Usage, price: ModelPrice): Usd {
  const numerator =
    part(usage.inputTokens, price.inputPerMtok) +
    part(usage.outputTokens, price.outputPerMtok) +
    part(usage.cacheReadTokens, price.cacheReadPerMtok) +
    part(usage.cacheWriteTokens, price.cacheWritePerMtok);
  return Usd.fromMicros(Number(divRoundHalfEven(numerator, MILLION)));
}
