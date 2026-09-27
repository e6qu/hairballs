/** How a finished pi run maps to a domain `RunOutcome` (pure). */

import {
  approvalNeeded,
  assertNever,
  completed,
  failed,
  type RunOutcome,
  type StopRun,
  stopped,
  stopRun,
} from "@org/agents";

import type { PendingApproval } from "./approval.ts";
import type { FinalMessage } from "./domain.ts";

export type RunFacts = {
  /** The guard's stop decision, if it (or a recorded external stop such as cancel) stopped the run. */
  readonly stopped: StopRun | null;
  /** A side-effecting call held for human approval in this run. */
  readonly pendingApproval: PendingApproval | null;
  /** The last assistant message of the run (null when the model was never called). */
  readonly final: FinalMessage | null;
};

/** Bedrock reports a guardrail intervention as a provider stop reason; pi turns it into an error. */
export const GUARDRAIL_MARKER = "guardrail_intervened";

/** A guardrail intervention is a policy stop, not a crash. */
export const guardrailStop: StopRun = stopRun("framework_limit", "Bedrock guardrail intervened");

function textOf(final: FinalMessage | null): string {
  if (final === null) return "";
  switch (final.kind) {
    case "text":
    case "aborted":
      return final.text;
    case "error":
      return "";
    default:
      return assertNever(final);
  }
}

export function decideOutcome(facts: RunFacts): RunOutcome {
  // Precedence: a guard stop wins (it may have aborted the run mid-approval), then a pending
  // approval, then what the model said.
  if (facts.stopped !== null) return stopped(facts.stopped, textOf(facts.final));
  if (facts.pendingApproval !== null) {
    const pending = facts.pendingApproval;
    return approvalNeeded(pending.approvalId, pending.tool, pending.reason);
  }
  const final = facts.final;
  if (final === null) return failed("the model produced no response");
  switch (final.kind) {
    case "text":
      return completed(final.text);
    case "aborted":
      // Aborted without a recorded stop (e.g. the process is shutting down).
      return stopped(stopRun("cancelled", "the run was aborted"), final.text);
    case "error":
      return final.message.includes(GUARDRAIL_MARKER) ? stopped(guardrailStop, "") : failed(final.message);
    default:
      return assertNever(final);
  }
}
