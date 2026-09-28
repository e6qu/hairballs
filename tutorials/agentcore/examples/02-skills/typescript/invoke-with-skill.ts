// Ask the helpdesk with an extra skill for this one call, and show the tools it uses (the shell).
// Usage: HARNESS_ARN=arn:... npm run invoke -- "question" [skill-s3-uri]
import { randomUUID } from "node:crypto";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { exitCode, render } from "./core.ts";
import {
  type HarnessArn,
  ParseError,
  type Question,
  type SessionId,
  type SkillUri,
  type StreamEvent,
  parseHarnessArn,
  parseQuestion,
  parseSessionId,
  parseSkillUri,
  parseStreamEvent,
} from "./domain.ts";

const DRAFT_SKILL = "s3://fintech-agent-skills/drafts/expense-policy/";

async function ask(
  harness: HarnessArn,
  session: SessionId,
  question: Question,
  skill: SkillUri,
): Promise<number> {
  const client = new BedrockAgentCoreClient({ region: "eu-west-1" });
  const response = await client.send(
    new InvokeHarnessCommand({
      harnessArn: harness,
      runtimeSessionId: session,
      skills: [{ s3: { uri: skill } }], // this call only; same name wins
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
  let harness: HarnessArn, question: Question, skill: SkillUri, session: SessionId;
  try {
    harness = parseHarnessArn(process.env.HARNESS_ARN ?? "");
    question = parseQuestion(args[0] ?? "");
    skill = parseSkillUri(args[1] ?? DRAFT_SKILL);
    session = parseSessionId(randomUUID());
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    console.error(
      `error: ${error.message}\nusage: HARNESS_ARN=arn:... invoke-with-skill.ts QUESTION [SKILL_S3_URI]`,
    );
    return 2;
  }
  return ask(harness, session, question, skill);
}

process.exitCode = await main(process.argv.slice(2));
