/** Agent configuration: parsed once from `config/agent.toml` plus environment overrides. */

import { readFileSync } from "node:fs";

import { parse as parseToml } from "smol-toml";

import { BusyPolicy } from "../core/messages.ts";
import { AwsRegion, Limits, ModelId, ModelPrice, ToolPolicy } from "../domain.ts";
import {
  attempt,
  expectNonEmptyString,
  expectObject,
  fail,
  field,
  fieldOr,
  must,
  type Parsed,
} from "../parsing.ts";

/** Environment variables as the shell sees them (`process.env`). */
export type Env = Readonly<Record<string, string | undefined>>;

// Environment variables that may override file values (deploy-time knobs in agentcore.json envVars).
const ENV_LIMIT_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["AGENT_MAX_TURNS", "max_turns"],
  ["AGENT_MAX_TOTAL_TOKENS", "max_total_tokens"],
  ["AGENT_MAX_USD", "max_usd"],
  ["AGENT_MAX_WALL_SECONDS", "max_wall_seconds"],
  ["AGENT_MAX_TOOL_CALLS", "max_tool_calls"],
];

export type AgentConfig = {
  readonly name: string;
  readonly modelId: ModelId;
  readonly region: AwsRegion;
  readonly price: ModelPrice;
  readonly limits: Limits;
  readonly tools: ToolPolicy;
  readonly busyPolicy: BusyPolicy;
};

/** Parse the TOML document (already loaded as untyped data) and apply env overrides. */
export function parseAgentConfig(raw: unknown, env: Env): Parsed<AgentConfig> {
  return attempt(() => {
    const doc = must(expectObject(raw, "$"));
    const agent = must(expectObject(must(field(doc, "agent", "$")), "$.agent"));
    const model = must(expectObject(must(field(doc, "model", "$")), "$.model"));

    const limitsRaw: Record<string, unknown> = {
      ...must(expectObject(must(field(doc, "limits", "$")), "$.limits")),
    };
    for (const [variable, key] of ENV_LIMIT_OVERRIDES) {
      const value = env[variable];
      if (value !== undefined) limitsRaw[key] = value;
    }

    const busyPolicy = must(BusyPolicy.parse(fieldOr(agent, "busy_policy", "steer"), "$.agent.busy_policy"));
    const name = must(expectNonEmptyString(must(field(agent, "name", "$.agent")), "$.agent.name", { maxLength: 48 }));
    const fileModelId = must(field(model, "id", "$.model"));
    const modelId = must(ModelId.parse(env["BEDROCK_MODEL_ID"] ?? fileModelId, "$.model.id"));
    const fileRegion = must(field(model, "region", "$.model"));
    const region = must(AwsRegion.parse(env["AWS_REGION"] ?? fileRegion, "$.model.region"));

    return {
      name,
      modelId,
      region,
      price: must(ModelPrice.parse(must(field(model, "price", "$.model")), "$.model.price")),
      limits: must(Limits.parse(limitsRaw, "$.limits")),
      tools: must(ToolPolicy.parse(must(field(doc, "tools", "$")), "$.tools")),
      busyPolicy,
    };
  });
}

/** Parse TOML text into untyped data; a syntax error is a ParseError at `$`. */
export function parseTomlText(text: string): Parsed<unknown> {
  return attempt(() => {
    try {
      return parseToml(text) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
      return must(fail("$", `is not valid TOML: ${message}`));
    }
  });
}

/** Read and parse a config file. File-system errors (missing file) are thrown: they are infrastructure. */
export function loadAgentConfig(path: string, env: Env): Parsed<AgentConfig> {
  const raw = parseTomlText(readFileSync(path, "utf8"));
  return raw.kind === "err" ? raw : parseAgentConfig(raw.value, env);
}

export function killSwitchFrom(env: Env): boolean {
  const value = (env["AGENT_KILL_SWITCH"] ?? "0").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}
