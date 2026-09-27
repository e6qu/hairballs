import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  canonicalJson,
  DurationMs,
  FakeClock,
  fingerprintArguments,
  JsonLinesAuditSink,
  killSwitchFrom,
  LOCAL_PRINCIPAL,
  loadAgentConfig,
  loadSettings,
  MemoryAuditSink,
  MessageId,
  parseAgentConfig,
  parseIncoming,
  parseTomlText,
  PrincipalId,
  principalFromHeaders,
  renderAuditEvent,
  renderReply,
  RunGuard,
  SessionId,
  stopRun,
  TokenCount,
  ToolName,
  unwrap,
  Usage,
  Usd,
  ApprovalId,
  type Parsed,
  type ParseError,
} from "../src/index.ts";

const CONFIG = {
  agent: { name: "demo", busy_policy: "steer" },
  model: {
    id: "global.anthropic.claude-sonnet-4-6",
    region: "eu-west-1",
    price: { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: "0.3", cache_write_per_mtok: "3.75" },
  },
  limits: {
    max_turns: 10,
    max_total_tokens: 100000,
    max_usd: "1.00",
    max_wall_seconds: 300,
    max_tool_calls: 3,
    repeat_threshold: 3,
  },
  tools: { allowed: ["calculate", "create_ticket"], approval_required: ["create_ticket"] },
};

const STRANDS_CONFIG = new URL("../../../../generic-agents/strands-sdk/config/agent.toml", import.meta.url);

function errorOf<T>(result: Parsed<T>): ParseError {
  if (result.kind !== "err") throw new Error("expected an error");
  return result.error;
}

test("config env override", () => {
  const cfg = unwrap(parseAgentConfig(CONFIG, { AGENT_MAX_USD: "0.25", AWS_REGION: "us-east-1" }));
  assert.equal(cfg.limits.maxUsd, Usd.of("0.25"));
  assert.equal(cfg.region, "us-east-1");
  assert.equal(cfg.busyPolicy, "steer");
  const model = unwrap(parseAgentConfig(CONFIG, { BEDROCK_MODEL_ID: "eu.anthropic.claude-x", AGENT_MAX_TURNS: "4" }));
  assert.equal(model.modelId, "eu.anthropic.claude-x");
  assert.equal(model.limits.maxTurns, 4);
});

test("config error paths", () => {
  const bad = { ...CONFIG, model: { ...CONFIG.model, region: "moon-1" } };
  assert.equal(errorOf(parseAgentConfig(bad, {})).path, "$.model.region");
  assert.equal(errorOf(parseAgentConfig(CONFIG, { AGENT_MAX_TURNS: "zero" })).path, "$.limits.max_turns");
  const busy = { ...CONFIG, agent: { name: "demo", busy_policy: "panic" } };
  assert.equal(errorOf(parseAgentConfig(busy, {})).message, "$.agent.busy_policy: must be steer, queue or reject");
  const { tools: _, ...noTools } = CONFIG;
  assert.equal(errorOf(parseAgentConfig(noTools, {})).path, "$.tools");
  assert.equal(errorOf(parseAgentConfig([], {})).path, "$");
});

test("config file of the strands variant loads through TOML", () => {
  const cfg = unwrap(loadAgentConfig(STRANDS_CONFIG.pathname, {}));
  assert.equal(cfg.name, "generic_strands");
  assert.equal(cfg.price.cacheWritePerMtok, Usd.of("3.75"));
  assert.equal(cfg.limits.maxWallTime, DurationMs.seconds(300));
  assert.deepEqual(cfg.tools.approvalRequired, ["create_ticket"]);
  assert.equal(errorOf(parseTomlText("[agent\nname=")).path, "$");
});

test("settings load config, approvals and prompt from AGENT_HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "org-agents-"));
  mkdirSync(join(home, "config"));
  mkdirSync(join(home, "prompts"));
  writeFileSync(join(home, "config", "agent.toml"), readFileSync(STRANDS_CONFIG));
  writeFileSync(join(home, "prompts", "system.md"), "You are helpful.\n");
  const settings = unwrap(loadSettings({ AGENT_HOME: home }));
  assert.equal(settings.systemPrompt, "You are helpful.\n");
  assert.equal(settings.approvals.selfApproval, false);
  assert.deepEqual([...settings.approvals.approvers], ["auth0|service-desk-lead"]);
  assert.equal(settings.agent.name, "generic_strands");
});

