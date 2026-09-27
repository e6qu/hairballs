/**
 * The pi model runtime and the Bedrock model (shell).
 *
 * - Credentials: pi-ai's in-memory credential store, so nothing is read from or written to
 *   `~/.pi/agent/auth.json`; Bedrock uses the AWS credentials in the environment (refreshed from
 *   the runtime role on AgentCore, see credentials.ts). Never an `apiKey` for Bedrock: it switches
 *   pi to bearer-token mode and disables SigV4.
 * - Catalog: no `models.json`; the agent's model (in production a tagged application inference
 *   profile ARN) is registered on pi's built-in `amazon-bedrock` provider with the configured
 *   price as `cost` (pi's default cost for a custom model is 0).
 */

import "./offline.ts"; // before pi runs: PI_OFFLINE & co.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type AgentConfig,
  attempt,
  type Env,
  expectNonEmptyString,
  expectObject,
  field,
  fieldOr,
  must,
  type Parsed,
  PositiveInt,
  parseTomlText,
} from "@org/agents";

import type { PiModelSettings } from "../core/domain.ts";
import { piCost } from "../core/pricing.ts";
import { piAi } from "./piAi.ts";

export type PiModel = Model<Api>;

export const BEDROCK_PROVIDER = "amazon-bedrock";

/** Parse the `[pi]` table of `config/agent.toml` (the whole document, untyped). */
export function parsePiModelSettings(raw: unknown): Parsed<PiModelSettings> {
  return attempt(() => {
    const doc = must(expectObject(raw, "$"));
    const pi = must(expectObject(must(field(doc, "pi", "$")), "$.pi"));
    return {
      modelFamily: must(expectNonEmptyString(must(field(pi, "model_family", "$.pi")), "$.pi.model_family", { maxLength: 64 })),
      contextWindow: must(PositiveInt.parse(fieldOr(pi, "context_window", 200_000), "$.pi.context_window")),
      maxOutputTokens: must(PositiveInt.parse(fieldOr(pi, "max_output_tokens", 8192), "$.pi.max_output_tokens")),
    };
  });
}

/** Same file resolution as `loadSettings` (`AGENT_CONFIG`, else `$AGENT_HOME/config/agent.toml`). */
export function loadPiModelSettings(env: Env, root?: string): Parsed<PiModelSettings> {
  const home = root ?? env["AGENT_HOME"] ?? process.cwd();
  const raw = parseTomlText(readFileSync(env["AGENT_CONFIG"] ?? join(home, "config", "agent.toml"), "utf8"));
  return raw.kind === "err" ? raw : parsePiModelSettings(raw.value);
}

/** A model runtime with no file-backed credentials or catalog (PI_OFFLINE must already be set). */
export function createModelRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ credentials: new piAi.InMemoryCredentialStore(), modelsPath: null });
}

/** Register the configured Bedrock model (inference profile) with cost, and return it. */
export function bedrockModel(runtime: ModelRuntime, agent: AgentConfig, settings: PiModelSettings, env: Env): PiModel {
  const baseUrl = env["BEDROCK_BASE_URL"] ?? `https://bedrock-runtime.${agent.region}.amazonaws.com`; // VPC endpoint override
  runtime.registerProvider(BEDROCK_PROVIDER, {
    models: [
      {
        id: agent.modelId,
        // pi enables Bedrock cachePoint by matching the family in the id *or name*; ARNs don't match.
        name: `${settings.modelFamily} (${agent.name})`,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: piCost(agent.price),
        contextWindow: settings.contextWindow,
        maxTokens: settings.maxOutputTokens,
      },
    ],
  });
  const model = runtime.getModel(BEDROCK_PROVIDER, agent.modelId);
  if (model === undefined) throw new Error(`pi did not register Bedrock model ${agent.modelId}`);
  return model;
}
