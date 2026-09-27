"""Drive one coding task: the agent does the reasoning; tests and the pull request are plain steps."""

import json
import os
import urllib.request
import uuid

import boto3

AGENT_ARN = os.environ.get(
    "AGENT_ARN",
    "arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/coder-AbCdEf1234",
)
GATEWAY_URL = "https://helpdesk-tools-abc123xyz.gateway.bedrock-agentcore.eu-west-1.amazonaws.com/mcp"

client = boto3.client("bedrock-agentcore", region_name="eu-west-1")


def ask(prompt: str, session_id: str, user_id: str) -> str:
    """One agent turn. user_id selects whose GitHub token the agent may fetch."""
    response = client.invoke_agent_runtime(
        agentRuntimeArn=AGENT_ARN,
        runtimeSessionId=session_id,
        runtimeUserId=user_id,  # needs bedrock-agentcore:InvokeAgentRuntimeForUser
        payload=json.dumps({"prompt": prompt}).encode(),
    )
    lines = response["response"].iter_lines()
    return "".join(json.loads(line[6:]) for line in lines if line.startswith(b"data: "))


def sh(command: str, session_id: str, timeout: int = 900) -> int:
    """Run a command in the agent's VM: no model, no tokens. Returns the exit code."""
    response = client.invoke_agent_runtime_command(
        agentRuntimeArn=AGENT_ARN,
        runtimeSessionId=session_id,
        body={"command": f'/bin/bash -c "{command}"', "timeout": timeout},
    )
    for event in response["stream"]:
        chunk = event.get("chunk", {})
        if "contentDelta" in chunk:
            delta = chunk["contentDelta"]
            print(delta.get("stdout", "") + delta.get("stderr", ""), end="")
        if "contentStop" in chunk:
            return chunk["contentStop"]["exitCode"]
    return -1


def open_pull_request(arguments: dict[str, str], user_token: str) -> str:
    """Call the GitHub tool behind the Gateway, as the user (tutorials 03, 06, 07)."""
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "github___create_pull_request", "arguments": arguments},
    }
    request = urllib.request.Request(
        GATEWAY_URL,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {user_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        return json.dumps(json.load(response)["result"])


def main() -> None:
    session = f"coder-issue-42-{uuid.uuid4()}"  # one session (and workspace) per task
    user = os.environ["USER_ID"]  # who asked; taken from their verified Auth0 token
    print(ask("Fix issue 42 in fintech/helpdesk-api. Clone it first.", session, user))

    tests = "cd /mnt/workspace/helpdesk-api && npm ci && npm test"
    for _ in range(3):  # the test run decides, not the model
        if sh(tests, session) == 0:
            break
        print(ask("The tests fail. Run them, read the output, fix it.", session, user))
    else:
        raise SystemExit("tests still fail: a human takes over")

    print(ask("Push the change to a new branch fix/issue-42.", session, user))
    pr = {
        "owner": "fintech",
        "repo": "helpdesk-api",
        "title": "Fix issue 42",
        "head": "fix/issue-42",
        "base": "main",
    }
    print(open_pull_request(pr, os.environ["USER_TOKEN"]))


if __name__ == "__main__":
    main()
