// The helpdesk agent for events: reply "accepted" at once, keep working in the background (shell).
import { Agent } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { accepted, onTask } from "./core.ts";
import { type Task, type TaskState, parseTask } from "./domain.ts";

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const SYSTEM_PROMPT = `You are the internal IT and expenses helpdesk for Fintech Ltd.
You are running unattended. Use your tools, then finish with a short summary.`;

const tasks = new Map<string, TaskState>(); // for this session's VM only

async function run(task: Task): Promise<void> {
  // While the task is registered, /ping answers HealthyBusy and the session stays alive.
  const pingId = app.addAsyncTask("helpdesk-task", { taskId: task.taskId });
  try {
    const agent = new Agent({ model: MODEL_ID, systemPrompt: SYSTEM_PROMPT });
    const result = await agent.invoke(task.prompt);
    // Report the result: a queue, a ticket note, a chat message.
    console.log(`task ${task.taskId} done: ${result.toString()}`);
    tasks.set(task.taskId, "done");
  } catch (error) {
    console.error(`task ${task.taskId} failed`, error);
    tasks.set(task.taskId, "failed");
  } finally {
    // /ping answers Healthy again; the idle timeout starts counting.
    app.completeAsyncTask(pingId);
  }
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload: unknown) => {
      const task = parseTask(payload); // outside data -> domain type, right here
      const next = onTask(tasks, task);
      if (next.kind === "start") {
        tasks.set(task.taskId, "running");
        void run(task);
      } // a retried event must not start a second run
      return accepted(task, tasks.get(task.taskId) ?? "running");
    },
  },
});

app.run({ port: 8080 });
