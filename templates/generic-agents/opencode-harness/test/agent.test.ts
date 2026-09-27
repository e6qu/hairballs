/**
 * End-to-end tests of the opencode variant: the pinned opencode binary + the org guard plugin +
 * the Python tools MCP server + a scripted fake model (offline, no AWS). Mirrors the reference
 * scenarios of `strands-sdk/tests/test_agent.py`. Skipped when `uv` is not installed.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  approvalResponse,
  CallerToken,
  FakeClock,
  MemoryAuditSink,
  PrincipalId,
  SessionId,
  cancelRequest,
  chatMessage,
  McpClient,
  MessageId,
  Prompt,
  type Reply,
  renderReply,
  ToolName,
  unwrap,
} from "@org/agents";

import { OTHER_PRINCIPAL_REASON } from "../src/core/identity.ts";
import { Registry } from "../src/shell/app.ts";
import type { OpencodeHost } from "../src/shell/opencodeHost.ts";
import { STEER_PREFIX } from "../src/shell/runner.ts";
import { ALICE, BOB, callerOf, hasUv, LEAD, send, settings, World } from "./support/world.ts";

const chat = (text: string, mid = "m1", who: PrincipalId = ALICE) =>
  chatMessage(MessageId.of(mid), who, Prompt.of(text));

function transcript(world: World): string {
  return JSON.stringify(world.model.requests.map((r) => r.messages));
}

function approvalOf(reply: Reply) {
  assert.equal(reply.kind, "approval_requested", JSON.stringify(renderReply(reply)));
  if (reply.kind !== "approval_requested") throw new Error("unreachable");
  return reply;
}

async function ticketText(world: World, id: string): Promise<string> {
  const client = new McpClient({ url: world.mcpUrl, handshake: "none" });
  const result = unwrap(await client.callTool(ToolName.of("get_ticket"), { ticket_id: id }));
  return result.text;
}

describe("opencode harness end to end", { skip: hasUv ? false : "uv is not installed", timeout: 240_000 }, () => {
  const world = new World();

  before(() => world.start(), { timeout: 120_000 });
  after(() => world.stop());

  test("tool use and answer", async () => {
    world.model.script([
      { toolCalls: [{ name: "gw_calculate", args: { expression: "0.1 + 0.2" } }] },
      { text: "The result is 0.3." },
    ]);
    const { runner } = world.thread();
    const reply = await send(runner, chat("what is 0.1 + 0.2?"));
    assert.deepEqual(reply, { kind: "answer", texts: ["The result is 0.3."] });
    assert.equal(world.model.calls, 2);
    // Only the org tools are offered to the model (built-ins are denied and hidden).
    assert.deepEqual(
      [...(world.model.requests[0]?.tools ?? [])].sort(),
      ["gw_calculate", "gw_create_ticket", "gw_get_ticket", "gw_search_knowledge"],
    );
    assert.match(JSON.stringify(world.model.requests[1]?.messages), /0\.1 \+ 0\.2 = 0\.3/);
  });

  test("rejected approval: the tool does not run and the model is told", async () => {
    world.model.script([
      { toolCalls: [{ name: "gw_create_ticket", args: { title: "VPN broken", description: "x" } }] },
      { text: "The ticket was not created." },
    ]);
    const { runner } = world.thread();
    const approval = approvalOf(await send(runner, chat("open a ticket")));
    const reply = await send(runner, approvalResponse(MessageId.of("a1"), LEAD, approval.approvalId, "reject"));
    assert.deepEqual(reply, { kind: "answer", texts: ["The ticket was not created."] });
    assert.match(await ticketText(world, "TCK-000001"), /not found/);
    assert.match(JSON.stringify(world.model.requests.at(-1)?.messages), /rejected by approver/);
  });

  test("ticket requires four-eyes approval, then is created once, requested by the run owner", async () => {
    world.model.script([
      {
        toolCalls: [
          {
            name: "gw_create_ticket",
            // The model tries to choose who asked; the guard overrides it.
            args: {
              title: "VPN broken",
              description: "Cannot connect, contact bob@example.com",
              priority: "high",
              requester_id: "usr_mallory",
              requester_name: "Mallory",
              requester_email: "mallory@evil.example",
            },
          },
        ],
      },
      { text: "Ticket TCK-000001 created." },
    ]);
    const { runner, audit } = world.thread();
    const approval = approvalOf(await send(runner, chat("please open a ticket, VPN is broken")));
    assert.deepEqual([...approval.approvers], [LEAD]); // the requester cannot self-approve
    assert.equal(approval.tool, "create_ticket");
    // Approvers see who asked (PII in the reply only).
    assert.deepEqual(renderReply(approval)["requester"], {
      kind: "user",
      user_id: "usr_alice",
      name: "Alice",
      email: "alice@example.com",
    });

    const self = await send(runner, approvalResponse(MessageId.of("a1"), ALICE, approval.approvalId, "approve"));
    assert.equal(self.kind, "refused");

    const ok = await send(runner, approvalResponse(MessageId.of("a2"), LEAD, approval.approvalId, "approve"));
    assert.deepEqual(ok, { kind: "answer", texts: ["Ticket TCK-000001 created."] });
    const ticket = await ticketText(world, "TCK-000001");
    assert.match(ticket, /VPN broken/);
    assert.match(ticket, /requested by Alice <alice@example\.com> \(usr_alice\)/); // the guard's, not the model's
    assert.doesNotMatch(ticket, /Mallory|mallory/);
    assert.match(await ticketText(world, "TCK-000002"), /not found/); // created exactly once
    assert.ok(audit.events.some((e) => e.kind === "tool_decision" && e.outcome === "needs_approval"));
    // (opencode's transcript keeps the model's own arguments; the MCP call got the guard's
    // requester above. The idempotency key is set by the same Object.assign; its derivation is
    // unit-tested in core.test.ts.)
    // Name and email never reach the audit log.
    const events = JSON.stringify(audit.events);
    for (const pii of ["alice@example.com", "Alice", "mallory"]) assert.ok(!events.includes(pii), `${pii} in audit`);
    // tool.execute.after redacted the tool result before the model saw it.
    const toolResults = JSON.stringify(
      world.model.requests.at(-1)?.messages.filter((m) => (m as { role?: string }).role === "tool"),
    );
    assert.match(toolResults, /\[REDACTED:email\]/);
    assert.doesNotMatch(toolResults, /bob@example\.com/);
  });

  test("the model is told the first name in the first user message only, never in the system prompt", async () => {
    world.model.script([{ text: "Hi Alice." }, { text: "Sure." }]);
    const { runner } = world.thread();
    await send(runner, chat("hello", "m1"));
    await send(runner, chat("and again", "m2"));
    const users = (i: number) =>
      (world.model.requests.at(i)?.messages ?? [])
        .filter((m) => (m as { role?: string }).role === "user")
        .map((m) => JSON.stringify((m as { content?: unknown }).content));
    const first = users(-2);
    assert.equal(first.length, 1);
    assert.match(first[0] ?? "", /\[Context: you are assisting Alice\.\]\\n\\nhello/);
    const second = users(-1);
    assert.equal(second.length, 2);
    assert.doesNotMatch(second[1] ?? "", /assisting/); // same speaker: no second introduction
    for (const request of world.model.requests.slice(-2)) {
      const system = JSON.stringify(request.messages.filter((m) => (m as { role?: string }).role === "system"));
      assert.doesNotMatch(system, /Alice|assisting/);
    }
  });

  test("loop detection stops the run", async () => {
    const same = { toolCalls: [{ name: "gw_search_knowledge", args: { query: "vpn" } }] };
    world.model.script([same, same, same, same, same, { text: "done" }]);
    const { runner, audit } = world.thread();
    const reply = await send(runner, chat("find vpn docs"));
    assert.equal(reply.kind, "run_halted", JSON.stringify(renderReply(reply)));
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "loop_detected");
    assert.ok(audit.events.some((e) => e.kind === "run_stopped"));
    assert.ok(world.model.calls <= 4, `model called ${world.model.calls} times`);
  });

  test("budget stops the run (org pricing from opencode's token counts)", async () => {
    world.model.script([
      // $0.30 of input at $3/MTok > $0.10, under the token limit
      { toolCalls: [{ name: "gw_calculate", args: { expression: "1+1" } }], inputTokens: 100_000, outputTokens: 0 },
      { text: "never reached" },
    ]);
    const { runner } = world.thread({ AGENT_MAX_USD: "0.10" });
    const reply = await send(runner, chat("add"));
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "budget", JSON.stringify(renderReply(reply)));
    assert.equal(renderReply(reply)["status"], "stopped");
    assert.equal(world.model.calls, 1);
  });

  test("kill switch: no model call is made", async () => {
    world.model.script([{ text: "hi" }]);
    const { runner } = world.thread({}, true);
    const reply = await send(runner, chat("hello"));
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "kill_switch", JSON.stringify(renderReply(reply)));
    assert.equal(world.model.calls, 0);
  });

  test("a tool outside the allowlist is blocked", async () => {
    world.model.script([
      { toolCalls: [{ name: "delete_everything", args: {} }] },
      { text: "I cannot do that." },
    ]);
    const { runner, audit } = world.thread();
    assert.deepEqual(await send(runner, chat("delete everything")), { kind: "answer", texts: ["I cannot do that."] });
    assert.ok(
      audit.events.some((e) => e.kind === "tool_decision" && e.tool === "delete_everything" && e.outcome === "denied"),
    );
    assert.match(JSON.stringify(world.model.requests[1]?.messages), /not in the allowlist/);
  });

  test("duplicates are ignored and cancel when idle is refused", async () => {
    world.model.script([{ text: "hello" }]);
    const { runner } = world.thread();
    await send(runner, chat("hi", "m1"));
    assert.deepEqual(await send(runner, chat("hi", "m1")), { kind: "acknowledged", ack: "duplicate" });
    assert.equal((await send(runner, cancelRequest(MessageId.of("c1"), ALICE))).kind, "refused");
  });

  test("steering: a message from the owner mid-run reaches the next model call", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    world.model.script([
      { toolCalls: [{ name: "gw_calculate", args: { expression: "2*3" } }], gate },
      { text: "6, and noted." },
    ]);
    const { runner } = world.thread();
    const running = send(runner, chat("what is 2*3?", "m1"));
    await world.model.received(1);
    assert.deepEqual(await send(runner, chat("also mention the unit", "m2")), { kind: "acknowledged", ack: "steered" });
    release();
    assert.deepEqual(await running, { kind: "answer", texts: ["6, and noted."] });
    assert.match(JSON.stringify(world.model.requests[1]?.messages), /also mention the unit/);
    assert.ok(transcript(world).includes(STEER_PREFIX.slice(1, 20)));
  });

  test("cancel mid-run stops the run", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    world.model.script([{ text: "slow", gate }]);
    const { runner } = world.thread();
    const running = send(runner, chat("take your time", "m1"));
    await world.model.received(1);
    assert.deepEqual(await send(runner, cancelRequest(MessageId.of("c1"), ALICE)), {
      kind: "acknowledged",
      ack: "cancelling",
    });
    const reply = await running;
    release();
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "cancelled", JSON.stringify(renderReply(reply)));
  });

  test("wall clock: the adapter timer aborts a run that takes too long", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    world.model.script([{ text: "too late", gate }]);
    const { runner } = world.thread({ AGENT_MAX_WALL_SECONDS: "1" });
    const reply = await send(runner, chat("hurry"));
    release();
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "wall_clock", JSON.stringify(renderReply(reply)));
  });

  test("identity: opencode is bound to the first prompter's token; another user's prompt is refused", async () => {
    const jwt = (sub: string) =>
      CallerToken.of(`eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`);
    const bob = BOB;
    const started: (CallerToken | null)[] = [];
    const registry = new Registry({
      settings: settings(),
      host: (token): OpencodeHost => {
        started.push(token);
        if (world.host === null) throw new Error("world not started");
        return world.host;
      },
      clock: new FakeClock(),
      audit: new MemoryAuditSink(),
      killSwitch: () => false,
    });
    const session = SessionId.of("thread-identity-000000000000000000000000001");
    const as = (who: PrincipalId) => ({ caller: callerOf(who), callerToken: jwt(who), workloadAccessToken: null });
    world.model.script([{ text: "hello alice" }, { text: "hello again" }]);

    assert.deepEqual(await registry.handle(session, chat("hi", "m1"), as(ALICE)), { kind: "answer", texts: ["hello alice"] });
    assert.deepEqual(started, [jwt(ALICE)]);
    assert.equal(registry.boundPrincipal, ALICE);

    // Bob (same session, or another one in this process) would call the Gateway with Alice's token.
    const refusedReply = await registry.handle(session, chat("me too", "b1", bob), as(bob));
    assert.deepEqual(refusedReply, { kind: "refused", reason: OTHER_PRINCIPAL_REASON });
    assert.doesNotMatch(JSON.stringify(renderReply(refusedReply)), /eyJ/);
    const other = SessionId.of("thread-identity-000000000000000000000000002");
    assert.equal((await registry.handle(other, chat("me too", "b2", bob), as(bob))).kind, "refused");
    assert.equal(world.model.calls, 1);

    // Alice continues; opencode is not restarted.
    assert.deepEqual(await registry.handle(session, chat("again", "m2"), as(ALICE)), { kind: "answer", texts: ["hello again"] });
    assert.equal(started.length, 1);
  });

  test("a provider error fails the run and the next message starts a new run", async () => {
    world.model.script([{ httpError: { status: 400, message: "model is not available" } }, { text: "back again" }]);
    const { runner } = world.thread();
    const first = await send(runner, chat("hello", "m1"));
    assert.equal(renderReply(first)["status"], "failed", JSON.stringify(renderReply(first)));
    assert.equal(runner.state.status.kind, "idle");
    assert.deepEqual(await send(runner, chat("hello again", "m2")), { kind: "answer", texts: ["back again"] });
  });
});
