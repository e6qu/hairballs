// Call the deployed helpdesk agent with the AWS SDK and print the streamed answer.
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const AGENT_ARN = process.env.AGENT_ARN!; // arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/...

const client = new BedrockAgentCoreClient({ region: "eu-west-1" });

async function ask(prompt: string, sessionId: string): Promise<void> {
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENT_ARN,
      runtimeSessionId: sessionId, // same id = same VM = same conversation
      payload: new TextEncoder().encode(JSON.stringify({ prompt })),
      contentType: "application/json",
      accept: "text/event-stream",
      qualifier: "DEFAULT",
    }),
  );
  let buffer = "";
  for await (const chunk of response.response as Readable) {
    buffer += String(chunk); // server-sent events: 'data: "..."' lines
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) process.stdout.write(String(JSON.parse(line.slice(6))));
    }
  }
  process.stdout.write("\n");
}

const [prompt = "hello", sessionId = randomUUID()] = process.argv.slice(2);
await ask(prompt, sessionId);
console.log(`session: ${sessionId}`);
