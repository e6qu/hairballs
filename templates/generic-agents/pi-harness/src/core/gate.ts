/**
 * What the pi `tool_call` hook does with the guard's verdict (pure).
 *
 * pi ends a tool batch without another model call only when *every* result in the batch has
 * `terminate: true`; so once an approval is pending in this turn, everything else is blocked
 * with `terminate` too, and the run ends waiting for the human.
 */

import { assertNever, type ToolVerdict } from "@org/agents";

export type ToolGate =
  | { readonly kind: "run" }
  | {
      readonly kind: "block";
      readonly reason: string;
      /** End the tool batch without another model call. */
      readonly terminate: boolean;
      /** Abort the pi run (the guard stopped it). */
      readonly abort: boolean;
    }
  | { readonly kind: "hold_for_approval"; readonly reason: string };

const block = (reason: string, terminate: boolean, abort = false): ToolGate => ({
  kind: "block",
  reason,
  terminate,
  abort,
});

export function gateTool(verdict: ToolVerdict, approvalPending: boolean): ToolGate {
  switch (verdict.kind) {
    case "proceed":
      return approvalPending ? block("deferred: another action in this turn is awaiting human approval", true) : { kind: "run" };
    case "block_tool":
      return block(`blocked: ${verdict.reason}`, approvalPending);
    case "require_approval":
      return approvalPending
        ? block("deferred: only one action can await human approval at a time", true)
        : { kind: "hold_for_approval", reason: verdict.reason };
    case "stop":
      return block(`run stopped (${verdict.reason}): ${verdict.detail}`, true, true);
    default:
      return assertNever(verdict);
  }
}
