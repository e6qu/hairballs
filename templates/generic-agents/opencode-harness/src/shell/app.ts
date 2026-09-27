/**
 * AgentCore Runtime entrypoint (shell): `GET /ping` + `POST /invocations` on 0.0.0.0:8080, with the
 * same request/response contract as the Python variants (`@org/agents` agentcoreServer).
 *
 * The adapter starts `opencode serve` lazily on the first prompt (one per microVM), with that
 * caller's Auth0 JWT for the tools MCP server, and drives it over loopback HTTP; see Registry,
 * opencodeHost.ts and runner.ts.
 *
 *   node src/shell/app.ts            # needs TOOLS_MCP_URL (default http://127.0.0.1:8000/mcp)
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AuditSink,
  type CallerToken,
  type Clock,
  type Env,
  type Incoming,
  type InvocationContext,
  type InvocationHandler,
  JsonLinesAuditSink,
  identityResolverFrom,
  killSwitchFrom,
  loadSettings,
  type PrincipalId,
  refused,
  type Reply,
  type SessionId,
  type Settings,
  startAgentCoreServer,
  SystemClock,
  unwrap,
  assertNever,
} from "@org/agents";

import { ModelBackend } from "../domain.ts";
import { toolIdentity } from "../core/identity.ts";
import { TOOLS_SERVER } from "../core/permissions.ts";
import { opencodeBinary } from "./binary.ts";
import { OpencodeHost } from "./opencodeHost.ts";
import { SessionRunner } from "./runner.ts";

export const PLUGIN_PATH = fileURLToPath(new URL("../plugin/orgGuard.ts", import.meta.url));
/** opencode agent name used in the generated config. */
export const AGENT = "org-generic";

export const NOTHING_ASKED_REASON = "nothing has been asked in this session yet";

export type RegistryOptions = {
  readonly settings: Settings;
  /** Builds the (single) opencode host; `mcpToken` is forwarded to the tools MCP server. */
  readonly host: (mcpToken: CallerToken | null) => OpencodeHost;
  readonly clock: Clock;
  readonly audit: AuditSink;
  readonly killSwitch: () => boolean;
};

/**
 * One runner per session; one opencode server per process (AgentCore: one microVM per session).
 *
 * opencode reads the MCP `Authorization` header once, at start. The server is therefore started
 * on the first prompt, with that caller's JWT, and the process is bound to that principal
 * (`core/identity.ts`): prompts from any other principal are refused, so no user's run ever
 * calls the Gateway with another user's token. Keep the runtime `maxLifetime` ≤ the Auth0
 * access-token lifetime (a refreshed token from the same user is not picked up).
 */
export class Registry {
  readonly #o: RegistryOptions;
  readonly #runners = new Map<SessionId, SessionRunner>();
  #host: OpencodeHost | null = null;
  #bound: PrincipalId | null = null;

  constructor(options: RegistryOptions) {
    this.#o = options;
  }

  get settings(): Settings {
    return this.#o.settings;
  }

  get host(): OpencodeHost | null {
    return this.#host;
  }

  /** The principal whose token the tools MCP connection carries (null before the first prompt). */
  get boundPrincipal(): PrincipalId | null {
    return this.#bound;
  }

  runner(session: SessionId, host: OpencodeHost): SessionRunner {
    let runner = this.#runners.get(session);
    if (runner === undefined) {
      runner = new SessionRunner({
        session,
        settings: this.#o.settings,
        host,
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

  /** `context.caller` is the sender's resolved identity (the AgentCore server's `IdentityResolver`). */
  async handle(session: SessionId, incoming: Incoming, context: InvocationContext): Promise<Reply> {
    const decision = toolIdentity(this.#bound, incoming);
    switch (decision.kind) {
      case "refuse":
        return refused(decision.reason);
      case "bind":
        this.#bound = decision.principal;
        this.#host ??= this.#o.host(context.callerToken);
        break;
      case "proceed":
        break;
      default:
        return assertNever(decision);
    }
    // A cancel or approval before any prompt: nothing can be running or pending yet.
    if (this.#host === null) return refused(NOTHING_ASKED_REASON);
    return this.runner(session, this.#host).handle(incoming, context.caller);
  }

  async stop(): Promise<void> {
    await this.#host?.stop();
  }
}

/** The `/invocations` handler: the context carries the caller's JWT (see `Registry`). */
export function invocationHandler(registry: Registry): InvocationHandler {
  return (session, incoming, context) => registry.handle(session, incoming, context);
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
    host: (mcpToken) =>
      new OpencodeHost({
        binary,
        settings,
        agent: AGENT,
        backend,
        server: TOOLS_SERVER,
        toolsMcpUrl: env["TOOLS_MCP_URL"] ?? "http://127.0.0.1:8000/mcp",
        mcpToken,
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
  // Requests without a token act as LOCAL_USER (local runs); REQUIRE_TOKEN=true refuses them.
  const identity = identityResolverFrom(registry.settings.identity, process.env);
  const server = await startAgentCoreServer({ handler: invocationHandler(registry), identity });
  console.error(`generic opencode agent listening on ${server.url}`);
  const shutdown = (): void => {
    void server
      .close()
      .finally(() => registry.stop())
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
