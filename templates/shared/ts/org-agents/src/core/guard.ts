/**
 * The run guard: a pure state machine that enforces limits, budgets and loop detection.
 *
 * The shell feeds it events (turn started, model usage, tool requested, kill switch) with the
 * current time, and carries out the decision it returns. No I/O, no clock, no framework types.
 */

import {
  DurationMs,
  type Fingerprint,
  Instant,
  type Limits,
  type ModelPrice,
  TokenCount,
  type ToolName,
  Usage,
  Usd,
} from "../domain.ts";
import { assertNever } from "../result.ts";
import { costOf } from "./pricing.ts";

export type StopReason =
  | "turn_limit"
  | "token_limit"
  | "budget"
  | "wall_clock"
  | "tool_call_limit"
  | "loop_detected"
  | "kill_switch"
  | "cancelled"
  | "framework_limit"; // a framework-side limit fired (e.g. recursion / usage limit)

export const STOP_REASONS: readonly StopReason[] = [
  "turn_limit",
  "token_limit",
  "budget",
  "wall_clock",
  "tool_call_limit",
  "loop_detected",
  "kill_switch",
  "cancelled",
  "framework_limit",
];

// ---------------------------------------------------------------- events

export type TurnStarted = { readonly kind: "turn_started"; readonly at: Instant };
export type ModelCallCompleted = {
  readonly kind: "model_call_completed";
  readonly usage: Usage;
  readonly at: Instant;
};
export type ToolRequested = {
  readonly kind: "tool_requested";
  readonly tool: ToolName;
  readonly fingerprint: Fingerprint;
  readonly at: Instant;
};
export type KillSwitchObserved = { readonly kind: "kill_switch_observed"; readonly at: Instant };

/** A stop decided outside the guard: user cancel, or a framework-side limit. */
export type ExternalStopObserved = {
  readonly kind: "external_stop_observed";
  readonly reason: StopReason;
  readonly detail: string;
  readonly at: Instant;
};
export const externalStopObserved = (reason: StopReason, detail: string, at: Instant): ExternalStopObserved => ({
  kind: "external_stop_observed",
  reason,
  detail,
  at,
});

export type GuardEvent = TurnStarted | ModelCallCompleted | ToolRequested | KillSwitchObserved | ExternalStopObserved;

export const turnStarted = (at: Instant): TurnStarted => ({ kind: "turn_started", at });
export const modelCallCompleted = (usage: Usage, at: Instant): ModelCallCompleted => ({
  kind: "model_call_completed",
  usage,
  at,
});
export const toolRequested = (tool: ToolName, fingerprint: Fingerprint, at: Instant): ToolRequested => ({
  kind: "tool_requested",
  tool,
  fingerprint,
  at,
});
export const killSwitchObserved = (at: Instant): KillSwitchObserved => ({ kind: "kill_switch_observed", at });

// ---------------------------------------------------------------- decisions

export type Continue = { readonly kind: "continue" };
export type StopRun = { readonly kind: "stop"; readonly reason: StopReason; readonly detail: string };
export type Decision = Continue | StopRun;

export const CONTINUE: Continue = { kind: "continue" };
export const stopRun = (reason: StopReason, detail: string): StopRun => ({ kind: "stop", reason, detail });

// ---------------------------------------------------------------- state

export type GuardState = {
  readonly startedAt: Instant;
  readonly turns: number;
  readonly tokens: TokenCount;
  readonly spent: Usd;
  readonly toolCalls: number;
  /** Identical-call counts keyed by `repeatKey(tool, fingerprint)`. */
  readonly repeats: ReadonlyMap<string, number>;
  readonly stopped: StopRun | null;
};

export const GuardState = {
  start(at: Instant): GuardState {
    return {
      startedAt: at,
      turns: 0,
      tokens: TokenCount.zero,
      spent: Usd.zero,
      toolCalls: 0,
      repeats: new Map(),
      stopped: null,
    };
  },
} as const;

export function repeatKey(tool: ToolName, fingerprint: Fingerprint): string {
  return `${tool}\u001f${fingerprint}`;
}

// ---------------------------------------------------------------- transitions

type Step = readonly [GuardState, Decision];

function stop(state: GuardState, decision: StopRun): Step {
  return [{ ...state, stopped: decision }, decision];
}

function checkTotals(state: GuardState, at: Instant, limits: Limits): StopRun | null {
  if (Instant.since(at, state.startedAt) > limits.maxWallTime) {
    return stopRun("wall_clock", `exceeded ${DurationMs.format(limits.maxWallTime)}`);
  }
  if (state.tokens >= limits.maxTotalTokens) {
    return stopRun("token_limit", `used ${state.tokens} tokens`);
  }
  if (state.spent >= limits.maxUsd) {
    return stopRun("budget", `spent ${Usd.format(state.spent)} of ${Usd.format(limits.maxUsd)}`);
  }
  return null;
}

function settle(state: GuardState, at: Instant, limits: Limits): Step {
  const over = checkTotals(state, at, limits);
  return over === null ? [state, CONTINUE] : stop(state, over);
}

/** Apply one event. Once stopped, the guard stays stopped. */
export function step(state: GuardState, event: GuardEvent, limits: Limits, price: ModelPrice): Step {
  if (state.stopped !== null) return [state, state.stopped];

  switch (event.kind) {
    case "kill_switch_observed":
      return stop(state, stopRun("kill_switch", "kill switch is on"));

    case "external_stop_observed":
      return stop(state, stopRun(event.reason, event.detail));

    case "turn_started": {
      const turns = state.turns + 1;
      const next = { ...state, turns };
      if (turns > limits.maxTurns) {
        return stop(next, stopRun("turn_limit", `turn ${turns} > ${limits.maxTurns}`));
      }
      return settle(next, event.at, limits);
    }

    case "model_call_completed": {
      const next = {
        ...state,
        tokens: TokenCount.add(state.tokens, Usage.total(event.usage)),
        spent: Usd.add(state.spent, costOf(event.usage, price)),
      };
      return settle(next, event.at, limits);
    }

    case "tool_requested": {
      const calls = state.toolCalls + 1;
      const key = repeatKey(event.tool, event.fingerprint);
      const seen = (state.repeats.get(key) ?? 0) + 1;
      const repeats = new Map(state.repeats).set(key, seen);
      const next = { ...state, toolCalls: calls, repeats };
      if (calls > limits.maxToolCalls) {
        return stop(next, stopRun("tool_call_limit", `tool call ${calls} > ${limits.maxToolCalls}`));
      }
      if (seen >= limits.repeatThreshold) {
        return stop(
          next,
          stopRun("loop_detected", `${event.tool} called ${seen} times with identical arguments`),
        );
      }
      return settle(next, event.at, limits);
    }

    default:
      return assertNever(event);
  }
}
