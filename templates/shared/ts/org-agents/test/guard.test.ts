import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONTINUE,
  costOf,
  DurationMs,
  Fingerprint,
  GuardState,
  Instant,
  killSwitchObserved,
  Limits,
  type ModelPrice,
  modelCallCompleted,
  PositiveInt,
  step,
  TokenCount,
  ToolName,
  toolRequested,
  turnStarted,
  Usage,
  Usd,
  type Decision,
} from "../src/index.ts";

const T0 = Instant.of(Date.UTC(2026, 0, 1));
const PRICE: ModelPrice = {
  inputPerMtok: Usd.of(3),
  outputPerMtok: Usd.of(15),
  cacheReadPerMtok: Usd.of("0.3"),
  cacheWritePerMtok: Usd.of("3.75"),
};
const LIMITS = Limits.of({
  maxTurns: PositiveInt.of(3),
  maxTotalTokens: PositiveInt.of(100_000),
  maxUsd: Usd.of("0.10"),
  maxWallTime: DurationMs.minutes(5),
  maxToolCalls: PositiveInt.of(5),
  repeatThreshold: PositiveInt.of(3),
});
const FP = Fingerprint.of("a".repeat(64));

const at = (seconds: number): Instant => Instant.plus(T0, DurationMs.seconds(seconds));

function assertStop(decision: Decision, reason: string): void {
  assert.equal(decision.kind, "stop");
  if (decision.kind === "stop") assert.equal(decision.reason, reason);
}

test("turn limit", () => {
  let state = GuardState.start(T0);
  for (let i = 0; i < 3; i += 1) {
    const [next, decision] = step(state, turnStarted(at(i)), LIMITS, PRICE);
    assert.deepEqual(decision, CONTINUE);
    state = next;
  }
  const [, decision] = step(state, turnStarted(at(4)), LIMITS, PRICE);
  assertStop(decision, "turn_limit");
  assert.deepEqual(decision, { kind: "stop", reason: "turn_limit", detail: "turn 4 > 3" });
});

test("budget stop uses exact cost", () => {
  const usage = Usage.of(TokenCount.of(10_000), TokenCount.of(5_000)); // 0.03 + 0.075 = 0.105 USD
  const [state, decision] = step(GuardState.start(T0), modelCallCompleted(usage, at(1)), LIMITS, PRICE);
  assertStop(decision, "budget");
  assert.equal(state.spent, Usd.of("0.105"));
  assert.equal(state.tokens, 15_000);
  assert.deepEqual(decision, { kind: "stop", reason: "budget", detail: "spent $0.105 of $0.1" });
});

test("cost is exact and rounds once, half-even", () => {
  const price: ModelPrice = { ...PRICE, inputPerMtok: Usd.of("0.000001") };
  // 1 token × 0.000001 $/Mtok = 1e-12 $ → rounds to 0
  assert.equal(costOf(Usage.of(TokenCount.of(1), TokenCount.zero), price), 0);
  // 3 cache-read tokens at $0.30/Mtok = 0.0000009 → 0.000001 (micro-rounded)
  assert.equal(costOf(Usage.of(TokenCount.zero, TokenCount.zero, TokenCount.of(3)), PRICE), 1);
  // 1_000_000 cache-write tokens at 3.75 → exactly 3.75
  assert.equal(
    costOf(Usage.of(TokenCount.zero, TokenCount.zero, TokenCount.zero, TokenCount.of(1_000_000)), PRICE),
    Usd.of("3.75"),
  );
});

test("token limit", () => {
  const limits = Limits.of({ ...LIMITS, maxUsd: Usd.of(1000), maxTotalTokens: PositiveInt.of(100) });
  const [, decision] = step(
    GuardState.start(T0),
    modelCallCompleted(Usage.of(TokenCount.of(60), TokenCount.of(40)), at(1)),
    limits,
    PRICE,
  );
  assert.deepEqual(decision, { kind: "stop", reason: "token_limit", detail: "used 100 tokens" });
});

test("loop detection on identical calls", () => {
  let state = GuardState.start(T0);
  const tool = ToolName.of("search");
  const decisions: Decision[] = [];
  for (let i = 0; i < 3; i += 1) {
    const [next, decision] = step(state, toolRequested(tool, FP, at(i)), LIMITS, PRICE);
    decisions.push(decision);
    state = next;
  }
  assert.deepEqual(decisions.slice(0, 2), [CONTINUE, CONTINUE]);
  assertStop(decisions[2] ?? CONTINUE, "loop_detected");
  assert.equal(state.toolCalls, 3);
});

test("different arguments are not a loop; tool call limit applies", () => {
  let state = GuardState.start(T0);
  const tool = ToolName.of("search");
  let last: Decision = CONTINUE;
  for (let i = 0; i < 6; i += 1) {
    const fp = Fingerprint.of(String(i).repeat(64));
    [state, last] = step(state, toolRequested(tool, fp, at(i)), LIMITS, PRICE);
    if (i < 5) assert.deepEqual(last, CONTINUE);
  }
  assert.deepEqual(last, { kind: "stop", reason: "tool_call_limit", detail: "tool call 6 > 5" });
});

test("wall clock", () => {
  const [, decision] = step(GuardState.start(T0), turnStarted(at(301)), LIMITS, PRICE);
  assert.deepEqual(decision, { kind: "stop", reason: "wall_clock", detail: "exceeded 0:05:00" });
});

test("stopped is sticky and kill switch", () => {
  const [state, decision] = step(GuardState.start(T0), killSwitchObserved(at(0)), LIMITS, PRICE);
  assertStop(decision, "kill_switch");
  const [after, again] = step(state, turnStarted(at(1)), LIMITS, PRICE);
  assert.deepEqual(again, decision);
  assert.equal(after, state);
});

test("step does not mutate the input state", () => {
  const start = GuardState.start(T0);
  step(start, toolRequested(ToolName.of("x"), FP, at(0)), LIMITS, PRICE);
  assert.equal(start.repeats.size, 0);
  assert.equal(start.toolCalls, 0);
});
