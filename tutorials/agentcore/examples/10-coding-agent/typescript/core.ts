// Pure logic: no AWS, no child processes, no clock, no randomness.
import {
  type BranchName,
  type CommitMessage,
  type Outcome,
  type PullRequest,
  type Repo,
  type SessionId,
  parseSessionId,
  repoPath,
} from "./domain.ts";

const OUTPUT_LIMIT = 4000; // characters of output the model sees

// Environment for one git process: the token goes here, never into argv, files or logs.
export function gitEnv(tokenValue: string): Readonly<Record<string, string>> {
  const basic = Buffer.from(`x-access-token:${tokenValue}`).toString("base64");
  return {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

export function cloneArgv(repo: Repo): readonly string[] {
  return ["git", "clone", `https://github.com/${repo.owner}/${repo.name}.git`, repoPath(repo)];
}

// Local git steps before a push. None of them needs the token.
export function commitSteps(
  branch: BranchName,
  message: CommitMessage,
): readonly (readonly string[])[] {
  return [
    ["git", "switch", "-c", branch],
    ["git", "add", "-A"],
    ["git", "commit", "-m", message],
  ];
}

// What the model sees after a command: the exit code and the end of the output.
export function describe(outcome: Outcome): string {
  switch (outcome.kind) {
    case "finished":
      return `exit ${outcome.exitCode}\n${outcome.output.slice(-OUTPUT_LIMIT)}`;
    case "timedOut":
      return `timed out\n${outcome.output.slice(-OUTPUT_LIMIT)}`;
  }
}

// One session per task. The nonce (a UUID) is passed in: no randomness here.
export function taskSession(task: string, nonce: string): SessionId {
  return parseSessionId(`coder-${task}-${nonce}`);
}

export type Next =
  | { readonly kind: "done" } // the tests pass: push and open the pull request
  | { readonly kind: "askToFix"; readonly attempt: number }
  | { readonly kind: "giveUp" }; // a human takes over

// The test run decides, not the model.
export function afterTests(outcome: Outcome, attempt: number, maxAttempts: number): Next {
  if (outcome.kind === "finished" && outcome.exitCode === 0) return { kind: "done" };
  return attempt + 1 < maxAttempts
    ? { kind: "askToFix", attempt: attempt + 1 }
    : { kind: "giveUp" };
}

// Arguments of the GitHub MCP tool create_pull_request.
export function pullRequestArguments(pr: PullRequest) {
  return {
    owner: pr.repo.owner,
    repo: pr.repo.name,
    title: pr.title,
    head: pr.head,
    base: pr.base,
  };
}
