/**
 * What to do with a message that arrives on a thread (pure).
 *
 * Covers the cases agents in chat threads must handle: duplicates (webhook retries), messages
 * arriving while a run is busy (steer vs. queue), cancellation, and approval responses.
 */

import type { ApprovalDecision, ApprovalId, MessageId, PrincipalId, Prompt } from "../domain.ts";
import { expectNonEmptyString, fail, type Parsed } from "../parsing.ts";
import { assertNever, ok } from "../result.ts";

/**
 * How a new message from the run's own principal is handled while the run is busy:
 * `steer` injects it before the next model call (same run), `queue` delivers it as a follow-up
 * once the run finishes, `reject` tells the sender the agent is busy.
 */
export type BusyPolicy = "steer" | "queue" | "reject";
export const BusyPolicy = {
  STEER: "steer",
  QUEUE: "queue",
  REJECT: "reject",
  parse(raw: unknown, path: string): Parsed<BusyPolicy> {
    const text = expectNonEmptyString(raw, path);
    if (text.kind === "err") return text;
    const value = text.value;
    return value === "steer" || value === "queue" || value === "reject"
      ? ok(value)
      : fail(path, "must be steer, queue or reject");
  },
} as const;

// ---------------------------------------------------------------- inputs

export type ChatMessage = {
  readonly kind: "chat_message";
  readonly messageId: MessageId;
  readonly sender: PrincipalId;
  readonly prompt: Prompt;
};

export type CancelRequest = {
  readonly kind: "cancel_request";
  readonly messageId: MessageId;
  readonly sender: PrincipalId;
};

export type ApprovalResponse = {
  readonly kind: "approval_response";
  readonly messageId: MessageId;
  readonly sender: PrincipalId;
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
};

export type Incoming = ChatMessage | CancelRequest | ApprovalResponse;

export const chatMessage = (messageId: MessageId, sender: PrincipalId, prompt: Prompt): ChatMessage => ({
  kind: "chat_message",
  messageId,
  sender,
  prompt,
});
export const cancelRequest = (messageId: MessageId, sender: PrincipalId): CancelRequest => ({
  kind: "cancel_request",
  messageId,
  sender,
});
export const approvalResponse = (
  messageId: MessageId,
  sender: PrincipalId,
  approvalId: ApprovalId,
  decision: ApprovalDecision,
): ApprovalResponse => ({ kind: "approval_response", messageId, sender, approvalId, decision });

// ---------------------------------------------------------------- thread status

export type Idle = { readonly kind: "idle" };
export type Running = { readonly kind: "running"; readonly owner: PrincipalId };
export type AwaitingApproval = {
  readonly kind: "awaiting_approval";
  readonly owner: PrincipalId;
  readonly approvalId: ApprovalId;
  readonly approvers: ReadonlySet<PrincipalId>;
};
export type ThreadStatus = Idle | Running | AwaitingApproval;

export const IDLE: Idle = { kind: "idle" };
export const running = (owner: PrincipalId): Running => ({ kind: "running", owner });
export const awaitingApproval = (
  owner: PrincipalId,
  approvalId: ApprovalId,
  approvers: ReadonlySet<PrincipalId>,
): AwaitingApproval => ({ kind: "awaiting_approval", owner, approvalId, approvers });

// ---------------------------------------------------------------- actions

export type StartRun = { readonly kind: "start_run"; readonly prompt: Prompt };
export type Steer = { readonly kind: "steer"; readonly prompt: Prompt };
export type QueueFollowUp = { readonly kind: "queue_follow_up"; readonly prompt: Prompt };
export type CancelRun = { readonly kind: "cancel_run" };
export type DeliverApproval = {
  readonly kind: "deliver_approval";
  readonly approvalId: ApprovalId;
  readonly decision: ApprovalDecision;
  readonly approver: PrincipalId;
};
export type IgnoreDuplicate = { readonly kind: "ignore_duplicate" };
export type Reject = { readonly kind: "reject"; readonly reason: string };

export type MessageAction =
  | StartRun
  | Steer
  | QueueFollowUp
  | CancelRun
  | DeliverApproval
  | IgnoreDuplicate
  | Reject;

const reject = (reason: string): Reject => ({ kind: "reject", reason });

export function onMessage(
  status: ThreadStatus,
  message: Incoming,
  seen: ReadonlySet<MessageId>,
  busyPolicy: BusyPolicy,
): MessageAction {
  if (seen.has(message.messageId)) return { kind: "ignore_duplicate" };

  switch (message.kind) {
    case "cancel_request":
      if (status.kind === "idle") return reject("nothing to cancel");
      return message.sender === status.owner ? { kind: "cancel_run" } : reject("only the run owner can cancel");

    case "approval_response":
      if (status.kind !== "awaiting_approval") return reject("no approval is pending");
      if (message.approvalId !== status.approvalId) {
        return reject("approval id does not match the pending request");
      }
      if (!status.approvers.has(message.sender)) return reject("sender is not an authorised approver");
      return {
        kind: "deliver_approval",
        approvalId: message.approvalId,
        decision: message.decision,
        approver: message.sender,
      };

    case "chat_message":
      switch (status.kind) {
        case "idle":
          return { kind: "start_run", prompt: message.prompt };
        case "awaiting_approval":
          return { kind: "queue_follow_up", prompt: message.prompt };
        case "running":
          if (message.sender !== status.owner) return { kind: "queue_follow_up", prompt: message.prompt };
          switch (busyPolicy) {
            case "steer":
              return { kind: "steer", prompt: message.prompt };
            case "queue":
              return { kind: "queue_follow_up", prompt: message.prompt };
            case "reject":
              return reject("the agent is busy with this thread");
            default:
              return assertNever(busyPolicy);
          }
        default:
          return assertNever(status);
      }

    default:
      return assertNever(message);
  }
}
