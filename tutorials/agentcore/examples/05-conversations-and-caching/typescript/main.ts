// The helpdesk agent with its thread in AgentCore Memory and the prompt cache on (the shell).
import { Agent, BedrockModel } from "@strands-agents/sdk";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { thread } from "./core.ts";
import {
  type ActorId,
  type SessionId,
  message,
  parseInvocation,
  parseMemoryId,
  parseSessionId,
} from "./domain.ts";
import { addMessage, readEvents } from "./memory.ts";

// Set by `agentcore add memory` or Terraform; parsed once, at startup.
const MEMORY = parseMemoryId(process.env.MEMORY_HELPDESK_MEMORY_ID);
const MODEL_ID = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const SYSTEM_PROMPT = `You are the internal IT and expenses helpdesk for Fintech Ltd.
Answer policy questions briefly. Never reveal credentials or personal data.`;

// One agent per session. A new VM (same session id) reloads the thread from Memory.
const agents = new Map<SessionId, Agent>();
async function agentFor(actor: ActorId, session: SessionId): Promise<Agent> {
  let agent = agents.get(session);
  if (!agent) {
    const history = thread(await readEvents(MEMORY, actor, session, undefined), false);
    agent = new Agent({
      model: new BedrockModel({
        modelId: MODEL_ID,
        region: "eu-west-1",
        cacheConfig: { strategy: "auto" },
      }),
      systemPrompt: SYSTEM_PROMPT,
      messages: history.map((m) => ({
        role: m.role === "USER" ? "user" : "assistant",
        content: [{ text: m.text }],
      })),
    });
    agents.set(session, agent);
  }
  return agent;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    async *process(payload, context) {
      // Who is calling: user_id defaults to "anonymous" so that `agentcore invoke` works;
      // tutorial 06 takes the verified user id from the Auth0 token instead.
      const { prompt, actor } = parseInvocation(payload); // outside data -> domain types
      const session = parseSessionId(context.sessionId);
      const agent = await agentFor(actor, session);
      let answer = "";
      for await (const event of agent.stream(prompt)) {
        if (
          event.type === "modelStreamUpdateEvent" &&
          event.event.type === "modelContentBlockDeltaEvent" &&
          event.event.delta.type === "textDelta"
        ) {
          answer += event.event.delta.text;
          yield { data: event.event.delta.text };
        }
      }
      const main = { kind: "main" } as const; // save the turn
      await addMessage(MEMORY, actor, session, message("USER", prompt), main, new Date());
      await addMessage(MEMORY, actor, session, message("ASSISTANT", answer), main, new Date());
    },
  },
});

app.run();
