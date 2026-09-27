// Ask the helpdesk harness a question and add up the tokens it used, cache reads included.
import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";

const HARNESS_ARN =
  process.env.HARNESS_ARN ??
  "arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/helpdesk-AbCdEf1234";
// Claude Haiku 4.5, global profile, USD per million tokens.
const PRICE = {
  inputTokens: 1.0,
  outputTokens: 5.0,
  cacheReadInputTokens: 0.1, // 10% of input
  cacheWriteInputTokens: 1.25, // 125% of input (5-minute cache)
};
type Totals = Record<keyof typeof PRICE, number>;

const client = new BedrockAgentCoreClient({ region: "eu-west-1" });

async function ask(prompt: string, sessionId: string): Promise<Totals> {
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn: HARNESS_ARN,
      runtimeSessionId: sessionId,
      messages: [{ role: "user", content: [{ text: prompt }] }],
    }),
  );
  const totals: Totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
  };
  for await (const event of response.stream ?? []) {
    if (event.contentBlockDelta) {
      process.stdout.write(event.contentBlockDelta.delta?.text ?? "");
    } else if (event.metadata) {
      // token usage of the model calls
      const usage = event.metadata.usage;
      totals.inputTokens += usage?.inputTokens ?? 0;
      totals.outputTokens += usage?.outputTokens ?? 0;
      totals.cacheReadInputTokens += usage?.cacheReadInputTokens ?? 0;
      totals.cacheWriteInputTokens += usage?.cacheWriteInputTokens ?? 0;
    } else if (event.messageStop) {
      console.log(`\n[stop: ${event.messageStop.stopReason}]`);
    }
  }
  return totals;
}

function costUsd(totals: Totals): number {
  const keys = Object.keys(PRICE) as (keyof Totals)[];
  return keys.reduce((sum, k) => sum + totals[k] * PRICE[k], 0) / 1_000_000;
}

const [prompt = "How much can I claim for meals on a 4-day trip?", sessionId = randomUUID()] =
  process.argv.slice(2);
const totals = await ask(prompt, sessionId);
console.log(totals, `$${costUsd(totals).toFixed(5)}`, `session: ${sessionId}`);
