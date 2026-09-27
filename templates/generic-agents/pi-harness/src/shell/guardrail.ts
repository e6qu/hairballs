/**
 * Bedrock Guardrails for pi (shell), installed only when `GUARDRAIL_ID` is set.
 *
 * pi sends no `guardrailConfig`; `before_provider_request` receives exactly the Converse
 * (`ConverseStreamCommand`) input and may return a replacement.
 *
 * FAILS OPEN: if a `before_provider_request` handler throws, pi logs it and sends the request
 * without the guardrail (extensions/runner.js `emitBeforeProviderRequest` catches and keeps the
 * previous payload). Treat this as defence in depth and also require the guardrail at the IAM
 * layer (AGENT_PI_BEDROCK.md §3.4). An intervention comes back as a provider error containing
 * `guardrail_intervened`, which core/outcome.ts reports as a policy stop, not a crash.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { expectObject } from "@org/agents";

import type { Guardrail } from "../core/domain.ts";

const BEDROCK_API = "bedrock-converse-stream";

/** Add `guardrailConfig` to a Converse request payload; other payloads are returned unchanged. */
export function withGuardrail(payload: unknown, guardrail: Guardrail): unknown {
  const fields = expectObject(payload, "$.payload");
  if (fields.kind === "err") return payload;
  return {
    ...fields.value,
    guardrailConfig: { guardrailIdentifier: guardrail.id, guardrailVersion: guardrail.version, trace: "enabled" },
  };
}

export function guardrailExtension(guardrail: Guardrail): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event, ctx) =>
      ctx.model?.api === BEDROCK_API ? withGuardrail(event.payload, guardrail) : undefined,
    );
  };
}
