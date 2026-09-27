/**
 * AgentCore Runtime entrypoint (shell): `GET /ping` + `POST /invocations` on 0.0.0.0:8080, with the
 * same request/response contract as the Python variants (`@org/agents` agentcoreServer).
 *
 * The adapter starts `opencode serve` lazily on the first invocation (one per microVM) and drives
 * it over loopback HTTP; see opencodeHost.ts and runner.ts.
 *
 *   node src/shell/app.ts            # needs TOOLS_MCP_URL (default http://127.0.0.1:8000/mcp)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentCoreRequestListener,
  type AuditSink,
  type Clock,
  type Env,
  type Incoming,
  JsonLinesAuditSink,
  killSwitchFrom,
  loadSettings,
  type Reply,
  type SessionId,
  type Settings,
  SystemClock,
  unwrap,
} from "@org/agents";

import { ModelBackend } from "../domain.ts";
import { TOOLS_SERVER } from "../core/permissions.ts";
import { opencodeBinary } from "./binary.ts";
import { OpencodeHost } from "./opencodeHost.ts";
import { SessionRunner } from "./runner.ts";

export const PLUGIN_PATH = fileURLToPath(new URL("../plugin/orgGuard.ts", import.meta.url));
/** opencode agent name used in the generated config. */
export const AGENT = "org-generic";

/** The caller's `Authorization` header, forwarded to the tools MCP server (AgentCore Gateway). */
export const requestAuthorization = new AsyncLocalStorage<string | null>();

export type RegistryOptions = {
  readonly settings: Settings;
  readonly host: (mcpAuthorization: string | null) => OpencodeHost;
  readonly clock: Clock;
  readonly audit: AuditSink;
  readonly killSwitch: () => boolean;
};

/** One runner per session; one opencode server per process (AgentCore: one microVM per session). */
export class Registry {
  readonly #o: RegistryOptions;
  readonly #runners = new Map<SessionId, SessionRunner>();
  #host: OpencodeHost | null = null;

  constructor(options: RegistryOptions) {
    this.#o = options;
  }

  get host(): OpencodeHost | null {
    return this.#host;
  }

  runner(session: SessionId, mcpAuthorization: string | null): SessionRunner {
    let runner = this.#runners.get(session);
    if (runner === undefined) {
      // The first caller's credentials are used for the MCP connection for the server's lifetime
      // (keep runtime maxLifetime ≤ the token lifetime; see README "Gaps").
      this.#host ??= this.#o.host(mcpAuthorization);
      runner = new SessionRunner({
        session,
        settings: this.#o.settings,
        host: this.#host,
        agent: AGENT,
        server: TOOLS_SERVER,
        clock: this.#o.clock,
        audit: this.#o.audit,
        killSwitch: this.#o.killSwitch,
      });
      this.#runners.set(session, runner);
    }
    return runner;
  }

  handle(session: SessionId, incoming: Incoming): Promise<Reply> {
    return this.runner(session, requestAuthorization.getStore() ?? null).handle(incoming);
  }

  async stop(): Promise<void> {
    await this.#host?.stop();
  }
}

export function productionRegistry(env: Env): Registry {
  const home = env["AGENT_HOME"] ?? process.cwd();
  const settings = unwrap(loadSettings(env, home));
  const backend = ModelBackend.bedrock(
    settings.agent.modelId,
    settings.agent.region,
    env["AWS_PROFILE"] ?? "agentcore",
    env["BEDROCK_ENDPOINT"] ?? null,
  );
  const binary = opencodeBinary(env);
  return new Registry({
    settings,
    host: (mcpAuthorization) =>
      new OpencodeHost({
        binary,
        settings,
        agent: AGENT,
        backend,
        server: TOOLS_SERVER,
        toolsMcpUrl: env["TOOLS_MCP_URL"] ?? "http://127.0.0.1:8000/mcp",
        mcpAuthorization,
        pluginPath: PLUGIN_PATH,
        modelsPath: join(home, "config", "opencode-models.json"),
        env,
        logs: env["OPENCODE_LOGS"] === "1",
      }),
    clock: new SystemClock(),
    audit: new JsonLinesAuditSink(),
    killSwitch: () => killSwitchFrom(process.env),
  });
}

async function main(): Promise<void> {
  const registry = productionRegistry(process.env);
  // agentCoreRequestListener is the same contract startAgentCoreServer serves; it is composed here
  // so the caller's Authorization header can be forwarded to the MCP server (the shared handler
  // signature does not carry headers).
  const { listener } = agentCoreRequestListener((session, incoming) => registry.handle(session, incoming));
  const server = createServer((request, response) => {
    const auth = request.headers.authorization;
    requestAuthorization.run(typeof auth === "string" ? auth : null, () => listener(request, response));
  });
  server.listen(8080, "0.0.0.0", () => console.error("generic opencode agent listening on 0.0.0.0:8080"));
  const shutdown = (): void => {
    server.close();
    registry.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
