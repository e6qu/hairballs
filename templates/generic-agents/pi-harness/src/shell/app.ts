/**
 * AgentCore Runtime entrypoint (shell): `GET /ping` + `POST /invocations` on 0.0.0.0:8080 via
 * `@org/agents`' `startAgentCoreServer`, with the same request/response JSON as the Python
 * variants. One pi AgentSession per AgentCore session (one microVM per session in production).
 *
 * Run locally:  node src/shell/app.ts   (needs AWS credentials for Bedrock and the tools MCP server)
 * Deploy:       agentcore deploy (see README)
 */

import "./offline.ts"; // first: PI_OFFLINE & co. must be set before pi runs

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type AuditSink,
  type Clock,
  type Env,
  identityResolverFrom,
  type InvocationHandler,
  JsonLinesAuditSink,
  killSwitchFrom,
  loadSettings,
  type SessionId,
  type Settings,
  startAgentCoreServer,
  SystemClock,
  unwrap,
} from "@org/agents";

import { Guardrail } from "../core/domain.ts";
import { instanceMetadataSource, refreshEnabled, startCredentialRefresh } from "./credentials.ts";
import { bedrockModel, createModelRuntime, loadPiModelSettings, type PiModel } from "./model.ts";
import { SessionRunner, type SessionRunnerOptions } from "./runner.ts";
import { McpToolGateway, type ToolCaller } from "./tools.ts";

export const DEFAULT_TOOLS_MCP_URL = "http://127.0.0.1:8000/mcp";

export type RegistryOptions = Omit<SessionRunnerOptions, "session">;

/** One runner per session. AgentCore gives each session its own microVM, so this stays small. */
export class Registry {
  readonly #options: RegistryOptions;
  readonly #runners = new Map<SessionId, Promise<SessionRunner>>();

  constructor(options: RegistryOptions) {
    this.#options = options;
  }

  get settings(): Settings {
    return this.#options.settings;
  }

  runner(session: SessionId): Promise<SessionRunner> {
    let runner = this.#runners.get(session);
    if (runner === undefined) {
      runner = SessionRunner.create({ ...this.#options, session });
      // A failed creation is not cached: the next message retries.
      runner.catch(() => this.#runners.delete(session));
      this.#runners.set(session, runner);
    }
    return runner;
  }
}

export function invocationHandler(registry: Registry): InvocationHandler {
  // The context carries the resolved caller and their JWT: the runner forwards the JWT to the
  // Gateway on tool calls and records the caller as the requester.
  return async (session, incoming, context) => (await registry.runner(session)).handle(incoming, context);
}

/** Production wiring: Bedrock model, tools MCP server (or Gateway), system clock, stdout audit. */
export async function productionRegistry(env: Env): Promise<Registry> {
  const settings: Settings = unwrap(loadSettings(env));
  const piModelSettings = unwrap(loadPiModelSettings(env));
  const guardrail = unwrap(Guardrail.fromEnv(env));
  const clock: Clock = new SystemClock();
  if (refreshEnabled(env)) {
    await startCredentialRefresh({ source: await instanceMetadataSource(), env: process.env, clock });
  }
  const modelRuntime: ModelRuntime = await createModelRuntime();
  const model: PiModel = bedrockModel(modelRuntime, settings.agent, piModelSettings, env);
  const caller: ToolCaller = new McpToolGateway({
    url: env["TOOLS_MCP_URL"] ?? DEFAULT_TOOLS_MCP_URL,
    clientInfo: { name: settings.agent.name, version: "0.1.0" },
  });
  const audit: AuditSink = new JsonLinesAuditSink();
  return new Registry({
    settings,
    modelRuntime,
    model,
    caller,
    clock,
    audit,
    killSwitch: () => killSwitchFrom(process.env),
    workDir: env["AGENT_WORKDIR"] ?? mkdtempSync(join(tmpdir(), "pi-agent-")),
    guardrail,
  });
}

async function main(): Promise<void> {
  const registry = await productionRegistry(process.env);
  // Requests without a token act as LOCAL_USER (local runs); REQUIRE_TOKEN=true refuses them.
  const identity = identityResolverFrom(registry.settings.identity, process.env);
  const server = await startAgentCoreServer({ handler: invocationHandler(registry), identity });
  console.error(`generic pi agent listening on ${server.url}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
