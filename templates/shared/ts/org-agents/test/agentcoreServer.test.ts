import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  CallerToken,
  callerTokenFromHeaders,
  type Incoming,
  type InvocationContext,
  invocationContextFromHeaders,
  NO_INVOCATION_CONTEXT,
  type Reply,
  type RunningAgentCoreServer,
  SESSION_HEADER,
  type SessionId,
  startAgentCoreServer,
  WorkloadAccessToken,
} from "../src/index.ts";

let server: RunningAgentCoreServer;
const calls: { session: SessionId; incoming: Incoming; context: InvocationContext }[] = [];
let release: (() => void) | null = null;

before(async () => {
  server = await startAgentCoreServer({
    host: "127.0.0.1",
    port: 0,
    onError: () => undefined,
    handler: async (session, incoming, context): Promise<Reply> => {
      calls.push({ session, incoming, context });
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

// ---------------------------------------------------------------- invocation context (credentials)

test("the handler receives the caller's JWT and the Workload Access Token", async () => {
  const token = jwt({ sub: "auth0|42" });
  const result = await invoke({ prompt: "ctx", message_id: "ctx1" }, { authorization: `bearer ${token}`, WorkloadAccessToken: "wat-1+/=" });
  assert.equal(result.status, 200);
  const last = calls.at(-1);
  assert.deepEqual(last?.context, { callerToken: token, workloadAccessToken: "wat-1+/=" });
  assert.equal(last?.incoming.sender, "auth0|42");
  assert.doesNotMatch(JSON.stringify(result.json), /wat-1|eyJ/); // never rendered
});

test("the WAT is also read from X-Amz-Bedrock-AgentCore-Identity-WAT; no headers → empty context", async () => {
  await invoke({ prompt: "ctx" }, { "X-Amz-Bedrock-AgentCore-Identity-WAT": "wat-2" });
  assert.deepEqual(calls.at(-1)?.context, { callerToken: null, workloadAccessToken: "wat-2" });
  await invoke({ prompt: "ctx" });
  assert.deepEqual(calls.at(-1)?.context, NO_INVOCATION_CONTEXT);
});

test("handlers written for (session, incoming) still type-check and run", async () => {
  const legacy = await startAgentCoreServer({
    host: "127.0.0.1",
    port: 0,
    handler: async (_session: SessionId, incoming: Incoming): Promise<Reply> => ({ kind: "answer", texts: [incoming.kind] }),
  });
  try {
    const response = await fetch(`${legacy.url}/invocations`, { method: "POST", body: JSON.stringify({ prompt: "x" }) });
    assert.deepEqual(await response.json(), { status: "completed", answers: ["chat_message"] });
  } finally {
    await legacy.close();
  }
});

test("an invalid WAT is rejected at the boundary without echoing it", async () => {
  const before = calls.length;
  const result = await invoke({ prompt: "x" }, { workloadaccesstoken: "has space-secret123" });
  assert.deepEqual(result.json, {
    status: "invalid_request",
    path: "$.headers.workloadaccesstoken",
    error: "must be visible ASCII without spaces",
  });
  assert.doesNotMatch(JSON.stringify(result.json), /secret123/);
  assert.equal(calls.length, before);
});

test("credential parsers: bearer scheme, JWT shape, no value in errors", () => {
  const token = jwt({ sub: "a" });
  assert.deepEqual(callerTokenFromHeaders({ Authorization: `Bearer  ${token} ` }), { kind: "ok", value: token });
  assert.deepEqual(callerTokenFromHeaders({ authorization: "Basic dXNlcjpwYXNz" }), { kind: "ok", value: null });
  assert.deepEqual(callerTokenFromHeaders(new Headers()), { kind: "ok", value: null });
  const bad = callerTokenFromHeaders({ authorization: "Bearer not-a-jwt-secret" });
  assert.equal(bad.kind, "err");
  assert.doesNotMatch(bad.kind === "err" ? bad.error.message : "", /secret/);
  assert.equal(CallerToken.parse("a.b", "$").kind, "err");
  assert.equal(CallerToken.parse("a.b.c d", "$").kind, "err");
  assert.equal(CallerToken.parse("x".repeat(20_000) + ".a.b", "$").kind, "err");
  assert.throws(() => WorkloadAccessToken.of("with space secret"), (e: Error) => !e.message.includes("secret"));
  // The Workload Access Token header wins over the alias; names are case-insensitive.
  const both = invocationContextFromHeaders(
    new Headers({ "X-Amz-Bedrock-AgentCore-Identity-WAT": "alias", WORKLOADACCESSTOKEN: "primary" }),
  );
  assert.deepEqual(both, { kind: "ok", value: { callerToken: null, workloadAccessToken: "primary" } });
});
