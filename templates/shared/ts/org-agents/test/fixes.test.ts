// Parity tests for the shared fixes: failed runs, cancel while awaiting approval, external stops.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalNeeded,
  ApprovalId,
  type ApprovalPolicy,
  cancelRequest,
  chatMessage,
  failed,
  FakeClock,
  finish,
  MemoryAuditSink,
  MessageId,
  PrincipalId,
  Prompt,
  receive,
  RunGuard,
  SessionId,
  ThreadState,
  ToolName,
} from "../src/index.ts";
import { parseAgentConfig } from "../src/shell/config.ts";
import { unwrap } from "../src/result.ts";

const ALICE = PrincipalId.of("alice");
const LEAD = PrincipalId.of("lead");
const POLICY: ApprovalPolicy = { selfApproval: false, approvers: new Set([LEAD, ALICE]) };

test("failed run returns the thread to idle and later messages start a new run", () => {
  let s = ThreadState.initial();
  [s] = receive(s, chatMessage(MessageId.of("1"), ALICE, Prompt.of("a")), "steer");
  const [idle, reply] = finish(s, failed("ThrottlingException"), ALICE, POLICY);
  assert.deepEqual(reply, { kind: "run_failed", error: "ThrottlingException" });
  assert.equal(idle.status.kind, "idle");
  const [, action] = receive(idle, chatMessage(MessageId.of("2"), ALICE, Prompt.of("b")), "steer");
  assert.equal(action.kind, "start_run");
});

test("cancel while awaiting approval goes idle", () => {
  let s = ThreadState.initial();
  [s] = receive(s, chatMessage(MessageId.of("1"), ALICE, Prompt.of("a")), "steer");
  [s] = finish(s, approvalNeeded(ApprovalId.of("ap"), ToolName.of("create_ticket"), "x"), ALICE, POLICY);
  const [after, action] = receive(s, cancelRequest(MessageId.of("2"), ALICE), "steer");
  assert.equal(action.kind, "cancel_run");
  assert.equal(after.status.kind, "idle");
});

test("external stop is sticky, audited once; failure is audited", () => {
  const cfg = unwrap(
    parseAgentConfig(
      {
        agent: { name: "demo" },
        model: {
          id: "global.anthropic.claude-sonnet-4-6",
          region: "eu-west-1",
          price: { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: "0.3", cache_write_per_mtok: "3.75" },
        },
        limits: { max_turns: 10, max_total_tokens: 100000, max_usd: "1.00", max_wall_seconds: 300, max_tool_calls: 3, repeat_threshold: 3 },
        tools: { allowed: ["calculate"] },
      },
      {},
    ),
  );
  const audit = new MemoryAuditSink();
  const guard = new RunGuard({ session: SessionId.of("s1"), limits: cfg.limits, price: cfg.price, tools: cfg.tools, clock: new FakeClock(), audit });
  const stop = guard.recordExternalStop("cancelled", "cancelled by owner");
  assert.equal(stop.reason, "cancelled");
  assert.equal(guard.beforeModelCall().kind, "stop");
  guard.fail("boom");
  assert.equal(audit.events.filter((e) => e.kind === "run_stopped").length, 1);
  assert.ok(audit.events.some((e) => e.kind === "run_failed"));
});
