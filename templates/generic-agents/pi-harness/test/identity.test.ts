/**
 * Caller identity → AgentCore Gateway: every tool call carries the run owner's Auth0 JWT as
 * `Authorization: Bearer …` (a fake MCP endpoint captures the headers), and the token never
 * appears in replies, audit events, the model's context or the logs.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  approvalResponse,
  CallerToken,
  type InvocationContext,
  MessageId,
  type Reply,
  renderAuditEvent,
  renderReply,
  type RunningAgentCoreServer,
  startAgentCoreServer,
  ToolName,
} from "@org/agents";

import { invocationHandler, Registry } from "../src/shell/app.ts";
import { McpToolGateway } from "../src/shell/tools.ts";
import { ALICE, BOB, chat, type FakeMcpServer, LEAD, makeRunner, startFakeMcpServer, testJwt, testRunnerOptions } from "./support.ts";

const ALICE_JWT = testJwt({ sub: ALICE });
const BOB_JWT = testJwt({ sub: BOB });
const LEAD_JWT = testJwt({ sub: LEAD });
const as = (jwt: string): InvocationContext => ({ callerToken: CallerToken.of(jwt), workloadAccessToken: null });
const toolCalls = (mcp: FakeMcpServer) =>
  mcp.seen.filter((r) => r.method === "tools/call").map((r) => [(r.params as { name: string }).name, r.authorization]);

/** Everything the harness wrote or returned, to check no token leaked into it. */
function assertNoTokens(texts: readonly string[]): void {
  for (const text of texts) {
    for (const jwt of [ALICE_JWT, BOB_JWT, LEAD_JWT]) {
      assert.ok(!text.includes(jwt) && !text.includes(jwt.split(".")[2] ?? jwt), `token leaked into: ${text.slice(0, 200)}`);
    }
  }
}

/** Capture console output while `body` runs (the harness must not log tokens). */
async function captureConsole<T>(body: () => Promise<T>): Promise<readonly [T, string[]]> {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const sink = (...args: unknown[]): void => void lines.push(args.map(String).join(" "));
  Object.assign(console, { log: sink, error: sink, warn: sink, info: sink });
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (writeOut as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    return [await body(), lines];
  } finally {
    Object.assign(console, saved);
    process.stdout.write = writeOut;
  }
}

describe("caller identity reaches the Gateway", () => {
  let mcp: FakeMcpServer;
  before(async () => {
    mcp = await startFakeMcpServer();
  });
  after(async () => {
    await mcp.stop();
  });

  test("McpToolGateway: one MCP client per token, Authorization only when there is a token", async () => {
    mcp.reset();
    const gateway = new McpToolGateway({ url: mcp.url, clientInfo: { name: "t", version: "0" } });
    await gateway.callTool(ToolName.of("calculate"), { expression: "1" }, CallerToken.of(ALICE_JWT));
    await gateway.callTool(ToolName.of("calculate"), { expression: "2" }, CallerToken.of(BOB_JWT));
    await gateway.callTool(ToolName.of("calculate"), { expression: "3" }, CallerToken.of(ALICE_JWT));
    await gateway.callTool(ToolName.of("calculate"), { expression: "4" }, null);
    assert.deepEqual(
      mcp.seen.map((r) => [r.method, r.authorization]),
      [
        ["initialize", `Bearer ${ALICE_JWT}`],
        ["notifications/initialized", `Bearer ${ALICE_JWT}`],
        ["tools/call", `Bearer ${ALICE_JWT}`],
        ["initialize", `Bearer ${BOB_JWT}`],
        ["notifications/initialized", `Bearer ${BOB_JWT}`],
        ["tools/call", `Bearer ${BOB_JWT}`],
        ["tools/call", `Bearer ${ALICE_JWT}`], // Alice's client (and MCP session) is reused
        ["initialize", null],
        ["notifications/initialized", null],
        ["tools/call", null],
      ],
    );
  });

  test("each run uses its owner's token; a queued follow-up uses its sender's token", async () => {
    mcp.reset();
    let queued: Reply | null = null;
    const [[reply, audit, model], logs] = await captureConsole(async () => {
      const harness = await makeRunner({
        caller: new McpToolGateway({ url: mcp.url, clientInfo: { name: "t", version: "0" } }),
        turns: [
          {
            tools: [["calculate", { expression: "1+1" }]],
            onCall: async () => {
              queued = await harness.runner.handle(chat("bob's question", "b1", BOB), as(BOB_JWT));
            },
          },
          { text: "2" },
          { tools: [["search_knowledge", { query: "vpn" }]] },
          { text: "vpn docs" },
        ],
      });
      const reply = await harness.runner.handle(chat("alice's question", "a1"), as(ALICE_JWT));
      return [reply, harness.audit, harness.model] as const;
    });
    assert.deepEqual(queued === null ? null : renderReply(queued), { status: "queued" });
    assert.deepEqual(renderReply(reply), { status: "completed", answers: ["2", "vpn docs"] });
    assert.deepEqual(toolCalls(mcp), [
      ["calculate", `Bearer ${ALICE_JWT}`],
      ["search_knowledge", `Bearer ${BOB_JWT}`],
    ]);
    assertNoTokens([
      JSON.stringify(renderReply(reply)),
      ...audit.events.map((e) => JSON.stringify(renderAuditEvent(e))),
      ...model.seen,
      ...logs,
    ]);
  });

  test("an approved call runs with the requester's token, not the approver's", async () => {
    mcp.reset();
    const harness = await makeRunner({
      caller: new McpToolGateway({ url: mcp.url, clientInfo: { name: "t", version: "0" } }),
      turns: [{ tools: [["create_ticket", { title: "VPN", description: "down" }]] }, { text: "created" }],
    });
    const requested = await harness.runner.handle(chat("open a ticket"), as(ALICE_JWT));
    assert.equal(requested.kind, "approval_requested");
    if (requested.kind !== "approval_requested") return;
    assert.deepEqual(toolCalls(mcp), []); // held: nothing reached the Gateway
    const reply = await harness.runner.handle(
      approvalResponse(MessageId.of("a2"), LEAD, requested.approvalId, "approve"),
      as(LEAD_JWT),
    );
    assert.deepEqual(renderReply(reply), { status: "completed", answers: ["created"] });
    assert.deepEqual(toolCalls(mcp), [["create_ticket", `Bearer ${ALICE_JWT}`]]);
    assertNoTokens([JSON.stringify(renderReply(requested)), ...harness.audit.events.map((e) => JSON.stringify(renderAuditEvent(e))), ...harness.model.seen]);
  });

  test("over HTTP: the Authorization header of /invocations is forwarded to the Gateway", async () => {
    mcp.reset();
    const { options } = await testRunnerOptions({
      caller: new McpToolGateway({ url: mcp.url, clientInfo: { name: "t", version: "0" } }),
      turns: [{ tools: [["calculate", { expression: "6*7" }]] }, { text: "42" }],
    });
    const server: RunningAgentCoreServer = await startAgentCoreServer({
      handler: invocationHandler(new Registry(options)),
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.url}/invocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": "thread-identity-00000000000000000000000001",
          authorization: `Bearer ${ALICE_JWT}`,
        },
        body: JSON.stringify({ prompt: "6*7?" }),
      });
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { status: "completed", answers: ["42"] });
      assertNoTokens([text]);
      assert.deepEqual(toolCalls(mcp), [["calculate", `Bearer ${ALICE_JWT}`]]);
    } finally {
      await server.close();
    }
  });
});
