/** The AgentCore adapter over HTTP: the same `/invocations` contract as the Python variants. */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { type RunningAgentCoreServer, startAgentCoreServer } from "@org/agents";

import { invocationHandler, Registry } from "../src/shell/app.ts";
import { PI_OFFLINE_ENV } from "../src/shell/offline.ts";
import { testRunnerOptions } from "./support.ts";

const SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

describe("AgentCore adapter", () => {
  let server: RunningAgentCoreServer;

  before(async () => {
    const { options } = await testRunnerOptions({ turns: [{ text: "Hello from pi." }] });
    server = await startAgentCoreServer({
      handler: invocationHandler(new Registry(options)),
      host: "127.0.0.1",
      port: 0,
    });
  });

  after(async () => {
    await server.close();
  });

  const invoke = async (body: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${server.url}/invocations`, {
      method: "POST",
      headers: { "content-type": "application/json", [SESSION_HEADER]: "thread-http-000000000000000000000000001" },
      body,
    });
    return (await response.json()) as Record<string, unknown>;
  };

  for (const payload of [{ prompt: "" }, { nope: 1 }, "text", [1, 2]]) {
    test(`rejects ${JSON.stringify(payload)} at the boundary`, async () => {
      assert.equal((await invoke(JSON.stringify(payload)))["status"], "invalid_request");
    });
  }

  test("rejects a body that is not JSON", async () => {
    assert.deepEqual(await invoke("{"), { status: "invalid_request", path: "$", error: "is not valid JSON" });
  });

  test("answers a prompt and reports health", async () => {
    assert.deepEqual(await invoke(JSON.stringify({ prompt: "hi", message_id: "m1" })), {
      status: "completed",
      answers: ["Hello from pi."],
    });
    const ping = await fetch(`${server.url}/ping`);
    assert.deepEqual(await ping.json(), { status: "Healthy" });
  });

  test("pi runs offline (no package install, version check or catalog refresh)", () => {
    for (const [name, value] of Object.entries(PI_OFFLINE_ENV)) assert.equal(process.env[name], value);
  });
});
