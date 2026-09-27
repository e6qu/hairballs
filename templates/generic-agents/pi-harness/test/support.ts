/**
 * Test support: a scripted fake model on pi-ai's built-in faux provider, the tools MCP server,
 * and a SessionRunner wired like production except for the model. Offline: no AWS, no real model.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  StreamFunction,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Caller,
  CallerToken,
  chatMessage,
  EmailAddress,
  type Env,
  err,
  FakeClock,
  humanUser,
  type Incoming,
  type InvocationContext,
  loadSettings,
  MemoryAuditSink,
  MessageId,
  PersonName,
  PrincipalId,
  Prompt,
  type Reply,
  SessionId,
  unwrap,
  UserId,
} from "@org/agents";

import { enforceOffline } from "../src/shell/offline.ts";
import { piAi } from "../src/shell/piAi.ts";
import { SessionRunner, type SessionRunnerOptions } from "../src/shell/runner.ts";
import type { ToolCaller } from "../src/shell/tools.ts";

enforceOffline(process.env);

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const TOOLS_DIR = fileURLToPath(new URL("../../tools", import.meta.url));
export const HAS_UV = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;
export const ALICE = PrincipalId.of("auth0|alice");
export const BOB = PrincipalId.of("auth0|bob");
export const LEAD = PrincipalId.of("auth0|service-desk-lead");
export const SESSION = SessionId.of("thread-1-00000000000000000000000000");

export const chat = (text: string, mid = "m1", who: PrincipalId = ALICE) =>
  chatMessage(MessageId.of(mid), who, Prompt.of(text));

function person(subject: PrincipalId, user: string, email: string, given: string | null): Caller {
  return humanUser({
    userId: UserId.of(user),
    subject,
    email: EmailAddress.of(email),
    givenName: given === null ? null : PersonName.of(given),
    familyName: null,
  });
}

/** The resolved callers of the test principals (what the IdentityResolver would give). */
export const CALLERS: ReadonlyMap<PrincipalId, Caller> = new Map([
  [ALICE, person(ALICE, "usr_alice", "alice@example.com", "Alice")],
  [BOB, person(BOB, "usr_bob", "bob@example.com", "Bob")],
  [LEAD, person(LEAD, "usr_lead", "lead@example.com", null)],
]);

/** The invocation context of a message from `who` (optionally with their JWT). */
export function contextFor(who: PrincipalId, jwt: string | null = null): InvocationContext {
  const caller = CALLERS.get(who);
  if (caller === undefined) throw new Error(`no test caller for ${who}`);
  return { caller, callerToken: jwt === null ? null : CallerToken.of(jwt), workloadAccessToken: null };
}

/** Deliver a message as its sender (the way the AgentCore server hands it to the runner). */
export function send(runner: SessionRunner, message: Incoming, jwt: string | null = null): Promise<Reply> {
  return runner.handle(message, contextFor(message.sender, jwt));
}

// ---------------------------------------------------------------- scripted model (faux provider)

export type ToolCallSpec = readonly [name: string, args: JsonObject];

/** One model call: tool calls and/or text, optional exact usage, or a provider error. */
export type Turn = {
  readonly tools?: readonly ToolCallSpec[];
  readonly text?: string;
  /** Replaces faux's estimated usage for this call. */
  readonly usage?: { readonly input: number; readonly output: number };
  readonly error?: string;
  /** Runs when the model is called (e.g. to deliver a message mid-run). */
  readonly onCall?: () => void | Promise<void>;
};

/** Text of every message in a model request (what the model "saw"). */
function contextText(context: TranscriptContext): string {
  return JSON.stringify(context.messages);
}

export class ScriptedModel {
  readonly model: Model<string>;
  readonly provider: ReturnType<PiAi["createProvider"]>;
  /** The request context of each model call. */
  readonly seen: string[] = [];
  #calls = 0;

