"""The helpdesk agent for events: reply "accepted" at once, keep working in the background (shell)."""

from __future__ import annotations

import asyncio

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent

from core import AlreadyKnown, Start, accepted, on_task
from domain import Task, TaskState, parse_task

MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0"
SYSTEM_PROMPT = """You are the internal IT and expenses helpdesk for Fintech Ltd.
You are running unattended. Use your tools, then finish with a short summary."""

app = BedrockAgentCoreApp()
tasks: dict[str, TaskState] = {}  # for this session's VM only
background: set[asyncio.Task[None]] = set()


async def run(task: Task) -> None:
    # While the task is registered, /ping answers HealthyBusy and the session stays alive.
    ping_id = app.add_async_task("helpdesk-task", {"taskId": task.task_id})
    try:
        agent = Agent(model=MODEL_ID, system_prompt=SYSTEM_PROMPT)
        result = await agent.invoke_async(task.prompt)
        # Report the result: a queue, a ticket note, a chat message.
        print(f"task {task.task_id} done: {result}")
        tasks[task.task_id] = TaskState.DONE
    except Exception as error:
        print(f"task {task.task_id} failed: {error!r}")
        tasks[task.task_id] = TaskState.FAILED
    finally:
        # /ping answers Healthy again; the idle timeout starts counting.
        app.complete_async_task(ping_id)


@app.entrypoint
async def invoke(payload: object, context: RequestContext) -> dict[str, str]:
    task = parse_task(payload)  # outside data -> domain type, right here
    match on_task(tasks, task):
        case Start():
            tasks[task.task_id] = TaskState.RUNNING
            job = asyncio.create_task(run(task))
            background.add(job)
            job.add_done_callback(background.discard)
        case AlreadyKnown():
            pass  # a retried event must not start a second run
    return accepted(task, tasks[task.task_id])


if __name__ == "__main__":
    app.run()
