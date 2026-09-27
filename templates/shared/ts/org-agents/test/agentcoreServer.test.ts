import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  type Incoming,
  type Reply,
  type RunningAgentCoreServer,
  SESSION_HEADER,
  type SessionId,
  startAgentCoreServer,
} from "../src/index.ts";

let server: RunningAgentCoreServer;
const calls: { session: SessionId; incoming: Incoming }[] = [];
let release: (() => void) | null = null;

before(async () => {
  server = await startAgentCoreServer({
    host: "127.0.0.1",
    port: 0,
    onError: () => undefined,
    handler: async (session, incoming): Promise<Reply> => {
      calls.push({ session, incoming });
      if (incoming.kind === "chat_message" && incoming.prompt === "wait") {
        await new Promise<void>((resolve) => (release = resolve));
      }
      if (incoming.kind === "chat_message" && incoming.prompt === "crash") throw new Error("bug");
      return incoming.kind === "chat_message"
        ? { kind: "answer", texts: [`echo: ${incoming.prompt}`] }
        : { kind: "acknowledged", ack: "cancelling" };
    },
  });
});

after(() => server.close());

async function invoke(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${server.url}/invocations`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function ping(): Promise<unknown> {
  return (await fetch(`${server.url}/ping`)).json();
}

function jwt(claims: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

test("ping is healthy when idle", async () => {
  assert.deepEqual(await ping(), { status: "Healthy" });
});

test("invocation goes through parse → handler → render", async () => {
  const result = await invoke(
    { prompt: "hi", message_id: "m1" },
    { [SESSION_HEADER]: "sess-123", authorization: `Bearer ${jwt({ sub: "auth0|42" })}` },
  );
  assert.deepEqual(result, { status: 200, json: { status: "completed", answers: ["echo: hi"] } });
  const last = calls.at(-1);
  assert.equal(last?.session, "sess-123");
  assert.deepEqual(last?.incoming, { kind: "chat_message", messageId: "m1", sender: "auth0|42", prompt: "hi" });
});

test("default session and local principal", async () => {
  const result = await invoke({ cancel: true, message_id: "c1" });
  assert.deepEqual(result.json, { status: "cancelling" });
  const last = calls.at(-1);
  assert.equal(last?.session, "local-session-0000000000000000000000");
  assert.equal(last?.incoming.sender, "local-dev");
});

test("invalid requests are reported with a path", async () => {
  assert.deepEqual((await invoke({ prompt: 3 })).json, {
    status: "invalid_request",
    path: "$.prompt",
    error: "expected a string, got integer",
  });
  assert.deepEqual((await invoke("{not json")).json, { status: "invalid_request", path: "$", error: "is not valid JSON" });
  assert.deepEqual((await invoke({ prompt: "x" }, { [SESSION_HEADER]: "bad session!" })).json, {
    status: "invalid_request",
    path: "$.session",
    error: "contains characters outside [A-Za-z0-9._:@/-]",
  });
  assert.equal(((await invoke({ prompt: "x" }, { authorization: "Bearer nope" })).json as { path: string }).path, "$.headers.authorization");
});

test("handler failures are a 500 without internals", async () => {
  assert.deepEqual(await invoke({ prompt: "crash" }), { status: 500, json: { status: "error", error: "internal error" } });
});

test("ping reports HealthyBusy while an invocation runs", async () => {
  const pending = invoke({ prompt: "wait" });
  while (release === null) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await ping(), { status: "HealthyBusy" });
  release();
  assert.deepEqual((await pending).json, { status: "completed", answers: ["echo: wait"] });
  assert.deepEqual(await ping(), { status: "Healthy" });
});

test("unknown routes are 404", async () => {
  const response = await fetch(`${server.url}/nope`);
  assert.equal(response.status, 404);
  await response.body?.cancel();
});
