/**
 * Whose identity the tools act with (pure).
 *
 * opencode's MCP `Authorization` header is part of the config it reads once at start, so the
 * adapter starts `opencode serve` with the Auth0 JWT of the first user who asks something and
 * binds the process to that principal. From then on, a prompt from any other principal is
 * refused: running it would silently call AgentCore Gateway with someone else's token.
 * Cancels and approval responses never start tool calls as their sender (an approved call runs in
 * the requester's run, with the requester's token), so they are not bound.
 */

import type { Incoming, PrincipalId } from "@org/agents";

export type IdentityDecision =
  /** First prompt: start opencode with this message's token and bind to its sender. */
  | { readonly kind: "bind"; readonly principal: PrincipalId }
  | { readonly kind: "proceed" }
  | { readonly kind: "refuse"; readonly reason: string };

export const OTHER_PRINCIPAL_REASON =
  "this agent's tools are bound to the user who started the session (their token is fixed in the " +
  "tool connection); start a new session to ask as a different user";

export function toolIdentity(bound: PrincipalId | null, message: Incoming): IdentityDecision {
  if (message.kind !== "chat_message") return { kind: "proceed" };
  if (bound === null) return { kind: "bind", principal: message.sender };
  return message.sender === bound ? { kind: "proceed" } : { kind: "refuse", reason: OTHER_PRINCIPAL_REASON };
}
