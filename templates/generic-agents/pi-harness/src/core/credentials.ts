/** When to refresh the runtime-role credentials (pure; the shell owns the timer and the fetch). */

import { DurationMs, Instant } from "@org/agents";

const MIN_DELAY = DurationMs.of(60_000);
const DEFAULT_TTL = DurationMs.of(15 * 60_000);
const REFRESH_BEFORE_EXPIRY = DurationMs.of(5 * 60_000);

/** Refresh 5 minutes before expiry (15-minute TTL assumed when unknown), never sooner than 1 minute. */
export function refreshDelay(expiration: Instant | null, now: Instant): DurationMs {
  const ttl = expiration === null ? DEFAULT_TTL : Instant.since(expiration, now);
  return DurationMs.of(Math.max(MIN_DELAY, ttl - REFRESH_BEFORE_EXPIRY));
}

/** After a failed fetch, try again soon (the old credentials may still be valid). */
export const RETRY_DELAY: DurationMs = MIN_DELAY;
