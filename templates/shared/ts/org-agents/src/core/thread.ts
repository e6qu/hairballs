/**
 * Thread state machine (pure): what a conversation thread is doing, and how messages and run
 * outcomes move it along. The shell stores the state and performs the actions this module returns.
 */

import type { MessageId, PrincipalId, Prompt } from "../domain.ts";
import { assertNever } from "../result.ts";
import { type ApprovalPolicy, approversFor, type Reply, type RunOutcome } from "./conversation.ts";
import {
  awaitingApproval,
  type BusyPolicy,
  IDLE,
  type Incoming,
  type MessageAction,
  onMessage,
  running,
  type ThreadStatus,
} from "./messages.ts";

export type QueuedPrompt = { readonly sender: PrincipalId; readonly prompt: Prompt };

export type ThreadState = {
  readonly status: ThreadStatus;
  readonly seen: ReadonlySet<MessageId>;
  readonly followUps: readonly QueuedPrompt[];
};

export const ThreadState = {
  initial(): ThreadState {
    return { status: IDLE, seen: new Set(), followUps: [] };
  },
} as const;

export function receive(
  state: ThreadState,
  message: Incoming,
  busy: BusyPolicy,
): readonly [ThreadState, MessageAction] {
  const action = onMessage(state.status, message, state.seen, busy);
  const next: ThreadState = { ...state, seen: new Set(state.seen).add(message.messageId) };
  switch (action.kind) {
    case "start_run":
      return [{ ...next, status: running(message.sender) }, action];
    case "queue_follow_up": {
      const queued: QueuedPrompt = { sender: message.sender, prompt: action.prompt };
      return [{ ...next, followUps: [...next.followUps, queued] }, action];
    }
    case "deliver_approval":
      return next.status.kind === "awaiting_approval"
        ? [{ ...next, status: running(next.status.owner) }, action]
        : [next, action];
    case "cancel_run":
      // A pending approval is abandoned on cancel; a running run stays running until it stops.
      return next.status.kind === "awaiting_approval" ? [{ ...next, status: IDLE }, action] : [next, action];
    case "steer":
    case "ignore_duplicate":
    case "reject":
      return [next, action];
    default:
      return assertNever(action);
  }
}

export function finish(
  state: ThreadState,
  outcome: RunOutcome,
  owner: PrincipalId,
  approvals: ApprovalPolicy,
): readonly [ThreadState, Reply] {
  switch (outcome.kind) {
    case "completed":
      return [{ ...state, status: IDLE }, { kind: "answer", texts: [outcome.text] }];
    case "approval_needed": {
      const approvers = approversFor(approvals, owner);
      return [
        { ...state, status: awaitingApproval(owner, outcome.approvalId, approvers) },
        {
          kind: "approval_requested",
          approvalId: outcome.approvalId,
          tool: outcome.tool,
          reason: outcome.reason,
          approvers,
        },
      ];
    }
    case "stopped":
      // A stopped run also drops queued follow-ups: limits apply to the thread's work, not one prompt.
      return [
        { ...state, status: IDLE, followUps: [] },
        { kind: "run_halted", stop: outcome.stop, text: outcome.text },
      ];
    case "failed":
      // Keep queued follow-ups: the failure belongs to this run, not to later messages.
      return [{ ...state, status: IDLE }, { kind: "run_failed", error: outcome.error }];
    default:
      return assertNever(outcome);
  }
}

/** Pop the next queued prompt when the thread is idle; the thread runs on behalf of its sender. */
export function nextFollowUp(state: ThreadState): readonly [ThreadState, QueuedPrompt | null] {
  const [queued, ...rest] = state.followUps;
  if (state.status.kind !== "idle" || queued === undefined) return [state, null];
  return [{ ...state, status: running(queued.sender), followUps: rest }, queued];
}

export function mergeAnswers(first: Reply, later: Reply): Reply {
  if (first.kind === "answer" && later.kind === "answer") {
    return { kind: "answer", texts: [...first.texts, ...later.texts] };
  }
  return later;
}
