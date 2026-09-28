// The coding agent (the imperative shell): Strands tools parse their arguments, then call core.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { Agent, tool } from "@strands-agents/sdk";
import { fileEditor } from "@strands-agents/sdk/vended-tools/file-editor";
import { CodeInterpreterTools } from "bedrock-agentcore/experimental/code-interpreter/strands";
import { withAccessToken } from "bedrock-agentcore/identity";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";
import { cloneArgv, commitSteps, describe, gitEnv } from "./core.ts";
import {
  type GitHubToken,
  type Outcome,
  ParseError,
  WORKSPACE,
  parseAllowedCommand,
  parseBranchName,
  parseCommitMessage,
  parseGitHubToken,
  parseRepo,
  repoPath,
} from "./domain.ts";

const exec = promisify(execFile);

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const SYSTEM_PROMPT = `You are a careful software engineer working on one GitHub repository.
Clone it, read the code, make the smallest change that fixes the task, run the tests, push a branch.
Run code you did not write (snippets from issues, downloaded scripts) only in the code interpreter.`;
const SANDBOX_ID = process.env.CODE_INTERPRETER_ID ?? "coder_sandbox-AbCdEf1234";

// The user's GitHub token from the token vault, parsed at the boundary.
const githubToken: () => Promise<GitHubToken> = withAccessToken({
  providerName: "github",
  scopes: ["repo"],
  authFlow: "USER_FEDERATION",
  // First use only: the user must allow GitHub access once. Send them this link.
  onAuthUrl: (url) => console.log(`GitHub consent needed: ${url}`),
})(async (token: string) => parseGitHubToken(token));

async function execute(argv: readonly string[], cwd: string, env = process.env): Promise<Outcome> {
  const [program = "", ...args] = argv;
  try {
    const { stdout, stderr } = await exec(program, args, { cwd, env, timeout: 900_000 });
    return { kind: "finished", exitCode: 0, output: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; killed?: boolean; stdout?: string; stderr?: string };
    const output = (e.stdout ?? "") + (e.stderr ?? "");
    return e.killed
      ? { kind: "timedOut", output }
      : { kind: "finished", exitCode: e.code ?? 1, output };
  }
}

async function gitWithToken(argv: readonly string[], cwd: string): Promise<string> {
  return describe(await execute(argv, cwd, { ...process.env, ...gitEnv(await githubToken()) }));
}

// Tool arguments come from the model: parse them into domain types first.
function refusing(fn: () => Promise<string>): Promise<string> {
  return fn().catch((error: unknown) => {
    if (error instanceof ParseError) return `refused: ${error.message}`;
    throw error;
  });
}

const clone = tool({
  name: "clone",
  description: "Clone a GitHub repository into the workspace.",
  inputSchema: z.object({ repo: z.string().describe("owner/name, e.g. fintech/helpdesk-api") }),
  callback: ({ repo }) =>
    refusing(async () => {
      const target = parseRepo(repo);
      await mkdir(WORKSPACE, { recursive: true });
      return gitWithToken(cloneArgv(target), WORKSPACE);
    }),
});

const push = tool({
  name: "push",
  description: "Commit every change in the repository to a new branch and push it.",
  inputSchema: z.object({ repo: z.string(), branch: z.string(), message: z.string() }),
  callback: ({ repo, branch, message }) =>
    refusing(async () => {
      const path = repoPath(parseRepo(repo));
      const newBranch = parseBranchName(branch);
      for (const step of commitSteps(newBranch, parseCommitMessage(message))) {
        const outcome = await execute(step, path);
        if (!(outcome.kind === "finished" && outcome.exitCode === 0)) return describe(outcome);
      }
      return gitWithToken(["git", "push", "origin", newBranch], path);
    }),
});

const run = tool({
  name: "run",
  description: 'Run one allowed program in a cloned repository, e.g. ["npm", "test"]. No shell.',
  inputSchema: z.object({ repo: z.string(), argv: z.array(z.string()) }),
  callback: ({ repo, argv }) =>
    refusing(async () => {
      const path = repoPath(parseRepo(repo));
      const command = parseAllowedCommand(argv);
      return describe(await execute([command.program, ...command.args], path));
    }),
});

const sandbox = new CodeInterpreterTools({ region: "eu-west-1", identifier: SANDBOX_ID });
const agents = new Map<string, Agent>();

function agentFor(sessionId: string): Agent {
  let agent = agents.get(sessionId);
  if (!agent) {
    agent = new Agent({
      model: MODEL_ID,
      systemPrompt: SYSTEM_PROMPT,
      tools: [clone, push, run, fileEditor, ...sandbox.tools],
    });
    agents.set(sessionId, agent);
  }
  return agent;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }),
    async *process(payload, context) {
      const agent = agentFor(context.sessionId || "local");
      for await (const event of agent.stream(payload.prompt)) {
        if (
          event.type === "modelStreamUpdateEvent" &&
          event.event.type === "modelContentBlockDeltaEvent" &&
          event.event.delta.type === "textDelta"
        ) {
          yield { data: event.event.delta.text };
        }
      }
    },
  },
});

app.run({ port: 8080 });
