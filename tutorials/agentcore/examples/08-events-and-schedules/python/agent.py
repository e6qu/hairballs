"""The helpdesk agent for events: reply "accepted" at once, then keep working in the background."""

import asyncio

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are the internal IT and expenses helpdesk for Fintech Ltd.
You are running unattended. Use your tools, then finish with a short summary."""

app = BedrockAgentCoreApp()
tasks: dict[str, str] = {}  # task id -> running | done | failed, for this session's VM
background: set[asyncio.Task[None]] = set()


async def run(task_id: str, prompt: str) -> None:
    # While the task is registered, /ping answers HealthyBusy and the session stays alive.
    ping_id = app.add_async_task("helpdesk-task", {"taskId": task_id})
    try:
        agent = Agent(model=MODEL_ID, system_prompt=SYSTEM_PROMPT)
        result = await agent.invoke_async(prompt)
        # Report the result: a queue, a ticket note, a chat message.
        print(f"task {task_id} done: {result}")
        tasks[task_id] = "done"
    except Exception as error:
        print(f"task {task_id} failed: {error!r}")
        tasks[task_id] = "failed"
    finally:
        # /ping answers Healthy again; the idle timeout starts counting.
        app.complete_async_task(ping_id)


@app.entrypoint
async def invoke(payload: dict[str, str], context: RequestContext) -> dict[str, str]:
    task_id = payload["taskId"]
    if task_id not in tasks:  # a retried event must not start a second run
        tasks[task_id] = "running"
        job = asyncio.create_task(run(task_id, payload["prompt"]))
        background.add(job)
        job.add_done_callback(background.discard)
    return {"status": "accepted", "taskId": task_id, "state": tasks[task_id]}


if __name__ == "__main__":
    app.run()
