/** Pure tests of the thread state machine (no framework, no fakes). */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalNeeded,
  ApprovalId,
  approvalResponse,
  type ApprovalPolicy,
  chatMessage,
  completed,
  finish,
  mergeAnswers,
  MessageId,
  nextFollowUp,
  PrincipalId,
  Prompt,
  receive,
  running,
  stopped,
  stopRun,
  ThreadState,
  ToolName,
} from "../src/index.ts";

const ALICE = PrincipalId.of("alice");
const BOB = PrincipalId.of("bob");
const LEAD = PrincipalId.of("lead");
const POLICY: ApprovalPolicy = { selfApproval: false, approvers: new Set([LEAD, ALICE]) };

const chat = (mid: string, who: PrincipalId, text: string) => chatMessage(MessageId.of(mid), who, Prompt.of(text));

test("start, queue, finish, follow-up", () => {
  let s = ThreadState.initial();
  [s] = receive(s, chat("1", ALICE, "a"), "steer");
  assert.deepEqual(s.status, running(ALICE));
  let action;
  [s, action] = receive(s, chat("2", BOB, "b"), "steer");
  assert.equal(action.kind, "queue_follow_up");
  let reply;
  [s, reply] = finish(s, completed("done"), ALICE, POLICY);
  assert.deepEqual(reply, { kind: "answer", texts: ["done"] });
  assert.equal(s.status.kind, "idle");
  let queued;
  [s, queued] = nextFollowUp(s);
  assert.ok(queued !== null && queued.sender === BOB && queued.prompt === "b");
  assert.deepEqual(s.status, running(BOB));
  assert.deepEqual(nextFollowUp(s)[1], null);
});

test("approval excludes requester under four eyes, then resumes on approval", () => {
  let s = ThreadState.initial();
  [s] = receive(s, chat("1", ALICE, "a"), "steer");
  const aid = ApprovalId.of("ap");
  let reply;
  [s, reply] = finish(s, approvalNeeded(aid, ToolName.of("create_ticket"), "x"), ALICE, POLICY);
  assert.equal(reply.kind, "approval_requested");
  if (reply.kind === "approval_requested") assert.deepEqual([...reply.approvers], [LEAD]);
  assert.equal(s.status.kind, "awaiting_approval");
  let action;
  [s, action] = receive(s, approvalResponse(MessageId.of("2"), LEAD, aid, "approve"), "steer");
  assert.equal(action.kind, "deliver_approval");
  assert.deepEqual(s.status, running(ALICE));
});

test("self approval policy includes the owner", () => {
  let s = ThreadState.initial();
  [s] = receive(s, chat("1", ALICE, "a"), "steer");
  const [, reply] = finish(s, approvalNeeded(ApprovalId.of("ap"), ToolName.of("t"), "x"), ALICE, {
    selfApproval: true,
    approvers: new Set(),
  });
  assert.ok(reply.kind === "approval_requested" && reply.approvers.has(ALICE));
});

test("stopped run drops follow-ups; duplicates are ignored", () => {
  let s = ThreadState.initial();
  [s] = receive(s, chat("1", ALICE, "a"), "steer");
  [s] = receive(s, chat("2", BOB, "b"), "steer");
  const [, dup] = receive(s, chat("2", BOB, "b"), "steer");
  assert.equal(dup.kind, "ignore_duplicate");
  let reply;
  [s, reply] = finish(s, stopped(stopRun("budget", "spent"), "partial"), ALICE, POLICY);
  assert.deepEqual(reply, { kind: "run_halted", stop: { kind: "stop", reason: "budget", detail: "spent" }, text: "partial" });
  assert.deepEqual(s.followUps, []);
  assert.equal(nextFollowUp(s)[1], null);
});

test("merge answers", () => {
  assert.deepEqual(mergeAnswers({ kind: "answer", texts: ["a"] }, { kind: "answer", texts: ["b"] }), {
    kind: "answer",
    texts: ["a", "b"],
  });
  const refused = { kind: "refused", reason: "no" } as const;
  assert.equal(mergeAnswers({ kind: "answer", texts: ["a"] }, refused), refused);
});
