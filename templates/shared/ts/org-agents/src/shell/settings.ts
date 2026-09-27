/** Agent settings: the shared org config plus the approval policy and system prompt (any framework). */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ApprovalPolicy } from "../core/conversation.ts";
import { attempt, expectObject, fieldOr, must, type Parsed } from "../parsing.ts";
import { type AgentConfig, type Env, parseAgentConfig, parseTomlText } from "./config.ts";

export type Settings = {
  readonly agent: AgentConfig;
  readonly approvals: ApprovalPolicy;
  readonly systemPrompt: string;
};

export function parseSettings(raw: unknown, env: Env, systemPrompt: string): Parsed<Settings> {
  return attempt(() => {
    const doc = must(expectObject(raw, "$"));
    return {
      agent: must(parseAgentConfig(raw, env)),
      approvals: must(ApprovalPolicy.parse(fieldOr(doc, "approvals", {}))),
      systemPrompt,
    };
  });
}

/**
 * Config and prompt live under `AGENT_HOME` (default: the working directory):
 * `config/agent.toml` (override: `AGENT_CONFIG`) and `prompts/system.md` (override: `AGENT_SYSTEM_PROMPT`).
 * Missing files throw (infrastructure); invalid content is a ParseError.
 */
export function loadSettings(env: Env, root?: string): Parsed<Settings> {
  const home = root ?? env["AGENT_HOME"] ?? process.cwd();
  const configPath = env["AGENT_CONFIG"] ?? join(home, "config", "agent.toml");
  const promptPath = env["AGENT_SYSTEM_PROMPT"] ?? join(home, "prompts", "system.md");
  const raw = parseTomlText(readFileSync(configPath, "utf8"));
  if (raw.kind === "err") return raw;
  return parseSettings(raw.value, env, readFileSync(promptPath, "utf8"));
}
