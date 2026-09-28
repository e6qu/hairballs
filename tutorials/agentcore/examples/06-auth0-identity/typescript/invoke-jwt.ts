// Call the agent over HTTPS with an Auth0 bearer token (the AWS SDK can't send bearer tokens).
// Usage: AGENT_ARN=arn:... TOKEN=... node dist/invoke-jwt.js "prompt" [session-id]
import { randomUUID } from "node:crypto";
import { invocationUrl, render } from "./core.ts";
import {
  type AccessToken,
  type AgentRuntimeArn,
  ParseError,
  type Prompt,
  type SessionId,
  parseAccessToken,
  parseAgentRuntimeArn,
  parsePrompt,
  parseSessionId,
  parseSseLine,
} from "./domain.ts";

async function ask(
  agent: AgentRuntimeArn,
  token: AccessToken,
  session: SessionId,
  prompt: Prompt,
): Promise<void> {
  const response = await fetch(invocationUrl(agent, "eu-west-1"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffer += chunk.value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSseLine(line); // outside data -> domain type, right here
      if (event) process.stdout.write(render(event));
    }
  }
  process.stdout.write("\n");
}

async function main(args: readonly string[]): Promise<number> {
  let agent: AgentRuntimeArn, token: AccessToken, prompt: Prompt, session: SessionId;
  try {
    agent = parseAgentRuntimeArn(process.env.AGENT_ARN ?? "");
    token = parseAccessToken(process.env.TOKEN);
    prompt = parsePrompt(args[0] ?? "");
    session = parseSessionId(args[1] ?? randomUUID());
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    console.error(
      `error: ${error.message}\nusage: AGENT_ARN=arn:... TOKEN=... invoke-jwt.js PROMPT [SESSION_ID]`,
    );
    return 2;
  }
  console.log(`session: ${session}`);
  await ask(agent, token, session, prompt);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
