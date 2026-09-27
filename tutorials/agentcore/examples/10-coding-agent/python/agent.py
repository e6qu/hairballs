"""A coding agent: a git checkout in a persistent workspace, a GitHub token only when needed."""

import base64
import os
import subprocess
from collections.abc import AsyncIterator
from pathlib import Path

from bedrock_agentcore.identity.auth import requires_access_token
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool
from strands_tools import editor
from strands_tools.code_interpreter import AgentCoreCodeInterpreter

os.environ.setdefault(
    "BYPASS_TOOL_CONSENT", "true"
)  # no interactive prompts on a server

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are a careful software engineer working on one GitHub repository.
Clone it, read the code, make the smallest change that fixes the task, run the tests, push a branch.
Run code you did not write (snippets from issues, downloaded scripts) only in the code interpreter."""
WORKSPACE = Path(
    "/mnt/workspace"
)  # session storage: kept across stop/resume of the session
PROGRAMS = {"git", "ls", "cat", "grep", "npm", "npx", "node", "python", "pytest", "uv"}
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
async def github_token(*, token: str = "") -> str:
    """The user's GitHub token from the token vault. Never stored, never logged."""
    return token


def repo_dir(repo: str) -> Path:
    path = (WORKSPACE / repo.split("/")[-1]).resolve()
    if path.parent != WORKSPACE:
        raise ValueError(f"not a repository name: {repo}")
    return path


async def git(args: list[str], cwd: Path) -> str:
    """Run git with the token in the child's environment only: not in argv, files or logs."""
    basic = base64.b64encode(f"x-access-token:{await github_token()}".encode()).decode()
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {basic}",
    }
    done = subprocess.run(
        ["git", *args], cwd=cwd, env=env, capture_output=True, text=True, timeout=600
    )
    return f"exit {done.returncode}\n{(done.stdout + done.stderr)[-4000:]}"


@tool
async def clone(repo: str) -> str:
    """Clone a GitHub repository into the workspace.

    Args:
        repo: owner/name, for example fintech/helpdesk-api.
    """
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/{repo}.git"
    return await git(["clone", url, str(repo_dir(repo))], WORKSPACE)


@tool
async def push(repo: str, branch: str, message: str) -> str:
    """Commit every change in the repository to a new branch and push it.

    Args:
        repo: owner/name of a cloned repository.
        branch: new branch name, for example fix/issue-42.
        message: the commit message.
    """
    cwd = repo_dir(repo)
    for args in (["switch", "-c", branch], ["add", "-A"], ["commit", "-m", message]):
        subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)
    return await git(["push", "origin", branch], cwd)


@tool
def run(repo: str, argv: list[str]) -> str:
    """Run one program in a cloned repository, for example ["npm", "test"]. No shell.

    Args:
        repo: owner/name of a cloned repository.
        argv: the program and its arguments.
    """
    if not argv or argv[0] not in PROGRAMS:
        return f"not allowed; use one of {sorted(PROGRAMS)}"
    done = subprocess.run(
        argv, cwd=repo_dir(repo), capture_output=True, text=True, timeout=900
    )
    return f"exit {done.returncode}\n{(done.stdout + done.stderr)[-4000:]}"


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
async def invoke(
    payload: dict[str, str], context: RequestContext
) -> AsyncIterator[str]:
    agent = agent_for(context.session_id or "local")
    async for event in agent.stream_async(payload["prompt"]):
        if "data" in event:
            yield event["data"]


if __name__ == "__main__":
    app.run()
