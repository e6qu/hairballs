/**
 * Caller identity.
 *
 * - → AgentCore Gateway: every tool call carries the run owner's Auth0 JWT as
 *   `Authorization: Bearer …` (a fake MCP endpoint captures the headers), and the token never
 *   appears in replies, audit events, the model's context or the logs.
 * - → tickets and approvers: `create_ticket` gets the run owner's `requester_*` (never the
 *   model's, never the approver's), approval replies show the requester, and name/email never
 *   reach audit events.
 * - → the model: the first name, in the first user message per speaker, never the system prompt.
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import {
  approvalResponse,
  CallerToken,
  identityResolverFrom,
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
import {
  ALICE,
  BOB,
  chat,
  type FakeMcpServer,
  LEAD,
  makeRunner,
  send,
  startFakeMcpServer,
  testJwt,
  testRunnerOptions,
} from "./support.ts";

const NS = "https://fintech.example/";
const ALICE_JWT = testJwt({ sub: ALICE, [`${NS}email`]: "alice@example.com", [`${NS}given_name`]: "Alice", [`${NS}user_id`]: "usr_alice" });
const BOB_JWT = testJwt({ sub: BOB, [`${NS}email`]: "bob@example.com", [`${NS}given_name`]: "Bob", [`${NS}user_id`]: "usr_bob" });
const LEAD_JWT = testJwt({ sub: LEAD, [`${NS}email`]: "lead@example.com", [`${NS}user_id`]: "usr_lead" });
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
              queued = await send(harness.runner, chat("bob's question", "b1", BOB), BOB_JWT);
            },
          },
          { text: "2" },
          { tools: [["search_knowledge", { query: "vpn" }]] },
          { text: "vpn docs" },
        ],
      });
      const reply = await send(harness.runner, chat("alice's question", "a1"), ALICE_JWT);
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
    const requested = await send(harness.runner, chat("open a ticket"), ALICE_JWT);
    assert.equal(requested.kind, "approval_requested");
    if (requested.kind !== "approval_requested") return;
    assert.deepEqual(toolCalls(mcp), []); // held: nothing reached the Gateway
    const reply = await send(harness.runner, approvalResponse(MessageId.of("a2"), LEAD, requested.approvalId, "approve"), LEAD_JWT);
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

// ---------------------------------------------------------------- requester, approvers, model context

/** The `arguments` of each `tools/call` the fake Gateway received. */
const toolArguments = (mcp: FakeMcpServer) =>
  mcp.seen
    .filter((r) => r.method === "tools/call")
    .map((r) => (r.params as { arguments?: Readonly<Record<string, unknown>> }).arguments ?? {});

/** Text of the last user message, and of all system messages, of one model request. */
function userAndSystem(seen: string | undefined): { readonly user: string; readonly system: string } {
  const messages = JSON.parse(seen ?? "[]") as { role: string; content: unknown }[];
  const users = messages.filter((m) => m.role === "user");
  const last = users.at(-1)?.content;
  const user = Array.isArray(last) ? last.map((b: { text?: string }) => b.text ?? "").join("") : String(last ?? "");
  return { user, system: JSON.stringify(messages.filter((m) => m.role === "system")) };
}

