/** Conversation domain types shared by all agents: approval policy, run outcomes and replies. */

import { type ApprovalId, PrincipalId, type ToolName } from "../domain.ts";
import { attempt, expectArray, expectBool, expectObject, fieldOr, must, type Parsed } from "../parsing.ts";
import { traverse } from "../result.ts";
import type { StopRun } from "./guard.ts";

/** Who may approve side-effecting tool calls. Four-eyes by default (no self-approval). */
export type ApprovalPolicy = {
  readonly selfApproval: boolean;
  readonly approvers: ReadonlySet<PrincipalId>;
};

export const ApprovalPolicy = {
  parse(raw: unknown, path = "$.approvals"): Parsed<ApprovalPolicy> {
    return attempt(() => {
      const fields = must(expectObject(raw, path));
      const approvers = must(expectArray(fieldOr(fields, "approvers", []), `${path}.approvers`));
      return {
        selfApproval: must(expectBool(fieldOr(fields, "self_approval", false), `${path}.self_approval`)),
        approvers: new Set(
          must(traverse(approvers, (item, i) => PrincipalId.parse(item, `${path}.approvers[${i}]`))),
        ),
      };
    });
  },
} as const;

export function approversFor(policy: ApprovalPolicy, owner: PrincipalId): ReadonlySet<PrincipalId> {
  const approvers = new Set(policy.approvers);
  if (policy.selfApproval) approvers.add(owner);
  else approvers.delete(owner);
  return approvers;
}

// ---------------------------------------------------------------- run outcomes (shell → core)

export type Completed = { readonly kind: "completed"; readonly text: string };
export type ApprovalNeeded = {
  readonly kind: "approval_needed";
  readonly approvalId: ApprovalId;
  readonly tool: ToolName;
  readonly reason: string;
};
export type Stopped = { readonly kind: "stopped"; readonly stop: StopRun; readonly text: string };
/** The framework or model provider raised; the thread must return to idle. */
export type Failed = { readonly kind: "failed"; readonly error: string };
export type RunOutcome = Completed | ApprovalNeeded | Stopped | Failed;
export const failed = (error: string): Failed => ({ kind: "failed", error });

export const completed = (text: string): Completed => ({ kind: "completed", text });
export const approvalNeeded = (approvalId: ApprovalId, tool: ToolName, reason: string): ApprovalNeeded => ({
  kind: "approval_needed",
  approvalId,
  tool,
  reason,
});
export const stopped = (stop: StopRun, text: string): Stopped => ({ kind: "stopped", stop, text });

// ---------------------------------------------------------------- replies (core → shell)

export type Ack = "steered" | "queued" | "cancelling" | "duplicate";

export type Answer = { readonly kind: "answer"; readonly texts: readonly string[] };
export type ApprovalRequested = {
  readonly kind: "approval_requested";
  readonly approvalId: ApprovalId;
  readonly tool: ToolName;
  readonly reason: string;
  readonly approvers: ReadonlySet<PrincipalId>;
};
export type RunHalted = { readonly kind: "run_halted"; readonly stop: StopRun; readonly text: string };
export type Acknowledged = { readonly kind: "acknowledged"; readonly ack: Ack };
export type Refused = { readonly kind: "refused"; readonly reason: string };
export type RunFailed = { readonly kind: "run_failed"; readonly error: string };
export type Reply = Answer | ApprovalRequested | RunHalted | RunFailed | Acknowledged | Refused;

export const answer = (texts: readonly string[]): Answer => ({ kind: "answer", texts });
export const acknowledged = (ack: Ack): Acknowledged => ({ kind: "acknowledged", ack });
export const refused = (reason: string): Refused => ({ kind: "refused", reason });
