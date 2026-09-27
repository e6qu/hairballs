/**
 * Rendering the opencode configuration (outbound JSON, passed as `OPENCODE_CONFIG_CONTENT`).
 *
 * Generated per microVM from `config/agent.toml` + the system prompt + the model backend + the
 * tools MCP endpoint, so the permission baseline can never drift from the org `ToolPolicy`. Keys
 * and semantics verified against opencode 1.18.31 (`packages/core/src/v1/config/*.ts`,
 * `config/config.ts`, `provider/provider.ts`).
 */

import type { Settings } from "@org/agents";

import type { ModelBackend } from "../domain.ts";
import { type McpServerName, type PermissionRule, permissionRules } from "../core/permissions.ts";

/** opencode's config-level permission object, keyed by permission; the position of a key is its
 * LAST occurrence in `rules`, so the object keeps the ruleset's last-match-wins semantics. */
export function renderPermission(rules: readonly PermissionRule[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (rule.pattern !== "*") throw new RangeError("only '*' patterns are rendered at config level");
    delete out[rule.permission];
    out[rule.permission] = rule.action;
  }
  return out;
}

/** Config key of the model. Keep "claude" in it: opencode enables Bedrock prompt caching only for
 * model ids containing claude/anthropic. */
export const MODEL_KEY = "claude-org";

export type ConfigInput = {
  readonly settings: Settings;
  /** opencode agent name (the only primary agent). */
  readonly agent: string;
  readonly backend: ModelBackend;
  readonly server: McpServerName;
  readonly toolsMcpUrl: string;
  /** Forwarded caller credentials for the tools MCP server (AgentCore Gateway), e.g. `Bearer <jwt>`. */
  readonly mcpAuthorization: string | null;
  readonly pluginPath: string;
};

function provider(backend: ModelBackend, settings: Settings): readonly [string, Record<string, unknown>] {
  const model = {
    id: backend.modelId,
    name: `${settings.agent.name} model`,
    tool_call: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    limit: { context: 200_000, output: 8_192 },
  };
  switch (backend.kind) {
    case "bedrock": {
      const options: Record<string, unknown> = { region: backend.region, profile: backend.profile };
      if (backend.endpoint !== null) options["endpoint"] = backend.endpoint;
      return [
        "amazon-bedrock",
        {
          // Explicit: the pinned (empty) model catalog does not name the SDK package. Bundled in
          // the opencode binary (provider.ts BUNDLED_PROVIDERS), so nothing is installed at runtime.
          npm: "@ai-sdk/amazon-bedrock",
          options,
          whitelist: [MODEL_KEY],
          models: { [MODEL_KEY]: model },
        },
      ];
    }
    case "openai_compatible":
      return [
        "orgtest",
        {
          npm: "@ai-sdk/openai-compatible", // bundled in the binary as well
          name: "org test model",
          options: { baseURL: backend.baseUrl, apiKey: "not-a-secret" },
          whitelist: [MODEL_KEY],
          models: { [MODEL_KEY]: model },
        },
      ];
  }
}

export function renderConfig(input: ConfigInput): Record<string, unknown> {
  const { settings, agent, backend } = input;
  const [providerId, providerConfig] = provider(backend, settings);
  const permission = renderPermission(permissionRules(settings.agent.tools, input.server));
  const mcp: Record<string, unknown> = {
    type: "remote",
    url: input.toolsMcpUrl,
    oauth: false, // credentials are forwarded, never negotiated by opencode
    timeout: 30_000,
  };
  if (input.mcpAuthorization !== null) mcp["headers"] = { Authorization: input.mcpAuthorization };
  return {
    $schema: "https://opencode.ai/config.json",
    username: "agent",
    enabled_providers: [providerId],
    model: `${providerId}/${MODEL_KEY}`,
    small_model: `${providerId}/${MODEL_KEY}`,
    provider: { [providerId]: providerConfig },
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    instructions: [],
    lsp: false,
    formatter: false,
    compaction: { auto: true, prune: true },
    experimental: {
      // A rejected approval becomes a tool error the model can explain, instead of ending the loop.
      continue_loop_on_deny: true,
    },
    mcp: { [input.server]: mcp },
    plugin: [input.pluginPath],
    default_agent: agent,
    agent: {
      build: { disable: true },
      plan: { disable: true },
      general: { disable: true },
      explore: { disable: true },
      [agent]: {
        mode: "primary",
        description: "Org generic assistant (deny-by-default tools via the org guard)",
        prompt: settings.systemPrompt,
        // Soft limit only (opencode appends a "max steps" message); the hard cap is the org guard.
        steps: settings.agent.limits.maxTurns,
        permission,
      },
    },
    permission,
  };
}
