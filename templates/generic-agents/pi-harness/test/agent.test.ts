/**
 * End-to-end tests of the pi agent with a scripted fake model (pi-ai faux provider): the same
 * scenarios as the reference variant (strands-sdk/tests/test_agent.py). Offline: no AWS, no
 * real model. Tests that execute tools start the Python tools MCP server (skipped without `uv`).
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  approvalResponse,
  cancelRequest,
  McpClient,
  MessageId,
  type Reply,
  renderReply,
  ToolName,
  unwrap,
} from "@org/agents";

import { ALICE, BOB, chat, HAS_UV, LEAD, makeRunner, startToolsServer, type ToolsServer } from "./support.ts";

const needsTools = { skip: HAS_UV ? false : "uv is not installed (tools MCP server)" } as const;

function withToolsServer(): { url: () => string; client: () => McpClient } {
  let server: ToolsServer | null = null;
  before(async () => {
    server = await startToolsServer();
  });
  after(async () => {
    await server?.stop();
  });
  const url = (): string => {
    if (server === null) throw new Error("tools server not started");
    return server.url;
  };
  return { url, client: () => new McpClient({ url: url() }) };
}

async function ticketText(client: McpClient, id: string): Promise<string> {
  const result = unwrap(await client.callTool(ToolName.of("get_ticket"), { ticket_id: id }));
  return result.text;
}

function approvalOf(reply: Reply) {
  assert.equal(reply.kind, "approval_requested", JSON.stringify(renderReply(reply)));
  if (reply.kind !== "approval_requested") throw new Error("unreachable");
  return reply;
}

describe("tool use", needsTools, () => {
  const tools = withToolsServer();

  test("tool use and answer", async () => {
    const { runner, model } = await makeRunner({
      caller: tools.client(),
      turns: [{ tools: [["calculate", { expression: "0.1 + 0.2" }]] }, { text: "The result is 0.3." }],
    });
    const reply = await runner.handle(chat("what is 0.1 + 0.2?"));
    assert.deepEqual(renderReply(reply), { status: "completed", answers: ["The result is 0.3."] });
    assert.match(model.seen[1] ?? "", /0\.1 \+ 0\.2 = 0\.3/);
  });

  test("loop detection stops the run", async () => {
    const same = { tools: [["search_knowledge", { query: "vpn" }]] } as const;
    const { runner, audit } = await makeRunner({
      caller: tools.client(),
      turns: [same, same, same, same, same, { text: "done" }],
    });
    const reply = await runner.handle(chat("find vpn docs"));
    assert.equal(reply.kind, "run_halted");
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "loop_detected");
    assert.ok(audit.events.some((e) => e.kind === "run_stopped"));
  });

  test("the pi tools match the MCP server's tools", async () => {
    const { runner } = await makeRunner({ turns: [] });
    const listed = unwrap(await tools.client().listTools());
    assert.deepEqual([...runner.activeToolNames()].sort(), listed.map((t) => t.name).sort());
  });
});

describe("four-eyes approval", needsTools, () => {
  const tools = withToolsServer();

  test("ticket requires four-eyes approval, then is created once", async () => {
    const { runner, model } = await makeRunner({
      caller: tools.client(),
      turns: [
        { tools: [["create_ticket", { title: "VPN broken", description: "Cannot connect", priority: "high" }]] },
        { text: "Ticket TCK-000001 created." },
      ],
    });
    const requested = approvalOf(await runner.handle(chat("please open a ticket, VPN is broken")));
    assert.deepEqual([...requested.approvers], [LEAD]); // the requester cannot self-approve
    assert.equal(model.calls, 1); // the held call ended the turn: no extra model call
    assert.match(await ticketText(tools.client(), "TCK-000001"), /not found/);

    const self = await runner.handle(approvalResponse(MessageId.of("a1"), ALICE, requested.approvalId, "approve"));
    assert.equal(self.kind, "refused");

    const ok = await runner.handle(approvalResponse(MessageId.of("a2"), LEAD, requested.approvalId, "approve"));
    assert.deepEqual(renderReply(ok), { status: "completed", answers: ["Ticket TCK-000001 created."] });
    const ticket = await ticketText(tools.client(), "TCK-000001");
    assert.match(ticket, /requested by auth0\|alice/); // set by the harness, not the model
    assert.match(model.seen[1] ?? "", /approved the create_ticket call/);

    // Redelivery of the approval is a duplicate; nothing is created twice.
    const again = await runner.handle(approvalResponse(MessageId.of("a2"), LEAD, requested.approvalId, "approve"));
    assert.deepEqual(renderReply(again), { status: "duplicate" });
    assert.match(await ticketText(tools.client(), "TCK-000002"), /not found/);
  });
});

describe("rejected approval", needsTools, () => {
  const tools = withToolsServer();

  test("rejected approval cancels the tool call", async () => {
    const { runner, model } = await makeRunner({
      caller: tools.client(),
      turns: [
        { tools: [["create_ticket", { title: "VPN broken", description: "x" }]] },
        { text: "The ticket was not created." },
      ],
    });
    const requested = approvalOf(await runner.handle(chat("open a ticket")));
    const reply = await runner.handle(approvalResponse(MessageId.of("a1"), LEAD, requested.approvalId, "reject"));
    assert.deepEqual(renderReply(reply), { status: "completed", answers: ["The ticket was not created."] });
    assert.match(await ticketText(tools.client(), "TCK-000001"), /not found/);
    assert.match(model.seen.at(-1) ?? "", /rejected by approver/);
  });
});

describe("limits and policy (no tools executed)", () => {
  test("only the org tools are offered: pi's built-in read/bash/edit/write are off", async () => {
    const { runner } = await makeRunner({ turns: [] });
    assert.deepEqual([...runner.activeToolNames()].sort(), ["calculate", "create_ticket", "get_ticket", "search_knowledge"]);
  });

  test("budget stops the run", async () => {
    const { runner } = await makeRunner({
      env: { AGENT_MAX_USD: "0.10" },
      // 100k input tokens at $3/Mtok = $0.30 > $0.10, under the 200k token limit.
      turns: [{ tools: [["calculate", { expression: "1+1" }]], usage: { input: 100_000, output: 0 } }, { text: "never reached" }],
    });
    const reply = await runner.handle(chat("add"));
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "budget");
    assert.equal(renderReply(reply)["status"], "stopped");
  });

  test("kill switch stops the run before any model call", async () => {
    const { runner, model } = await makeRunner({ kill: true, turns: [{ text: "hi" }] });
    const reply = await runner.handle(chat("hello"));
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "kill_switch");
    assert.equal(model.calls, 0);
  });

  test("a tool that is not registered is blocked", async () => {
    const { runner, model } = await makeRunner({
      turns: [{ tools: [["delete_everything", {}]] }, { text: "I cannot do that." }],
    });
    assert.deepEqual(renderReply(await runner.handle(chat("delete everything"))), {
      status: "completed",
      answers: ["I cannot do that."],
    });
    assert.match(model.seen[1] ?? "", /delete_everything not found/);
  });

  test("tool output is redacted before the model (and the transcript) sees it", async () => {
    const leaky = {
      callTool: async () => ({ kind: "ok" as const, value: { kind: "ok" as const, text: "owner jane.doe@example.com key AKIAABCDEFGHIJKLMNOP" } }),
    };
    const { runner, model } = await makeRunner({
      caller: leaky,
      turns: [{ tools: [["get_ticket", { ticket_id: "TCK-000001" }]] }, { text: "done" }],
    });
    await runner.handle(chat("show ticket"));
    assert.doesNotMatch(model.seen[1] ?? "", /jane\.doe@example\.com|AKIAABCDEFGHIJKLMNOP/);
    assert.match(model.seen[1] ?? "", /owner .*key /);
  });

  test("duplicate message and cancel while idle", async () => {
    const { runner } = await makeRunner({ turns: [{ text: "hello" }] });
    await runner.handle(chat("hi", "m1"));
    assert.deepEqual(renderReply(await runner.handle(chat("hi", "m1"))), { status: "duplicate" });
    assert.equal((await runner.handle(cancelRequest(MessageId.of("c1"), ALICE))).kind, "refused");
  });

  test("a provider error fails the run; the next message starts a new run", async () => {
    const { runner } = await makeRunner({
      turns: [{ error: "400 ValidationException: malformed request" }, { text: "hello again" }],
    });
    const failed = await runner.handle(chat("hi", "m1"));
    assert.equal(renderReply(failed)["status"], "failed");
    assert.equal(runner.state.status.kind, "idle");
    assert.deepEqual(renderReply(await runner.handle(chat("hi again", "m2"))), {
      status: "completed",
      answers: ["hello again"],
    });
  });

  test("a guardrail intervention is a policy stop, not a failure", async () => {
    const { runner } = await makeRunner({ turns: [{ error: "Provider stopped with: guardrail_intervened" }] });
    const reply = await runner.handle(chat("something disallowed"));
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "framework_limit");
  });
});

describe("messages mid-run", () => {
  test("the owner's message is steered into the run before the next model call", async () => {
    let steered: Reply | null = null;
    const harness = await makeRunner({
      turns: [
        {
          tools: [["calculate", { expression: "2*3" }]],
          onCall: async () => {
            steered = await harness.runner.handle(chat("also mention the unit", "m2"));
          },
        },
        { text: "6, and noted." },
      ],
    });
    const reply = await harness.runner.handle(chat("what is 2*3?", "m1"));
    assert.deepEqual(steered === null ? null : renderReply(steered), { status: "steered" });
    assert.deepEqual(renderReply(reply), { status: "completed", answers: ["6, and noted."] });
    assert.doesNotMatch(harness.model.seen[0] ?? "", /also mention the unit/);
    assert.match(harness.model.seen[1] ?? "", /also mention the unit/);
  });

  test("another user's message is queued and runs afterwards on their behalf", async () => {
    let queued: Reply | null = null;
    const harness = await makeRunner({
      turns: [
        {
          text: "first answer",
          onCall: async () => {
            queued = await harness.runner.handle(chat("my question", "b1", BOB));
          },
        },
        { text: "answer for bob" },
      ],
    });
    const reply = await harness.runner.handle(chat("alice's question", "a1"));
    assert.deepEqual(queued === null ? null : renderReply(queued), { status: "queued" });
    assert.deepEqual(renderReply(reply), { status: "completed", answers: ["first answer", "answer for bob"] });
  });

  test("cancel from the owner stops the run", async () => {
    let cancelling: Reply | null = null;
    const harness = await makeRunner({
      turns: [
        {
          tools: [["calculate", { expression: "1+1" }]],
          onCall: async () => {
            cancelling = await harness.runner.handle(cancelRequest(MessageId.of("c1"), ALICE));
          },
        },
        { text: "never reached" },
      ],
    });
    const reply = await harness.runner.handle(chat("add", "m1"));
    assert.deepEqual(cancelling === null ? null : renderReply(cancelling), { status: "cancelling" });
    assert.equal(reply.kind === "run_halted" && reply.stop.reason, "cancelled");
    assert.equal(harness.model.calls, 1);
  });
});
