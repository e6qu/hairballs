/** Pure core: permission ruleset from the org tool policy, tool-name mapping, ask routing. */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  fingerprintArguments,
  PrincipalId,
  SessionId,
  ToolName,
  ToolPattern,
  type ToolPolicy,
} from "@org/agents";

import {
  decideAsk,
  McpServerName,
  mcpToolKey,
  orgToolName,
  type PermissionRule,
  permissionRules,
  sideEffectArguments,
  TOOLS_SERVER,
} from "../src/core/permissions.ts";
import { renderPermission } from "../src/shell/opencodeConfig.ts";

const policy = (allowed: string[], approval: string[]): ToolPolicy => ({
  allowed: allowed.map((p) => ToolPattern.of(p)),
  approvalRequired: approval.map((p) => ToolPattern.of(p)),
});
const ORG = policy(["calculate", "search_knowledge", "get_ticket", "create_ticket"], ["create_ticket"]);

/** opencode's evaluation (permission/index.ts `evaluate`): last matching rule wins, default ask. */
function glob(pattern: string, value: string): boolean {
  const body = [...pattern].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\-]/g, "\\$&")));
  return new RegExp(`^${body.join("")}$`, "s").test(value);
}
function evaluate(permission: string, rules: readonly PermissionRule[]): string {
  return rules.findLast((r) => glob(r.permission, permission) && glob(r.pattern, "*"))?.action ?? "ask";
}
function evaluateConfig(permission: string, config: Record<string, string>): string {
  const rules = Object.entries(config).map(([p, action]) => ({ permission: p, pattern: "*", action }) as PermissionRule);
  return evaluate(permission, rules);
}

describe("permission ruleset (deny by default)", () => {
  const rules = permissionRules(ORG, TOOLS_SERVER);

  test("org MCP tools are allowed, approval tools ask, everything else is denied", () => {
    assert.equal(evaluate("gw_calculate", rules), "allow");
    assert.equal(evaluate("gw_search_knowledge", rules), "allow");
    assert.equal(evaluate("gw_create_ticket", rules), "ask");
    assert.equal(evaluate("gw_delete_everything", rules), "deny");
    for (const builtin of ["bash", "edit", "read", "webfetch", "websearch", "task", "skill", "external_directory", "question"]) {
      assert.equal(evaluate(builtin, rules), "deny", builtin);
    }
    assert.equal(evaluate("some_new_builtin", rules), "deny");
    assert.equal(evaluate("doom_loop", rules), "ask");
    assert.equal(evaluate("invalid", rules), "allow");
  });

  test("the config-level object keeps last-match-wins semantics for duplicate keys", () => {
    const tricky = permissionRules(policy(["create_ticket", "*"], ["create_ticket"]), TOOLS_SERVER);
    assert.equal(evaluate("gw_create_ticket", tricky), "ask");
    assert.equal(evaluateConfig("gw_create_ticket", renderPermission(tricky)), "ask");
    assert.equal(evaluateConfig("gw_calculate", renderPermission(tricky)), "allow");
    assert.equal(evaluateConfig("bash", renderPermission(tricky)), "deny");
    assert.equal(evaluateConfig("gw_create_ticket", renderPermission(rules)), "ask");
  });

  test("MCP tool keys follow opencode's sanitization; globs are kept", () => {
    assert.equal(mcpToolKey(TOOLS_SERVER, ToolPattern.of("create_ticket")), "gw_create_ticket");
    assert.equal(mcpToolKey(TOOLS_SERVER, ToolPattern.of("tickets.*")), "gw_tickets_*");
    assert.equal(mcpToolKey(McpServerName.of("gw"), ToolName.of("a-b")), "gw_a-b");
  });
});

describe("tool names and permission requests", () => {
  test("opencode tool keys map back to org tool names", () => {
    assert.equal(orgToolName("gw_create_ticket", {}, TOOLS_SERVER), "create_ticket");
    assert.equal(orgToolName("bash", {}, TOOLS_SERVER), "bash");
    assert.equal(orgToolName("invalid", { tool: "delete_everything", error: "x" }, TOOLS_SERVER), "delete_everything");
    assert.equal(orgToolName("invalid", { tool: "gw_calculate" }, TOOLS_SERVER), "calculate");
    assert.equal(orgToolName("invalid", {}, TOOLS_SERVER), null);
    assert.equal(orgToolName("invalid", { tool: "rm -rf /" }, TOOLS_SERVER), null);
  });

  test("asks are routed to approvers only for approval-required org tools", () => {
    assert.deepEqual(decideAsk("gw_create_ticket", ORG, TOOLS_SERVER), {
      kind: "route_to_approvers",
      tool: "create_ticket",
    });
    assert.equal(decideAsk("gw_calculate", ORG, TOOLS_SERVER).kind, "reject");
    assert.equal(decideAsk("gw_drop_tables", ORG, TOOLS_SERVER).kind, "reject");
    assert.equal(decideAsk("bash", ORG, TOOLS_SERVER).kind, "reject");
    assert.equal(decideAsk("external_directory", ORG, TOOLS_SERVER).kind, "reject");
    assert.equal(decideAsk("doom_loop", ORG, TOOLS_SERVER).kind, "reject_loop");
  });

  test("side-effect arguments: principal from the guard, idempotency key from session + canonical args", () => {
    const session = SessionId.of("thread-1");
    const tool = ToolName.of("create_ticket");
    const alice = PrincipalId.of("auth0|alice");
    const a = sideEffectArguments(session, tool, fingerprintArguments({ title: "x", description: "y" }), alice);
    const b = sideEffectArguments(session, tool, fingerprintArguments({ description: "y", title: "x" }), alice);
    const other = sideEffectArguments(SessionId.of("thread-2"), tool, fingerprintArguments({ title: "x", description: "y" }), alice);
    assert.equal(a["requested_by"], "auth0|alice");
    assert.match(a["idempotency_key"] ?? "", /^idem-[0-9a-f]{32}$/);
    assert.equal(a["idempotency_key"], b["idempotency_key"]);
    assert.notEqual(a["idempotency_key"], other["idempotency_key"]);
  });
});