  constructor(turns: readonly Turn[]) {
    const core = piAi.createFauxCore({
      provider: "faux",
      // Faux prices are irrelevant: the org guard prices usage from config/agent.toml.
      models: [{ id: "faux-1", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }],
    });
    core.setResponses(
      turns.map((turn) => async (context: TranscriptContext): Promise<AssistantMessage> => {
        this.seen.push(contextText(context));
        await turn.onCall?.();
        if (turn.error !== undefined) {
          return piAi.fauxAssistantMessage([], { stopReason: "error", errorMessage: turn.error });
        }
        const blocks = [
          ...(turn.text === undefined ? [] : [piAi.fauxText(turn.text)]),
          ...(turn.tools ?? []).map(([name, args]) => piAi.fauxToolCall(name, args)),
        ];
        return piAi.fauxAssistantMessage(blocks, { stopReason: turn.tools === undefined ? "stop" : "toolUse" });
      }),
    );
    const withUsage = <T extends StreamFunction<string, never>>(stream: T): T =>
      ((model: Model<string>, context: TranscriptContext, options: never): AssistantMessageEventStream => {
        const usage = turns[this.#calls]?.usage;
        this.#calls += 1;
        const inner = stream(model, context, options);
        return usage === undefined ? inner : overrideUsage(inner, usage);
      }) as T;
    this.provider = piAi.createProvider({
      id: core.provider,
      auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
      models: core.models,
      api: { stream: withUsage(core.stream), streamSimple: withUsage(core.streamSimple) },
    });
    this.model = core.getModel();
  }

  /** Number of model calls pi made. */
  get calls(): number {
    return this.#calls;
  }
}

type PiAi = typeof piAi;

function overrideUsage(inner: AssistantMessageEventStream, usage: { input: number; output: number }): AssistantMessageEventStream {
  const outer = piAi.createAssistantMessageEventStream();
  const patch = (message: AssistantMessage): AssistantMessage => ({
    ...message,
    usage: {
      ...message.usage,
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: usage.input + usage.output,
    },
  });
  void (async () => {
    for await (const event of inner) {
      if (event.type === "done") {
        const message = patch(event.message);
        outer.push({ ...event, message });
        outer.end(message);
        return;
      }
      if (event.type === "error") {
        const message = patch(event.error);
        outer.push({ ...event, error: message });
        outer.end(message);
        return;
      }
      outer.push(event);
    }
  })();
  return outer;
}

// ---------------------------------------------------------------- runner

/** A tool caller for tests that must not reach any tool. */
export const NO_TOOLS: ToolCaller = {
  callTool: async () => err({ kind: "transport", detail: "no tools server in this test" }),
};

export type Harness = {
  readonly runner: SessionRunner;
  readonly model: ScriptedModel;
  readonly audit: MemoryAuditSink;
};

export type RunnerSetup = {
  readonly turns: readonly Turn[];
  readonly env?: Env;
  readonly kill?: boolean;
  readonly caller?: ToolCaller;
};

/** Everything a SessionRunner needs except the session id (what app.ts's Registry takes). */
export async function testRunnerOptions(setup: RunnerSetup): Promise<{
  readonly options: Omit<SessionRunnerOptions, "session">;
  readonly model: ScriptedModel;
  readonly audit: MemoryAuditSink;
}> {
  const model = new ScriptedModel(setup.turns);
  const modelRuntime = await ModelRuntime.create({ credentials: new piAi.InMemoryCredentialStore(), modelsPath: null });
  modelRuntime.registerNativeProvider(model.provider);
  const audit = new MemoryAuditSink();
  const options = {
    settings: unwrap(loadSettings(setup.env ?? {}, ROOT)),
    modelRuntime,
    model: model.model,
    caller: setup.caller ?? NO_TOOLS,
    clock: new FakeClock(),
    audit,
    killSwitch: () => setup.kill ?? false,
    workDir: mkdtempSync(join(tmpdir(), "pi-harness-test-")),
    guardrail: null,
    piSettings: { retry: { enabled: false } }, // a scripted error must fail the run, not be retried
    warn: () => undefined,
  };
  return { options, model, audit };
}

export async function makeRunner(setup: RunnerSetup): Promise<Harness> {
  const { options, model, audit } = await testRunnerOptions(setup);
  const runner = await SessionRunner.create({ ...options, session: SESSION });
  return { runner, model, audit };
}

// ---------------------------------------------------------------- tools MCP server

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`MCP server exited with ${child.exitCode}`);
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`MCP server did not listen on ${port} within ${timeoutMs} ms`);
}

export type ToolsServer = { readonly url: string; stop(): Promise<void> };

/** Start `python -m generic_tools.shell.mcp_server` (fresh in-memory ticket store) on a free port. */
export async function startToolsServer(): Promise<ToolsServer> {
  const port = await freePort();
  const child = spawn(
    "uv",
    ["run", "--directory", TOOLS_DIR, "--extra", "mcp", "python", "-m", "generic_tools.shell.mcp_server"],
    { env: { ...process.env, MCP_PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  try {
    await waitForPort(port, child, 90_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw new Error(`${String(error)}\n${stderr.slice(-2000)}`);
  }
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    async stop() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    },
  };
}

// ---------------------------------------------------------------- fake MCP endpoint (header capture)

export type McpRequestSeen = {
  readonly method: string;
  /** The `Authorization` header as received, or null. */
  readonly authorization: string | null;
  readonly params: unknown;
};

export type FakeMcpServer = { readonly url: string; readonly seen: readonly McpRequestSeen[]; reset(): void; stop(): Promise<void> };

/**
 * A minimal Streamable-HTTP MCP endpoint standing in for AgentCore Gateway: it records the
 * `Authorization` header of every JSON-RPC message and answers `tools/call` with `<tool> ok`.
 */
export async function startFakeMcpServer(): Promise<FakeMcpServer> {
  const seen: McpRequestSeen[] = [];
  let sessions = 0;
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: unknown };
      const auth = request.headers.authorization;
      seen.push({ method: message.method, authorization: typeof auth === "string" ? auth : null, params: message.params });
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const reply = (result: unknown, headers: Record<string, string> = {}): void => {
        response.writeHead(200, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      };
      switch (message.method) {
        case "initialize":
          sessions += 1;
          reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake-gateway" } }, { "mcp-session-id": `s${sessions}` });
          return;
        case "tools/call": {
          const name = (message.params as { name?: unknown } | undefined)?.name;
          reply({ content: [{ type: "text", text: `${String(name)} ok` }] });
          return;
        }
        default:
          reply({ tools: [] });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seen,
    reset: () => void seen.splice(0),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** An unsigned JWT with the given claims (AgentCore Runtime validates real ones before us). */
export function testJwt(claims: Record<string, unknown>): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2lnbmF0dXJl`;
}
