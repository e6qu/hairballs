/**
 * pi model `cost` from the configured price (pure).
 *
 * pi wants USD per million tokens as plain numbers. A custom model without `cost` defaults to 0,
 * which would make pi's own cost figures read $0, so the registered model always carries the
 * configured price. The budget itself is enforced by the org RunGuard in integer micro-dollars.
 */

import { type ModelPrice, Usd } from "@org/agents";

export type PiCost = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

const perMtok = (usd: Usd): number => Usd.micros(usd) / 1_000_000;

export function piCost(price: ModelPrice): PiCost {
  return {
    input: perMtok(price.inputPerMtok),
    output: perMtok(price.outputPerMtok),
    cacheRead: perMtok(price.cacheReadPerMtok),
    cacheWrite: perMtok(price.cacheWritePerMtok),
  };
}
