"""Drive one coding task (the imperative shell): the agent reasons; tests and the PR are plain steps.

Usage: AGENT_ARN=arn:... USER_ID=usr_... USER_TOKEN=<Auth0 token> uv run python workflow.py
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import uuid

import boto3

from core import AskToFix, Done, GiveUp, after_tests, pull_request_arguments, task_session
from domain import (
    AgentArn,
    BranchName,
    Outcome,
    Output,
    ParseError,
    PullRequest,
    Repo,
    SessionId,
    UserId,
    UserToken,
    parse_command_event,
    parse_pull_request_reply,
)

GATEWAY_URL = (
    "https://helpdesk-tools-abc123xyz.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp"
)
MAX_ATTEMPTS = 3

client = boto3.client("bedrock-agentcore", region_name="eu-west-1")


def ask(agent: AgentArn, session: SessionId, user: UserId, prompt: str) -> str:
    """One agent turn. The user id selects whose GitHub token the agent may fetch."""
    response = client.invoke_agent_runtime(
        agentRuntimeArn=agent.value,
        runtimeSessionId=session.value,
        runtimeUserId=user.value,  # needs bedrock-agentcore:InvokeAgentRuntimeForUser
        payload=json.dumps({"prompt": prompt}).encode(),
    )
    lines = response["response"].iter_lines()
    return "".join(str(json.loads(line[6:])) for line in lines if line.startswith(b"data: "))


def sh(agent: AgentArn, session: SessionId, command: str, timeout: int = 900) -> Outcome:
    """Run a command in the agent's VM: no model, no tokens."""
    response = client.invoke_agent_runtime_command(
        agentRuntimeArn=agent.value,
        runtimeSessionId=session.value,
        body={"command": f'/bin/bash -c "{command}"', "timeout": timeout},
    )
    for raw in response["stream"]:
        event = parse_command_event(raw)  # outside data -> domain type, right here
        if isinstance(event, Output):
            print(event.text, end="")
        elif event is not None:
            return event
    raise ParseError("the command stream ended without an exit code")


def open_pull_request(pr: PullRequest, token: UserToken) -> str:
    """Call the GitHub tool behind the Gateway, as the user (tutorials 03, 06, 07)."""
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "github___create_pull_request", "arguments": pull_request_arguments(pr)},
    }
    request = urllib.request.Request(
        GATEWAY_URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {token.value}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return str(parse_pull_request_reply(json.load(response)))


def main() -> int:
    try:
        agent = AgentArn.parse(os.environ.get("AGENT_ARN", ""))
        user = UserId.parse(os.environ.get("USER_ID", ""))  # from their verified Auth0 token
        token = UserToken.parse(os.environ.get("USER_TOKEN", ""))
        repo, branch = Repo.parse("fintech/helpdesk-api"), BranchName.parse("fix/issue-42")
    except ParseError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    session = task_session("issue-42", str(uuid.uuid4()))  # one session (and workspace) per task
    print(ask(agent, session, user, f"Fix issue 42 in {repo.slug}. Clone it first."))

    tests = f"cd /mnt/workspace/{repo.name} && npm ci && npm test"
    attempt = 0
    while True:
        match after_tests(sh(agent, session, tests), attempt, MAX_ATTEMPTS):
            case Done():
                break
            case AskToFix(attempt=attempt):
                print(
                    ask(agent, session, user, "The tests fail. Run them, read the output, fix it.")
                )
            case GiveUp():
                print("tests still fail: a human takes over", file=sys.stderr)
                return 1

    print(ask(agent, session, user, f"Push the change to a new branch {branch.value}."))
    pr = PullRequest(repo, branch, BranchName.parse("main"), "Fix issue 42")
    print(open_pull_request(pr, token))
    return 0


if __name__ == "__main__":
    sys.exit(main())
