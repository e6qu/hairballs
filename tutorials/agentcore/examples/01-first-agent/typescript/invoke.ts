// Ask the deployed helpdesk harness a question and stream the answer (the imperative shell).
// Usage: HARNESS_ARN=arn:... npm run invoke -- "question" [session-id]
import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { exitCode, render } from "./core.ts";
import {
  type HarnessArn,
  ParseError,
  type Question,
  type SessionId,
  type StreamEvent,
  parseHarnessArn,
  parseQuestion,
  parseSessionId,
  parseStreamEvent,
} from "./domain.ts";

async function ask(harness: HarnessArn, session: SessionId, question: Question): Promise<number> {
  const client = new BedrockAgentCoreClient({ region: "eu-west-1" });
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn: harness,
      runtimeSessionId: session, // same id = same VM and conversation
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  const events: StreamEvent[] = [];
  for await (const raw of response.stream ?? []) {
    const event = parseStreamEvent(raw); // outside data -> domain type, right here
    if (event) {
      events.push(event);
      process.stdout.write(render(event));
    }
  }
  return exitCode(events);
}

async function main(args: readonly string[]): Promise<number> {
  let harness: HarnessArn, question: Question, session: SessionId;
  try {
    harness = parseHarnessArn(process.env.HARNESS_ARN ?? "");
    question = parseQuestion(args[0] ?? "");
    session = parseSessionId(args[1] ?? randomUUID());
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    console.error(
      `error: ${error.message}\nusage: HARNESS_ARN=arn:... invoke.ts QUESTION [SESSION_ID]`,
    );
    return 2;
  }
  console.log(`session: ${session}`);
  return ask(harness, session, question);
}

process.exitCode = await main(process.argv.slice(2));
