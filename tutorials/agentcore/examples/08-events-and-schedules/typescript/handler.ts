// Lambda: EventBridge rule or Scheduler -> the helpdesk agent (the imperative shell).
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { sessionIdFor, taskFor, usable } from "./core.ts";
import {
  type Accepted,
  type CachedToken,
  type Config,
  type SessionId,
  type Task,
  parseAgentReply,
  parseConfig,
  parseTokenResponse,
  parseTrigger,
} from "./domain.ts";

const AUTH0_TOKEN_URL = "https://fintech.eu.auth0.com/oauth/token";
const AUDIENCE = "https://agents.fintech.example";

const secrets = new SecretsManagerClient({});
let cached: CachedToken | undefined; // lives as long as this Lambda instance

// Client-credentials token, fetched once per instance and reused until it nearly expires.
async function m2mToken(config: Config): Promise<CachedToken> {
  const token = usable(cached, Date.now());
  if (token !== undefined) return token;
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.secretId }));
  const response = await fetch(AUTH0_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: secret.SecretString ?? "",
      audience: AUDIENCE,
    }),
  });
  cached = parseTokenResponse(await response.json(), Date.now());
  return cached;
}

async function start(
  config: Config,
  token: CachedToken,
  session: SessionId,
  task: Task,
): Promise<Accepted> {
  const arn = encodeURIComponent(config.agent);
  const host = `https://bedrock-agentcore.${config.region}.amazonaws.com`;
  const response = await fetch(`${host}/runtimes/${arn}/invocations?qualifier=DEFAULT`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.value}`,
      "Content-Type": "application/json",
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session,
    },
    body: JSON.stringify({ taskId: task.taskId, prompt: task.prompt }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`agent returned ${response.status}: ${await response.text()}`);
  return parseAgentReply(await response.json());
}

export async function handler(event: unknown): Promise<Accepted> {
  const config = parseConfig(process.env);
  const trigger = parseTrigger(event); // outside data -> domain type, right here
  const reply = await start(
    config,
    await m2mToken(config),
    sessionIdFor(trigger.ref),
    taskFor(trigger),
  );
  console.log(JSON.stringify(reply));
  return reply; // the agent keeps working on its own
}
