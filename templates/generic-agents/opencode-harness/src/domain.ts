/**
 * Domain types specific to the opencode variant (the shared ones come from `@org/agents`).
 *
 * opencode identifiers are opaque strings minted by the opencode server; they are parsed once at
 * the HTTP/SSE boundary (`shell/opencodeEvents.ts`) into these branded types.
 */

import { AwsRegion, fail, ModelId, ok, type Parsed } from "@org/agents";

const OPENCODE_ID = /^[A-Za-z0-9_-]{1,128}$/;

function opaqueId<T extends string>(label: string) {
  return {
    parse(raw: unknown, path: string): Parsed<T> {
      if (typeof raw !== "string" || !OPENCODE_ID.test(raw)) return fail(path, `is not a valid ${label}`);
      return ok(raw as T);
    },
    of(text: string): T {
      if (!OPENCODE_ID.test(text)) throw new RangeError(`invalid ${label}: ${text}`);
      return text as T;
    },
  } as const;
}

/** An opencode session (`ses_…`): one per conversation thread (= one AgentCore session). */
export type OcSessionId = string & { readonly __brand: "OcSessionId" };
export const OcSessionId = opaqueId<OcSessionId>("opencode session id");

/** An opencode message (`msg_…`). */
export type OcMessageId = string & { readonly __brand: "OcMessageId" };
export const OcMessageId = opaqueId<OcMessageId>("opencode message id");

/** An opencode permission request (`per_…`), answered with `once` or `reject`. */
export type PermissionRequestId = string & { readonly __brand: "PermissionRequestId" };
export const PermissionRequestId = opaqueId<PermissionRequestId>("permission request id");

/**
 * Where opencode sends model calls.
 *
 * - `bedrock`: production. opencode's bundled `@ai-sdk/amazon-bedrock` with a `credential_process`
 *   AWS profile (AGENTS_OPENCODE_BEDROCK.md §3.1); `modelId` should be an application inference
 *   profile ARN.
 * - `openai_compatible`: tests and local development only (the scripted fake model). It is never
 *   selected from the environment, only constructed in code.
 */
export type ModelBackend =
  | {
      readonly kind: "bedrock";
      readonly modelId: ModelId;
      readonly region: AwsRegion;
      readonly profile: string;
      /** e.g. a VPC interface endpoint; `null` = the regional default. */
      readonly endpoint: string | null;
    }
  | { readonly kind: "openai_compatible"; readonly baseUrl: string; readonly modelId: ModelId };

export const ModelBackend = {
  bedrock(modelId: ModelId, region: AwsRegion, profile: string, endpoint: string | null = null): ModelBackend {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(profile)) throw new RangeError("invalid AWS profile name");
    return { kind: "bedrock", modelId, region, profile, endpoint };
  },
  openaiCompatible(baseUrl: string, modelId: ModelId): ModelBackend {
    return { kind: "openai_compatible", baseUrl, modelId };
  },
} as const;
