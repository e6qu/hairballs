/**
 * Parsing AgentCore `/invocations` requests into domain messages.
 *
 * Payload shapes accepted (all fields untyped until parsed here):
 *
 *     {"prompt": "...", "message_id": "..."}                                   -> ChatMessage
 *     {"cancel": true, "message_id": "..."}                                    -> CancelRequest
 *     {"approval": {"id": "...", "decision": "approve"}, "message_id": "..."}  -> ApprovalResponse
 *
 * The sender is the resolved caller's `subject` (the Auth0 `sub` of the already validated JWT
 * forwarded by AgentCore Runtime in the `Authorization` header; locally `local-dev`). The caller
 * and the raw credentials (the caller's JWT and the Workload Access Token) form the
 * `InvocationContext` handed to the handler.
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
import type { Caller } from "../identity.ts";
import { attempt, expectBool, expectObject, field, hasField, must, type Parsed } from "../parsing.ts";
import { type HeaderRecord, headerValue, jwtClaimsFromHeaders, LOCAL_USER } from "./identity.ts";

export const LOCAL_PRINCIPAL: PrincipalId = LOCAL_USER.subject;

/**
 * Read `sub` from the Bearer JWT. AgentCore Runtime has already validated the token; we only
 * decode its claims. Without a token (local development) the principal is `local-dev`.
 * Prefer `IdentityResolver.resolve` for the full caller (profile and org user id).
 */
export function principalFromHeaders(headers: HeaderRecord | Headers): Parsed<PrincipalId> {
  const claims = jwtClaimsFromHeaders(headers);
  if (claims.kind === "err") return claims;
  if (claims.value === null) return { kind: "ok", value: LOCAL_PRINCIPAL };
  const raw = claims.value;
  return attempt(() => {
    const fields = must(expectObject(raw, "$.jwt"));
    return must(PrincipalId.parse(must(field(fields, "sub", "$.jwt")), "$.jwt.sub"));
  });
}

/** Header names under which AgentCore Runtime passes the Workload Access Token (first wins). */
export const WORKLOAD_ACCESS_TOKEN_HEADERS = ["workloadaccesstoken", "x-amz-bedrock-agentcore-identity-wat"] as const;

/**
 * Per-request identity, handed to the invocation handler next to the parsed message: who is
 * calling (`caller`, whose `subject` is the message's sender) and the raw credentials. The
 * credentials are secrets: pass them on (Gateway, AgentCore Identity), never log, audit or render
 * them. The caller's name and email are PII: replies and tool arguments only, never audit events.
 */
export type InvocationContext = {
  /** Resolved from the JWT claims by an `IdentityResolver`; `LOCAL_USER` without a token (local development). */
  readonly caller: Caller;
  /** The caller's validated Auth0 JWT; `null` without `Authorization: Bearer …` (local development). */
  readonly callerToken: CallerToken | null;
  /** AgentCore Identity's Workload Access Token; `null` when the runtime did not send one. */
  readonly workloadAccessToken: WorkloadAccessToken | null;
};

export const NO_INVOCATION_CONTEXT: InvocationContext = { caller: LOCAL_USER, callerToken: null, workloadAccessToken: null };

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

/** The context of a request whose caller has already been resolved (`IdentityResolver.resolve`). */
export function invocationContextFromHeaders(headers: HeaderRecord | Headers, caller: Caller): Parsed<InvocationContext> {
  return attempt(() => ({
    caller,
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
