/** Outbound serialization of replies: the only place the /invocations response JSON is defined. */

import type { Reply } from "../core/conversation.ts";
import { type Caller, displayName } from "../identity.ts";
import { assertNever } from "../result.ts";

export function render(reply: Reply): Record<string, unknown> {
  switch (reply.kind) {
    case "answer":
      return { status: "completed", answers: [...reply.texts] };
    case "approval_requested":
      return {
        status: "approval_required",
        approval_id: reply.approvalId,
        tool: reply.tool,
        reason: reply.reason,
        approvers: [...reply.approvers].sort(),
        ...(reply.requester === null ? {} : { requester: renderCaller(reply.requester) }),
      };
    case "run_halted":
      return { status: "stopped", reason: reply.stop.reason, detail: reply.stop.detail, answer: reply.text };
    case "acknowledged":
      return { status: reply.ack };
    case "run_failed":
      return { status: "failed", error: reply.error };
    case "refused":
      return { status: "refused", reason: reply.reason };
    default:
      return assertNever(reply);
  }
}

/** Requester as shown to approvers. Contains PII (name, email): replies only, never audit logs. */
export function renderCaller(caller: Caller): Record<string, unknown> {
  switch (caller.kind) {
    case "human":
      return { kind: "user", user_id: caller.userId, name: displayName(caller), email: caller.email };
    case "service":
      return { kind: "service", client: caller.subject };
    default:
      return assertNever(caller);
  }
}
