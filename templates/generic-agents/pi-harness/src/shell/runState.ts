/**
 * The mutable per-run state shared by the session runner and the org extension (shell).
 *
 * pi's extension `ctx` carries no request identity, so the runner publishes the active run here
 * before it calls `session.prompt()` and clears it afterwards (AGENT_PI_BEDROCK.md §7.1).
 */

import type { PrincipalId, RunGuard, SessionId } from "@org/agents";

import type { PendingApproval } from "../core/approval.ts";

export type ActiveRun = {
  readonly guard: RunGuard;
  readonly session: SessionId;
  /** The principal the run acts for (`requested_by` of side-effecting tools). */
  readonly owner: PrincipalId;
  /** Set by the `tool_call` hook when a call is held for human approval. */
  pendingApproval: PendingApproval | null;
  /**
   * The runner already asked the guard before handing the prompt to pi (so a kill switch or an
   * exhausted budget never reaches the provider); the first `turn_start` must not count again.
   */
  firstTurnChecked: boolean;
};

export class RunSlot {
  current: ActiveRun | null = null;
}
