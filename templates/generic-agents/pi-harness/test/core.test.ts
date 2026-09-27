/** Pure core: plain unit tests, no fakes, no I/O. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DurationMs,
  Instant,
  type ModelPrice,
  PrincipalId,
  Prompt,
  SessionId,
  stopRun,
  ToolName,
  Usd,
  unwrap,
} from "@org/agents";

import {
  approvalGrantedPrompt,
  approvalIdFor,
  approvalRejectedPrompt,
  type PendingApproval,
  pendingApprovalNotice,
} from "../src/core/approval.ts";
import { refreshDelay } from "../src/core/credentials.ts";
import { Guardrail, ToolCallId } from "../src/core/domain.ts";
import { gateTool } from "../src/core/gate.ts";
import { decideOutcome, guardrailStop } from "../src/core/outcome.ts";
import { piCost } from "../src/core/pricing.ts";
import { STEER_PREFIX, steeringText } from "../src/core/steering.ts";

const SESSION = SessionId.of("thread-1-00000000000000000000000000");
const CALL = unwrap(ToolCallId.parse("tooluse_abc"));
const pending: PendingApproval = {
  approvalId: approvalIdFor(SESSION, CALL),
  tool: ToolName.of("create_ticket"),
  toolCallId: CALL,
  arguments: { title: "VPN" },
  reason: "tool 'create_ticket' changes external state and needs approval",
};

describe("gateTool", () => {
  test("proceed runs, unless an approval is already pending in the turn", () => {
    assert.deepEqual(gateTool({ kind: "proceed" }, false), { kind: "run" });
    const deferred = gateTool({ kind: "proceed" }, true);
    assert.equal(deferred.kind === "block" && deferred.terminate, true);
  });

  test("a blocked tool does not end the turn by itself", () => {
    assert.deepEqual(gateTool({ kind: "block_tool", reason: "not allowed" }, false), {
      kind: "block",
      reason: "blocked: not allowed",
      terminate: false,
      abort: false,
    });
  });

  test("approval holds the call; a second one in the same turn is deferred", () => {
    assert.deepEqual(gateTool({ kind: "require_approval", reason: "r" }, false), { kind: "hold_for_approval", reason: "r" });
    assert.equal(gateTool({ kind: "require_approval", reason: "r" }, true).kind, "block");
  });

  test("a guard stop blocks, terminates and aborts", () => {
    const gate = gateTool(stopRun("loop_detected", "x"), false);
    assert.deepEqual(gate, { kind: "block", reason: "run stopped (loop_detected): x", terminate: true, abort: true });
  });
});

describe("decideOutcome", () => {
  test("a guard stop wins over everything", () => {
    const stop = stopRun("budget", "spent");
    const outcome = decideOutcome({ stopped: stop, pendingApproval: pending, final: { kind: "text", text: "partial" } });
    assert.deepEqual(outcome, { kind: "stopped", stop, text: "partial" });
  });

  test("a pending approval asks for approval", () => {
    const outcome = decideOutcome({ stopped: null, pendingApproval: pending, final: { kind: "text", text: "" } });
    assert.equal(outcome.kind, "approval_needed");
  });

  test("text completes, errors fail, guardrail interventions stop", () => {
    assert.deepEqual(decideOutcome({ stopped: null, pendingApproval: null, final: { kind: "text", text: "hi" } }), {
      kind: "completed",
      text: "hi",
    });
    assert.deepEqual(decideOutcome({ stopped: null, pendingApproval: null, final: { kind: "error", message: "boom" } }), {
      kind: "failed",
      error: "boom",
    });
    const guardrail = decideOutcome({
      stopped: null,
      pendingApproval: null,
      final: { kind: "error", message: "Provider stopped with: guardrail_intervened" },
    });
    assert.deepEqual(guardrail, { kind: "stopped", stop: guardrailStop, text: "" });
    assert.equal(decideOutcome({ stopped: null, pendingApproval: null, final: null }).kind, "failed");
  });
});

describe("approval", () => {
  test("approval ids are deterministic per session and tool call", () => {
    assert.equal(approvalIdFor(SESSION, CALL), pending.approvalId);
    assert.notEqual(approvalIdFor(SessionId.of("thread-2-00000000000000000000000000"), CALL), pending.approvalId);
    assert.match(pending.approvalId, /^appr-[0-9a-f]{24}$/);
  });

  test("the model is told what happened", () => {
    assert.match(pendingApprovalNotice(pending), new RegExp(pending.approvalId));
    const lead = PrincipalId.of("auth0|lead");
    assert.match(approvalGrantedPrompt(pending, lead, { kind: "ok", text: "TCK-000001" }), /approved.*\n.*TCK-000001/s);
    assert.match(approvalRejectedPrompt(pending, lead), /rejected by approver auth0\|lead/);
  });
});

describe("small helpers", () => {
  test("credentials refresh 5 minutes before expiry, at least after a minute", () => {
    const now = Instant.of(0);
    assert.equal(refreshDelay(Instant.of(60 * 60_000), now), DurationMs.of(55 * 60_000));
    assert.equal(refreshDelay(Instant.of(2 * 60_000), now), DurationMs.of(60_000));
    assert.equal(refreshDelay(null, now), DurationMs.of(10 * 60_000));
  });

  test("pi cost is USD per Mtok from the exact configured price", () => {
    const price: ModelPrice = {
      inputPerMtok: Usd.of("3.00"),
      outputPerMtok: Usd.of("15"),
      cacheReadPerMtok: Usd.of("0.30"),
      cacheWritePerMtok: Usd.of("3.75"),
    };
    assert.deepEqual(piCost(price), { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
  });

  test("steering text is marked as an interjection", () => {
    assert.equal(steeringText(Prompt.of("x")), `${STEER_PREFIX} x`);
  });

  test("guardrail config is parsed from the environment", () => {
    assert.deepEqual(Guardrail.fromEnv({}), { kind: "ok", value: null });
    assert.deepEqual(Guardrail.fromEnv({ GUARDRAIL_ID: "gr-123", GUARDRAIL_VERSION: "2" }), {
      kind: "ok",
      value: { id: "gr-123", version: "2" },
    });
    assert.equal(Guardrail.fromEnv({ GUARDRAIL_ID: "gr-123" }).kind, "err");
  });
});
