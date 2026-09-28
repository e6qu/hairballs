// Call the deployed helpdesk agent with the AWS SDK and print the streamed answer (the shell).
// Usage: AGENT_ARN=arn:... node dist/invoke.js "prompt" [session-id]
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { exitCode, render } from "./core.ts";
import {
  type AgentRuntimeArn,
  type AnswerEvent,
  ParseError,
  type Prompt,
  type SessionId,
  parseAgentRuntimeArn,
  parsePrompt,
  parseSessionId,
  parseSseLine,
} from "./domain.ts";

async function ask(agent: AgentRuntimeArn, session: SessionId, prompt: Prompt): Promise<number> {
  const client = new BedrockAgentCoreClient({ region: "eu-west-1" });
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: agent,
      runtimeSessionId: session, // same id = same VM = same conversation
      payload: new TextEncoder().encode(JSON.stringify({ prompt })),
      contentType: "application/json",
      accept: "text/event-stream",
      qualifier: "DEFAULT",
    }),
  );
  const events: AnswerEvent[] = [];
  let buffer = "";
  for await (const chunk of response.response as Readable) {
    buffer += String(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseSseLine(line); // outside data -> domain type, right here
      if (event) {
        events.push(event);
        process.stdout.write(render(event));
      }
    }
  }
  process.stdout.write("\n");
  return exitCode(events);
}

async function main(args: readonly string[]): Promise<number> {
  let agent: AgentRuntimeArn, prompt: Prompt, session: SessionId;
  try {
    agent = parseAgentRuntimeArn(process.env.AGENT_ARN ?? "");
    prompt = parsePrompt(args[0] ?? "");
    session = parseSessionId(args[1] ?? randomUUID());
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    console.error(
      `error: ${error.message}\nusage: AGENT_ARN=arn:... invoke.js PROMPT [SESSION_ID]`,
    );
    return 2;
  }
  console.log(`session: ${session}`);
  return ask(agent, session, prompt);
}

process.exitCode = await main(process.argv.slice(2));
