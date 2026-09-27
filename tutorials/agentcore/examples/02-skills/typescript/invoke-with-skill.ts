// Ask the helpdesk with an extra skill for this one call, and show the tools it uses.
// Usage: HARNESS_ARN=arn:... npm run invoke -- "question" [skill-s3-uri]
import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";

const DRAFT_SKILL = "s3://fintech-agent-skills/drafts/expense-policy/";
const client = new BedrockAgentCoreClient({ region: "eu-west-1" });

async function ask(harnessArn: string, question: string, skillUri: string): Promise<void> {
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn,
      runtimeSessionId: randomUUID(),
      skills: [{ s3: { uri: skillUri } }], // this call only; same name wins
      messages: [{ role: "user", content: [{ text: question }] }],
    }),
  );
  for await (const event of response.stream ?? []) {
    const toolUse = event.contentBlockStart?.start?.toolUse;
    const delta = event.contentBlockDelta?.delta;
    if (toolUse) {
      process.stdout.write(`\n[tool ${toolUse.name}] `);
    } else if (delta?.toolUse) {
      process.stdout.write(delta.toolUse.input ?? ""); // the tool's arguments
    } else if (delta?.text) {
      process.stdout.write(delta.text);
    } else if (event.runtimeClientError) {
      throw new Error(event.runtimeClientError.message);
    }
  }
  console.log();
}

const [question, skill = DRAFT_SKILL] = process.argv.slice(2);
const harnessArn = process.env.HARNESS_ARN;
if (!question || !harnessArn) {
  throw new Error('Usage: HARNESS_ARN=arn:... npm run invoke -- "question" [skill-s3-uri]');
}
await ask(harnessArn, question, skill);
