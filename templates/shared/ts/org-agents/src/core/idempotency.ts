/**
 * Idempotency keys for side-effecting tools (pure).
 *
 * A retried or looping agent must not create the same ticket, payment or message twice. The key
 * depends only on the session, the tool and the canonical arguments, so a replay yields the same
 * key. (sha256 from node:crypto is a deterministic function, not I/O.)
 */

import { createHash } from "node:crypto";

import type { Brand, Fingerprint, SessionId, ToolName } from "../domain.ts";

export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export function idempotencyKey(session: SessionId, tool: ToolName, args: Fingerprint): IdempotencyKey {
  const digest = createHash("sha256").update(`${session}\u001f${tool}\u001f${args}`, "utf8").digest("hex");
  return `idem-${digest.slice(0, 32)}` as IdempotencyKey;
}
