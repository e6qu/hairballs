// A coding agent: a git checkout in a persistent workspace, a GitHub token only when needed.
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Agent, tool } from "@strands-agents/sdk";
import { fileEditor } from "@strands-agents/sdk/vended-tools/file-editor";
import { CodeInterpreterTools } from "bedrock-agentcore/experimental/code-interpreter/strands";
import { withAccessToken } from "bedrock-agentcore/identity";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

const exec = promisify(execFile);

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const SYSTEM_PROMPT = `You are a careful software engineer working on one GitHub repository.
Clone it, read the code, make the smallest change that fixes the task, run the tests, push a branch.
Run code you did not write (snippets from issues, downloaded scripts) only in the code interpreter.`;
const WORKSPACE = "/mnt/workspace"; // session storage: kept across stop/resume of the session
const PROGRAMS = new Set([
  "git",
  "ls",
  "cat",
  "grep",
  "npm",
  "npx",
  "node",
  "python",
  "pytest",
  "uv",
]);
const SANDBOX_ID = process.env.CODE_INTERPRETER_ID ?? "coder_sandbox-AbCdEf1234";

/** The user's GitHub token from the token vault. Never stored, never logged. */
const githubToken = withAccessToken({
  providerName: "github",
  scopes: ["repo"],
  authFlow: "USER_FEDERATION",
  // First use only: the user must allow GitHub access once. Send them this link.
  onAuthUrl: (url) => console.log(`GitHub consent needed: ${url}`),
})(async (token: string) => token);

function repoDir(repo: string): string {
  const dir = path.resolve(WORKSPACE, repo.split("/").pop() ?? "");
  if (path.dirname(dir) !== WORKSPACE) throw new Error(`not a repository name: ${repo}`);
  return dir;
}

/** Run a program without a shell; return its exit code and the end of its output. */
async function runProgram(argv: string[], cwd: string, env = process.env): Promise<string> {
  const [program = "", ...args] = argv;
  try {
    const { stdout, stderr } = await exec(program, args, { cwd, env, timeout: 900_000 });
    return `exit 0\n${(stdout + stderr).slice(-4000)}`;
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return `exit ${e.code ?? 1}\n${((e.stdout ?? "") + (e.stderr ?? "")).slice(-4000)}`;
  }
}

/** Run git with the token in the child's environment only: not in argv, files or logs. */
async function git(args: string[], cwd: string): Promise<string> {
  const basic = Buffer.from(`x-access-token:${await githubToken()}`).toString("base64");
  return runProgram(["git", ...args], cwd, {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  });
}

const clone = tool({
  name: "clone",
  description: "Clone a GitHub repository into the workspace.",
  inputSchema: z.object({ repo: z.string().describe("owner/name, e.g. fintech/helpdesk-api") }),
  callback: async ({ repo }) => {
    await mkdir(WORKSPACE, { recursive: true });
    return git(["clone", `https://github.com/${repo}.git`, repoDir(repo)], WORKSPACE);
  },
});

const push = tool({
  name: "push",
  description: "Commit every change in the repository to a new branch and push it.",
  inputSchema: z.object({ repo: z.string(), branch: z.string(), message: z.string() }),
  callback: async ({ repo, branch, message }) => {
    const cwd = repoDir(repo);
    for (const args of [
      ["switch", "-c", branch],
      ["add", "-A"],
      ["commit", "-m", message],
    ]) {
      await exec("git", args, { cwd });
    }
    return git(["push", "origin", branch], cwd);
  },
});

const run = tool({
  name: "run",
  description: 'Run one program in a cloned repository, e.g. ["npm", "test"]. No shell.',
  inputSchema: z.object({ repo: z.string(), argv: z.array(z.string()).min(1) }),
  callback: async ({ repo, argv }) =>
    PROGRAMS.has(argv[0] ?? "")
      ? runProgram(argv, repoDir(repo))
      : `not allowed; use one of ${[...PROGRAMS].join(", ")}`,
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
