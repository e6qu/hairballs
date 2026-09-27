/**
 * RunGuard: the imperative wrapper that framework adapters call.
 *
 * It owns the mutable bits (current guard state, clock, audit sink, kill-switch probe) and
 * delegates every decision to the pure core (core/guard.ts, core/toolPolicy.ts).
 */

import {
  type Decision,
  GuardState,
  externalStopObserved,
  killSwitchObserved,
  type StopReason,
  modelCallCompleted,
  step,
  type StopRun,
  toolRequested,
  turnStarted,
} from "../core/guard.ts";
import { decideTool } from "../core/toolPolicy.ts";
import type { Limits, ModelPrice, SessionId, ToolName, ToolPolicy, Usage } from "../domain.ts";
import { assertNever } from "../result.ts";
import type { AuditSink } from "./audit.ts";
import type { Clock } from "./clock.ts";
import { fingerprintArguments } from "./fingerprint.ts";

export type Proceed = { readonly kind: "proceed" };
export type BlockTool = { readonly kind: "block_tool"; readonly reason: string };
export type RequireApproval = { readonly kind: "require_approval"; readonly reason: string };
export type ToolVerdict = Proceed | BlockTool | RequireApproval | StopRun;

export type RunGuardOptions = {
  readonly session: SessionId;
  readonly limits: Limits;
  readonly price: ModelPrice;
  readonly tools: ToolPolicy;
  readonly clock: Clock;
  readonly audit: AuditSink;
  /** Probed before every model call; `true` stops the run (see `killSwitchFrom(env)`). */
  readonly killSwitch?: () => boolean;
};

export class RunGuard {
  readonly #session: SessionId;
  readonly #limits: Limits;
  readonly #price: ModelPrice;
  readonly #tools: ToolPolicy;
  readonly #clock: Clock;
  readonly #audit: AuditSink;
  readonly #killSwitch: () => boolean;
  #state: GuardState;

  constructor(options: RunGuardOptions) {
    this.#session = options.session;
    this.#limits = options.limits;
    this.#price = options.price;
    this.#tools = options.tools;
    this.#clock = options.clock;
    this.#audit = options.audit;
    this.#killSwitch = options.killSwitch ?? ((): boolean => false);
    this.#state = GuardState.start(this.#clock.now());
    this.#audit.emit({ kind: "run_started", session: this.#session, at: this.#state.startedAt });
  }

  get session(): SessionId {
    return this.#session;
  }

  get state(): GuardState {
    return this.#state;
  }

  get stopped(): StopRun | null {
    return this.#state.stopped;
  }

  #apply(decision: Decision, wasStopped: boolean): Decision {
    if (decision.kind === "stop" && !wasStopped) {
      this.#audit.emit({ kind: "run_stopped", session: this.#session, stop: decision, at: this.#clock.now() });
    }
    return decision;
  }

  /** Call at the start of every turn (before each model call). */
  beforeModelCall(): Decision {
    const wasStopped = this.#state.stopped !== null;
    const now = this.#clock.now();
    const event = this.#killSwitch() ? killSwitchObserved(now) : turnStarted(now);
    const [state, decision] = step(this.#state, event, this.#limits, this.#price);
    this.#state = state;
    return this.#apply(decision, wasStopped);
  }

  afterModelCall(usage: Usage): Decision {
    const wasStopped = this.#state.stopped !== null;
    const now = this.#clock.now();
    const [state, decision] = step(this.#state, modelCallCompleted(usage, now), this.#limits, this.#price);
    this.#state = state;
    this.#audit.emit({ kind: "usage", session: this.#session, usage, runTotal: state.spent, at: now });
    return this.#apply(decision, wasStopped);
  }

  /** `rawArguments` are the tool arguments exactly as the model produced them (fingerprinted, not parsed). */
  beforeToolCall(tool: ToolName, rawArguments: unknown): ToolVerdict {
    const wasStopped = this.#state.stopped !== null;
    const now = this.#clock.now();
    const session = this.#session;
    const policy = decideTool(tool, this.#tools);
    if (policy.kind === "denied") {
      this.#audit.emit({ kind: "tool_decision", session, tool, outcome: "denied", reason: policy.reason, at: now });
      return { kind: "block_tool", reason: policy.reason };
    }
    const event = toolRequested(tool, fingerprintArguments(rawArguments), now);
    const [state, decision] = step(this.#state, event, this.#limits, this.#price);
    this.#state = state;
    if (decision.kind === "stop") {
      this.#audit.emit({ kind: "tool_decision", session, tool, outcome: "stopped", reason: decision.detail, at: now });
      this.#apply(decision, wasStopped);
      return decision;
    }
    switch (policy.kind) {
      case "needs_approval":
        this.#audit.emit({
          kind: "tool_decision",
          session,
          tool,
          outcome: "needs_approval",
          reason: policy.reason,
          at: now,
        });
        return { kind: "require_approval", reason: policy.reason };
      case "allowed":
        this.#audit.emit({ kind: "tool_decision", session, tool, outcome: "allowed", reason: "", at: now });
        return { kind: "proceed" };
      default:
        return assertNever(policy);
    }
  }

  /** Record a stop decided outside the guard (cancel, framework limit) so state and audit agree. */
  recordExternalStop(reason: StopReason, detail: string): StopRun {
    const wasStopped = this.#state.stopped !== null;
    const [state, decision] = step(
      this.#state,
      externalStopObserved(reason, detail, this.#clock.now()),
      this.#limits,
      this.#price,
    );
    this.#state = state;
    this.#apply(decision, wasStopped);
    return this.#state.stopped ?? { kind: "stop", reason, detail };
  }

  /** Usage from model calls made outside the agent loop (e.g. a context summarizer). */
  recordExternalUsage(usage: Usage): Decision {
    return this.afterModelCall(usage);
  }

  fail(error: string): void {
    this.#audit.emit({ kind: "run_failed", session: this.#session, error, at: this.#clock.now() });
  }

  finish(): void {
    this.#audit.emit({
      kind: "run_finished",
      session: this.#session,
      turns: this.#state.turns,
      spent: this.#state.spent,
      at: this.#clock.now(),
    });
  }
}
