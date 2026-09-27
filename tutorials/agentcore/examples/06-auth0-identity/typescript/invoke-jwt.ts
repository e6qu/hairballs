// Call the agent over HTTPS with an Auth0 bearer token (the AWS SDK can't send bearer tokens).
import { randomUUID } from "node:crypto";

const AGENT_ARN = process.env.AGENT_ARN!; // arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/...
const URL =
  "https://bedrock-agentcore.eu-west-1.amazonaws.com/runtimes/" +
  `${encodeURIComponent(AGENT_ARN)}/invocations?qualifier=DEFAULT`;

async function ask(token: string, prompt: string, sessionId: string): Promise<void> {
  const response = await fetch(URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    buffer += chunk.value; // server-sent events: 'data: "..."' lines
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) process.stdout.write(String(JSON.parse(line.slice(6))));
    }
  }
  process.stdout.write("\n");
}

const [prompt = "hello", sessionId = randomUUID()] = process.argv.slice(2);
await ask(process.env.TOKEN!, prompt, sessionId);
console.log(`session: ${sessionId}`);
