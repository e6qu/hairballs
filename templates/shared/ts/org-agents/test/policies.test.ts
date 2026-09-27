import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalResponse,
  ApprovalId,
  awaitingApproval,
  cancelRequest,
  chatMessage,
  decideTool,
  Fingerprint,
  IDLE,
  idempotencyKey,
  MessageId,
  onMessage,
  PrincipalId,
  Prompt,
  redact,
  running,
  SessionId,
  ToolName,
  ToolPattern,
  type ToolPolicy,
} from "../src/index.ts";

const ALICE = PrincipalId.of("alice");
const BOB = PrincipalId.of("bob");
const P = Prompt.of("hello");

const chat = (mid: string, who = ALICE) => chatMessage(MessageId.of(mid), who, P);

test("message policy", () => {
  const seen = new Set([MessageId.of("m0")]);
  assert.deepEqual(onMessage(IDLE, chat("m0"), seen, "steer"), { kind: "ignore_duplicate" });
  assert.deepEqual(onMessage(IDLE, chat("m1"), seen, "steer"), { kind: "start_run", prompt: P });
  assert.deepEqual(onMessage(running(ALICE), chat("m1"), seen, "steer"), { kind: "steer", prompt: P });
  assert.deepEqual(onMessage(running(ALICE), chat("m1"), seen, "queue"), { kind: "queue_follow_up", prompt: P });
  assert.deepEqual(onMessage(running(ALICE), chat("m1"), seen, "reject"), {
    kind: "reject",
    reason: "the agent is busy with this thread",
  });
  assert.deepEqual(onMessage(running(ALICE), chat("m1", BOB), seen, "steer"), { kind: "queue_follow_up", prompt: P });
  assert.deepEqual(onMessage(running(ALICE), cancelRequest(MessageId.of("c"), ALICE), seen, "steer"), {
    kind: "cancel_run",
  });
  assert.equal(onMessage(running(ALICE), cancelRequest(MessageId.of("c"), BOB), seen, "steer").kind, "reject");
  assert.deepEqual(onMessage(IDLE, cancelRequest(MessageId.of("c"), ALICE), seen, "steer"), {
    kind: "reject",
    reason: "nothing to cancel",
  });
});

test("approval only from approver", () => {
  const aid = ApprovalId.of("ap-1");
  const status = awaitingApproval(ALICE, aid, new Set([BOB]));
  const ok = approvalResponse(MessageId.of("a1"), BOB, aid, "approve");
  assert.deepEqual(onMessage(status, ok, new Set(), "steer"), {
    kind: "deliver_approval",
    approvalId: aid,
    decision: "approve",
    approver: BOB,
  });
  const selfApprove = approvalResponse(MessageId.of("a2"), ALICE, aid, "approve");
  assert.equal(onMessage(status, selfApprove, new Set(), "steer").kind, "reject");
  const wrongId = approvalResponse(MessageId.of("a3"), BOB, ApprovalId.of("other"), "approve");
  assert.deepEqual(onMessage(status, wrongId, new Set(), "steer"), {
    kind: "reject",
    reason: "approval id does not match the pending request",
  });
  assert.deepEqual(onMessage(IDLE, ok, new Set(), "steer"), { kind: "reject", reason: "no approval is pending" });
  assert.deepEqual(onMessage(status, chat("m9"), new Set(), "steer"), { kind: "queue_follow_up", prompt: P });
});

test("tool policy", () => {
  const policy: ToolPolicy = {
    allowed: [ToolPattern.of("calculate"), ToolPattern.of("create_*")],
    approvalRequired: [ToolPattern.of("create_*")],
  };
  assert.deepEqual(decideTool(ToolName.of("calculate"), policy), { kind: "allowed" });
  assert.deepEqual(decideTool(ToolName.of("create_ticket"), policy), {
    kind: "needs_approval",
    reason: "tool 'create_ticket' changes external state and needs approval",
  });
  assert.deepEqual(decideTool(ToolName.of("delete_all"), policy), {
    kind: "denied",
    reason: "tool 'delete_all' is not in the allowlist",
  });
});

test("redaction", () => {
  const text =
    "card 4111 1111 1111 1111, iban GB82 WEST 1234 5698 7654 32, mail a.b@example.com, key AKIAABCDEFGHIJKLMNOP, id 1234567890123";
  const result = redact(text);
  assert.ok(!result.text.includes("4111") && !result.text.includes("GB82"));
  assert.equal(result.findings.get("card_number"), 1);
  assert.equal(result.findings.get("iban"), 1);
  assert.equal(result.findings.get("email"), 1);
  assert.equal(result.findings.get("aws_access_key"), 1);
  assert.ok(result.text.includes("1234567890123")); // fails Luhn → not a card number
  assert.ok(result.changed);
  assert.equal(
    result.text,
    "card [REDACTED:card_number], iban [REDACTED:iban], mail [REDACTED:email], key [REDACTED:aws_access_key], id 1234567890123",
  );
});

test("redaction of bearer tokens; invalid IBAN checksum is kept; clean text unchanged", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdXRoMHwxMjMifQ.c2lnbmF0dXJlLXZhbHVl";
  assert.equal(redact(`Authorization: Bearer ${jwt}`).text, "Authorization: Bearer [REDACTED:bearer_token]");
  assert.equal(redact("GB00 WEST 1234 5698 7654 32").findings.get("iban"), undefined);
  const clean = redact("nothing to see here");
  assert.equal(clean.changed, false);
  assert.equal(clean.text, "nothing to see here");
});

test("idempotency key is stable", () => {
  const fp = Fingerprint.of("b".repeat(64));
  const k1 = idempotencyKey(SessionId.of("s1"), ToolName.of("create_ticket"), fp);
  assert.equal(k1, idempotencyKey(SessionId.of("s1"), ToolName.of("create_ticket"), fp));
  assert.notEqual(k1, idempotencyKey(SessionId.of("s2"), ToolName.of("create_ticket"), fp));
  assert.match(k1, /^idem-[0-9a-f]{32}$/);
});
