/**
 * opencode permissions from the org tool policy (pure).
 *
 * opencode evaluates permission rules **last match wins**; no match means `ask`, and a tool whose
 * last matching rule is `"*": deny` is hidden from the model (opencode `permission/index.ts`
 * `evaluate` / `disabled`). The ruleset below is deny-by-default:
 *
 *   1. `*` → deny, and every built-in tool → deny (this agent is not a coding agent);
 *   2. `invalid` → allow (opencode's error-reporting pseudo tool for unknown tool calls; the org
 *      guard plugin still checks the tool the model asked for);
 *   3. MCP tools of the tools server (`<server>_<tool>`) matching `[tools] allowed` → allow;
 *   4. tools matching `[tools] approval_required` → ask (answered by the adapter, never a human at
 *      a terminal);
 *   5. `doom_loop` → ask (the adapter rejects it and stops the run).
 *
 * The same `ToolPolicy` also drives the RunGuard in the adapter, so the two layers agree.
 */

import {
  assertNever,
  decideTool,
  type Fingerprint,
  idempotencyKey,
  type PrincipalId,
  type SessionId,
  ToolName,
  type ToolPattern,
  type ToolPolicy,
} from "@org/agents";

export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionRule = {
  readonly permission: string;
  readonly pattern: string;
  readonly action: PermissionAction;
};

/** Name of an MCP server in the opencode config; its tools appear to the model as `<name>_<tool>`. */
export type McpServerName = string & { readonly __brand: "McpServerName" };
export const McpServerName = {
  of(name: string): McpServerName {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(name)) throw new RangeError(`invalid MCP server name: ${name}`);
    return name as McpServerName;
  },
} as const;

/** The MCP server of the category tools (AgentCore Gateway in production). */
export const TOOLS_SERVER: McpServerName = McpServerName.of("gw");

/** opencode's name for the pseudo tool that reports an unknown / malformed tool call. */
export const INVALID_TOOL = "invalid";

/** Built-in opencode tools and permission keys, all denied for this (non-coding) agent. */
export const BUILTIN_PERMISSIONS: readonly string[] = [
  "bash",
  "edit",
  "read",
  "glob",
  "grep",
  "list",
  "lsp",
  "webfetch",
  "websearch",
  "codesearch",
  "task",
  "skill",
  "todowrite",
  "todoread",
  "question",
  "external_directory",
];

/** opencode sanitizes MCP tool names with `[^a-zA-Z0-9_-] → _` (`mcp/catalog.ts` `toolName`). */
function sanitize(text: string, keepGlob: boolean): string {
  return text.replace(keepGlob ? /[^a-zA-Z0-9_*?-]/g : /[^a-zA-Z0-9_-]/g, "_");
}

/** The opencode tool key (and permission name) of an MCP tool pattern, e.g. `gw_create_ticket`. */
export function mcpToolKey(server: McpServerName, pattern: ToolPattern | ToolName): string {
  return `${sanitize(server, false)}_${sanitize(pattern, true)}`;
}

export function permissionRules(policy: ToolPolicy, server: McpServerName): readonly PermissionRule[] {
  const rule = (permission: string, action: PermissionAction): PermissionRule => ({ permission, pattern: "*", action });
  return [
    rule("*", "deny"),
    ...BUILTIN_PERMISSIONS.map((name) => rule(name, "deny")),
    rule(INVALID_TOOL, "allow"),
    ...policy.allowed.map((pattern) => rule(mcpToolKey(server, pattern), "allow")),
    ...policy.approvalRequired.map((pattern) => rule(mcpToolKey(server, pattern), "ask")),
    rule("doom_loop", "ask"),
  ];
}

/**
 * The org tool name behind an opencode tool key: `gw_create_ticket` → `create_ticket`;
 * `invalid` → the tool the model actually asked for; built-ins keep their name (and are denied).
 * `null` when no valid tool name can be derived (the call is blocked).
 */
export function orgToolName(key: string, rawArgs: unknown, server: McpServerName): ToolName | null {
  let name = key;
  if (key === INVALID_TOOL) {
    const requested =
      typeof rawArgs === "object" && rawArgs !== null ? (rawArgs as Readonly<Record<string, unknown>>)["tool"] : undefined;
    if (typeof requested !== "string") return null;
    name = requested;
  }
  const prefix = `${sanitize(server, false)}_`;
  if (name.startsWith(prefix)) name = name.slice(prefix.length);
  return ToolName.is(name) ? name : null;
}

// ---------------------------------------------------------------- permission requests

export type ApprovalRoute = { readonly kind: "route_to_approvers"; readonly tool: ToolName };
export type RejectAsk = { readonly kind: "reject"; readonly reason: string };
export type RejectLoop = { readonly kind: "reject_loop"; readonly detail: string };
export type AskDecision = ApprovalRoute | RejectAsk | RejectLoop;

/**
 * What the adapter does with an opencode `permission.asked` request. Only tools that the org
 * policy marks as approval-required go to the approvers; opencode's doom-loop guard stops the run;
 * everything else is rejected.
 */
export function decideAsk(permission: string, policy: ToolPolicy, server: McpServerName): AskDecision {
  if (permission === "doom_loop") {
    return { kind: "reject_loop", detail: "opencode doom-loop guard: identical tool calls in one response" };
  }
  const prefix = `${sanitize(server, false)}_`;
  if (!permission.startsWith(prefix)) return { kind: "reject", reason: `'${permission}' is not an org tool` };
  const tool = orgToolName(permission, undefined, server);
  if (tool === null) return { kind: "reject", reason: `'${permission}' is not a valid tool name` };
  const decision = decideTool(tool, policy);
  switch (decision.kind) {
    case "needs_approval":
      return { kind: "route_to_approvers", tool };
    case "allowed":
      return { kind: "reject", reason: `tool '${tool}' does not need approval; unexpected permission request` };
    case "denied":
      return { kind: "reject", reason: decision.reason };
    default:
      return assertNever(decision);
  }
}

// ---------------------------------------------------------------- side-effect context

/**
 * Arguments the guard (not the model) sets on side-effecting tool calls: who asked for it, and an
 * idempotency key derived from the session, the tool and the model's canonical arguments, so a
 * retried or replayed call cannot create a second ticket.
 */
export function sideEffectArguments(
  session: SessionId,
  tool: ToolName,
  modelArguments: Fingerprint,
  requestedBy: PrincipalId,
): Readonly<Record<string, string>> {
  return {
    requested_by: requestedBy,
    idempotency_key: idempotencyKey(session, tool, modelArguments),
  };
}
