// Ask the deployed helpdesk harness a question and stream the answer.
// Usage: HARNESS_ARN=arn:... npm run invoke -- "question" [session-id]
import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";

const client = new BedrockAgentCoreClient({ region: "eu-west-1" });

async function ask(harnessArn: string, sessionId: string, question: string): Promise<void> {
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn,
      runtimeSessionId: sessionId, // same id = same VM and conversation
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  for await (const event of response.stream ?? []) {
    if (event.contentBlockDelta?.delta?.text) {
      process.stdout.write(event.contentBlockDelta.delta.text);
    } else if (event.messageStop) {
      console.log(`\n[stop: ${event.messageStop.stopReason}]`);
    } else if (event.runtimeClientError) {
      throw new Error(event.runtimeClientError.message);
    }
  }
}

const [question, session = randomUUID()] = process.argv.slice(2);
const harnessArn = process.env.HARNESS_ARN;
if (!question || !harnessArn) {
  throw new Error('Usage: HARNESS_ARN=arn:... npm run invoke -- "question" [session-id]');
}
console.log(`session: ${session}`);
await ask(harnessArn, session, question);
