/**
 * Shell pieces that need no opencode process: boundary parsers for opencode events, the rendered
 * config, the guard bridge, the IMDS credential_process helper and the /invocations boundary.
 */

import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import {
  AwsRegion,
  CallerToken,
  FakeClock,
  MemoryAuditSink,
  ModelId,
  SESSION_HEADER,
  startAgentCoreServer,
  TokenCount,
  unwrap,
} from "@org/agents";

import { ModelBackend, OcSessionId } from "../src/domain.ts";
import { TOOLS_SERVER } from "../src/core/permissions.ts";
import { invocationHandler, NOTHING_ASKED_REASON, Registry } from "../src/shell/app.ts";
import { GUARD_TOKEN_HEADER, GuardBridge, type GuardTarget } from "../src/shell/guardBridge.ts";
import { fetchImdsCredentials, renderCredentialProcess } from "../src/shell/imdsCredentials.ts";
import { MODEL_KEY, renderConfig } from "../src/shell/opencodeConfig.ts";
import { isAbortError, parseAssistantMessages, parseEvent } from "../src/shell/opencodeEvents.ts";
import { settings } from "./support/world.ts";

describe("opencode events (boundary parsing)", () => {
  test("assistant message usage: reasoning counts as output, cache tokens kept", () => {
    const event = unwrap(
      parseEvent({
        type: "message.updated",
        properties: {
          sessionID: "ses_1",
          info: {
            id: "msg_1",
            role: "assistant",
            sessionID: "ses_1",
            time: { created: 1, completed: 2 },
            tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } },
            cost: 0.123, // opencode's catalog estimate: ignored
          },
        },
      }),
    );
    assert.equal(event.kind, "assistant_message");
    if (event.kind !== "assistant_message") return;
    assert.equal(event.completed, true);
    assert.deepEqual(event.usage, {
      inputTokens: TokenCount.of(100),
      outputTokens: TokenCount.of(25),
      cacheReadTokens: TokenCount.of(7),
      cacheWriteTokens: TokenCount.of(3),
    });
  });

  test("permission, idle, error and unknown events", () => {
    assert.deepEqual(
      unwrap(parseEvent({ type: "permission.asked", properties: { id: "per_1", sessionID: "ses_1", permission: "gw_create_ticket", patterns: ["*"] } })),
      { kind: "permission_asked", session: "ses_1", request: "per_1", permission: "gw_create_ticket" },
    );
    assert.deepEqual(unwrap(parseEvent({ type: "session.idle", properties: { sessionID: "ses_1" } })), {
      kind: "session_idle",
      session: "ses_1",
    });
    const error = unwrap(
      parseEvent({ type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "bad" } } } }),
    );
    assert.deepEqual(error, { kind: "session_error", session: "ses_1", error: "APIError: bad" });
    assert.ok(isAbortError("MessageAbortedError: Aborted"));
    assert.deepEqual(unwrap(parseEvent({ type: "message.part.delta", properties: {} })), { kind: "other" });
    assert.equal(parseEvent({ type: "permission.asked", properties: { id: "../x", sessionID: "ses_1", permission: "p" } }).kind, "err");
    assert.equal(parseEvent("nope").kind, "err");
  });

  test("messages: only assistant text parts, synthetic parts skipped", () => {
    const messages = unwrap(
      parseAssistantMessages([
        { info: { id: "msg_u", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        {
          info: { id: "msg_a", role: "assistant", time: { created: 1, completed: 2 }, tokens: { input: 1, output: 1 } },
          parts: [
            { type: "step-start" },
            { type: "text", text: "Hello" },
            { type: "text", text: "[synthetic]", synthetic: true },
          ],
        },
      ]),
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.text, "Hello");
  });
});

describe("rendered opencode config", () => {
  const base = {
    settings: settings(),
    agent: "org-generic",
    server: TOOLS_SERVER,
    toolsMcpUrl: "https://gw.example/mcp",
    pluginPath: "/app/plugin/orgGuard.ts",
  };

  test("production: bundled Bedrock provider with a profile, no keys; locked-down defaults", () => {
    const config = renderConfig({
      ...base,
      backend: ModelBackend.bedrock(ModelId.of("arn:aws:bedrock:eu-west-1:123:application-inference-profile/x"), AwsRegion.of("eu-west-1"), "agentcore"),
      mcpToken: CallerToken.of("eyJhbGciOiJub25lIn0.eyJzdWIiOiJhIn0.sig"),
    });
    const text = JSON.stringify(config);
    assert.equal(config["model"], `amazon-bedrock/${MODEL_KEY}`);
    assert.deepEqual(config["enabled_providers"], ["amazon-bedrock"]);
    assert.match(text, /"npm":"@ai-sdk\/amazon-bedrock"/);
    assert.match(text, /"profile":"agentcore"/);
    assert.doesNotMatch(text, /apiKey|AWS_BEARER_TOKEN|secret/i);
    assert.equal(config["share"], "disabled");
    assert.equal(config["autoupdate"], false);
    assert.equal(config["snapshot"], false);
    assert.deepEqual(config["plugin"], ["/app/plugin/orgGuard.ts"]);
    assert.match(text, /"gw":\{"type":"remote","url":"https:\/\/gw.example\/mcp","oauth":false,"timeout":30000,"headers":\{"Authorization":"Bearer eyJhbGciOiJub25lIn0\.eyJzdWIiOiJhIn0\.sig"\}\}/);
    const permission = config["permission"] as Record<string, string>;
    assert.equal(permission["*"], "deny");
    assert.equal(permission["gw_create_ticket"], "ask");
    assert.equal(permission["webfetch"], "deny");
  });
});

