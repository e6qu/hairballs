/** Outbound serialization of replies: the only place the /invocations response JSON is defined. */

import type { Reply } from "../core/conversation.ts";
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
