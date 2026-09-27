/** Shell adapters: boundary parsers, MCP arguments, guardrail payload, Bedrock model, credentials. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FakeClock, Instant, loadSettings, ok, PrincipalId, serviceClient, ToolName, unwrap, Usage, TokenCount } from "@org/agents";

import { refreshEnabled, startCredentialRefresh } from "../src/shell/credentials.ts";
import { withGuardrail } from "../src/shell/guardrail.ts";
import { BEDROCK_PROVIDER, bedrockModel, loadPiModelSettings, parsePiModelSettings } from "../src/shell/model.ts";
import { piAi } from "../src/shell/piAi.ts";
import { parseAssistantUsage, parseCompactionUsage, parseFinalMessage } from "../src/shell/piMessages.ts";
import { genericTools, invokeTool, mcpArguments, type ToolCaller } from "../src/shell/tools.ts";
import { ALICE, BOB, CALLERS, ROOT, SESSION } from "./support.ts";

const tool = (name: string) => {
  const found = genericTools(piAi.Type).find((t) => t.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

describe("pi message parsing", () => {
  test("assistant usage in pi's shape", () => {
    const message = { role: "assistant", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18 } };
    assert.deepEqual(parseAssistantUsage(message), ok(Usage.of(TokenCount.of(10), TokenCount.of(5), TokenCount.of(2), TokenCount.of(1))));
    assert.deepEqual(parseAssistantUsage({ role: "user", content: [] }), ok(null));
    assert.equal(parseAssistantUsage({ role: "assistant", usage: { input: -1 } }).kind, "err");
  });

  test("compaction usage is optional", () => {
    assert.deepEqual(parseCompactionUsage({ summary: "s" }), ok(null));
    assert.equal(unwrap(parseCompactionUsage({ usage: { input: 3, output: 1 } }))?.inputTokens, 3);
  });

  test("the final message of a run", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Hel" }, { type: "text", text: "lo" }] },
      { role: "toolResult", content: [] },
    ];
    assert.deepEqual(parseFinalMessage(messages), ok({ kind: "text", text: "Hello" }));
    assert.deepEqual(parseFinalMessage([{ role: "assistant", stopReason: "error", errorMessage: "boom", content: [] }]), ok({ kind: "error", message: "boom" }));
    assert.deepEqual(parseFinalMessage([]), ok(null));
    assert.equal(parseFinalMessage([42]).kind, "err");
  });
});

describe("tool arguments", () => {
  const identity = { session: SESSION, requester: CALLERS.get(ALICE) ?? null, callerToken: null };

  test("create_ticket: the harness sets the requester and the idempotency key, not the model", () => {
    const forged = {
      title: "VPN",
      description: "down",
      requester_id: "usr_mallory",
      requester_name: "Mallory",
      requester_email: "mallory@evil.example",
      requested_by: "mallory",
      idempotency_key: "x",
    };
    const args = unwrap(mcpArguments(tool("create_ticket"), forged, identity));
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
    assert.match(String(args["idempotency_key"]), /^idem-[0-9a-f]{32}$/);
    const again = unwrap(mcpArguments(tool("create_ticket"), { description: "down", title: "VPN" }, identity));
    assert.equal(again["idempotency_key"], args["idempotency_key"]); // same call → same key (forged fields ignored)
    const other = unwrap(mcpArguments(tool("create_ticket"), { title: "VPN", description: "down" }, { ...identity, requester: CALLERS.get(BOB) ?? null }));
    assert.equal(other["idempotency_key"], args["idempotency_key"]); // keyed by session + arguments
    assert.equal(other["requester_id"], "usr_bob");
  });

  test("create_ticket: a service caller has no email; an unknown requester fails the call", () => {
    const service = { ...identity, requester: serviceClient(PrincipalId.of("m2m@clients")) };
    const args = unwrap(mcpArguments(tool("create_ticket"), { title: "VPN", description: "down", requester_email: "x@y.io" }, service));
    assert.equal(args["requester_id"], "m2m@clients");
    assert.equal(args["requester_name"], "service m2m@clients");
    assert.equal(args["requester_email"], "");
    const unknown = mcpArguments(tool("create_ticket"), { title: "VPN", description: "down" }, { ...identity, requester: null });
    assert.equal(unknown.kind === "err" && unknown.error.path, "$.requester");
    // Read-only tools do not need a requester.
    assert.equal(mcpArguments(tool("calculate"), { expression: "1" }, { ...identity, requester: null }).kind, "ok");
  });

  test("read-only tools get only their declared fields", () => {
    assert.deepEqual(unwrap(mcpArguments(tool("calculate"), { expression: "1+1", extra: true }, identity)), { expression: "1+1" });
    assert.equal(mcpArguments(tool("calculate"), "1+1", identity).kind, "err");
  });

  test("MCP failures become tool errors for the model", async () => {
    const down: ToolCaller = { callTool: async () => ({ kind: "err", error: { kind: "transport", detail: "refused" } }) };
    assert.deepEqual(await invokeTool(down, tool("get_ticket"), { ticket_id: "TCK-1" }, identity), {
      kind: "error",
      text: "get_ticket is unavailable: MCP transport error: refused",
    });
    const calls: unknown[] = [];
    const up: ToolCaller = {
      callTool: async (name, args) => {
        calls.push([name, args]);
        return { kind: "ok", value: { kind: "error", text: "ticket TCK-1 not found" } };
      },
    };
    assert.deepEqual(await invokeTool(up, tool("get_ticket"), { ticket_id: "TCK-1" }, identity), { kind: "error", text: "ticket TCK-1 not found" });
    assert.deepEqual(calls, [[ToolName.of("get_ticket"), { ticket_id: "TCK-1" }]]);
  });
});

describe("guardrail payload", () => {
  test("adds guardrailConfig to a Converse request, keeps the rest", () => {
    const payload = { modelId: "m", messages: [] };
    assert.deepEqual(withGuardrail(payload, { id: "gr-1", version: "3" }), {
      modelId: "m",
      messages: [],
      guardrailConfig: { guardrailIdentifier: "gr-1", guardrailVersion: "3", trace: "enabled" },
    });
    assert.equal(withGuardrail("not an object", { id: "gr-1", version: "3" }), "not an object");
  });
});

describe("Bedrock model", () => {
  test("the inference profile is registered with the family in its name and the configured cost", async () => {
    const settings = unwrap(loadSettings({ BEDROCK_MODEL_ID: "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/abc123" }, ROOT));
    const runtime = await ModelRuntime.create({ credentials: new piAi.InMemoryCredentialStore(), modelsPath: null });
    const model = bedrockModel(runtime, settings.agent, unwrap(loadPiModelSettings({}, ROOT)), {});
    assert.equal(model.provider, BEDROCK_PROVIDER);
    assert.equal(model.api, "bedrock-converse-stream");
    assert.equal(model.name, "claude-sonnet-4-6 (generic_pi_harness)");
    assert.deepEqual(model.cost, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    assert.equal(model.baseUrl, "https://bedrock-runtime.eu-west-1.amazonaws.com");
  });

  test("[pi] settings are parsed with defaults", () => {
    assert.deepEqual(unwrap(parsePiModelSettings({ pi: { model_family: "claude-haiku-4-5" } })), {
      modelFamily: "claude-haiku-4-5",
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    });
    assert.equal(parsePiModelSettings({}).kind, "err");
  });
});

describe("credential refresh", () => {
  test("only on AgentCore", () => {
    assert.equal(refreshEnabled({}), false);
    assert.equal(refreshEnabled({ AGENTCORE_RUNTIME: "1" }), true);
  });

  test("writes the role credentials into the environment pi reads", async () => {
    const clock = new FakeClock(Instant.of(0));
    const env: Record<string, string | undefined> = { AWS_SESSION_TOKEN: "stale" };
    let fetches = 0;
    const refresher = await startCredentialRefresh({
      clock,
      env,
      source: async () => {
        fetches += 1;
        return { accessKeyId: "AKIA-TEST", secretAccessKey: "secret", sessionToken: "token", expiration: new Date(3_600_000) };
      },
    });
    refresher.stop();
    assert.equal(fetches, 1);
    assert.deepEqual(env, { AWS_ACCESS_KEY_ID: "AKIA-TEST", AWS_SECRET_ACCESS_KEY: "secret", AWS_SESSION_TOKEN: "token" });
  });
});
