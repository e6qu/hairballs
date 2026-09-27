// Drive one coding task: the agent does the reasoning; tests and the pull request are plain steps.
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  InvokeAgentRuntimeCommandCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const AGENT_ARN =
  process.env.AGENT_ARN ??
  "arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/coder-AbCdEf1234";
const GATEWAY_URL =
  "https://helpdesk-tools-abc123xyz.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp";

const client = new BedrockAgentCoreClient({ region: "eu-west-1" });

/** One agent turn. userId selects whose GitHub token the agent may fetch. */
async function ask(prompt: string, sessionId: string, userId: string): Promise<string> {
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: AGENT_ARN,
      runtimeSessionId: sessionId,
      runtimeUserId: userId, // needs bedrock-agentcore:InvokeAgentRuntimeForUser
      payload: new TextEncoder().encode(JSON.stringify({ prompt })),
    }),
  );
  let text = "";
  for await (const chunk of response.response as Readable) text += String(chunk);
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => String(JSON.parse(line.slice(6))))
    .join("");
}

/** Run a command in the agent's VM: no model, no tokens. Returns the exit code. */
async function sh(command: string, sessionId: string, timeout = 900): Promise<number> {
  const response = await client.send(
    new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: AGENT_ARN,
      runtimeSessionId: sessionId,
      body: { command: `/bin/bash -c "${command}"`, timeout },
    }),
  );
  for await (const event of response.stream ?? []) {
    const chunk = event.chunk;
    if (chunk?.contentDelta) {
      process.stdout.write((chunk.contentDelta.stdout ?? "") + (chunk.contentDelta.stderr ?? ""));
    }
    if (chunk?.contentStop) return chunk.contentStop.exitCode ?? -1;
  }
  return -1;
}

/** Call the GitHub tool behind the Gateway, as the user (tutorials 03, 06, 07). */
async function openPullRequest(args: Record<string, string>, userToken: string): Promise<string> {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "github___create_pull_request", arguments: args },
    }),
  });
  return JSON.stringify(((await response.json()) as { result: unknown }).result);
}

const session = `coder-issue-42-${randomUUID()}`; // one session (and workspace) per task
const user = process.env.USER_ID!; // who asked; taken from their verified Auth0 token
console.log(await ask("Fix issue 42 in fintech/helpdesk-api. Clone it first.", session, user));

const tests = "cd /mnt/workspace/helpdesk-api && npm ci && npm test";
let passed = false;
for (let i = 0; i < 3 && !passed; i++) {
  // the test run decides, not the model
  passed = (await sh(tests, session)) === 0;
  if (!passed) {
    console.log(await ask("The tests fail. Run them, read the output, fix it.", session, user));
  }
}
if (!passed) throw new Error("tests still fail: a human takes over");

console.log(await ask("Push the change to a new branch fix/issue-42.", session, user));
const pr = {
  owner: "fintech",
  repo: "helpdesk-api",
  title: "Fix issue 42",
  head: "fix/issue-42",
  base: "main",
};
console.log(await openPullRequest(pr, process.env.USER_TOKEN!));
