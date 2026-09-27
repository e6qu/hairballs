/**
 * Human approval of side-effecting tool calls (pure).
 *
 * pi has no interrupt/resume for a single tool call, so the approval flow is:
 *   1. the guard extension blocks the tool call with a "pending approval" result and ends the
 *      turn (`terminate: true`); the run ends with `approval_needed`;
 *   2. on approval the shell executes *that exact call* (same arguments) through the MCP client,
 *      with the harness-set `requested_by` and idempotency key, and hands the result back to the
 *      agent as a new, auditable prompt; on rejection it tells the agent the action was not done.
 */

import { createHash } from "node:crypto";

import { ApprovalId, type PrincipalId, type SessionId, type ToolName } from "@org/agents";

import type { ToolCallId, ToolOutcome } from "./domain.ts";

export type PendingApproval = {
  readonly approvalId: ApprovalId;
  readonly tool: ToolName;
  readonly toolCallId: ToolCallId;
  /** The arguments exactly as the model produced them (already validated by pi against the tool schema). */
  readonly arguments: unknown;
  readonly reason: string;
};

/** Deterministic, so a replayed tool call maps to the same approval request. */
export function approvalIdFor(session: SessionId, toolCallId: ToolCallId): ApprovalId {
  const digest = createHash("sha256").update(`${session}\u001f${toolCallId}`, "utf8").digest("hex");
  return ApprovalId.of(`appr-${digest.slice(0, 24)}`);
}

/** The tool result the model sees while the call waits for a human. */
export function pendingApprovalNotice(approval: PendingApproval): string {
  return (
    `Not executed yet: ${approval.reason}. Approval request ${approval.approvalId} is pending with a human ` +
    "approver. Tell the user it is pending approval and stop; do not call the tool again."
  );
}

/** The prompt that resumes the agent after an approver granted the request. */
export function approvalGrantedPrompt(approval: PendingApproval, approver: PrincipalId, outcome: ToolOutcome): string {
  const status = outcome.kind === "ok" ? "was executed" : "was attempted and failed";
  return (
    `[Approval ${approval.approvalId}] ${approver} approved the ${approval.tool} call (${approval.toolCallId}). ` +
    `It ${status}. Result:\n${outcome.text}\n\nReport the result to the user.`
  );
}

/** The prompt that resumes the agent after an approver rejected the request. */
export function approvalRejectedPrompt(approval: PendingApproval, approver: PrincipalId): string {
  return (
    `[Approval ${approval.approvalId}] The ${approval.tool} call (${approval.toolCallId}) was rejected by approver ` +
    `${approver}. It was NOT executed. Tell the user and do not retry it.`
  );
}
