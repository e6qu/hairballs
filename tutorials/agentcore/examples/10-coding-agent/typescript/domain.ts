// Domain types for the coding agent and the workflow that drives it.
// Outside data (tool arguments from the model, environment, command output streamed back from the
// agent's VM, the Gateway's reply) is parsed into these types at the boundary.
import type { InvokeAgentRuntimeCommandStreamOutput } from "@aws-sdk/client-bedrock-agentcore";

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export class ParseError extends Error {}

export const WORKSPACE = "/mnt/workspace"; // session storage: kept across stop/resume

// --- The agent's tools --------------------------------------------------------------------

export interface Repo {
  readonly owner: string;
  readonly name: string; // no "/", not "." or ".."
}

const REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

export function parseRepo(raw: string): Repo {
  const match = REPO.exec(raw);
  const [, owner, name] = match ?? [];
  if (owner === undefined || name === undefined || name === "." || name === "..") {
    throw new ParseError(`not a GitHub repository (owner/name): ${raw}`);
  }
  return { owner, name };
}

// A checkout inside the workspace. Only repoPath makes one, so it can't point elsewhere.
export type RepoPath = Brand<string, "RepoPath">;
export const repoPath = (repo: Repo) => `${WORKSPACE}/${repo.name}` as RepoPath;

export type BranchName = Brand<string, "BranchName">;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function parseBranchName(raw: string): BranchName {
  const bad =
    raw.includes("..") || raw.includes("//") || raw.endsWith("/") || raw.endsWith(".lock");
  if (bad || !BRANCH.test(raw)) throw new ParseError(`not a branch name: ${raw}`);
  return raw as BranchName;
}

export type CommitMessage = Brand<string, "CommitMessage">;

export function parseCommitMessage(raw: string): CommitMessage {
  const text = raw.trim();
  if (text === "") throw new ParseError("the commit message is empty");
  return text as CommitMessage;
}

// The programs the model may run. Anything else is refused at the boundary.
export const PROGRAMS = [
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
] as const;
export type Program = (typeof PROGRAMS)[number];

// An argv list whose program is allowed. Never a shell string.
export interface AllowedCommand {
  readonly program: Program;
  readonly args: readonly string[];
}

export function parseAllowedCommand(raw: readonly string[]): AllowedCommand {
  const [first, ...args] = raw;
  const program = PROGRAMS.find((p) => p === first);
  if (program === undefined) {
    throw new ParseError(`${String(first)} is not allowed; use one of ${PROGRAMS.join(", ")}`);
  }
  return { program, args };
}

export type GitHubToken = Brand<string, "GitHubToken">; // from the token vault; never printed

export function parseGitHubToken(raw: unknown): GitHubToken {
  if (typeof raw !== "string" || raw === "") throw new ParseError("no GitHub token");
  return raw as GitHubToken;
}

// How a command in the agent's VM ended.
export type Outcome =
  | { readonly kind: "finished"; readonly exitCode: number; readonly output: string }
  | { readonly kind: "timedOut"; readonly output: string };

// --- The workflow -------------------------------------------------------------------------

export type AgentArn = Brand<string, "AgentArn">;
export type SessionId = Brand<string, "SessionId">; // one session (and workspace) per task
export type UserId = Brand<string, "UserId">; // who asked; selects whose GitHub token is used
export type UserToken = Brand<string, "UserToken">; // their Auth0 token, for the Gateway

const RUNTIME_ARN = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[\w-]+$/;
const USER_ID = /^usr_[a-z0-9]+$/;

export function parseAgentArn(raw: string): AgentArn {
  if (!RUNTIME_ARN.test(raw)) throw new ParseError(`not an AgentCore runtime ARN: ${raw}`);
  return raw as AgentArn;
}

export function parseSessionId(raw: string): SessionId {
  if (raw.length < 33 || raw.length > 256)
    throw new ParseError("a session id must be 33-256 chars");
  return raw as SessionId;
}

export function parseUserId(raw: string): UserId {
  if (!USER_ID.test(raw)) throw new ParseError(`not a user id: ${raw}`);
  return raw as UserId;
}

export function parseUserToken(raw: string): UserToken {
  if (raw.split(".").length !== 3) throw new ParseError("the user token is not a JWT");
  return raw as UserToken;
}

export type CommandEvent = { readonly kind: "output"; readonly text: string } | Outcome;

// One InvokeAgentRuntimeCommand stream event, or undefined for events the workflow ignores.
export function parseCommandEvent(
  raw: InvokeAgentRuntimeCommandStreamOutput,
): CommandEvent | undefined {
  const chunk = raw.chunk;
  if (chunk?.contentDelta) {
    return {
      kind: "output",
      text: (chunk.contentDelta.stdout ?? "") + (chunk.contentDelta.stderr ?? ""),
    };
  }
  if (chunk?.contentStop) {
    if (chunk.contentStop.status === "TIMED_OUT") return { kind: "timedOut", output: "" };
    const exitCode = chunk.contentStop.exitCode;
    if (exitCode === undefined) throw new ParseError("$.chunk.contentStop.exitCode: missing");
    return { kind: "finished", exitCode, output: "" };
  }
  return undefined;
}

export interface PullRequest {
  readonly repo: Repo;
  readonly head: BranchName;
  readonly base: BranchName;
  readonly title: string;
}

export type PullRequestReply =
  | { readonly kind: "opened"; readonly text: string }
  | { readonly kind: "refused"; readonly reason: string }; // the Gateway or its policy said no

// The Gateway's JSON-RPC reply to github___create_pull_request.
export function parsePullRequestReply(raw: unknown): PullRequestReply {
  if (typeof raw !== "object" || raw === null) throw new ParseError("$: expected an object");
  if ("error" in raw) return { kind: "refused", reason: JSON.stringify(raw.error) };
  const result: unknown = "result" in raw ? raw.result : undefined;
  if (typeof result !== "object" || result === null) throw new ParseError("$.result: missing");
  const content: unknown = "content" in result ? result.content : [];
  const text = (Array.isArray(content) ? content : [])
    .map((b: unknown) => (typeof b === "object" && b !== null && "text" in b ? String(b.text) : ""))
    .join("\n");
  const isError = "isError" in result && result.isError === true;
  return isError ? { kind: "refused", reason: text } : { kind: "opened", text };
}
