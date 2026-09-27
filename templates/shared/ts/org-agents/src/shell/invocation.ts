/**
 * Parsing AgentCore `/invocations` requests into domain messages.
 *
 * Payload shapes accepted (all fields untyped until parsed here):
 *
 *     {"prompt": "...", "message_id": "..."}                                   -> ChatMessage
 *     {"cancel": true, "message_id": "..."}                                    -> CancelRequest
 *     {"approval": {"id": "...", "decision": "approve"}, "message_id": "..."}  -> ApprovalResponse
 *
 * The sender comes from the (already validated) Auth0 JWT forwarded by AgentCore Runtime in the
 * `Authorization` header; locally it defaults to `local-dev`. The raw credentials (the caller's
 * JWT and the Workload Access Token) are parsed into an `InvocationContext` for the handler.
 */

import { randomUUID } from "node:crypto";

import type { Incoming } from "../core/messages.ts";
import {
  ApprovalDecision,
  ApprovalId,
  CallerToken,
  MessageId,
  PrincipalId,
  Prompt,
  WorkloadAccessToken,
} from "../domain.ts";
import { attempt, expectBool, expectObject, fail, field, hasField, must, type Parsed } from "../parsing.ts";

export const LOCAL_PRINCIPAL: PrincipalId = PrincipalId.of("local-dev");

/** Request headers as Node (`IncomingHttpHeaders`) or a plain record gives them. */
export type HeaderRecord = Readonly<Record<string, string | readonly string[] | undefined>>;

function headerValue(headers: HeaderRecord | Headers, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value[0] as string | undefined;
  }
  return undefined;
}

/**
 * Read `sub` from the Bearer JWT. AgentCore Runtime has already validated the token; we only
 * decode its claims. Without a token (local development) the principal is `local-dev`.
 */
export function principalFromHeaders(headers: HeaderRecord | Headers): Parsed<PrincipalId> {
  const auth = headerValue(headers, "authorization");
  if (auth === undefined || !auth.toLowerCase().startsWith("bearer ")) return { kind: "ok", value: LOCAL_PRINCIPAL };
  const parts = auth.slice(7).trim().split(".");
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined) return fail("$.headers.authorization", "is not a JWT");
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return fail("$.headers.authorization", "has an undecodable payload");
  }
  return attempt(() => {
    const fields = must(expectObject(claims, "$.jwt"));
    return must(PrincipalId.parse(must(field(fields, "sub", "$.jwt")), "$.jwt.sub"));
  });
}

/** Header names under which AgentCore Runtime passes the Workload Access Token (first wins). */
export const WORKLOAD_ACCESS_TOKEN_HEADERS = ["workloadaccesstoken", "x-amz-bedrock-agentcore-identity-wat"] as const;

/**
 * Per-request credentials, handed to the invocation handler next to the parsed message. Both are
 * secrets: pass them on (Gateway, AgentCore Identity), never log, audit or render them.
 */
export type InvocationContext = {
  /** The caller's validated Auth0 JWT; `null` without `Authorization: Bearer …` (local development). */
  readonly callerToken: CallerToken | null;
  /** AgentCore Identity's Workload Access Token; `null` when the runtime did not send one. */
  readonly workloadAccessToken: WorkloadAccessToken | null;
};

export const NO_INVOCATION_CONTEXT: InvocationContext = { callerToken: null, workloadAccessToken: null };

/** The bearer token of `Authorization: Bearer <jwt>` (scheme case-insensitive), or null. */
export function callerTokenFromHeaders(headers: HeaderRecord | Headers): Parsed<CallerToken | null> {
  const auth = headerValue(headers, "authorization");
  if (auth === undefined || !auth.toLowerCase().startsWith("bearer ")) return { kind: "ok", value: null };
  return CallerToken.parse(auth.slice(7), "$.headers.authorization");
}

/** The Workload Access Token from `WorkloadAccessToken` or `X-Amz-Bedrock-AgentCore-Identity-WAT`. */
export function workloadAccessTokenFromHeaders(headers: HeaderRecord | Headers): Parsed<WorkloadAccessToken | null> {
  for (const name of WORKLOAD_ACCESS_TOKEN_HEADERS) {
    const value = headerValue(headers, name);
    if (value !== undefined) return WorkloadAccessToken.parse(value, `$.headers.${name}`);
  }
  return { kind: "ok", value: null };
}

export function invocationContextFromHeaders(headers: HeaderRecord | Headers): Parsed<InvocationContext> {
  return attempt(() => ({
    callerToken: must(callerTokenFromHeaders(headers)),
    workloadAccessToken: must(workloadAccessTokenFromHeaders(headers)),
  }));
}

/** Parse an `/invocations` body. `newMessageId` supplies ids for bodies without `message_id`. */
export function parseIncoming(
  raw: unknown,
  sender: PrincipalId,
  newMessageId: () => MessageId = () => MessageId.of(`auto-${randomUUID()}`),
): Parsed<Incoming> {
  return attempt((): Incoming => {
    const body = must(expectObject(raw, "$"));
    const messageId = hasField(body, "message_id")
      ? must(MessageId.parse(body["message_id"], "$.message_id"))
      : newMessageId();
    if (hasField(body, "cancel") && must(expectBool(body["cancel"], "$.cancel"))) {
      return { kind: "cancel_request", messageId, sender };
    }
    if (hasField(body, "approval")) {
      const approval = must(expectObject(body["approval"], "$.approval"));
      return {
        kind: "approval_response",
        messageId,
        sender,
        approvalId: must(ApprovalId.parse(must(field(approval, "id", "$.approval")), "$.approval.id")),
        decision: must(
          ApprovalDecision.parse(must(field(approval, "decision", "$.approval")), "$.approval.decision"),
        ),
      };
    }
    return {
      kind: "chat_message",
      messageId,
      sender,
      prompt: must(Prompt.parse(must(field(body, "prompt", "$")), "$.prompt")),
    };
  });
}