describe("guard bridge", () => {
  test("requires the token, and refuses sessions without an active run (fail closed)", async () => {
    const bridge = new GuardBridge(() => undefined);
    await bridge.start();
    try {
      const post = (path: string, body: unknown, token: string | null) =>
        fetch(`${bridge.url}${path}`, {
          method: "POST",
          headers: token === null ? {} : { [GUARD_TOKEN_HEADER]: token },
          body: JSON.stringify(body),
        });
      assert.equal((await post("/model", { sessionID: "ses_1" }, null)).status, 403);
      assert.equal((await post("/model", { sessionID: "ses_1" }, "wrong")).status, 403);
      assert.deepEqual(await (await post("/model", { sessionID: "ses_1" }, bridge.token)).json(), {
        action: "stop",
        reason: "no active org run for this session",
      });
      const target: GuardTarget = {
        beforeModelCall: async () => ({ kind: "continue" }),
        beforeToolCall: async (key) => (key === "gw_ok" ? { kind: "proceed", set: { requested_by: "auth0|a" } } : { kind: "block", reason: "no" }),
        toolResult: (_key, texts) => texts.map((t) => t.toUpperCase()),
      };
      bridge.register(OcSessionId.of("ses_1"), target);
      assert.deepEqual(await (await post("/tool", { sessionID: "ses_1", tool: "gw_ok", args: {} }, bridge.token)).json(), {
        action: "proceed",
        set: { requested_by: "auth0|a" },
      });
      assert.deepEqual(await (await post("/result", { sessionID: "ses_1", tool: "gw_ok", texts: ["a"] }, bridge.token)).json(), {
        texts: ["A"],
      });
      assert.equal((await post("/tool", { sessionID: 3 }, bridge.token)).status, 400);
    } finally {
      await bridge.stop();
    }
  });
});

describe("IMDS credential_process helper", () => {
  test("IMDSv2 token → role → credentials, rendered as credential_process JSON", async () => {
    const seen: string[] = [];
    const imds: Server = createHttpServer((request, response) => {
      seen.push(`${request.method} ${request.url} ${String(request.headers["x-aws-ec2-metadata-token"] ?? "")}`);
      if (request.url === "/latest/api/token") return void response.end("tok");
      if (request.url === "/latest/meta-data/iam/security-credentials/") return void response.end("agent-role\n");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ Code: "Success", AccessKeyId: "ASIAEXAMPLE", SecretAccessKey: "s", Token: "t", Expiration: "2026-09-27T12:00:00Z" }),
      );
    });
    await new Promise<void>((resolve) => imds.listen(0, "127.0.0.1", resolve));
    try {
      const credentials = await fetchImdsCredentials(`http://127.0.0.1:${(imds.address() as AddressInfo).port}/`);
      assert.deepEqual(JSON.parse(renderCredentialProcess(credentials)), {
        Version: 1,
        AccessKeyId: "ASIAEXAMPLE",
        SecretAccessKey: "s",
        SessionToken: "t",
        Expiration: "2026-09-27T12:00:00Z",
      });
      assert.deepEqual(seen, [
        "PUT /latest/api/token ",
        "GET /latest/meta-data/iam/security-credentials/ tok",
        "GET /latest/meta-data/iam/security-credentials/agent-role tok",
      ]);
    } finally {
      await new Promise<void>((resolve) => imds.close(() => resolve()));
    }
  });
});

const JWT_ALICE = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: "auth0|alice" })).toString("base64url")}.sig`;

describe("/invocations boundary", () => {
  test("invalid payloads are rejected before any run (no opencode needed)", async () => {
    const registry = new Registry({
      settings: settings(),
      host: () => {
        throw new Error("opencode must not be started for invalid input");
      },
      clock: new FakeClock(),
      audit: new MemoryAuditSink(),
      killSwitch: () => false,
    });
    const server = await startAgentCoreServer({ handler: invocationHandler(registry), host: "127.0.0.1", port: 0 });
    const { url } = server;
    try {
      for (const payload of [{ prompt: "" }, { nope: 1 }, "text", { approval: { id: "x", decision: "maybe" } }]) {
        const response = await fetch(`${url}/invocations`, {
          method: "POST",
          headers: { "content-type": "application/json", [SESSION_HEADER]: "thread-1-00000000000000000000000000" },
          body: JSON.stringify(payload),
        });
        const body = (await response.json()) as Record<string, unknown>;
        assert.equal(body["status"], "invalid_request", JSON.stringify(payload));
      }
      // A cancel or approval before any prompt is refused without starting opencode (or binding).
      for (const payload of [{ cancel: true }, { approval: { id: "x", decision: "approve" } }]) {
        const response = await fetch(`${url}/invocations`, {
          method: "POST",
          headers: { [SESSION_HEADER]: "thread-1-00000000000000000000000000", authorization: `Bearer ${JWT_ALICE}` },
          body: JSON.stringify(payload),
        });
        assert.deepEqual(await response.json(), { status: "refused", reason: NOTHING_ASKED_REASON });
      }
      assert.equal(registry.boundPrincipal, null);
      assert.deepEqual(await (await fetch(`${url}/ping`)).json(), { status: "Healthy" });
      assert.equal(registry.host, null);
    } finally {
      await server.close();
    }
  });
});
