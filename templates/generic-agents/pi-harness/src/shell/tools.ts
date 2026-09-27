/**
 * The generic tools as pi tools, executed through the tools MCP server (shell).
 *
 * pi has no MCP client, so each tool is registered with `pi.registerTool` and its `execute` calls
 * `tools/call` on the category MCP server (locally `python -m generic_tools.shell.mcp_server`, in
 * production the AgentCore Gateway URL) through `@org/agents`' `McpClient`.
 *
 * The TypeBox parameter schemas are framework schema (what pi shows the model and validates); they
 * live only here. Arguments are forwarded as untyped data and parsed by the tools service. For
 * `create_ticket` the harness (never the model) sets `requested_by` and `idempotency_key`.
 *
 * Every call carries the run owner's Auth0 JWT (`CallerToken`) as `Authorization: Bearer …`, so
 * AgentCore Gateway (and its Cedar policy) sees the user, not the agent. `McpToolGateway` keeps
 * one MCP client (and MCP session) per token.
 */

import {
  type CallerToken,
  describeMcpError,
  expectObject,
  fingerprintArguments,
  idempotencyKey,
  McpClient,
  type McpCallResult,
  type McpError,
  type Parsed,
  type PrincipalId,
  type Result,
  type SessionId,
  ToolName,
} from "@org/agents";

import type { ToolOutcome } from "../core/domain.ts";
import type { PiAi } from "./piAi.ts";

type TSchema = ReturnType<PiAi["Type"]["Object"]>;

export type GenericTool = {
  readonly name: ToolName;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  /** Fields the model may set; anything else in the model's arguments is dropped. */
  readonly argumentNames: readonly string[];
  /** The harness adds `requested_by` (the run's principal) and `idempotency_key`. */
  readonly harnessIdentity: boolean;
};

/**
 * Anything that can call an MCP tool on behalf of a caller (`McpToolGateway`, or a fake in tests).
 * `token` is the run owner's JWT, or `null` locally (no `Authorization` header).
 */
export type ToolCaller = {
  callTool(name: ToolName, args: unknown, token: CallerToken | null): Promise<Result<McpCallResult, McpError>>;
};

/** Who a call is made for: the run owner (and their token), in this session. */
export type CallIdentity = {
  readonly session: SessionId;
  readonly principal: PrincipalId;
  readonly callerToken: CallerToken | null;
};

/**
 * The production `ToolCaller`: the tools MCP server / AgentCore Gateway, one `McpClient` per
 * caller token (a Gateway MCP session belongs to one identity). Tokens rotate, so only the most
 * recently used `maxClients` are kept. The token is only ever sent as a header, never logged.
 */
export class McpToolGateway implements ToolCaller {
  readonly #url: string;
  readonly #clientInfo: { readonly name: string; readonly version: string };
  readonly #maxClients: number;
  readonly #clients = new Map<CallerToken | null, McpClient>();

  constructor(options: {
    readonly url: string;
    readonly clientInfo: { readonly name: string; readonly version: string };
    readonly maxClients?: number;
  }) {
    this.#url = options.url;
    this.#clientInfo = options.clientInfo;
    this.#maxClients = options.maxClients ?? 16;
  }

  callTool(name: ToolName, args: unknown, token: CallerToken | null): Promise<Result<McpCallResult, McpError>> {
    return this.#client(token).callTool(name, args);
  }

  #client(token: CallerToken | null): McpClient {
    let client = this.#clients.get(token);
    if (client === undefined) {
      client = new McpClient({
        url: this.#url,
        clientInfo: this.#clientInfo,
        ...(token === null ? {} : { bearerToken: token }),
      });
    } else {
      this.#clients.delete(token); // re-inserted below: most recently used last
    }
    this.#clients.set(token, client);
    for (const oldest of this.#clients.keys()) {
      if (this.#clients.size <= this.#maxClients) break;
      this.#clients.delete(oldest);
    }
    return client;
  }
}

// Descriptions match generic_tools.shell.service.TOOL_DESCRIPTIONS (checked by test/tools.test.ts).
export function genericTools(Type: PiAi["Type"]): readonly GenericTool[] {
  return [
    {
      name: ToolName.of("calculate"),
      label: "Calculate",
      description: "Evaluate an arithmetic expression exactly (decimals; + - * / and parentheses).",
      parameters: Type.Object({ expression: Type.String({ description: "e.g. (180 * 3) + 12.50" }) }),
      argumentNames: ["expression"],
      harnessIdentity: false,
    },
    {
      name: ToolName.of("search_knowledge"),
      label: "Search knowledge",
      description: "Search the internal knowledge base and return the most relevant passages.",
      parameters: Type.Object({
        query: Type.String(),
        max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3 })),
      }),
      argumentNames: ["query", "max_results"],
      harnessIdentity: false,
    },
    {
      name: ToolName.of("create_ticket"),
      label: "Create ticket",
      description: "Create a service-desk ticket. Changes external state; requires human approval.",
      parameters: Type.Object({
        title: Type.String(),
        description: Type.String(),
        priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")])),
      }),
      argumentNames: ["title", "description", "priority"],
      harnessIdentity: true,
    },
    {
      name: ToolName.of("get_ticket"),
      label: "Get ticket",
      description: "Fetch a service-desk ticket by id (e.g. TCK-000001).",
      parameters: Type.Object({ ticket_id: Type.String() }),
      argumentNames: ["ticket_id"],
      harnessIdentity: false,
    },
  ];
}

/**
 * The `tools/call` arguments: the model's fields the tool declares, plus (for side-effecting
 * tools) the principal and an idempotency key derived from the session and those fields.
 */
export function mcpArguments(tool: GenericTool, modelArguments: unknown, identity: CallIdentity): Parsed<Record<string, unknown>> {
  const fields = expectObject(modelArguments, "$.arguments");
  if (fields.kind === "err") return fields;
  const picked: Record<string, unknown> = {};
  for (const name of tool.argumentNames) {
    if (Object.hasOwn(fields.value, name)) picked[name] = fields.value[name];
  }
  if (!tool.harnessIdentity) return { kind: "ok", value: picked };
  const key = idempotencyKey(identity.session, tool.name, fingerprintArguments(picked));
  return { kind: "ok", value: { ...picked, requested_by: identity.principal, idempotency_key: key } };
}

export async function invokeTool(
  caller: ToolCaller,
  tool: GenericTool,
  modelArguments: unknown,
  identity: CallIdentity,
): Promise<ToolOutcome> {
  const args = mcpArguments(tool, modelArguments, identity);
  if (args.kind === "err") return { kind: "error", text: `invalid arguments: ${args.error.message}` };
  const result = await caller.callTool(tool.name, args.value, identity.callerToken);
  if (result.kind === "err") return { kind: "error", text: `${tool.name} is unavailable: ${describeMcpError(result.error)}` };
  return result.value.kind === "ok" ? { kind: "ok", text: result.value.text } : { kind: "error", text: result.value.text };
}
