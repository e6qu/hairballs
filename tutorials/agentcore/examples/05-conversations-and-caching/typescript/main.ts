// The helpdesk agent with its thread in AgentCore Memory and the prompt cache on.
import { Agent, BedrockModel } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { z } from "zod";
import { addMessage, readThread } from "./memory.js";

const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const SYSTEM_PROMPT = `You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Never reveal credentials or personal data.`;

// One agent per session. A new VM (same session id) reloads the thread from Memory.
const agents = new Map<string, Agent>();
async function agentFor(userId: string, sessionId: string): Promise<Agent> {
  let agent = agents.get(sessionId);
  if (!agent) {
    const thread = await readThread(userId, sessionId);
    agent = new Agent({
      model: new BedrockModel({
        modelId: MODEL_ID,
        region: "eu-west-1",
        cacheConfig: { strategy: "auto" },
      }),
      systemPrompt: SYSTEM_PROMPT,
      messages: thread.map(([role, text]) => ({
        role: role === "USER" ? "user" : "assistant",
        content: [{ text }],
      })),
    });
    agents.set(sessionId, agent);
  }
  return agent;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    // Who is calling. The default lets `agentcore invoke` work; tutorial 06 takes the verified
    // user id from the Auth0 token instead.
    requestSchema: z.object({ prompt: z.string(), user_id: z.string().default("anonymous") }),
    async *process(payload, context) {
      const userId = payload.user_id;
      const sessionId = context.sessionId || "local";
      const agent = await agentFor(userId, sessionId);
      let answer = "";
      for await (const event of agent.stream(payload.prompt)) {
        if (
          event.type === "modelStreamUpdateEvent" &&
          event.event.type === "modelContentBlockDeltaEvent" &&
          event.event.delta.type === "textDelta"
        ) {
          answer += event.event.delta.text;
          yield { data: event.event.delta.text };
        }
      }
      await addMessage(userId, sessionId, "USER", payload.prompt); // save the turn
      await addMessage(userId, sessionId, "ASSISTANT", answer);
    },
  },
});

app.run();
