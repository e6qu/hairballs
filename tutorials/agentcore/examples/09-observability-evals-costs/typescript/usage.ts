// Ask the helpdesk harness a question and report the tokens it used (the imperative shell).
// Usage: HARNESS_ARN=arn:... npm run usage -- "question" [session-id]
import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { cacheHitRatio, cost, dollars, render, total } from "./core.ts";
import {
  HAIKU_4_5,
  type HarnessArn,
  ParseError,
  type SessionId,
  type StreamEvent,
  parseHarnessArn,
  parseSessionId,
  parseStreamEvent,
} from "./domain.ts";

async function ask(
  harness: HarnessArn,
  session: SessionId,
  question: string,
): Promise<StreamEvent[]> {
  const client = new BedrockAgentCoreClient({ region: "eu-west-1" });
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn: harness,
      runtimeSessionId: session,
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  const events: StreamEvent[] = [];
  for await (const raw of response.stream ?? []) {
    const event = parseStreamEvent(raw); // stream metadata -> TokenUsage, right here
    if (event) {
      events.push(event);
      process.stdout.write(render(event));
    }
  }
  return events;
}

async function main(args: readonly string[]): Promise<number> {
  let harness: HarnessArn, session: SessionId;
  try {
    harness = parseHarnessArn(process.env.HARNESS_ARN ?? "");
    session = parseSessionId(args[1] ?? randomUUID());
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    console.error(`error: ${error.message}`);
    return 2;
  }
  const usage = total(await ask(harness, session, args[0] ?? "Can I expense a taxi?"));
  console.log(usage);
  const hits = (cacheHitRatio(usage) * 100).toFixed(0);
  console.log(`cost ${dollars(cost(usage, HAIKU_4_5))}, cache hits ${hits}%`);
  console.log(`session: ${session}`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
