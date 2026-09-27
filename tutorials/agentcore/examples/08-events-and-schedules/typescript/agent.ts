// The helpdesk agent for events: reply "accepted" at once, then keep working in the background.
import { Agent } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const SYSTEM_PROMPT = `You are the internal IT and expenses helpdesk for Fintech Ltd.
You are running unattended. Use your tools, then finish with a short summary.`;

const tasks = new Map<string, "running" | "done" | "failed">(); // for this session's VM

async function run(taskId: string, prompt: string): Promise<void> {
  // While the task is registered, /ping answers HealthyBusy and the session stays alive.
  const pingId = app.addAsyncTask("helpdesk-task", { taskId });
  try {
    const agent = new Agent({ model: MODEL_ID, systemPrompt: SYSTEM_PROMPT });
    const result = await agent.invoke(prompt);
    // Report the result: a queue, a ticket note, a chat message.
    console.log(`task ${taskId} done: ${result.toString()}`);
    tasks.set(taskId, "done");
  } catch (error) {
    console.error(`task ${taskId} failed`, error);
    tasks.set(taskId, "failed");
  } finally {
    // /ping answers Healthy again; the idle timeout starts counting.
    app.completeAsyncTask(pingId);
  }
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ taskId: z.string(), prompt: z.string() }),
    process: async ({ taskId, prompt }) => {
      // A retried event must not start a second run.
      if (!tasks.has(taskId)) {
        tasks.set(taskId, "running");
        void run(taskId, prompt);
      }
      return { status: "accepted", taskId, state: tasks.get(taskId) };
    },
  },
});

app.run({ port: 8080 });
