"""The coding agent (the imperative shell): Strands tools parse their arguments, then call core."""

from __future__ import annotations

import os
import subprocess
from collections.abc import AsyncIterator

from bedrock_agentcore.identity.auth import requires_access_token
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool
from strands_tools import editor
from strands_tools.code_interpreter import AgentCoreCodeInterpreter

from core import clone_argv, commit_steps, describe, git_env
from domain import (
    WORKSPACE,
    AllowedCommand,
    BranchName,
    CommitMessage,
    Finished,
    GitHubToken,
    Outcome,
    ParseError,
    Repo,
    RepoPath,
    TimedOut,
)

os.environ.setdefault("BYPASS_TOOL_CONSENT", "true")  # no interactive prompts on a server

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are a careful software engineer working on one GitHub repository.
Clone it, read the code, make the smallest change that fixes the task, run the tests, push a branch.
Run code you did not write (snippets from issues, downloaded scripts) only in the code interpreter."""
SANDBOX_ID = os.environ.get("CODE_INTERPRETER_ID", "coder_sandbox-AbCdEf1234")

app = BedrockAgentCoreApp()


def ask_user_to_consent(url: str) -> None:
    # First use only: the user must allow GitHub access once. Send them this link.
    print(f"GitHub consent needed: {url}")


@requires_access_token(
    provider_name="github",
    scopes=["repo"],
    auth_flow="USER_FEDERATION",
    on_auth_url=ask_user_to_consent,
    into="token",
)
async def vault_token(*, token: str = "") -> str:
    return token


async def github_token() -> GitHubToken:
    """The user's GitHub token from the token vault, parsed at the boundary."""
    return GitHubToken.parse(await vault_token())


def execute(argv: list[str], cwd: str, env: dict[str, str] | None = None) -> Outcome:
    try:
        done = subprocess.run(
            argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=900, check=False
        )
    except subprocess.TimeoutExpired as exc:
        return TimedOut(str(exc.output or ""))
    return Finished(done.returncode, done.stdout + done.stderr)


async def git_with_token(argv: list[str], cwd: str) -> str:
    env = {**os.environ, **git_env((await github_token()).value)}
    return describe(execute(argv, cwd, env))


@tool
async def clone(repo: str) -> str:
    """Clone a GitHub repository into the workspace.

    Args:
        repo: owner/name, for example fintech/helpdesk-api.
    """
    try:
        target = Repo.parse(repo)  # tool arguments from the model -> domain type
    except ParseError as exc:
        return f"refused: {exc}"
    os.makedirs(WORKSPACE, exist_ok=True)
    return await git_with_token(clone_argv(target), str(WORKSPACE))


@tool
async def push(repo: str, branch: str, message: str) -> str:
    """Commit every change in the repository to a new branch and push it.

    Args:
        repo: owner/name of a cloned repository.
        branch: new branch name, for example fix/issue-42.
        message: the commit message.
    """
    try:
        path = str(RepoPath.of(Repo.parse(repo)).path)
        new_branch, text = BranchName.parse(branch), CommitMessage.parse(message)
    except ParseError as exc:
        return f"refused: {exc}"
    for step in commit_steps(new_branch, text):
        outcome = execute(step, path)
        if not (isinstance(outcome, Finished) and outcome.exit_code == 0):
            return describe(outcome)
    return await git_with_token(["git", "push", "origin", new_branch.value], path)


@tool
def run(repo: str, argv: list[str]) -> str:
    """Run one allowed program in a cloned repository, for example ["npm", "test"]. No shell.

    Args:
        repo: owner/name of a cloned repository.
        argv: the program and its arguments.
    """
    try:
        path = RepoPath.of(Repo.parse(repo))
        command = AllowedCommand.parse(argv)
    except ParseError as exc:
        return f"refused: {exc}"
    return describe(execute(command.argv, str(path.path)))


sandbox = AgentCoreCodeInterpreter(region="eu-west-1", identifier=SANDBOX_ID)
agents: dict[str, Agent] = {}


def agent_for(session_id: str) -> Agent:
    if session_id not in agents:
        agents[session_id] = Agent(
            model=MODEL_ID,
            system_prompt=SYSTEM_PROMPT,
            tools=[clone, push, run, editor, sandbox.code_interpreter],
        )
    return agents[session_id]


@app.entrypoint
async def invoke(payload: dict[str, str], context: RequestContext) -> AsyncIterator[str]:
    agent = agent_for(context.session_id or "local")
    async for event in agent.stream_async(payload["prompt"]):
        if "data" in event:
            yield event["data"]


if __name__ == "__main__":
    app.run()
