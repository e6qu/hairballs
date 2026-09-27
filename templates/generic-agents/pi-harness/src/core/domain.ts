/**
 * Domain types of this variant that the shared library does not have (pure, no I/O).
 *
 * Everything else (SessionId, ToolName, Usage, Usd, RunOutcome, ...) comes from `@org/agents`.
 */

import { type Brand, expectNonEmptyString, fail, ok, type Parsed } from "@org/agents";

/** The id pi / the model gives one tool call (e.g. `tooluse_...` on Bedrock). Opaque. */
export type ToolCallId = Brand<string, "ToolCallId">;
export const ToolCallId = {
  parse(raw: unknown, path = "$.toolCallId"): Parsed<ToolCallId> {
    const text = expectNonEmptyString(raw, path, { maxLength: 512 });
    return text.kind === "err" ? text : ok(text.value as ToolCallId);
  },
} as const;

/** What a tool call produced, as the model will see it. */
export type ToolOutcome =
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "error"; readonly text: string };

/**
 * The last assistant message of a pi run, reduced to what decides the run outcome.
 * `error` is a provider/model failure (pi reports it as `stopReason: "error"`).
 */
export type FinalMessage =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "aborted"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

/** pi-specific model settings from the `[pi]` table of `config/agent.toml`. */
export type PiModelSettings = {
  /** Model family, e.g. `claude-sonnet-4-6`: pi enables Bedrock prompt caching by matching it. */
  readonly modelFamily: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
};

/** Amazon Bedrock guardrail attached to every Converse request (optional). */
export type Guardrail = { readonly id: string; readonly version: string };

const GUARDRAIL_ID = /^[A-Za-z0-9:/._-]{1,2048}$/;
const GUARDRAIL_VERSION = /^(DRAFT|[1-9][0-9]{0,7})$/;

export const Guardrail = {
  /** `GUARDRAIL_ID` unset → no guardrail; set → `GUARDRAIL_VERSION` is required. */
  fromEnv(env: Readonly<Record<string, string | undefined>>): Parsed<Guardrail | null> {
    const id = env["GUARDRAIL_ID"]?.trim();
    if (id === undefined || id === "") return ok(null);
    if (!GUARDRAIL_ID.test(id)) return fail("$.env.GUARDRAIL_ID", "is not a guardrail id or ARN");
    const version = env["GUARDRAIL_VERSION"]?.trim() ?? "";
    if (!GUARDRAIL_VERSION.test(version)) {
      return fail("$.env.GUARDRAIL_VERSION", "must be DRAFT or a version number when GUARDRAIL_ID is set");
    }
    return ok({ id, version });
  },
} as const;
