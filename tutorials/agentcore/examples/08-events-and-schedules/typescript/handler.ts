// Lambda: EventBridge rule or Scheduler -> the helpdesk agent, with an Auth0 M2M token.
import { createHash } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { EventBridgeEvent } from "aws-lambda";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
// The helpdesk Runtime agent, JWT inbound (tutorial 06)
const AGENT_ARN = process.env.AGENT_ARN!;
// The Auth0 M2M app "agent-scheduler", and the Secrets Manager secret with its client secret
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID!;
const AUTH0_SECRET_ID = process.env.AUTH0_SECRET_ID!;
const AUTH0_TOKEN_URL = "https://fintech.eu.auth0.com/oauth/token";
const AUDIENCE = "https://agents.fintech.example";

type Event = EventBridgeEvent<string, Record<string, string>>;

const secrets = new SecretsManagerClient({ region: REGION });
let token = "";
let tokenExpires = 0;

/** Client-credentials token, cached for as long as this Lambda instance lives. */
async function m2mToken(): Promise<string> {
  if (Date.now() < tokenExpires - 60_000) return token;
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: AUTH0_SECRET_ID }));
  const response = await fetch(AUTH0_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AUTH0_CLIENT_ID,
      client_secret: secret.SecretString!,
      audience: AUDIENCE,
    }),
  });
  const reply = (await response.json()) as { access_token: string; expires_in: number };
  token = reply.access_token;
  tokenExpires = Date.now() + reply.expires_in * 1000;
  return token;
}

/** Same event -> same session id. A retried delivery reaches the same agent session. */
export function sessionId(event: Event): string {
  return createHash("sha256").update(`${event.source}:${event.id}`).digest("hex");
}

export function promptFor(event: Event): string {
  if (event.source === "fintech.tickets") {
    return `Ticket ${event.detail.ticketId} was escalated. Triage it and add a note.`;
  }
  return "Write the daily digest of open high-priority tickets and post it as a note.";
}

export async function handler(event: Event): Promise<Record<string, string>> {
  const arn = encodeURIComponent(AGENT_ARN);
  const url = `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${arn}/invocations?qualifier=DEFAULT`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await m2mToken()}`,
      "Content-Type": "application/json",
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId(event),
    },
    body: JSON.stringify({ taskId: event.id, prompt: promptFor(event) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`agent returned ${response.status}: ${await response.text()}`);
  const reply = (await response.json()) as Record<string, string>;
  console.log(JSON.stringify({ event: event.id, agent: reply }));
  return reply; // {"status": "accepted", ...}: the agent keeps working on its own
}
