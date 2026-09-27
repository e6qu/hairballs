import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DurationMs,
  Instant,
  Limits,
  ModelId,
  PrincipalId,
  Prompt,
  SessionId,
  ToolName,
  ToolPattern,
  ToolPolicy,
  Usd,
  unwrap,
  type Parsed,
  type ParseError,
} from "../src/index.ts";

const LIMITS_RAW = {
  max_turns: 5,
  max_total_tokens: 1000,
  max_usd: "0.50",
  max_wall_seconds: 60,
  max_tool_calls: 10,
  repeat_threshold: 3,
};

function errorOf<T>(result: Parsed<T>): ParseError {
  assert.equal(result.kind, "err");
  if (result.kind !== "err") throw new Error("expected an error");
  return result.error;
}

test("usd is exact micro-dollars and rejects negative", () => {
  assert.equal(unwrap(Usd.parse("0.1", "$")), 100_000);
  assert.equal(unwrap(Usd.parse(0.1, "$")), 100_000); // number via shortest repr, not binary expansion
  assert.equal(unwrap(Usd.parse("3.75", "$")), 3_750_000);
  assert.equal(unwrap(Usd.parse(1e-7, "$")), 0); // 0.0000001 → 0 (half-even)
  assert.equal(unwrap(Usd.parse("0.0000015", "$")), 2); // half-even: 1.5 → 2
  assert.equal(unwrap(Usd.parse("0.0000025", "$")), 2); // half-even: 2.5 → 2
  assert.equal(unwrap(Usd.parse("1e2", "$")), 100_000_000);
  assert.equal(errorOf(Usd.parse("-1", "$")).detail, "must be >= 0");
  errorOf(Usd.parse(true, "$"));
  errorOf(Usd.parse("abc", "$"));
  errorOf(Usd.parse("NaN", "$"));
  errorOf(Usd.parse(Number.POSITIVE_INFINITY, "$"));
  assert.equal(Usd.toDecimalString(Usd.of("0.105")), "0.105000");
  assert.equal(Usd.format(Usd.of("0.105")), "$0.105");
  assert.equal(Usd.format(Usd.of(1)), "$1");
  assert.equal(Usd.format(Usd.zero), "$0");
});

test("limits parse reports path", () => {
  const error = errorOf(Limits.parse({ ...LIMITS_RAW, max_turns: 0 }));
  assert.equal(error.path, "$.limits.max_turns");
  assert.equal(error.message, "$.limits.max_turns: must be >= 1");
  assert.equal(errorOf(Limits.parse({ ...LIMITS_RAW, repeat_threshold: 1 })).path, "$.limits.repeat_threshold");
  const { max_usd: _, ...missing } = LIMITS_RAW;
  const missingError = errorOf(Limits.parse(missing));
  assert.equal(missingError.path, "$.limits.max_usd");
  assert.equal(missingError.detail, "is required");
});

test("limits parse accepts env strings", () => {
  const limits = unwrap(Limits.parse({ ...LIMITS_RAW, max_turns: "7" }));
  assert.equal(limits.maxTurns, 7);
  assert.equal(limits.maxWallTime, DurationMs.seconds(60));
  assert.equal(limits.maxUsd, 500_000);
});

test("bool is not a count", () => {
  errorOf(Limits.parse({ ...LIMITS_RAW, max_turns: true }));
  errorOf(Limits.parse({ ...LIMITS_RAW, max_turns: 1.5 }));
});

test("prompt rejects blank", () => {
  errorOf(Prompt.parse("   "));
  errorOf(Prompt.parse("x".repeat(Prompt.MAX_CHARS + 1)));
  assert.equal(unwrap(Prompt.parse("  hi  ")), "hi");
  assert.throws(() => Prompt.of(" "));
});

test("tool policy parse and glob", () => {
  const policy = unwrap(ToolPolicy.parse({ allowed: ["gw_*", "calculate"], approval_required: ["gw_pay*"] }));
  const [first] = policy.allowed;
  assert.ok(first !== undefined && ToolPattern.matches(first, ToolName.of("gw_search")));
  assert.ok(!ToolPattern.matches(ToolPattern.of("calculate"), ToolName.of("calculator")));
  assert.ok(ToolPattern.matches(ToolPattern.of("get_?icket"), ToolName.of("get_ticket")));
  assert.ok(!ToolPattern.matches(ToolPattern.of("a.b"), ToolName.of("axb"))); // "." is literal
  assert.equal(errorOf(ToolPolicy.parse({ allowed: ["ok", "bad name"] })).path, "$.tools.allowed[1]");
  assert.deepEqual(unwrap(ToolPolicy.parse({ allowed: [] })).approvalRequired, []);
});

test("model id accepts arn", () => {
  const arn = "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/abc123";
  assert.equal(unwrap(ModelId.parse(arn)), arn);
});

test("identifiers", () => {
  assert.equal(unwrap(PrincipalId.parse("auth0|123")), "auth0|123");
  assert.equal(unwrap(PrincipalId.parse("abc@clients")), "abc@clients");
  errorOf(SessionId.parse("auth0|123")); // '|' only allowed in principals
  assert.equal(errorOf(SessionId.parse(42)).path, "$.session_id");
  assert.throws(() => ToolName.of("1abc"));
});

test("instant and duration rendering match Python", () => {
  const t0 = Instant.of(Date.UTC(2026, 0, 1));
  assert.equal(Instant.toIso(t0), "2026-01-01T00:00:00+00:00");
  assert.equal(Instant.toIso(Instant.of(t0 + 1500)), "2026-01-01T00:00:01.500000+00:00");
  assert.equal(DurationMs.format(DurationMs.minutes(5)), "0:05:00");
  assert.equal(DurationMs.format(DurationMs.seconds(90_061.5)), "1 day, 1:01:01.500000");
  assert.equal(unwrap(Instant.parse("2026-01-01T00:00:00Z", "$.at")), t0);
  errorOf(Instant.parse("2026-01-01T00:00:00", "$.at"));
});