test("kill switch from env", () => {
  assert.equal(killSwitchFrom({}), false);
  assert.equal(killSwitchFrom({ AGENT_KILL_SWITCH: " ON " }), true);
  assert.equal(killSwitchFrom({ AGENT_KILL_SWITCH: "1" }), true);
  assert.equal(killSwitchFrom({ AGENT_KILL_SWITCH: "no" }), false);
});

test("run guard flow", () => {
  const cfg = unwrap(parseAgentConfig(CONFIG, {}));
  const clock = new FakeClock();
  const audit = new MemoryAuditSink();
  const guard = new RunGuard({ session: SessionId.of("s1"), ...cfg, clock, audit });
  guard.beforeModelCall();
  assert.deepEqual(guard.beforeToolCall(ToolName.of("calculate"), { expression: "1+1" }), { kind: "proceed" });
  assert.equal(guard.beforeToolCall(ToolName.of("create_ticket"), { title: "x" }).kind, "require_approval");
  assert.equal(guard.beforeToolCall(ToolName.of("rm_rf"), {}).kind, "block_tool");
  guard.afterModelCall(Usage.of(TokenCount.of(100), TokenCount.of(10)));
  clock.advance(DurationMs.minutes(10));
  const decision = guard.beforeModelCall();
  assert.equal(decision.kind, "stop");
  if (decision.kind === "stop") assert.equal(decision.reason, "wall_clock");
  guard.beforeModelCall(); // sticky: no second stop event
  guard.finish();
  const stops = audit.events.filter((e) => e.kind === "run_stopped");
  assert.equal(stops.length, 1);
  const [stop] = stops;
  assert.ok(stop !== undefined);
  assert.equal(renderAuditEvent(stop)["reason"], "wall_clock");
  assert.deepEqual(
    audit.events.map((e) => e.kind),
    ["run_started", "tool_decision", "tool_decision", "tool_decision", "usage", "run_stopped", "run_finished"],
  );
  const usage = audit.events.find((e) => e.kind === "usage");
  assert.ok(usage !== undefined);
  assert.deepEqual(renderAuditEvent(usage), {
    audit: true,
    session: "s1",
    at: "2026-01-01T00:00:00+00:00",
    type: "usage",
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    run_usd: "0.000450",
  });
});

test("run guard stops on tool-call limit and kill switch", () => {
  const cfg = unwrap(parseAgentConfig(CONFIG, {}));
  const audit = new MemoryAuditSink();
  let kill = false;
  const guard = new RunGuard({ session: SessionId.of("s2"), ...cfg, clock: new FakeClock(), audit, killSwitch: () => kill });
  for (let i = 0; i < 3; i += 1) guard.beforeToolCall(ToolName.of("calculate"), { expression: String(i) });
  const verdict = guard.beforeToolCall(ToolName.of("calculate"), { expression: "4" });
  assert.equal(verdict.kind, "stop");
  kill = true;
  const guard2 = new RunGuard({ session: SessionId.of("s3"), ...cfg, clock: new FakeClock(), audit, killSwitch: () => kill });
  const decision = guard2.beforeModelCall();
  assert.ok(decision.kind === "stop" && decision.reason === "kill_switch");
});

test("audit json lines match Python's compact, ASCII-only form", () => {
  const lines: string[] = [];
  const sink = new JsonLinesAuditSink({ write: (chunk: string) => lines.push(chunk) });
  sink.emit({
    kind: "tool_decision",
    session: SessionId.of("s1"),
    tool: ToolName.of("calculate"),
    outcome: "denied",
    reason: "nicht erlaubt: é",
    at: new FakeClock().now(),
  });
  assert.deepEqual(lines, [
    '{"audit":true,"session":"s1","at":"2026-01-01T00:00:00+00:00","type":"tool_decision","tool":"calculate","outcome":"denied","reason":"nicht erlaubt: \\u00e9"}\n',
  ]);
});