describe("the requester", () => {
  let mcp: FakeMcpServer;
  before(async () => {
    mcp = await startFakeMcpServer();
  });
  after(async () => {
    await mcp.stop();
  });

  test("create_ticket gets the run owner as requester (not the model's choice, not the approver); approvers see who asked; no PII in audit", async () => {
    mcp.reset();
    const harness = await makeRunner({
      caller: new McpToolGateway({ url: mcp.url, clientInfo: { name: "t", version: "0" } }),
      turns: [
        {
          tools: [
            [
              "create_ticket",
              {
                title: "VPN",
                description: "down",
                requester_id: "usr_mallory",
                requester_name: "Mallory",
                requester_email: "mallory@evil.example",
              },
            ],
          ],
        },
        { text: "created" },
      ],
    });
    const requested = await send(harness.runner, chat("open a ticket"), ALICE_JWT);
    assert.deepEqual(renderReply(requested)["requester"], {
      kind: "user",
      user_id: "usr_alice",
      name: "Alice",
      email: "alice@example.com",
    });
    if (requested.kind !== "approval_requested") return;
    const reply = await send(harness.runner, approvalResponse(MessageId.of("a2"), LEAD, requested.approvalId, "approve"), LEAD_JWT);
    assert.deepEqual(renderReply(reply), { status: "completed", answers: ["created"] });
    const [args] = toolArguments(mcp);
    assert.deepEqual(
      { ...args, idempotency_key: undefined },
      {
        title: "VPN",
        description: "down",
        requester_id: "usr_alice",
        requester_name: "Alice",
        requester_email: "alice@example.com",
        idempotency_key: undefined,
      },
    );
    const audit = harness.audit.events.map((e) => JSON.stringify(renderAuditEvent(e))).join("\n");
    for (const pii of ["alice@example.com", "Alice", "lead@example.com", "mallory"]) assert.ok(!audit.includes(pii), `${pii} in audit`);
  });

  test("a queued follow-up's ticket is requested by its sender", async () => {
    mcp.reset();
    let queued: Reply | null = null;
    const harness = await makeRunner({
      caller: new McpToolGateway({ url: mcp.url, clientInfo: { name: "t", version: "0" } }),
      turns: [
        {
          text: "hello Alice",
          onCall: async () => {
            queued = await send(harness.runner, chat("open a ticket", "b1", BOB), BOB_JWT);
          },
        },
        { tools: [["create_ticket", { title: "Printer", description: "jammed" }]] },
      ],
    });
    const reply = await send(harness.runner, chat("hi", "a1"), ALICE_JWT);
    assert.deepEqual(queued === null ? null : renderReply(queued), { status: "queued" });
    assert.deepEqual(renderReply(reply)["requester"], { kind: "user", user_id: "usr_bob", name: "Bob", email: "bob@example.com" });
    assert.deepEqual(renderReply(reply)["approvers"], [LEAD]);
  });

  test("the model is told the first name once per speaker, never in the system prompt", async () => {
    let queued: Reply | null = null;
    const harness = await makeRunner({
      turns: [
        { text: "Hi Alice." },
        { text: "Sure." },
        {
          text: "Hello.",
          onCall: async () => {
            queued = await send(harness.runner, chat("bob here", "b1", BOB));
          },
        },
        { text: "Hi Bob." },
        { text: "Back to you." },
      ],
    });
    await send(harness.runner, chat("hello", "m1"));
    await send(harness.runner, chat("and again", "m2"));
    await send(harness.runner, chat("lead here", "m3", LEAD)); // Bob's prompt is queued behind it
    assert.deepEqual(queued === null ? null : renderReply(queued), { status: "queued" });
    await send(harness.runner, chat("alice again", "m4"));
    const seen = harness.model.seen.map(userAndSystem);
    assert.deepEqual(
      seen.map((s) => s.user),
      [
        "[Context: you are assisting Alice.]\n\nhello",
        "and again",
        "lead here", // no given name: no preamble
        "[Context: you are assisting Bob.]\n\nbob here",
        "[Context: you are assisting Alice.]\n\nalice again", // the speaker changed back
      ],
    );
    for (const { system } of seen) assert.doesNotMatch(system, /Alice|Bob|assisting/);
  });

  test("over HTTP: the caller comes from the token's claims; the user id survives an email change; no email → invalid_request", async () => {
    mcp.reset();
    const { options } = await testRunnerOptions({
      caller: new McpToolGateway({ url: mcp.url, clientInfo: { name: "t", version: "0" } }),
      turns: [
        { tools: [["create_ticket", { title: "A", description: "a" }]] },
        { tools: [["create_ticket", { title: "B", description: "b" }]] },
      ],
    });
    const server: RunningAgentCoreServer = await startAgentCoreServer({
      handler: invocationHandler(new Registry(options)),
      identity: identityResolverFrom(options.settings.identity, {}),
      host: "127.0.0.1",
      port: 0,
    });
    const invoke = async (session: string, claims: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const response = await fetch(`${server.url}/invocations`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-amzn-bedrock-agentcore-runtime-session-id": session,
          authorization: `Bearer ${testJwt(claims)}`,
        },
        body: JSON.stringify({ prompt: "open a ticket" }),
      });
      return (await response.json()) as Record<string, unknown>;
    };
    try {
      const carol = { sub: "auth0|carol", [`${NS}email`]: "carol@old.example", [`${NS}given_name`]: "Carol" };
      const first = await invoke("thread-carol-0000000000000000000000000001", carol);
      const requester = first["requester"] as Record<string, unknown>;
      assert.equal(first["status"], "approval_required");
      assert.match(String(requester["user_id"]), /^usr_[0-9a-f]{32}$/); // minted: no user_id claim
      const renamed = { ...carol, [`${NS}email`]: "carol@new.example", [`${NS}family_name`]: "Doe" };
      const second = await invoke("thread-carol-0000000000000000000000000002", renamed);
      assert.deepEqual(second["requester"], {
        kind: "user",
        user_id: requester["user_id"],
        name: "Carol Doe",
        email: "carol@new.example",
      });
      assert.deepEqual(await invoke("thread-carol-0000000000000000000000000003", { sub: "auth0|dave" }), {
        status: "invalid_request",
        path: `$.jwt.${NS}email`,
        error: "is required for human users (add it in the Auth0 Action)",
      });
      assert.equal(toolArguments(mcp).length, 0); // nothing ran without approval
    } finally {
      await server.close();
    }
  });
});
