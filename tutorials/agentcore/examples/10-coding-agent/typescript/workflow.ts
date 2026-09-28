// Drive one coding task (the imperative shell): the agent reasons; tests and the PR are plain steps.
// Usage: AGENT_ARN=arn:... USER_ID=usr_... USER_TOKEN=<Auth0 token> npm run workflow
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  InvokeAgentRuntimeCommandCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { afterTests, pullRequestArguments, taskSession } from "./core.ts";
import {
  type AgentArn,
  type Outcome,
  type PullRequest,
  type PullRequestReply,
  type SessionId,
  type UserId,
  type UserToken,
  ParseError,
  parseAgentArn,
  parseBranchName,
  parseCommandEvent,
  parsePullRequestReply,
  parseRepo,
  parseUserId,
  parseUserToken,
} from "./domain.ts";

const GATEWAY_URL =
  "https://helpdesk-tools-abc123xyz.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp";
const MAX_ATTEMPTS = 3;

const client = new BedrockAgentCoreClient({ region: "eu-west-1" });

// One agent turn. The user id selects whose GitHub token the agent may fetch.
async function ask(
  agent: AgentArn,
  session: SessionId,
  user: UserId,
  prompt: string,
): Promise<string> {
  const response = await client.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: agent,
      runtimeSessionId: session,
      runtimeUserId: user, // needs bedrock-agentcore:InvokeAgentRuntimeForUser
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

// Run a command in the agent's VM: no model, no tokens.
async function sh(
  agent: AgentArn,
  session: SessionId,
  command: string,
  timeout = 900,
): Promise<Outcome> {
  const response = await client.send(
    new InvokeAgentRuntimeCommandCommand({
      agentRuntimeArn: agent,
      runtimeSessionId: session,
      body: { command: `/bin/bash -c "${command}"`, timeout },
    }),
  );
  for await (const raw of response.stream ?? []) {
    const event = parseCommandEvent(raw); // outside data -> domain type, right here
    if (event?.kind === "output") process.stdout.write(event.text);
    else if (event) return event;
  }
  throw new ParseError("the command stream ended without an exit code");
}

// Call the GitHub tool behind the Gateway, as the user (tutorials 03, 06, 07).
async function openPullRequest(pr: PullRequest, token: UserToken): Promise<PullRequestReply> {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "github___create_pull_request", arguments: pullRequestArguments(pr) },
    }),
  });
  return parsePullRequestReply(await response.json());
}

async function main(): Promise<number> {
  const agent = parseAgentArn(process.env.AGENT_ARN ?? "");
  const user = parseUserId(process.env.USER_ID ?? ""); // from their verified Auth0 token
  const token = parseUserToken(process.env.USER_TOKEN ?? "");
  const repo = parseRepo("fintech/helpdesk-api");
  const branch = parseBranchName("fix/issue-42");
  const session = taskSession("issue-42", randomUUID()); // one session (and workspace) per task
  console.log(
    await ask(agent, session, user, `Fix issue 42 in ${repo.owner}/${repo.name}. Clone it first.`),
  );

  const tests = `cd /mnt/workspace/${repo.name} && npm ci && npm test`;
  for (let attempt = 0; ; ) {
    const next = afterTests(await sh(agent, session, tests), attempt, MAX_ATTEMPTS);
    if (next.kind === "done") break;
    if (next.kind === "giveUp") {
      console.error("tests still fail: a human takes over");
      return 1;
    }
    attempt = next.attempt;
    console.log(
      await ask(agent, session, user, "The tests fail. Run them, read the output, fix it."),
    );
  }

  console.log(await ask(agent, session, user, `Push the change to a new branch ${branch}.`));
  const pr = { repo, head: branch, base: parseBranchName("main"), title: "Fix issue 42" };
  console.log(await openPullRequest(pr, token));
  return 0;
}

process.exitCode = await main();