test("fingerprints are canonical", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(fingerprintArguments({ a: 1, b: 2 }), fingerprintArguments({ b: 2, a: 1 }));
  assert.notEqual(fingerprintArguments({ a: 1 }), fingerprintArguments({ a: 2 }));
  // Same bytes as Python json.dumps(..., sort_keys=True, separators=(",", ":")) for JSON data:
  assert.equal(canonicalJson({ expression: "0.1+0.2", n: "ü" }), '{"expression":"0.1+0.2","n":"\\u00fc"}');
});

function jwt(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.sig`;
}

test("principal from headers", () => {
  assert.equal(unwrap(principalFromHeaders({})), LOCAL_PRINCIPAL);
  assert.equal(unwrap(principalFromHeaders({ Authorization: `Bearer ${jwt({ sub: "auth0|123" })}` })), "auth0|123");
  assert.equal(unwrap(principalFromHeaders({ authorization: `Bearer ${jwt({ sub: "abc@clients" })}` })), "abc@clients");
  assert.equal(unwrap(principalFromHeaders(new Headers({ authorization: `bearer ${jwt({ sub: "u1" })}` }))), "u1");
  assert.equal(errorOf(principalFromHeaders({ Authorization: "Bearer not-a-jwt" })).path, "$.headers.authorization");
  assert.equal(errorOf(principalFromHeaders({ Authorization: `Bearer ${jwt({ aud: "x" })}` })).path, "$.jwt.sub");
  assert.equal(errorOf(principalFromHeaders({ Authorization: "Bearer a.!!!.c" })).path, "$.headers.authorization");
});

test("parse incoming variants", () => {
  const who = LOCAL_PRINCIPAL;
  const chat = unwrap(parseIncoming({ prompt: "hi" }, who, () => MessageId.of("fixed")));
  assert.deepEqual(chat, { kind: "chat_message", messageId: "fixed", sender: who, prompt: "hi" });
  assert.match(unwrap(parseIncoming({ prompt: "hi" }, who)).messageId, /^auto-[0-9a-f-]{36}$/);
  assert.deepEqual(unwrap(parseIncoming({ cancel: true, message_id: "m1" }, who)), {
    kind: "cancel_request",
    messageId: "m1",
    sender: who,
  });
  assert.deepEqual(unwrap(parseIncoming({ approval: { id: "ap1", decision: "APPROVE" }, message_id: "m2" }, who)), {
    kind: "approval_response",
    messageId: "m2",
    sender: who,
    approvalId: "ap1",
    decision: "approve",
  });
  assert.equal(unwrap(parseIncoming({ cancel: false, prompt: "go" }, who)).kind, "chat_message");
  assert.equal(errorOf(parseIncoming({ prompt: 3 }, who)).path, "$.prompt");
  assert.equal(errorOf(parseIncoming({}, who)).path, "$.prompt");
  assert.equal(errorOf(parseIncoming({ approval: { id: "ap1", decision: "maybe" } }, who)).path, "$.approval.decision");
  assert.equal(errorOf(parseIncoming("hi", who)).path, "$");
});

test("replies render to the same JSON as Python", () => {
  assert.deepEqual(renderReply({ kind: "answer", texts: ["a", "b"] }), { status: "completed", answers: ["a", "b"] });
  assert.deepEqual(
    renderReply({
      kind: "approval_requested",
      approvalId: ApprovalId.of("ap1"),
      tool: ToolName.of("create_ticket"),
      reason: "needs approval",
      approvers: new Set([PrincipalId.of("zed"), PrincipalId.of("auth0|lead")]),
    }),
    {
      status: "approval_required",
      approval_id: "ap1",
      tool: "create_ticket",
      reason: "needs approval",
      approvers: ["auth0|lead", "zed"],
    },
  );
  assert.deepEqual(renderReply({ kind: "run_halted", stop: stopRun("budget", "spent $1 of $1"), text: "partial" }), {
    status: "stopped",
    reason: "budget",
    detail: "spent $1 of $1",
    answer: "partial",
  });
  assert.deepEqual(renderReply({ kind: "acknowledged", ack: "queued" }), { status: "queued" });
  assert.deepEqual(renderReply({ kind: "refused", reason: "no" }), { status: "refused", reason: "no" });
});
