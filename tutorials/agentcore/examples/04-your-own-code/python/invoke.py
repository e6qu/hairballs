"""Call the deployed helpdesk agent with boto3 and print the streamed answer."""

import json
import os
import sys
import uuid

import boto3

AGENT_ARN = os.environ["AGENT_ARN"]  # arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/...

client = boto3.client("bedrock-agentcore", region_name="eu-west-1")


def ask(prompt: str, session_id: str) -> None:
    response = client.invoke_agent_runtime(
        agentRuntimeArn=AGENT_ARN,
        runtimeSessionId=session_id,  # same id = same VM = same conversation
        payload=json.dumps({"prompt": prompt}).encode(),
        contentType="application/json",
        accept="text/event-stream",
        qualifier="DEFAULT",
    )
    for line in response["response"].iter_lines():  # server-sent events: b'data: "..."'
        if line.startswith(b"data: "):
            print(json.loads(line[6:]), end="", flush=True)
    print()


if __name__ == "__main__":
    session_id = sys.argv[2] if len(sys.argv) > 2 else str(uuid.uuid4())
    ask(sys.argv[1], session_id)
    print(f"session: {session_id}")
